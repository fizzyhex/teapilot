import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { HostRequest, HostResult } from './host.js';
import { prepareConversation, type ConversationTurn } from './integration/events.js';
import type { ChatPromptState } from './composer.js';
import { isMode, modes, permissions, repositoryPermissions, workloadFor, type Mode } from './execution/grants.js';
import type { Approve } from './execution/policy.js';
import type { EventSink } from './integration/events.js';
import { keptNote, workspaceCommand, workspaceHelp, type WorkspaceControls } from './workspace/commands.js';
import type { SessionWorkspace } from './workspace/terminal.js';
import { isTierPreference, tierPreferences, type Tier, type TierPreference } from './config.js';
import type { SkillPreferences } from './skills/settings.js';

const sessionHelp = `Commands: /mode ${modes.join('|')}, /tier ${tierPreferences.join('|')}, /skills list|enable|disable|update|offline|reset, /convo clear, ${workspaceHelp}, /new, /cd <path>, /permissions, /grant <permission>, /revoke <permission>, /btw <question>, /plan <idea>, /rfc <idea>, /exit, /quit`;

const keptSteps = 6;

/** A side question: `/btw` and what follows, answered from the conversation without joining it. */
export const isAside = (text: string): boolean => /^\/btw(?:\s|$)/i.test(text.trim());

/** The two ways to ask for a proposal: `plan` is an implementation plan, `rfc` a design proposal. */
export type ProposalKind = 'plan' | 'rfc';

/** A request for a proposal: `/plan` or `/rfc` and the idea after it, sent as an ordinary turn that asks for a proposal and no changes yet. */
export const proposalRequest = (text: string): { kind: ProposalKind; idea: string } | undefined => {
  const match = /^\/(plan|rfc)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return match ? { kind: match[1]!.toLowerCase() as ProposalKind, idea: (match[2] ?? '').trim() } : undefined;
};

const proposalHead = `[PLAN MODE] You are in plan mode - a read-only exploration mode for safe analysis.

---

## Plan

%prompt%

---

DO NOT MAKE ANY CHANGES UNTIL THE USER GIVES AN EXPLICIT "go ahead"!`;

const planTemplate = `${proposalHead}

## Plan Mode Restrictions:
- Write tools are forbidden and disabled
- Bash is restricted to an allowlist of read-only commands
- Do not perform planned work

## Research & Source Gathering

[!] Only enough research to confirm feasibility is required.

If focused research needs a separate context, use \`delegate_task\` for up to 2 bounded assignments with \`agent_type\` \`research\`, a concise \`description\`, complete \`prompt\` and any \`artifacts\` (file paths or artifact IDs):
  -> inspect the relevant \`workspace\` context; understanding any existing implementation & constraints.
  -> if more info is required; direct an agent to perform focused web research with \`web_search\`.


## Output

Output a concrete, high-level plan, inside <plan> tags:

\`\`\`text
<plan>
# [title]


[plan]
1. concrete implementation step
2 ...

[verification]
...

[if applicable; non-obvious design choice / tradeoff? 1 paragraph max]

[key tradeoffs / rationale, only if non-obvious]

[clarifying questions, 0-3]
</plan>
\`\`\`

[!] Include relevant file paths, and prefer simple solutions that mesh well with anything in the existing workspace.

`;

const rfcTemplate = `${proposalHead} Your reply MUST use the template below, starting with the "<rfc>" tag - with NOTHING else extra.

\`\`\`template
<rfc>
# Proposal name

## Summary

Briefly explain the proposal, its purpose, and intended outcome.

## Motivation

Describe the problem or opportunity, relevant use cases, and why this is worth doing.

## Design

Explain the proposed approach in enough detail to understand how it would work. Cover key decisions, constraints, dependencies, responsibilities, and practical examples where useful.

## Drawbacks

Identify the main risks, costs, trade-offs, and reasons not to proceed.

## Alternatives

Describe other approaches considered, including doing nothing, and their likely impact.

## Prior Art

Reference similar approaches used elsewhere or internally. Compare relevant patterns, supporting practices, and constraints, and note how this proposal aligns or differs.
</rfc>
\`\`\``;

/** The idea wrapped in the template for its kind. */
export const proposalPrompt = (kind: ProposalKind, idea: string): string => (kind === 'rfc' ? rfcTemplate : planTemplate).replace('%prompt%', () => idea);

/** What the model is told, as the host, about the request before this one stopping. */
export function stopNotice(stopped: NonNullable<ConversationTurn['stopped']>): string {
  const calls = stopped.failedCalls?.length
    ? ` These calls failed; stop repeating now and change your approach:\n${stopped.failedCalls.map(({ call, error }) => `- ${call}${error ? ` → ${error}` : ''}`).join('\n')}`
    : '';
  return `[note] the previous request stopped before finishing (${stopped.status.replaceAll('_', ' ')}).${calls}`;
}

/** Optional behaviour layered on a session, such as teachat. Every hook is awaited in turn order. */
export interface SessionExtension {
  /** Runs before any command or turn: background work must get out of the way first. */
  busy?(): Promise<void>;
  /** Extra fields for each turn's request. */
  request?(): Partial<HostRequest>;
  turnEnd?(turn: ConversationTurn, result: HostResult): Promise<void>;
  /** The conversation was cleared with /new. */
  reset?(): Promise<void>;
  /** Handles a slash command it owns; false leaves it to the session. */
  command?(command: string, args: string): Promise<boolean>;
  help?: string;
}

/**
 * One session loop for every mode (chat, ask, code). The mode selects instructions
 * and default access; history, tiers, grants and commands behave identically.
 * A session stays interactive even when an opening prompt was supplied.
 */
export async function runSession(options: {
  request: HostRequest;
  maxPromptChars: number;
  input: (state: ChatPromptState) => Promise<string>;
  run: (request: HostRequest) => Promise<HostResult>;
  once?: boolean;
  approve?: Approve;
  log?: (text: string) => void;
  onEvent?: EventSink;
  extension?: SessionExtension;
  /** The conversation's turns after each change, for surfaces that keep them across restarts; empty once cleared. */
  onHistory?: (history: ConversationTurn[]) => void;
  /** Files the session works on outside Code mode: @mentioned files come in, and files sent back land beside the user. */
  workspace?: SessionWorkspace;
  /** /workspace, /convo clear and /new for a session whose files are kept by its surface rather than `workspace`. */
  files?: WorkspaceControls;
  skills?: { preferences(): SkillPreferences; command(args: string): Promise<string> };
}): Promise<number> {
  const extension = options.extension;
  const help = sessionHelp + (extension?.help ? `, ${extension.help}` : '');
  let history: ConversationTurn[] = options.request.history ?? [];
  let mode: Mode = options.request.mode ?? 'chat';
  const grants = options.request.authorization;
  let cwd = options.request.cwd;
  let prompt = options.request.prompt;
  let correction = options.request.correction;
  let tier: TierPreference = options.request.tier ?? 'auto';
  let relatedTier: Tier | undefined = options.request.relatedTier;
  const sessionId = options.request.sessionId ?? randomUUID();
  let taskId = options.request.taskId ?? history.at(-1)?.taskId ?? randomUUID();
  let exitCode = 0;
  let spentUsd = 0;
  let lastModel: string | undefined;
  const files = options.workspace ?? options.files;
  /** /convo clear: the conversation starts over; access, spending and the workspace's files stay. */
  const clearConvo = async () => {
    history = []; options.onHistory?.(history); correction = undefined; relatedTier = undefined; tier = 'auto';
    taskId = randomUUID();
    await extension?.reset?.(); await files?.clearScratch();
  };
  while (!options.request.signal?.aborted) {
    if (!prompt.trim()) {
      try { prompt = await options.input({ spentUsd, lastModel, tier, ...(grants ? { mode, grants: grants.list(), cwd: grants.root } : {}) }); }
      catch (error) {
        if (error instanceof Error && error.name === 'TerminalClosedError') break;
        throw error;
      }
    }
    prompt = prompt.trim();
    if (['/exit', '/quit'].includes(prompt)) { options.onHistory?.([]); break; }
    if (!prompt) continue;
    await extension?.busy?.();
    // A side question sees the conversation but stays out of it: no history, no correction, and extensions never learn of it.
    const aside = isAside(prompt) ? prompt.slice(4).trim() : undefined;
    if (aside !== undefined) {
      if (!aside) options.log?.('/btw <question> asks an aside about this conversation without adding it to the conversation.');
      else {
        const workspace = mode !== 'code' ? options.workspace : undefined;
        const question = workspace ? await workspace.attach(aside, cwd, options.maxPromptChars - aside.length - 1500) : aside;
        // No scratchpad either: that is where the session's transcript is kept.
        const result = await options.run({ ...options.request, ...extension?.request?.(), skills: options.skills?.preferences() ?? options.request.skills, cwd, prompt: question, correction: undefined, tier, relatedTier, history,
          mode, conversational: !options.once, side: true, scratch: undefined, workload: grants ? undefined : workloadFor(mode), ...(workspace ? { workspace: workspace.context(cwd) } : {}) });
        spentUsd += result.spentUsd;
        lastModel = result.models?.at(-1) ?? lastModel;
        if (!result.success) exitCode = 2;
      }
      prompt = '';
      if (options.once) break;
      continue;
    }
    // A proposal request is an ordinary turn, so the proposal stays in the conversation for the talk that follows.
    const proposal = proposalRequest(prompt);
    if (proposal) {
      if (!proposal.idea) {
        options.log?.(proposal.kind === 'rfc'
          ? '/rfc <idea> asks for a design proposal to discuss before any changes are made.'
          : '/plan <idea> asks for an implementation plan to discuss before any changes are made.');
        prompt = '';
        if (options.once) break;
        continue;
      }
      prompt = proposalPrompt(proposal.kind, proposal.idea);
    }
    if (prompt.startsWith('/')) {
      const [command, value, extra] = prompt.split(/\s+/);
      if (command === '/cd') {
        const target = prompt.slice(3).trim().replace(/^(["'])(.*)\1$/, '$2');
        let moved = !target;
        if (!grants) options.log?.('/cd needs a session with access grants.');
        else if (target) try {
          await grants.reroot(resolve(grants.root, target.replace(/^~(?=$|[\\/])/, homedir())), mode, options.onEvent);
          cwd = grants.root; moved = true;
        } catch (error) {
          options.log?.(`Cannot change directory: ${(error as NodeJS.ErrnoException).code === 'ENOENT' ? `${target} does not exist` : error instanceof Error ? error.message : String(error)}. Root unchanged: ${grants.root}`);
        }
        if (grants && moved) options.log?.(`Root: ${grants.root}\nSession access: ${grants.list().join(', ') || 'none'}${mode === 'code'
          && !(grants.allows('repository.write') && grants.allows('repository.shell')) ? ' (write and shell are requested for this root when first needed)' : ''}`);
      } else if (command === '/permissions' && !value) options.log?.(`Session access (${grants?.root ?? cwd}): ${grants?.list().join(', ') || 'none'}`);
      else if (command === '/grant' && !extra && permissions.includes(value as typeof permissions[number])) {
        const permission = value as typeof permissions[number];
        const approved = !!grants && await grants.request([permission], 'You requested it.', options.approve ?? (async () => false), options.request.signal,
          async (type, fields) => { options.onEvent?.({ type, ...fields }); });
        options.log?.(approved ? `Session access: ${grants.list().join(', ')}` : `${permission} was not granted (denied or unavailable).`);
      } else if (command === '/revoke' && !extra && permissions.includes(value as typeof permissions[number])) {
        grants?.revoke(value as typeof permissions[number], options.onEvent);
        options.log?.(`Session access: ${grants?.list().join(', ') || 'none'}`);
      } else if (command === '/tier' && !extra && isTierPreference(value)) {
        tier = value; options.log?.(`Tier preference: ${tier}`);
      } else if (command === '/skills' && options.skills) {
        try { options.log?.(await options.skills.command(prompt.slice(7).trim())); }
        catch (error) { options.log?.(error instanceof Error ? error.message : String(error)); }
      } else if (command === '/convo') {
        if (value === 'clear' && !extra) {
          await clearConvo();
          options.log?.(['cleared the conversation.', keptNote(files?.count() ?? 0)].filter(Boolean).join(' '));
        } else options.log?.('Conversation commands: /convo clear');
      } else if (command === '/workspace') options.log?.((await workspaceCommand(files, prompt))!);
      else if (command === '/new' && !value) {
        await clearConvo();
        if (options.workspace) await options.workspace.reset();
        else if (files) { await files.clearFiles(); files.name(''); }
        options.log?.('started a new task with an empty workspace');
      } else if (command === '/mode' && !extra && isMode(value)) {
        const approved = value !== 'code' || !grants || await grants.request(repositoryPermissions.filter(permission => grants.available().includes(permission)),
          'You requested Code mode.', options.approve ?? (async () => false), options.request.signal,
          async (type, fields) => { options.onEvent?.({ type, ...fields }); });
        if (approved) { mode = value; options.log?.(`Mode: ${mode}`); }
        else options.log?.('Code access was not approved; mode unchanged.');
      } else if (!await extension?.command?.(command!, prompt.slice(command!.length).trim())) options.log?.(help);
      prompt = '';
      if (options.once) break;
      continue;
    }
    // Code mode works on the repository itself; the other modes keep files in the session's workspace.
    const workspace = mode !== 'code' ? options.workspace : undefined;
    if (workspace) prompt = await workspace.attach(prompt, cwd, options.maxPromptChars - prompt.length - (correction?.length ?? 0) - 1500);
    // With session grants the host routes by mode and activates access on demand;
    // without them the mode's workload is fixed for the turn.
    const stopped = history.at(-1)?.stopped;
    const notice = stopped ? stopNotice(stopped) : undefined;
    const result = await options.run({ ...options.request, ...extension?.request?.(), skills: options.skills?.preferences() ?? options.request.skills, sessionId, taskId, cwd, prompt, correction, notice, tier, relatedTier, history,
      readOnly: Boolean(proposal), taskObjective: proposal?.idea, planAction: proposal?.kind === 'plan' ? 'new' : undefined,
      mode, conversational: !options.once, workload: grants ? undefined : workloadFor(mode), ...(workspace ? { workspace: workspace.context(cwd) } : {}),
      ...(options.workspace ? { scratch: options.workspace.scratch() } : {}) });
    spentUsd += result.spentUsd;
    taskId = result.taskId ?? taskId;
    lastModel = result.models?.at(-1) ?? lastModel;
    if (result.tier && result.tier !== 'fast') relatedTier = result.tier;
    if (!result.success) exitCode = 2;
    const user = (notice ? `${notice}\n\n` : '') + (proposal ? `/${proposal.kind} ${proposal.idea}` : prompt) + (correction ? `\nUser correction:\n${correction}` : '');
    // A failed turn's text is the host's diagnostic, and anything the host writes as the reply reads as the model's
    // own words, which it then copies. The turn keeps only what the model said; the next one opens with a notice.
    const assistant = result.success ? result.historyText ?? result.text : result.reply ?? '';
    const turn: ConversationTurn = { user, assistant, taskId, ...(result.steps?.length ? { steps: result.steps } : {}),
      ...(result.success ? {} : { stopped: { status: result.status, ...(result.failedCalls?.length ? { failedCalls: result.failedCalls } : {}) } }) };
    // Only recent turns keep their steps: fitting history to a model replays older ones as text anyway.
    const turns = [...history, turn];
    history = prepareConversation('', [], turns.map((turn, index) => index < turns.length - keptSteps ? { user: turn.user, assistant: turn.assistant, taskId: turn.taskId } : turn), options.maxPromptChars).history;
    options.onHistory?.(history);
    await extension?.turnEnd?.({ user, assistant }, result);
    correction = undefined;
    prompt = '';
    if (options.once) break;
  }
  return exitCode;
}

// Compatibility for existing embedders; CLI ask/chat/code all use runSession.
export const runChat = runSession;
