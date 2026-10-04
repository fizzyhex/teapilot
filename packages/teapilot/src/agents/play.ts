import { readFile } from 'node:fs/promises';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import type { User } from '@teapilot/discord-play';
import type { Config } from '../config.js';
import { asText } from '../workspace/store.js';
import { workspaceName, type ConversationWorkspace } from './workspace.js';
import type { Approve, ExecutionPolicy } from '../execution/policy.js';
import { PlayError } from '../discord/play/render.js';
import { hashFile, playLimits, type PlayRuntime, type Source, type StartOptions, type TestAction, type TestExpectation, type TestReport } from '../discord/play/runtime.js';
import { checkAssetName, collectAssets, sandboxIdentity, type AssetFiles } from '../discord/play/assets.js';
import { fingerprint, RequestRecovery, type ToolOutcome } from './recovery.js';

/** The Discord conversation a request comes from; the host builds this, never the model. */
export interface PlayContext {
  runtime: PlayRuntime;
  /** Where apps run; undefined where there is nowhere to post them. */
  channelId?: string;
  /** Set where teapilot answers through an interaction and cannot post in the channel: apps post through it instead. */
  post?: StartOptions['post'];
  conversation: string;
  owner?: User;
  /** The conversation's workspace: where apps' files live, next to attachments that picture() shows. */
  files?: ConversationWorkspace;
  /** Server emoji people pasted in this conversation, by name, so ctx.emoji knows them without the model passing them. */
  emojis?: Record<string, string>;
  /** Names among `emojis` pasted in the current request. */
  requested?: string[];
}

const customEmoji = /<a?:(\w{2,32}):\d{17,20}>/g;
/** Server emoji written as <:name:id> in these texts, by name; the last one pasted wins a name used twice. */
export function pastedEmoji(...texts: string[]): Record<string, string> {
  return Object.fromEntries(texts.flatMap(value => [...value.matchAll(customEmoji)].map(match => [match[1]!, match[0]])));
}

/**
 * ["everyone"] as "everyone", and "invoker" or a <@id> mention inside a list as the ID it names: models mix the
 * keywords and mentions into the list form. A list always includes whoever starts the app, since "for me and
 * @friend" often reaches the tool as the friend alone.
 */
function participantsFor(value: string | string[] | undefined, owner: User): string | string[] | undefined {
  if (!Array.isArray(value)) return value;
  if (value.length === 1 && ['everyone', 'invoker'].includes(value[0]!)) return value[0];
  if (value.includes('everyone')) return 'everyone';
  return [...new Set([owner.id, ...value.map(id => id === 'invoker' ? owner.id : id.replace(/^<@!?(\d+)>$/, '$1'))])];
}
const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }], details: {} });
const participants = Type.Optional(Type.Union([Type.String({ description: '"everyone" or "invoker".' }), Type.Array(Type.String({ description: 'Discord user ID copied from a <@id> mention.' }), { minItems: 1, maxItems: 25 })], { description: 'Who may use the controls; a list always includes whoever starts the app. Omit for the app\'s own default, which is everyone.' }));
const assets = Type.Optional(Type.Record(Type.String(), Type.String(), { maxProperties: 32, description: 'Sandboxed text assets: logical name for ctx.readText(name) -> workspace file or repository path (relative to the workspace/repository root, not the app). Up to 32 UTF-8 files, 256 KiB each, 1 MiB combined. A mapping replaces the selection; {} clears it. Reloading/testing the same app file inherits its selection when omitted.' }));

/**
 * discord.play: the model writes small apps and the runtime runs them. An app is a file in the conversation's
 * workspace, made with write and changed with edit, so a fix costs an edit rather than the whole app again. Mistakes
 * in an app come back as ordinary results to fix and retry, not tool failures, since iterating is the normal workflow.
 */
export function play(context: PlayContext, config: Config, policy: ExecutionPolicy, approve: Approve, recovery = new RequestRecovery()): { systemPrompt: string; tools: AgentTool[] } {
  const has = (permission: Config['policy']['permissions'][number]) => config.policy.permissions.includes(permission);
  // With repository access apps are files of the repository, and the conversation's workspace is not in play (run.ts leaves `files` out);
  // without it they are files of the workspace. Never both, so a name always means one file.
  const repository = has('repository.read');
  /** The tool argument that names an app's file in this world. */
  const location = (description: string) => ({ [repository ? 'path' : 'file']: Type.Optional(Type.String({ description })) });
  const owner: User = context.owner ?? { id: '0' };
  const require = () => { if (!has('discord.play')) throw new Error('Missing discord.play permission'); };
  /** The code play_start or play_update last rejected, and the file the current call is trying. */
  let rejected: string | undefined, trying: { code: string; file?: string } | undefined;
  /** The running app play_update last tried, preferred when a dry run names no file. */
  let updating: string | undefined;
  /** The app play_start posted in this turn, so the same app is not posted twice. */
  let started: { id: string; title: string } | undefined;

  /** An app's workspace file as text, or why it cannot run. Files the file tools just wrote are found too. */
  const load = async (name: string): Promise<{ name: string; code: string } | string> => {
    const files = context.files;
    if (!files) return 'Apps run from workspace files, and this conversation has no workspace.';
    const wanted = workspaceName(name);
    let stored = files.store.read(files.conversation, wanted);
    if (!stored) { await files.store.reconcile(files.conversation); stored = files.store.read(files.conversation, wanted); }
    if (!stored) {
      const here = files.store.list(files.conversation).map(entry => entry.name).filter(entry => /\.(m?js|ts)$/.test(entry));
      return `No file named ${JSON.stringify(wanted)} in the workspace: write the app to it first, then call this again.${here.length ? ` App files here: ${here.join(', ')}.` : ''}`;
    }
    const code = asText(stored.file.name, stored.data, stored.file.type);
    return code === undefined ? `${stored.file.name} is not a text file, so it cannot run as an app.` : { name: stored.file.name, code };
  };
  const snapshot = (files: AssetFiles) => collectAssets(files, async name => {
    if (repository) return policy.path(name, false);
    if (!context.files) throw new PlayError('this conversation has no workspace for assets.');
    checkAssetName(workspaceName(name));
    const { store, conversation } = context.files;
    let entry = store.get(conversation, workspaceName(name));
    if (!entry) { await store.reconcile(conversation); entry = store.get(conversation, workspaceName(name)); }
    const path = entry && store.safePath(conversation, entry.name);
    if (!path) throw new PlayError(`asset file ${JSON.stringify(name)} is missing or not a plain file in this conversation's workspace.`);
    return path;
  });
  let validationState: unknown;
  const validationKey = (identity: string, state = validationState) => fingerprint([context.conversation, identity, state ?? null, context.emojis]);
  const prepare = async (code: string, file: string, assetFiles: AssetFiles, retry: boolean) => {
    const source: Extract<Source, { kind: 'sandbox' }> = { kind: 'sandbox', code, assets: await snapshot(assetFiles) };
    const identity = sandboxIdentity(source);
    const key = validationKey(identity);
    if (!retry && (key === rejected || recovery.rejectedApps.has(key) || recovery.failedTests.has(key))) return `${file} is unchanged since it was rejected by validation or testing (including its assets). nothing was posted or updated. fix the demonstrated defect with edit first; testing exhaustion is not permission to publish broken code.`;
    trying = { code: identity, file };
    return { source, file, assetFiles };
  };
  /** Workspace files run sandboxed; a trusted repository file runs as Node only after an operator approves it. */
  const resolve = async (args: { path?: string; file?: string; trusted?: boolean; assets?: AssetFiles }, signal?: AbortSignal, retry = false): Promise<{ source: Source; file?: string; assetFiles?: AssetFiles } | string> => {
    if (args.file !== undefined && args.path !== undefined) return 'Give file or path, not both.';
    if (args.file !== undefined && repository) return 'Apps are repository files here: pass path, not file.';
    if (args.path !== undefined && !repository) return 'Apps are workspace files here: pass file, not path.';
    if (args.file !== undefined) {
      if (args.trusted) return 'Workspace files run sandboxed only; leave trusted off.';
      const loaded = await load(args.file);
      if (typeof loaded === 'string') return loaded;
      return prepare(loaded.code, loaded.name, args.assets ?? {}, retry);
    }
    if (args.path === undefined) return repository ? 'Pass path: the app\'s repository file, written with write first.' : 'Pass file: the app\'s workspace file, written with write first.';
    const target = await policy.path(args.path, false);
    if (!args.trusted) {
      const code = await readFile(target, 'utf8');
      return prepare(code, args.path, args.assets ?? {}, retry);
    }
    if (args.assets !== undefined) return 'assets are for sandboxed apps; trusted Node apps read their own files.';
    if (!has('repository.shell')) return 'Trusted apps need repository.shell; request it first.';
    const sha256 = await hashFile(target);
    const approved = await approve({ kind: 'play', summary: `Run ${args.path} as a trusted Discord app? It runs as ordinary Node code, outside the sandbox, and can make any Discord API call as teapilot's bot.`, details: `File: ${target}\nSHA-256: ${sha256}\nAny later change to the file needs approval again.`, signal });
    return approved ? { source: { kind: 'trusted', path: target, sha256 } } : 'The operator did not approve running this app outside the sandbox.';
  };
  /**
   * An app's workspace file, written from its inline source for an app started before apps were files, so every
   * app is changed the same way: edit its file, then play_update.
   */
  const fileOf = async (id: string): Promise<string | undefined> => {
    const recorded = context.runtime.file(id, context.conversation);
    if (recorded) return recorded;
    const source = context.runtime.source(id, context.conversation);
    if (source.kind !== 'sandbox' || !context.files) return undefined;
    const saved = await context.files.store.saveAt(context.files.conversation, `apps/${id}.js`, Buffer.from(source.code), 'teapilot');
    context.runtime.adopt(id, context.conversation, saved.name);
    return saved.name;
  };
  /** Emoji apps may use: those pasted in the conversation, then any the model passes, named with or without colons. */
  const known = (extra: Record<string, string> = {}): Record<string, string> => ({ ...context.emojis, ...Object.fromEntries(Object.entries(extra)
    .map(([name, value]) => [name.replace(/^:|:$/g, ''), value.trim()]).filter(([, value]) => /^<a?:\w{2,32}:\d{17,20}>$/.test(value!))) });
  /** Models swap server emoji for lookalikes, believing only Unicode shows in text; point out the ones this request pasted that the app leaves out. */
  const unused = (source: Source | undefined) => {
    const missing = source?.kind === 'sandbox' ? (context.requested ?? []).filter(name => !source.code.includes(name)) : [];
    return missing.length ? `\nNote: the request pasted ${missing.map(name => context.emojis![name]).join(' ')}, which the app never uses. Server emoji show like any other emoji in text, grid cells and buttons: write each exactly as pasted, or ctx.emoji("${missing[0]}"), instead of a lookalike.` : '';
  };
  /** Whether this turn dry-ran anything, so a long app posted untried gets a nudge to play it through. */
  let tested = false;
  let testReport: TestReport | undefined;
  let toolOutcome: ToolOutcome | undefined;
  const attempt = async (tool: string, work: () => Promise<string>) => {
    require();
    trying = undefined;
    validationState = undefined;
    testReport = undefined; toolOutcome = undefined;
    try {
      const result = text(await work());
      const report = testReport as TestReport | undefined;
      const { text: _text, ...test } = report ?? {};
      return { ...result, details: { ...(toolOutcome ? { outcome: toolOutcome } : {}), ...(report ? { test } : {}) } };
    }
    catch (error) {
      if (!(error instanceof PlayError)) throw error;
      // Set by resolve() while the work ran.
      const tried = trying as { code: string; file?: string } | undefined;
      rejected = tried?.code ? validationKey(tried.code) : undefined;
      if (rejected) recovery.rejectedApps.add(rejected);
      const fix = tried?.file ? `\nFix it with edit on ${tried.file} (small exact replacements), then call ${tool} again with the same file, rather than writing the whole app again.` : '';
      return { ...text(`App problem, nothing was changed: ${error.message}${fix}`), details: { outcome: { code: 'runtime_error' as const, changed: false, failed: true } } };
    }
  };

  const newest = () => context.runtime.list(context.conversation).filter(app => app.status === 'running').at(-1)?.id;
  const sameFile = (a: string | undefined, b: string | undefined): boolean => {
    if (a === undefined || b === undefined) return false;
    if (repository) return policy.resolve(a) === policy.resolve(b);
    const canonical = (name: string) => context.files?.store.get(context.files.conversation, workspaceName(name))?.name ?? workspaceName(name);
    return canonical(a) === canonical(b);
  };
  /** Running apps this conversation can see: its own, then others shown in its channel. */
  const visible = () => context.runtime.list(context.conversation, context.channelId).filter(app => app.status === 'running');

  const tools: AgentTool[] = [
    {
      name: 'play_start', label: 'Start Discord app',
      description: `Post a new interactive app from its ${repository ? 'repository' : 'workspace'} entry file, written with write first, plus optional declared text assets snapshotted for ctx.readText(name). Returns its id and a text preview, or the problem to fix with edit.`,
      parameters: Type.Object({
        ...location(`The app's ${repository ? 'repository' : 'workspace'} file, such as apps/snake.js.`),
        assets,
        title: Type.String({ minLength: 1, maxLength: 100 }),
        ...repository ? { trusted: Type.Optional(Type.Boolean({ description: 'Run the file at path as Node outside the sandbox, with ctx.discord for raw API calls. Needs repository.shell and an operator approval.' })) } : {},
        participants,
        emojis: Type.Optional(Type.Record(Type.String(), Type.String(), { description: 'Rarely needed: server emoji pasted in this conversation are already in ctx.emoji. Others as <:name:id>, by name, copied exactly; never :shortcodes: such as :angel:, which are standard Unicode emoji (😇).' })),
      }),
      execute: async (_id, params, signal) => attempt('play_start', async () => {
        const args = params as { title?: string; path?: string; file?: string; trusted?: boolean; assets?: AssetFiles; participants?: string | string[]; emojis?: Record<string, string> };
        if (!context.channelId) return 'Apps cannot run here: teapilot has nowhere to post them. Ask the user to message teapilot in a channel or DM it can post in.';
        updating = undefined;
        const title = args.title;
        if (!title) return 'Give the app a title.';
        if (started?.title === title && visible().some(app => app.id === started!.id)) return `Nothing was started: app ${started.id} "${title}" is already live from this turn. Change it with edit on its file and play_update, so people keep one copy.`;
        // Checked before the code, so a wrong argument never counts as rejected code.
        const participants = participantsFor(args.participants, owner);
        if (Array.isArray(participants) && !participants.every(id => /^\d{17,20}$/.test(id))) return 'Nothing was started: participants must be "everyone", "invoker", or Discord user IDs copied from <@id> mentions.';
        const loaded = await resolve(args, signal);
        if (typeof loaded === 'string') return loaded;
        const { source, file, assetFiles } = loaded;
        const { record, preview } = await context.runtime.start({ title, channelId: context.channelId, post: context.post, conversation: context.conversation, owner, source, assetFiles, participants: participants as never, emojis: known(args.emojis), ...(file ? { file } : {}) });
        rejected = undefined; started = { id: record.id, title };
        // Probing presses each control once; rules that play out over many turns only show up when played through.
        const untried = !tested && source.kind === 'sandbox' && source.code.split('\n').length > 120;
        return `Started app ${record.id} (${record.participants === 'everyone' ? 'anyone can play' : `participants: ${JSON.stringify(record.participants)}`}). It is live in the channel; do not repeat its contents in your answer.\nPreview:\n${preview}${unused(source)}${untried ? '\nonly basic control checks ran, not a full playthrough. use a short targeted simulation if practical; otherwise give the user a brief gameplay checklist. do not claim untested rules passed.' : ''}`;
      }),
    },
    {
      name: 'play_update', label: 'Update Discord app',
      description: `Reload a running app's code and selected text assets from its ${repository ? 'repository' : 'workspace'} files, or rename its stored title, and re-render its message in place. Asset-only edits count. State is kept unless reset is true: data already copied into state is not replaced by refreshing an asset. View text comes from the app's code.`,
      parameters: Type.Object({
        id: Type.Optional(Type.String({ description: 'Omit for the newest running app in this conversation.' })),
        title: Type.Optional(Type.String({ minLength: 1, maxLength: 100, description: 'Change the stored app name. Titles and text inside its message are defined by its code.' })),
        ...location(`Run from this ${repository ? 'repository' : 'workspace'} file from now on, instead of the app's own.`),
        assets,
        ...repository ? { trusted: Type.Optional(Type.Boolean()) } : {},
        reset: Type.Optional(Type.Boolean({ description: 'Start over from init() instead of keeping the current state.' })),
        timers: Type.Optional(Type.Array(Type.Object({ id: Type.String(), ms: Type.Number() }), { minItems: 1, maxItems: 5, description: 'Timers to start now, such as [{ id: "tick", ms: 2000 }]: a loop the new code adds never starts on its own in an app past its init and start button.' })),
      }),
      execute: async (_id, params, signal) => attempt('play_update', async () => {
        const args = params as { id?: string; title?: string; file?: string; path?: string; trusted?: boolean; assets?: AssetFiles; reset?: boolean; timers?: Array<{ id: string; ms: number }> };
        const id = args.id ?? newest();
        if (!id) return 'No running app in this conversation; pass id (see play_list) or use play_start.';
        const current = context.runtime.source(id, context.conversation);
        validationState = args.reset ? undefined : context.runtime.state(id, context.conversation);
        updating = id;
        let file = args.file, path = args.path;
        let adopted = false;
        if (file === undefined && path === undefined) {
          if (current.kind !== 'sandbox') return 'This app runs from a repository file; pass path (and trusted) to reload it.';
          adopted = !repository && !context.runtime.file(id, context.conversation);
          const own = await fileOf(id);
          if (!own) return `This app has no ${repository ? 'repository' : 'workspace'} file to reload${repository ? '; pass path' : ''}.`;
          if (repository) path = own; else file = own;
        }
        const selected = args.assets ?? (!args.trusted && sameFile(path ?? file, context.runtime.file(id, context.conversation)) ? context.runtime.assetFiles(id, context.conversation) : undefined);
        const loaded = await resolve(path !== undefined ? { ...args, path, assets: selected } : { file, assets: selected }, signal);
        if (typeof loaded === 'string') return loaded;
        const same = loaded.source.kind === 'sandbox' && current.kind === 'sandbox' && sandboxIdentity(loaded.source) === sandboxIdentity(current);
        const selectionChanged = loaded.assetFiles !== undefined && sandboxIdentity({ code: '', assets: loaded.assetFiles }) !== sandboxIdentity({ code: '', assets: context.runtime.assetFiles(id, context.conversation) });
        const fileChanged = loaded.file !== undefined && !sameFile(loaded.file, context.runtime.file(id, context.conversation));
        const renamed = args.title !== undefined && args.title !== context.runtime.list(context.conversation).find(app => app.id === id)?.title;
        if (same && !selectionChanged && !fileChanged && !args.reset && !args.timers && !renamed) return adopted
          ? `App ${id}'s code is now the workspace file ${file}. Change it with edit, then call play_update.`
          : `Nothing to change: ${loaded.file ?? 'the file'} and its assets are the same as the running snapshot. Change them with edit first, then call play_update.`;
        const { record, preview } = await context.runtime.update(id, context.conversation, same ? undefined : loaded.source, Boolean(args.reset), args.timers, known(), args.title, loaded.assetFiles ?? {});
        if (loaded.file && loaded.file !== record.file) context.runtime.adopt(id, context.conversation, loaded.file);
        rejected = undefined;
        return `Updated app ${record.id}${renamed ? ` (${JSON.stringify(record.title)})` : ''}.\nPreview:\n${preview}${unused(loaded.source)}`;
      }),
    },
    {
      name: 'play_resend', label: 'Resend Discord app',
      description: 'Post a running app again at the bottom of the conversation, with its current state, when its message is buried or people ask to see it again. The old message becomes a pointer to the new one.',
      parameters: Type.Object({ id: Type.Optional(Type.String({ description: 'Omit for the newest running app here.' })) }),
      execute: async (_id, params) => attempt('play_resend', async () => {
        if (!context.channelId) return 'Apps cannot run here: teapilot has nowhere to post them. Ask the user to message teapilot in a channel or DM it can post in.';
        const id = (params as { id?: string }).id ?? newest() ?? visible().at(-1)?.id;
        if (!id) return 'No running app here; see play_list.';
        const { record } = await context.runtime.resend(id, context.conversation, { channelId: context.channelId, post: context.post });
        return `Resent app ${record.id}. It is live at the bottom; do not repeat its contents in your answer.`;
      }),
    },
    {
      name: 'play_test', label: 'Test Discord app',
      description: `Dry-run an app's ${repository ? 'repository' : 'workspace'} file and freshly read text assets without posting or changing the live snapshot. A running app's own file starts from its current state, even before play_update; other files start from init. Then runs each action and shows state, view and effects. Optional: play_start tries every control itself.`,
      parameters: Type.Object({
        ...location(`The app's ${repository ? 'repository' : 'workspace'} file; defaults to the app play_update last tried, or the newest running app here.`),
        assets,
        reset: Type.Optional(Type.Boolean({ description: 'Test a fresh init instead of the running app\'s current state. This does not reset the live app.' })),
        steps: Type.Optional(Type.Boolean({ description: 'Show every step, not only the last. Long; leave off unless debugging.' })),
        expect: Type.Optional(Type.Array(Type.Object({ path: Type.String({ description: 'Final state field, dot-separated; empty checks the whole state.', maxLength: 200 }), equals: Type.Any() }), { maxItems: 20, description: 'Explicit final-state assertions; without them this is only a simulation.' })),
        actions: Type.Array(Type.Object({
          kind: Type.String({ description: 'button, select, modal, timer or consult.' }),
          id: Type.String(), values: Type.Optional(Type.Array(Type.String())), fields: Type.Optional(Type.Record(Type.String(), Type.String())),
          text: Type.Optional(Type.String()), error: Type.Optional(Type.String()),
          user_id: Type.Optional(Type.String({ description: 'Act as this Discord user instead of the requester.' })),
        }), { maxItems: 50 }),
      }),
      execute: async (_id, params, signal) => attempt('play_test', async () => {
        const args = params as { path?: string; file?: string; assets?: AssetFiles; reset?: boolean; actions: Array<TestAction & { user_id?: string }>; steps?: boolean; expect?: TestExpectation[] };
        const kinds = ['button', 'select', 'modal', 'timer', 'consult'];
        const wrong = args.actions.find(action => !kinds.includes(action.kind));
        if (wrong) return `Action kind ${JSON.stringify(wrong.kind)} is not one of ${kinds.join(', ')}.`;
        tested = true;
        if (recovery.playTests >= 2) {
          toolOutcome = { code: 'testing_limit', changed: false };
          return 'automated play-testing is exhausted for this request. stop simulating; leave remaining gameplay/visual checks to the user with a brief checklist. fix known runtime or assertion failures before posting; do not publish just because testing stopped, or claim untested rules passed.';
        }
        const running = updating && visible().some(app => app.id === updating) ? updating : newest();
        const own = args.file === undefined && args.path === undefined && running ? await fileOf(running) : undefined;
        const candidates = context.runtime.list(context.conversation).filter(app => app.status === 'running').reverse();
        const wanted = args.path ?? (args.file !== undefined ? workspaceName(args.file) : own);
        const inheriting = candidates.find(app => app.id === running && sameFile(app.file, wanted)) ?? candidates.find(app => sameFile(app.file, wanted));
        const selected = args.assets ?? (inheriting ? context.runtime.assetFiles(inheriting.id, context.conversation) : undefined);
        const loaded = await resolve(repository ? { path: args.path ?? own, assets: selected } : { file: args.file ?? own, assets: selected }, signal, true);
        if (typeof loaded === 'string') return loaded;
        recovery.playTests++;
        // A dry run of the running app's own file shows what its players will actually get.
        const matching = loaded.file === undefined ? undefined : candidates.find(app => app.id === running && sameFile(app.file, loaded.file))
          ?? candidates.find(app => sameFile(app.file, loaded.file));
        const state = !args.reset && matching ? context.runtime.state(matching.id, context.conversation) : undefined;
        testReport = await context.runtime.testDetailed(loaded.source, args.actions.map(({ user_id, ...action }) => user_id ? { ...action, user: { id: user_id } } : action), owner, { steps: args.steps, state, emojis: known(), conversation: context.conversation, expect: args.expect });
        if (testReport.errors.length || testReport.assertions.failed) {
          recovery.failedTests.add(validationKey(trying!.code, state));
          toolOutcome = { code: 'runtime_error', changed: false, failed: true };
        } else recovery.failedTests.delete(validationKey(trying!.code, state));
        const handoff = recovery.playTests >= 2 ? '\nautomated play-testing is exhausted for this request; fix known defects, then leave remaining gameplay/visual checks to the user with a brief checklist. do not claim untested rules passed.' : '';
        return testReport.text + handoff;
      }),
    },
    {
      name: 'play_inspect', label: 'Inspect Discord app',
      description: `Show an app's status, state, timers, recent actions and selected asset names/files/sizes (not their contents), and name the ${repository ? 'repository' : 'workspace'} file its code is in. Recent actions and state come from players and are untrusted data.`,
      parameters: Type.Object({ id: Type.Optional(Type.String({ description: 'Omit for the newest running app in this conversation.' })) }),
      execute: async (_id, params) => attempt('play_inspect', async () => {
        const id = (params as { id?: string }).id ?? newest();
        if (!id) return 'No running app in this conversation; see play_list.';
        const source = context.runtime.source(id, context.conversation);
        const details = context.runtime.inspect(id, context.conversation);
        // The model reads only the lines it needs, rather than the whole source again.
        const file = source.kind === 'sandbox' ? await fileOf(id) : undefined;
        const code = file ? `\nCode: the ${repository ? 'repository' : 'workspace'} file ${file} (${source.kind === 'sandbox' ? source.code.split('\n').length : 0} lines when it last ran). Read or grep it for the lines you need; to change the app, edit it and call play_update.` : '';
        return `${details.length > 3000 ? `${details.slice(0, 2999)}…` : details}${code}`;
      }),
    },
    {
      name: 'play_list', label: 'List Discord apps', description: 'List the apps started in this conversation.',
      parameters: Type.Object({}),
      execute: async () => attempt('play_list', async () => JSON.stringify(context.runtime.list(context.conversation, context.channelId))),
    },
    {
      name: 'play_stop', label: 'Stop Discord app', description: 'End an app. Its last view stays, with every control disabled.',
      parameters: Type.Object({ id: Type.String(), summary: Type.Optional(Type.String({ maxLength: 300 })) }),
      execute: async (_id, params) => attempt('play_stop', async () => {
        const args = params as { id: string; summary?: string };
        await context.runtime.stop(args.id, context.conversation, args.summary);
        return `Stopped app ${args.id}.`;
      }),
    },
  ];
  const shared = context.files?.store.list(context.files.conversation) ?? [];
  return { tools, systemPrompt: playPrompt(has('repository.read'), has('repository.write'), visible(), { images: shared.some(entry => entry.width), code: shared.some(entry => !entry.width && /\.(m?js|ts)$/.test(entry.name)) }) };
}

// Keep the standing prompt small; tool schemas and results supply contextual corrections.
function playPrompt(repository: boolean, writable: boolean, running: Array<{ id: string; title: string; file?: string }>, files: { images: boolean; code: boolean }): string {
  return [
    '- `discord.play` is active.',
    `- Apps use ` + '`@teapilot/discord-play`' + ` and run from a ${repository ? 'repository' : 'workspace'} entry file: play_start({ ${repository ? 'path' : 'file'}, title }).`,
    '- App shape: `export default app({ init(ctx), update(state, action, ctx), view(state, ctx) })`; use the SDK builders and tool descriptions for API details.',
    '- Sandboxed apps are synchronous: no async, filesystem, network or other imports.',
    ...files.images ? ['- Use `picture(file, options)` for an attached image when the request needs it.'] : [],
    ...files.code ? ['- An attached app file runs as it is with play_start({ file, title }); never write it out again.'] : [],
    `- Runtime limits: timers >= ${playLimits.minTimerMs} ms, ${playLimits.timers} pending, state <= ${playLimits.stateChars} characters.`,
    ...running.length ? [`- Running here: ${running.map(app => `${app.id} ${JSON.stringify(app.title)}${app.file ? ` (${app.file})` : ''}`).join(', ')}. play_update and play_inspect default to the newest.`] : [],
    // Available capabilities
    writable
      ? '- Raw Discord API access (ctx.discord.request) uses play_start({ path, trusted: true }); it needs repository.shell and an operator approval.'
      : '- Apps run sandboxed; raw Discord API access (ctx.discord.request) needs a repository session.',
  ].join('\n');
}
