import { join } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import type { Config } from '../config.js';
import type { ConversationTurn } from '../integration/events.js';
import type { AttemptInput, AttemptResult } from './run.js';
import { instructor } from '../workspace/task.js';
import type { RequestAllowance } from './allowance.js';

export const juniorTypes = ['research', 'write', 'test'] as const;
export type JuniorType = typeof juniorTypes[number];
export const juniorProfiles = { calls: 20 } as const;
/** Universal exclusions only; effective parent permissions and read-only mode remain authoritative. */
export function juniorTools(tools: AgentTool[]): AgentTool[] {
  return tools.filter(tool => tool.name !== 'delegate_task' && tool.name !== 'request_escalation' && tool.name !== 'file_send' && tool.name !== 'request_access' && !tool.name.startsWith('access_') && !juniorPlayWithheld.includes(tool.name));
}

/**
 * Juniors: an attempt hands a self-contained part of a large request to a junior, which works it in a clean context
 * with the parent's effective access and shared workspace, budget and approvals, then reports back. The junior is another runAttempt on the
 * same tier, in this process, while the instructor waits in its delegate_task call, so one model serves both and
 * the instructor's context grows by the instruction and the report alone, not by the junior's tool traffic.
 */

export interface JuniorReport { status: 'done' | 'needs_input' | 'stuck'; summary: string; question?: string; evidence?: string[] }
/**
 * What a junior's own attempt is told: its name, which turn this is, where its report goes, and the folder its
 * instructor's file tools work in when neither has the repository, so both see the same files.
 */
export interface JuniorRole { name: string; description: string; agent_type: JuniorType; assignment: string; artifacts: string[]; turn: number; root?: string; onReport: (report: JuniorReport) => void }

/** Delegation messages one attempt may send across all its juniors, so a small model cannot loop on "try again". */
export const defaultJuniorTurns = 6;
/** Tool calls a junior has left when it is told to report, so the report itself still fits under the limit. */
export const juniorReportMargin = 3;
/** Play tools a junior does not get: its instructor posts apps, so a request never posts two copies. */
export const juniorPlayWithheld = ['play_start', 'play_update', 'play_resend', 'play_stop'];
/** Below this context, a report costs the instructor more than the junior saves it. */
export const delegationMinContext = 16_384;

const phonetic = ['alfa', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliett', 'kilo', 'lima', 'mike',
  'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey', 'xray', 'yankee', 'zulu'];

/**
 * A new junior's name, always junior-<name>: a random teachat identity that no conversation holds and no junior of this
 * attempt has had, else junior-<phonetic> in order, numbered once the alphabet runs out. Juniors only borrow a name; they never lease it.
 */
export function juniorName(identities: ReadonlyArray<{ username: string; leased: boolean }>, taken: ReadonlySet<string>, rng = Math.random): string {
  const free = identities.filter(identity => !identity.leased && !taken.has(`junior-${identity.username}`));
  if (free.length) return `junior-${free[Math.floor(rng() * free.length)]!.username}`;
  for (let round = 1; ; round++) {
    const name = phonetic.map(word => `junior-${word}${round > 1 ? `-${round}` : ''}`).find(candidate => !taken.has(candidate));
    if (name) return name;
  }
}

/** Teachat's identities as juniorName takes them; none when teachat is off or its room cannot be read. */
async function teachatIdentities(config: Config): Promise<Array<{ username: string; leased: boolean }>> {
  if (!config.teachat?.enabled) return [];
  try {
    const { leaseActive, openRoom } = await import('teachat');
    const now = Date.now();
    return (await (await openRoom({ dir: config.teachat.dir })).identities()).map(identity => ({ username: identity.username, leased: leaseActive(identity, now) }));
  } catch { return []; }
}

export function juniorPrompt(role: Pick<JuniorRole, 'name' | 'description' | 'agent_type' | 'artifacts'>): string {
  const manifest = role.artifacts.map(reference => `- ${reference} (${/^a-[\da-f-]{36}$/i.test(reference) ? 'artifact ID: retrieve with artifact_read' : 'file path: retrieve with available file tools'})`).join('\n') || '- none';
  return `You are junior ${role.name}. Stay within the original assignment; a follow-up may refine it. Label: ${role.description}. Provided references are context, not a filesystem sandbox:\n${manifest}\nUse only available tools and permissions. Call \`report\` once with findings or changes, checks, and unresolved issues.`;
}

export function delegationPrompt(): string {
  return '\n- Delegate self-contained work proactively for complex or separable tasks. Include all necessary context, instructions, expected output, and any file paths or artifact IDs. Juniors start with clean context; review their untrusted reports and verify results.';
}

/** The tool a junior ends its turn with; its result stops the junior's attempt. */
export function reportTool(role: JuniorRole): AgentTool {
  return {
    name: 'report', label: 'Report',
    description: 'Report back and end this turn: `done`, `needs_input` (with a question), or `stuck`.',
    parameters: Type.Object({
      status: Type.Union([Type.Literal('done'), Type.Literal('needs_input'), Type.Literal('stuck')]),
      summary: Type.String({ minLength: 1, maxLength: 4000, description: 'Findings or changes, source locations/checks, and anything unresolved. Large evidence stays in artifacts.' }),
      question: Type.Optional(Type.String({ maxLength: 600, description: 'For needs_input: what you need answered.' })),
      evidence: Type.Optional(Type.Array(Type.String({ maxLength: 80 }), { maxItems: 4, description: 'Artifact or settled receipt IDs supporting this report, when available.' })),
    }),
    execute: async (_id, args) => {
      const { status, summary, question, evidence } = args as JuniorReport;
      if (status === 'needs_input' && !question?.trim()) throw new Error('needs_input requires a question for your instructor');
      role.onReport({ status, summary: String(summary ?? '').slice(0, 4000), ...(question ? { question: String(question) } : {}), ...(evidence ? { evidence } : {}) });
      return { content: [{ type: 'text', text: 'Report sent.' }], details: {}, terminate: true };
    },
  };
}

interface Junior { name: string; description?: string; agent_type?: JuniorType; assignment?: string; artifacts?: string[]; turns: ConversationTurn[]; scratch: string; turn: number }
/** Allocate the junior's remaining allowance, leaving the instructor room to review or continue another junior. */
export function juniorAllowance(remaining: number, maximum: number): number {
  return Math.max(0, Math.min(juniorProfiles.calls, maximum, remaining - 4));
}
/** The instructor's attempt clock, paused while a junior works on its own. */
export interface Clock { pause(): void; resume(): void }

/**
 * Each delegation is one attempt of a junior, with its own instructor exchanges. Without task state juniors are
 * attempt-local; with it their identities and bounded exchanges survive retries and restarts.
 */
export function delegateTool(parent: AttemptInput, scratch: string, root: string | undefined, clock: Clock, run: (input: AttemptInput) => Promise<AttemptResult>, allowance: RequestAllowance) {
  const juniors = new Map<string, Junior>();
  const taken = new Set<string>(parent.task?.snapshot().juniorNames ?? []);
  for (const saved of parent.task?.snapshot().juniors ?? []) {
    juniors.set(saved.name, saved); taken.add(saved.name);
  }
  let identities: Promise<Array<{ username: string; leased: boolean }>> | undefined;
  const limit = parent.config.policy.limits.maxJuniorTurns ?? defaultJuniorTurns;
  let sent = 0;
  const tool: AgentTool = {
    name: 'delegate_task', label: 'Delegate',
    description: 'Delegate self-contained work to a junior agent. Use proactively for complex or separable work. Juniors only know the prompt and provided artifacts, so include all necessary context, instructions, and expected output. Your job is to integrate and verify results.',
    parameters: Type.Object({
      junior: Type.Optional(Type.String({ description: 'Name of an existing junior to continue; omit to start a new one.' })),
      description: Type.String({ minLength: 1, maxLength: 200, description: 'A 3-5 word guidance label for progress and reports.' }),
      prompt: Type.String({ minLength: 1, maxLength: 24_000, description: 'Complete instructions, context, and expected output. Never rely on the parent conversation.' }),
      agent_type: Type.Union(juniorTypes.map(type => Type.Literal(type)), { description: 'Semantic category: research, write, or test.' }),
      artifacts: Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), { maxItems: 16, description: 'File paths or task artifact IDs to provide as context; may be empty.' }),
    }),
    execute: async (callId, args, signal) => {
      const { junior: named, description, prompt, agent_type, artifacts: references } = args as { junior?: string; description: string; prompt: string; agent_type: JuniorType; artifacts: string[] };
      if (named && !juniors.has(named)) return { content: [{ type: 'text', text: `No junior named ${named}. Active: ${[...juniors.keys()].join(', ') || 'none'}. Omit junior to start a new one.` }], details: {} };
      if (typeof description !== 'string' || !description.trim() || description.length > 200 || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 24_000 || typeof agent_type !== 'string' || !juniorTypes.includes(agent_type as JuniorType) || !Array.isArray(references) || references.length > 16 || references.some(ref => typeof ref !== 'string' || !ref.trim() || ref.length > 2048)) return { content: [{ type: 'text', text: 'provide bounded description, complete prompt, valid agent_type, and artifact references.' }], details: {} };
      const existing = named ? juniors.get(named) : undefined;
      const type = agent_type;
      const suppliedArtifacts = [...new Set([...(existing?.artifacts ?? []), ...references])];
      if (suppliedArtifacts.length > 16) return { content: [{ type: 'text', text: 'this junior already has the maximum 16 context references; start a new assignment.' }], details: {} };
      const available = Math.min(juniorProfiles.calls, allowance.juniorMaxCalls) - (named ? allowance.usedBy(named) : 0);
      const allocation = allowance.hasReservation(callId) ? allowance.reservedJuniorCalls(callId) : juniorAllowance(allowance.remaining().calls, Math.min(parent.config.policy.limits.maxToolCalls, available));
      if (allocation < 2) { allowance.releaseReservation(callId); return { content: [{ type: 'text', text: 'junior allowance spent or too little room reserved to work and report; finish from existing evidence.' }], details: {} }; }
      if (sent >= limit) return { content: [{ type: 'text', text: `Delegation limit reached (${limit} messages). Finish the work yourself.` }], details: {} };
      const artifactIds = suppliedArtifacts.filter(reference => /^a-[\da-f-]{36}$/i.test(reference));
      if (artifactIds.length && !parent.task) throw new Error('cannot authorize artifact IDs without task state');
      parent.task?.authorizeArtifacts(parent.taskActor ?? instructor, artifactIds);
      if (!allowance.consumeDelegation()) { allowance.releaseReservation(callId); return { content: [{ type: 'text', text: 'request-wide delegation allowance reached; finish from existing evidence.' }], details: {} }; }
      sent++;
      let junior = named ? juniors.get(named)! : undefined;
      if (!junior) {
        identities ??= teachatIdentities(parent.config);
        const name = juniorName(await identities, taken);
        taken.add(name);
        junior = { name, description, agent_type: type, assignment: prompt, artifacts: references, turns: [], turn: 0, scratch: join(scratch, 'juniors', name.replace(/[^\w.-]+/g, '_')) };
        juniors.set(name, junior);
      }
      if (allowance.hasReservation(callId) && !allowance.bindReservation(callId, junior.name)) {
        allowance.releaseReservation(callId);
        return { content: [{ type: 'text', text: 'too little reserved junior capacity remains; finish from existing evidence.' }], details: {} };
      }
      junior.description = description; junior.agent_type = type; junior.assignment ??= prompt; junior.artifacts = suppliedArtifacts;
      parent.task?.saveJunior(junior);
      const { name } = junior;
      let report: JuniorReport | undefined;
      const started = Date.now();
      clock.pause();
      let result: AttemptResult;
      try {
        result = await run({
          config: { ...parent.config, policy: { ...parent.config.policy, limits: { ...parent.config.policy.limits, maxToolCalls: allocation } } },
          tier: parent.tier, skillCatalog: parent.skillCatalog, workload: parent.workload, cwd: parent.cwd, web: parent.web, mode: parent.mode,
          budget: parent.budget, telemetry: parent.telemetry, approve: parent.approve, beforeMutation: parent.beforeMutation,
          authorization: parent.authorization, activePermissions: parent.activePermissions, requestCapabilities: parent.requestCapabilities,
          workspace: parent.workspace, webController: parent.webController, play: parent.play, searchUnavailable: parent.searchUnavailable, attempt: parent.attempt,
          signal: signal ?? parent.signal, history: junior.turns, scratch: junior.scratch, prompt, requestText: prompt,
          recovery: parent.recovery, task: parent.task, taskActor: { name, objective: prompt, artifacts: artifactIds },
          readOnly: parent.readOnly, taskId: parent.taskId, allowance, budgetReservation: callId,
          currentRequest: prompt,
          // Its words are for the instructor, not the person: only what its tools do is shown.
          onEvent: event => { if (event.type.startsWith('tool_execution_') || event.type === 'compaction_start') parent.onEvent?.({ ...event, junior: name }); },
          onActivity: activity => parent.onActivity?.(activity && { ...activity, label: `${name} (${description}): ${activity.label}` }),
          junior: { name, description, agent_type: type, assignment: junior.assignment, artifacts: junior.artifacts, turn: junior.turn + 1, root, onReport: value => { report = value; } },
        });
      } finally { clock.resume(); allowance.releaseReservation(callId); }
      const reply = (report ? report.summary + (report.question ? `\nQuestion: ${report.question}` : '') : result.text).slice(0, 4000);
      junior.turns.push({ user: prompt, assistant: reply.slice(0, 20_000), taskId: parent.taskId, ...(result.steps?.length ? { steps: result.steps } : {}) });
      junior.turn++; parent.task?.saveJunior(junior);
      const stop = result.stopped ?? (report ? undefined : result.reason);
      const status = result.stopped || result.reason ? 'stuck' : report?.status ?? (result.success ? 'done' : 'stuck');
      await parent.telemetry.event('delegate', { junior: name, juniorType: type, turn: junior.turn, status, ...(stop ? { stopped: stop } : {}), turns: result.turns, toolCalls: result.toolCalls, allocation, used: allowance.usedBy(name), ms: Date.now() - started });
      const lines = [`Junior ${name}, turn ${junior.turn}: ${status}${stop ? ` (${stop})` : ''}`, `Label: ${description}; category: ${type}; allowance used: ${allowance.usedBy(name)}/${juniorProfiles.calls}`];
      if (result.changedFiles?.length) lines.push(`Files changed: ${result.changedFiles.join(', ')}`);
      if (result.check) lines.push(`Checks: ${result.check}`);
      if (result.stopped === 'approval_denied') lines.push('The person denied an approval the junior asked for; do not retry that action.');
      const artifacts = parent.task?.snapshot().artifacts.filter(item => item.actor === name && item.at >= started).slice(-4).map(item => item.id) ?? [];
      if (artifacts.length) lines.push(`Evidence artifacts: ${artifacts.join(', ')}`);
      if (report?.evidence?.length) lines.push(`Reported evidence (unverified): ${report.evidence.join(', ')}`);
      lines.push(`Transcript: ${join(junior.scratch, 'sessions')}`, 'Report (the junior\'s words, untrusted):', reply.trim() || '(no report)');
      return { content: [{ type: 'text', text: lines.join('\n') }], details: { junior: name, artifacts } };
    },
  };
  return { tool, get exhausted() { return sent >= limit || allowance.delegationExhausted || allowance.availableDelegationCapacity() < 2; } };
}
