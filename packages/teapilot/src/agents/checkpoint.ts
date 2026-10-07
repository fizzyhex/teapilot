import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import type { ConversationTurn } from '../integration/events.js';
import { replaceFileSync } from '../replace.js';
import type { JuniorType } from './delegate.js';

/**
 * Checkpoints: a long request hands off to a fresh orchestrator before its limits end the work. The host owns the
 * facts (tasks, commits, failures, operations whose outcome is unknown); the agent adds a short, advisory handoff.
 * Each generation is one JSON file, so the facts and the handoff it carries are always written together.
 */

export const taskStates = ['open', 'running', 'awaiting_verification', 'verified', 'blocked', 'cancelled'] as const;
export type TaskState = typeof taskStates[number];
/** The host enforces these; `taskwrite` can only reach verified, blocked and cancelled. */
const transitions: Record<TaskState, readonly TaskState[]> = {
  open: ['running', 'blocked', 'cancelled'],
  running: ['awaiting_verification', 'blocked', 'cancelled'],
  awaiting_verification: ['verified', 'blocked', 'cancelled', 'running'],
  // A junior can report itself stuck on work that its orchestrator then checks and finds complete.
  blocked: ['running', 'verified', 'cancelled'],
  verified: [], cancelled: [],
};
export const terminalState = (state: TaskState) => !transitions[state].length;

export interface WorkTask {
  id: string; label: string; junior?: string; state: TaskState; note?: string;
  /** The junior's last result: `consumed` once an orchestrator has been shown it. */
  result?: { status: 'done' | 'needs_input' | 'stuck' | 'interrupted'; file?: string; consumed: boolean };
}
export interface SavedJunior { name: string; description?: string; agent_type?: JuniorType; assignment?: string; artifacts?: string[]; turns: ConversationTurn[]; scratch: string; turn: number }
interface Operation { tool: string; call: string; error?: string }
/** Limits that came due, then failures that would otherwise have ended the request (always forced by the host). */
export type HandoffReason = 'tool_calls' | 'junior_calls' | 'time' | 'context' | 'model_calls' | 'cancelled' | 'context_limit' | 'ineffective_calls' | 'search_unavailable' | 'missing_tool_call';

export interface HostState {
  reason: HandoffReason; forced: boolean; attempts: number;
  /** `commits` are those since the previous checkpoint (or the workflow's start): `base`, shortened. `headSha` is where the next one counts from. */
  git?: { root: string; branch?: string; head?: string; headSha?: string; base?: string; commits: string[]; dirty: string[]; dirtyCount: number };
  tasks: WorkTask[];
  failures: Operation[];
  /** Started, but whether they took effect was never confirmed: never retried automatically. */
  unknown: Operation[];
  last?: { tool: string; ok: boolean; call: string };
  scratchpad?: { folder: string; recent: string[] };
  skills: string[];
}
export interface CheckpointRecord {
  version: 1; id: string; generation: number; at: number; requestId: string;
  /** Its file's number in the conversation's scratchpad: unlike `generation`, it never starts over with a request. */
  sequence: number;
  status: 'continued' | 'parked' | 'resumed';
  host: HostState;
  /** The agent's own words: guidance, never a source of truth. Absent on a forced checkpoint. */
  handoff?: { status: string; next: string };
  steer?: string;
  juniors: SavedJunior[];
}
export type CheckpointDecision = { action: 'continue' } | { action: 'steer'; text: string } | { action: 'stop' };

const run = promisify(execFile);
/**
 * Read-only queries. A workspace repository belongs to the sandbox's user, so it is trusted for these alone, with the
 * settings that let a repository's own config run programs during status or log turned off.
 */
const git = async (root: string, ...args: string[]) => (await run('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false', '-c', 'core.quotepath=off', ...args], { cwd: root, timeout: 4000, windowsHide: true })).stdout.trim();
/** Tools that only look or keep books: neither unknown outcomes nor side effects. */
const inspection = new Set(['read', 'ls', 'find', 'grep', 'web_search', 'web_read', 'skill', 'artifact_read', 'task_state', 'taskwrite', 'checkpoint', 'request_escalation', 'request_capabilities']);
/** What still runs once a checkpoint is urgent: looking, bookkeeping and the checkpoint itself. */
export const checkpointInspection = (name: string) => inspection.has(name) && !['web_search', 'web_read', 'request_escalation', 'request_capabilities'].includes(name);
const uncertain = /abort|timed? ?out|ETIMEDOUT|ECONNRESET|socket hang up|attempt stopped/i;
const clip = (text: string, limit: number) => { const value = text.trim(); return value.length > limit ? `${value.slice(0, limit - 1)}…` : value; };
const shortCall = (tool: string, args: unknown) => {
  const value = args as { command?: unknown; path?: unknown; label?: unknown; description?: unknown; id?: unknown };
  const detail = [value.command, value.path, value.label, value.description, value.id].find(item => typeof item === 'string') as string | undefined;
  return detail ? `${tool} ${JSON.stringify(detail.length > 120 ? `${detail.slice(0, 119)}…` : detail)}` : tool;
};

/** One request's host-owned workflow state, shared by every generation of its orchestrator. */
export class Workflow {
  readonly tasks = new Map<string, WorkTask>();
  readonly juniors = new Map<string, SavedJunior>();
  readonly skills = new Set<string>();
  private pending = new Map<string, Operation>();
  private failures: Operation[] = [];
  private unknown: Operation[] = [];
  private last?: HostState['last'];
  private base?: string;
  root?: string;
  generation = 0;
  /** Told of every task change, for progress displays. */
  onTask?: (task: WorkTask) => void;
  /** A checkpoint parked by an earlier request, offered to this one's first orchestrator. */
  parked?: CheckpointRecord;

  private first = 0;
  private sequence = 0;
  /** `limit` counts this request's checkpoints, not those of the parked request it may pick up. */
  constructor(readonly requestId: string, readonly limit: number, readonly scratch?: string) {}

  /** Restores a parked checkpoint's tasks and juniors when the conversation's scratchpad holds one. */
  static open(requestId: string, limit: number, scratch?: string): Workflow {
    const flow = new Workflow(requestId, limit, scratch);
    const parked = scratch ? latest(scratch) : undefined;
    flow.sequence = parked?.sequence ?? 0;
    if (parked?.status === 'parked') {
      flow.parked = parked;
      flow.generation = flow.first = parked.generation;
      flow.base = parked.host.git?.headSha ?? parked.host.git?.base;
      for (const task of parked.host.tasks) flow.tasks.set(task.id, { ...task, ...(task.result ? { result: { ...task.result, consumed: false } } : {}) });
      for (const junior of parked.juniors) flow.juniors.set(junior.name, junior);
      for (const skill of parked.host.skills) flow.skills.add(skill);
      flow.unknown = [...parked.host.unknown];
    }
    return flow;
  }
  get canCheckpoint(): boolean { return this.generation - this.first < this.limit; }

  /** Where commits are counted from: the repository the orchestrator works in, at its first use in this workflow. */
  async useRoot(root: string | undefined): Promise<void> {
    if (!root || this.root) return;
    this.root = root;
    try { this.base ??= await git(root, 'rev-parse', 'HEAD'); } catch { /* not a repository, or git is missing */ }
  }

  openTask(label: string, junior: string): WorkTask {
    const task: WorkTask = { id: `t${this.tasks.size + 1}`, label: label.trim().slice(0, 80), junior, state: 'open' };
    this.tasks.set(task.id, task);
    this.onTask?.(task);
    return task;
  }
  /** The task a junior is working through, if it is still open to more work. */
  taskOf(junior: string): WorkTask | undefined { return [...this.tasks.values()].findLast(task => task.junior === junior && !terminalState(task.state)); }
  move(id: string, state: TaskState, note?: string): WorkTask {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`no task ${id}. tasks: ${[...this.tasks.keys()].join(', ') || 'none'}`);
    if (task.state === state) {
      if (note !== undefined) { task.note = note.trim().slice(0, 200) || undefined; this.onTask?.(task); }
      return task;
    }
    if (!transitions[task.state].includes(state)) throw new Error(`task ${id} is ${task.state}; it can become ${transitions[task.state].join(', ') || 'nothing (final)'}`);
    task.state = state;
    if (note !== undefined) task.note = note.trim().slice(0, 200) || undefined;
    this.onTask?.(task);
    return task;
  }

  /** Side-effecting calls are tracked from start to result, so one cut off midway stays explicitly unknown. */
  begin(id: string, tool: string, args: unknown): void { if (!inspection.has(tool)) this.pending.set(id, { tool, call: shortCall(tool, args) }); }
  settle(id: string, tool: string, args: unknown, failed: boolean, text: string): void {
    const started = this.pending.get(id); this.pending.delete(id);
    const call = started?.call ?? shortCall(tool, args);
    if (tool !== 'checkpoint') this.last = { tool, ok: !failed, call };
    if (!failed) return;
    const error = text.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (started && uncertain.test(text)) this.unknown.push({ ...started, error });
    else this.failures = [...this.failures, { tool, call, error }].slice(-5);
  }
  skillLoaded(id: string): void { this.skills.add(id); }

  /** The host's own view now. Juniors still running when the orchestrator stopped are marked interrupted. */
  async state(reason: HandoffReason, forced: boolean, attempts: number): Promise<HostState> {
    for (const task of this.tasks.values()) if (task.state === 'running') {
      task.result = { status: 'interrupted', consumed: false };
      this.unknown.push({ tool: 'delegate_task', call: `delegate_task to ${task.junior ?? 'a junior'} (${task.id})`, error: 'interrupted mid-assignment; its changes may be partial' });
    }
    for (const operation of this.pending.values()) this.unknown.push({ ...operation, error: 'no result before the handoff' });
    this.pending.clear();
    return {
      reason, forced, attempts,
      ...(this.root ? { git: await this.git(this.root) } : {}),
      tasks: [...this.tasks.values()].map(task => ({ ...task, ...(task.result ? { result: { ...task.result } } : {}) })),
      failures: [...this.failures], unknown: this.unknown.slice(-6), ...(this.last ? { last: this.last } : {}),
      ...(this.scratch ? { scratchpad: { folder: this.scratch, recent: recentFiles(this.scratch) } } : {}),
      skills: [...this.skills],
    };
  }
  private async git(root: string): Promise<HostState['git'] | undefined> {
    try {
      const [branch, headSha, status] = await Promise.all([git(root, 'rev-parse', '--abbrev-ref', 'HEAD'), git(root, 'rev-parse', 'HEAD'), git(root, 'status', '--porcelain=v1')]);
      const head = headSha.slice(0, 7);
      const commits = this.base ? (await git(root, 'log', '--oneline', '-n', '8', `${this.base}..HEAD`)).split('\n').filter(Boolean) : [];
      // The scratchpad is teapilot's own working space, not the project's.
      const dirty = status.split('\n').filter(Boolean).map(line => line.trim()).filter(line => !/^\S+\s+"?\.scratch\//.test(line));
      return { root, branch, head, headSha, ...(this.base ? { base: this.base.slice(0, 7) } : {}), commits, dirty: dirty.slice(0, 8), dirtyCount: dirty.length };
    } catch { return undefined; }
  }

  /** Writes the next generation in one step: a checkpoint either exists whole, or not at all. */
  async checkpoint(input: { reason: HandoffReason; forced: boolean; attempts: number; handoff?: { status: string; next: string } }): Promise<CheckpointRecord> {
    const host = await this.state(input.reason, input.forced, input.attempts);
    const record: CheckpointRecord = {
      version: 1, id: randomUUID(), generation: this.generation + 1, sequence: this.sequence + 1, at: Date.now(), requestId: this.requestId, status: 'continued', host,
      ...(input.handoff ? { handoff: { status: clip(input.handoff.status, 400), next: clip(input.handoff.next, 800) } } : {}),
      juniors: [...this.juniors.values()].map(junior => ({ ...junior, turns: junior.turns.slice(-4).map(turn => ({ user: turn.user.slice(0, 2000), assistant: turn.assistant.slice(0, 4000), ...(turn.taskId ? { taskId: turn.taskId } : {}) })) })),
    };
    this.save(record);
    this.generation = record.generation; this.sequence = record.sequence;
    // Each checkpoint reports the commits made since the one before it.
    if (host.git?.headSha) this.base = host.git.headSha;
    // The next generation starts with what is new since this one.
    this.failures = []; this.unknown = [];
    for (const task of this.tasks.values()) if (task.result) task.result.consumed = false;
    return record;
  }
  save(record: CheckpointRecord): void {
    if (!this.scratch) return;
    const folder = join(this.scratch, 'checkpoints');
    mkdirSync(folder, { recursive: true });
    const temporary = join(folder, `.${record.id}.tmp`);
    try {
      const fd = openSync(temporary, 'wx', 0o600);
      try { writeFileSync(fd, JSON.stringify(record, null, 1)); fsyncSync(fd); } finally { closeSync(fd); }
      replaceFileSync(temporary, join(folder, fileName(record)));
    } finally { rmSync(temporary, { force: true }); }
  }
  path(record: CheckpointRecord): string | undefined { return this.scratch && join(this.scratch, 'checkpoints', fileName(record)); }
}

const fileName = (record: CheckpointRecord) => `${String(record.sequence).padStart(4, '0')}.json`;

/** A conversation's newest checkpoint, or none when its scratchpad has none or it cannot be read. */
export function latest(scratch: string): CheckpointRecord | undefined {
  try {
    const name = readdirSync(join(scratch, 'checkpoints')).filter(file => /^\d+\.json$/.test(file)).sort().at(-1);
    const record = name && JSON.parse(readFileSync(join(scratch, 'checkpoints', name), 'utf8')) as CheckpointRecord;
    return record && record.version === 1 ? record : undefined;
  } catch { return undefined; }
}

function recentFiles(folder: string): string[] {
  const files: Array<{ path: string; at: number }> = [];
  for (const sub of ['outputs', '']) {
    try {
      for (const name of readdirSync(join(folder, sub))) {
        if (name.startsWith('.') || name.endsWith('.tmp')) continue;
        const info = statSync(join(folder, sub, name));
        if (info.isFile()) files.push({ path: sub ? `${sub}/${name}` : name, at: info.mtimeMs });
      }
    } catch { /* no such folder */ }
  }
  return files.sort((a, b) => b.at - a.at).slice(0, 4).map(file => file.path);
}

const reasons: Record<HandoffReason, string> = {
  tool_calls: 'out of tool calls', junior_calls: 'junior allowance spent', time: 'out of time', context: 'context full', model_calls: 'out of model calls',
  cancelled: 'action not approved', context_limit: 'hit the context limit', ineffective_calls: 'calls weren’t making progress', search_unavailable: 'search unavailable', missing_tool_call: 'provider sent no usable tool call',
};
/** What the next agent is told about a failure handoff, in place of the bare error. */
const failureAdvice: Partial<Record<HandoffReason, string>> = {
  cancelled: 'the user didn\'t approve the action. stop now and check with them, or try a different approach.',
  context_limit: 'the previous agent hit the context limit. try orchestration with `delegate_task`, or a narrower approach.',
  ineffective_calls: 'the previous agent\'s tools were returning the same results repeatedly. consider alternate routes.',
  search_unavailable: 'web search is unavailable. stop now and tell the user, or continue offline if appropriate.',
  missing_tool_call: 'the last announced tool call did not run. inspect existing work and continue with a simpler approach; do not reconstruct or replay the missing call.',
};
const taskLine = (task: WorkTask) => `task ${task.id} "${task.label}"${task.junior ? ` (${task.junior})` : ''}: ${task.state.replaceAll('_', ' ')}${task.note ? ` - ${task.note}` : ''}${task.result && !terminalState(task.state) ? `; result ${task.result.status}${task.result.consumed ? '' : ', not yet read by you'}${task.result.file ? ` (${task.result.file})` : ''}` : ''}`;

/** Live bookkeeping survives compaction without carrying the juniors' transcripts or reports inline. */
export function workflowTasks(flow: Workflow): string | undefined {
  if (!flow.tasks.size) return undefined;
  return [...flow.tasks.values()].map(task => `- ${taskLine(task)}`).join('\n');
}

/** What the next orchestrator is told: small, with the host's facts first and the agent's words marked as such. */
/** `withdrawn` names tools the host has taken away since the handoff was written, which it may still suggest. */
export function continuation(record: CheckpointRecord, parked = false, withdrawn: string[] = []): string {
  const { host } = record;
  const lines = [`[checkpoint ${record.generation}] you are continuing an existing workflow${parked ? ' that was parked' : ''} (handoff: ${reasons[host.reason]}${host.forced ? ', forced by the host' : ''}). limits are renewed; scratchpad, juniors and tasks carry over.`, '', 'objective state (host-recorded):'];
  if (host.git) {
    lines.push(`- ${host.git.branch ?? 'repository'} at ${host.git.head ?? '?'}${host.git.commits.length ? `; ${host.git.commits.length} commit${host.git.commits.length === 1 ? '' : 's'} since ${host.git.base}: ${host.git.commits.slice(0, 4).join(' | ')}` : '; no new commits'}`);
    lines.push(`- working tree: ${host.git.dirtyCount ? `${host.git.dirty.join(', ')}${host.git.dirtyCount > host.git.dirty.length ? ` (+${host.git.dirtyCount - host.git.dirty.length} more)` : ''}` : 'clean'}`);
  }
  for (const task of host.tasks) lines.push(`- ${taskLine(task)}`);
  for (const operation of host.unknown) lines.push(`- outcome unknown: ${operation.call}${operation.error ? ` (${operation.error})` : ''}. check its effect before repeating it`);
  for (const failure of host.failures.slice(-3)) lines.push(`- failed: ${failure.call}: ${failure.error ?? 'error'}`);
  if (host.last) lines.push(`- last operation: ${host.last.call} ${host.last.ok ? 'succeeded' : 'failed'}`);
  if (host.scratchpad) lines.push(`- scratchpad: ${host.scratchpad.folder}${host.scratchpad.recent.length ? ` (newest: ${host.scratchpad.recent.join(', ')})` : ''}`);
  if (host.skills.length) lines.push(parked ? `- skills loaded before: ${host.skills.join(', ')} (load again if needed)` : `- skills carried over: ${host.skills.join(', ')}`);
  if (lines.at(-1) === 'objective state (host-recorded):') lines.push('- nothing recorded');
  lines.push('', record.handoff ? `previous agent's handoff (guidance, not fact):\n- status: ${record.handoff.status}\n- next: ${record.handoff.next}` : 'the previous agent left no handoff.');
  if (withdrawn.length) lines.push(`- withdrawn for this request: ${withdrawn.join(', ')}. skip any step that needs ${withdrawn.length === 1 ? 'it' : 'them'}.`);
  if (record.steer) lines.push('', `the user steered at this checkpoint: ${record.steer}`);
  lines.push('', 'treat host state as authoritative and the handoff as guidance. inspect before trusting either.');
  // After the line Details cuts at: it speaks to the agent, not the person.
  const advice = failureAdvice[host.reason];
  if (advice) lines.push(advice);
  return lines.join('\n');
}

/** What people see at a checkpoint: a few lines; the full record is behind Details or in the file. */
export function checkpointCard(record: CheckpointRecord): { title: string; lines: string[] } {
  const { host } = record;
  const counts = new Map<string, number>();
  for (const task of host.tasks) counts.set(task.state, (counts.get(task.state) ?? 0) + 1);
  const lines: string[] = [];
  if (host.tasks.length) lines.push(`juniors: ${[...counts].map(([state, count]) => `${count} ${state.replaceAll('_', ' ')}`).join(' · ')}`);
  if (host.git) lines.push(`commits: ${host.git.commits.length ? `${host.git.commits.length} new` : 'none new'} (${host.git.head})${host.git.dirtyCount ? ` · ${host.git.dirtyCount} uncommitted` : ''}`);
  if (host.unknown.length) lines.push(`⚠ ${host.unknown.length} operation${host.unknown.length === 1 ? '' : 's'} with unknown outcome`);
  if (record.handoff) lines.push(`next: ${record.handoff.next.length > 160 ? `${record.handoff.next.slice(0, 159)}…` : record.handoff.next}`);
  else lines.push('no handoff from the agent; the host wrote this one');
  return { title: `checkpoint ${record.generation} · ${reasons[host.reason]}${host.forced ? ' (forced)' : ''}`, lines };
}

/** The checkpoint in full for Details: still compact, one line per fact. */
export function checkpointDetails(record: CheckpointRecord, file?: string): string {
  return `${continuation(record).split('\n').slice(2).join('\n').replace(/\ntreat host state[\s\S]*$/, '').trim()}${file ? `\n\nsaved: ${file}` : ''}`;
}

/** The orchestrator's checkpoint and task tools. Neither counts against the tool budget that makes checkpoints due. */
export function checkpointTool(submit: (handoff: { status: string; next: string }) => Promise<CheckpointRecord>): AgentTool {
  return {
    name: 'checkpoint', label: 'Checkpoint',
    description: 'Hand off to a fresh agent with renewed limits. The host records tasks, commits and failures itself; add a brief status and the next step.',
    parameters: Type.Object({
      // Lenient limits: a long handoff is cut short when saved rather than refused, which would spend an attempt.
      status: Type.String({ minLength: 1, maxLength: 2000, description: 'Where the work stands, in a sentence or two.' }),
      next: Type.String({ minLength: 1, maxLength: 2000, description: 'The next concrete step, with the files or checks it involves.' }),
    }),
    execute: async (_id, args) => {
      const { status, next } = args as { status?: unknown; next?: unknown };
      if (typeof status !== 'string' || !status.trim() || typeof next !== 'string' || !next.trim()) throw new Error('checkpoint needs a non-empty status and next step');
      const record = await submit({ status, next });
      return { content: [{ type: 'text', text: `checkpoint ${record.generation} saved. this agent ends here.` }], details: { checkpoint: record.generation }, terminate: true };
    },
  };
}

export function taskwriteTool(flow: Workflow): AgentTool {
  return {
    name: 'taskwrite', label: 'Update task',
    description: 'Settle a delegated task: verified once you have checked its result, blocked to park it, or cancelled. The host enforces valid transitions.',
    parameters: Type.Object({
      task: Type.String({ maxLength: 12, description: 'Task id from delegate_task, such as t1.' }),
      state: Type.Union([Type.Literal('verified'), Type.Literal('blocked'), Type.Literal('cancelled')]),
      note: Type.Optional(Type.String({ maxLength: 200, description: 'Why, briefly.' })),
    }),
    execute: async (_id, args) => {
      const { task, state, note } = args as { task: string; state: TaskState; note?: string };
      const moved = flow.move(String(task), state, note);
      return { content: [{ type: 'text', text: taskLine(moved) }], details: {} };
    },
  };
}
