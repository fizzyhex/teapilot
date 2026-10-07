import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { replaceFileSync } from '../replace.js';
import { clip } from './sandbox.js';
import { scratchLimits, type Kind, type Saved } from './scratch.js';
import type { RequestRecovery } from '../agents/recovery.js';
import { planReferenceSchema, type PlanReference } from './plan.js';
import { skillIdLimit } from './skills.js';
import { blockerSchema } from './blocker.js';

/** Bounds apply to stored working state as well as the view: history belongs in session transcripts. */
export const taskLimits = { steps: 8, claims: 16, artifacts: 128, receipts: 64, projectionChars: 6000, retrievalChars: scratchLimits.retrievalChars, stateBytes: 512 * 1024 };
const id = z.string().regex(/^[\w-]{1,80}$/);
const refs = z.array(id).max(4);
export const stepSchema = z.object({ id, goal: z.string().min(1).max(240), status: z.enum(['ready', 'working', 'blocked', 'done']), acceptance: z.string().max(240).default(''), evidence: refs.default([]), blocker: blockerSchema.optional() }).strict();
export const claimSchema = z.object({ id, text: z.string().min(1).max(400), basis: z.enum(['observed', 'inferred', 'reported']), evidence: refs.min(1) }).strict();
const sourceSchema = z.object({ path: z.string().max(2048).optional(), url: z.string().max(2048).optional(), query: z.string().max(200).optional(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().positive().optional(), skill: z.object({ id: z.string().min(1).max(skillIdLimit), file: z.string().min(1).max(240), set: z.string().max(skillIdLimit).optional(), revision: z.string().regex(/^[\da-f]{40}$/).optional() }).strict().optional() }).strict();
const artifactSchema = z.object({ id, sha256: z.string().regex(/^[a-f0-9]{64}$/), path: z.string().max(2048), bytes: z.number().int().nonnegative().max(8 * 1024 * 1024), lines: z.number().int().nonnegative(), complete: z.boolean(), kind: z.enum(['logs', 'pages', 'outputs']), actor: id, producer: id, producerTool: z.string().max(80).optional(), request: z.string().max(100).optional(), origin: z.enum(['file', 'inventory', 'saved-output', 'transcript']).optional(), source: sourceSchema.optional(), sourceEpoch: z.number().int().nonnegative().optional(), at: z.number() }).strict();
const receiptSchema = z.object({ id, request: z.string().max(100), actor: id, tool: z.string().max(80), call: z.string().max(2000).optional(), argsSha256: z.string(), summary: z.string().max(240), excerpt: z.string().max(400), origin: z.enum(['file', 'inventory', 'saved-output', 'transcript']).optional(), source: sourceSchema.optional(), sourceEpoch: z.number().int().nonnegative().optional(), stale: z.boolean().optional(), uncertainSource: z.boolean().optional(), status: z.enum(['pending', 'succeeded', 'failed', 'uncertain']), artifacts: z.array(id).max(8), at: z.number() }).strict();
const toolBudgetSchema = z.object({ instructorCalls: z.number().int().nonnegative(), instructorGranted: z.number().int().nonnegative(), continuationBatches: z.number().int().nonnegative(), instructorBatchCalls: z.number().int().nonnegative(), juniorMaxCalls: z.number().int().positive(), maxContinuationBatches: z.number().int().nonnegative() }).strict();
type RequestLimits = { calls: number; modelCalls: number; timeoutMs: number; delegations?: number; readOnly?: boolean; instructorCalls?: number; juniorCalls?: number; juniorPool?: number; maxContinuationBatches?: number };
const requestSchema = z.object({ id: z.string().max(100), calls: z.number().int().nonnegative(), modelCalls: z.number().int().nonnegative(), maxCalls: z.number().int().nonnegative(), maxModelCalls: z.number().int().nonnegative(), deadline: z.number(), status: z.string().max(80), delegations: z.number().int().nonnegative(), maxDelegations: z.number().int().nonnegative(), readOnly: z.boolean().optional(), continuationDenied: z.boolean().default(false), juniorCalls: z.record(id, z.number().int().nonnegative()).default({}), juniorPoolCalls: z.number().int().nonnegative().default(0), maxJuniorPoolCalls: z.number().int().nonnegative().optional(), toolBudget: toolBudgetSchema.optional() }).strict();
const juniorSchema = z.object({ name: id, type: z.enum(['research', 'plan', 'implement', 'review']).optional(), agent_type: z.enum(['research', 'write', 'test']).optional(), description: z.string().max(500).optional(), assignment: z.string().max(24_000).optional(), artifacts: z.array(z.string().min(1).max(2048)).max(16).optional(), scratch: z.string().max(2048), turn: z.number().int().nonnegative(), turns: z.array(z.object({ user: z.string().max(24_000), assistant: z.string().max(4000) })).max(6) }).strict();
const stateSchema = z.object({
  version: z.literal(1), id, scope: z.string().max(4096), scratch: z.string().max(2048), revision: z.number().int().nonnegative(), objective: z.string().max(24_000),
  constraints: z.array(z.string().min(1).max(400)).max(8).refine(values => JSON.stringify(values).length <= 2400, 'constraints exceed the pinned context allowance'),
  currentRequest: z.string().max(24_000).optional(),
  status: z.enum(['active', 'waiting', 'blocked', 'completed', 'cancelled']),
  steps: z.array(stepSchema.extend({ actor: id, request: z.string().max(100).optional() })).max(taskLimits.steps),
  claims: z.array(claimSchema.extend({ actor: id, request: z.string().max(100).optional() })).max(taskLimits.claims),
  artifacts: z.array(artifactSchema).max(taskLimits.artifacts), receipts: z.array(receiptSchema).max(taskLimits.receipts), request: requestSchema.optional(), juniors: z.array(juniorSchema).max(30),
  juniorNames: z.array(id).max(128).default([]),
  plan: planReferenceSchema.optional(),
  fileFailures: z.array(z.tuple([z.string().regex(/^[a-f0-9]{64}$/), z.string().max(1000)])).max(64),
  execution: z.record(id, z.object({ changedFiles: z.array(z.string().max(512)).max(16), unresolvedChecks: z.array(z.string().max(240)).max(32), currentCheck: z.enum(['passed', 'failed', 'not-run-after-edit']), shellUncertain: z.boolean(), overflow: z.object({ changedFiles: z.number().int().nonnegative(), unresolvedChecks: z.number().int().nonnegative() }) }).strict()).default({}),
  sourceEpoch: z.number().int().nonnegative().default(0), checks: z.array(z.object({ command: z.string().max(500), commandHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), status: z.enum(['passed', 'failed']), actor: id, epoch: z.number().int().nonnegative() }).strict()).max(128).default([]),
}).strict();
export type TaskState = z.infer<typeof stateSchema>;
export interface TaskActor { name: string; objective?: string; artifacts?: string[] }
export const instructor: TaskActor = { name: 'instructor' };
export interface TaskUpdate { revision: number; step?: z.input<typeof stepSchema>; claim?: z.input<typeof claimSchema>; remove_step?: string; remove_claim?: string }
export interface EvidenceFilters { query?: string; tool?: string; request?: string }
export interface EvidenceSource { path?: string; url?: string; query?: string; offset?: number; limit?: number; skill?: { id: string; file: string; set?: string; revision?: string } }
export interface ExecutionState { changedFiles: string[]; unresolvedChecks: string[]; currentCheck: 'passed' | 'failed' | 'not-run-after-edit'; shellUncertain: boolean }
const brief = (text: string, limit: number): string => {
  let allowance = limit, result = clip(text, allowance);
  while (JSON.stringify(result).length > limit + 2 && allowance > 0) {
    allowance = Math.floor(allowance / 2);
    result = clip(text, allowance);
  }
  return result;
};
const taskIdFor = (scope: string): string => `t-${createHash('sha256').update(scope).digest('hex').slice(0, 24)}`;
function boundedJson(value: unknown, limit: number): string {
  const candidate = structuredClone(value) as any;
  for (;;) {
    const text = JSON.stringify(candidate);
    if (text.length <= limit) return text;
    let target: { parent: any; key: string | number; value: string } | undefined;
    const visit = (node: any) => {
      if (typeof node === 'string') return;
      if (!node || typeof node !== 'object') return;
      for (const key of Object.keys(node)) {
        const child = node[key];
        if (typeof child === 'string') {
          if (!target || child.length > target.value.length) target = { parent: node, key, value: child };
        } else visit(child);
      }
    };
    visit(candidate);
    if (!target || !target.value.length) {
      const idValue = typeof candidate?.id === 'string' ? candidate.id : undefined;
      const fallback = JSON.stringify({ ...(idValue ? { id: idValue } : {}), truncated: true });
      return fallback.length <= limit ? fallback : '{"truncated":true}';
    }
    target.parent[target.key] = clip(target.value, Math.floor(target.value.length / 2));
  }
}
function safeAncestors(path: string): boolean {
  let current = resolve(path);
  for (;;) {
    try { if (lstatSync(current).isSymbolicLink()) return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false; }
    const parent = dirname(current);
    if (parent === current) return true;
    current = parent;
  }
}

/** Host-owned, atomic snapshots. runHost's state lock serializes writers; models only submit bounded deltas. */
export class TaskStore {
  private constructor(private readonly file: string, private state: TaskState, readonly scratch: string, private readonly redact: (text: string) => string, private readonly archive: string) {}

  static open(stateDir: string, scope: string, objective: string, scratch: string, redact = (text: string) => text, constraints: string[] = []): TaskStore {
    const key = createHash('sha256').update(scope).digest('hex');
    const directory = join(stateDir, 'tasks');
    mkdirSync(directory, { recursive: true });
    if (lstatSync(directory).isSymbolicLink()) throw new Error('task state directory is linked');
    const file = join(directory, `${key}.json`);
    let state: TaskState;
    if (existsSync(file)) {
      const info = lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > taskLimits.stateBytes) throw new Error('unsafe task state file');
      state = stateSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
      if (state.scope !== scope) throw new Error('task scope mismatch');
      if (state.scratch !== resolve(scratch)) throw new Error('task scratch scope changed');
    } else state = stateSchema.parse({ version: 1, id: taskIdFor(scope), scope, scratch: resolve(scratch), revision: 0, objective: redact(objective), constraints: constraints.map(redact), status: 'active', steps: [], claims: [], artifacts: [], receipts: [], juniors: [], juniorNames: [], fileFailures: [], execution: {} });
    if (state.id !== taskIdFor(scope)) throw new Error('task ID does not match its scope');
    const archive = join(stateDir, 'task-records', state.id);
    const store = new TaskStore(file, state, resolve(scratch), redact, archive);
    // Never infer whether a call with a missing result executed. Do not replay it automatically.
    if (state.receipts.some(receipt => receipt.status === 'pending')) store.change(next => {
      for (const receipt of next.receipts) if (receipt.status === 'pending') receipt.status = 'uncertain';
      next.status = 'blocked';
    });
    else if (!existsSync(file) || !('execution' in state)) store.change(() => undefined);
    return store;
  }

  snapshot(): TaskState { return structuredClone(this.state); }
  setPlan(plan: PlanReference): void {
    if (JSON.stringify(this.state.plan) !== JSON.stringify(plan)) this.change(next => { next.plan = plan; }, true);
  }
  /** Explicit user amendments come through the host, never through task_state. */
  configure(update: { objective?: string; constraints?: string[]; currentRequest?: string }): void {
    this.change(next => {
      if (update.objective !== undefined) next.objective = this.redact(update.objective);
      if (update.constraints !== undefined) next.constraints = update.constraints.map(value => this.redact(value));
      if (update.currentRequest !== undefined) next.currentRequest = this.redact(update.currentRequest);
    }, update.objective !== undefined || update.constraints !== undefined);
  }
  /** A cleared conversation must not resurrect its state or references on restart. */
  static clearScratch(stateDir: string, scratch: string): void {
    const directory = join(stateDir, 'tasks');
    if (!safeAncestors(directory) || !existsSync(directory) || !lstatSync(directory).isDirectory()) return;
    for (const name of readdirSync(directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const file = join(directory, name), info = lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > taskLimits.stateBytes) continue;
      try {
        const state = stateSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
        const scopeKey = createHash('sha256').update(state.scope).digest('hex');
        if (name !== `${scopeKey}.json` || state.id !== taskIdFor(state.scope)) continue;
        if (state.scratch === resolve(scratch)) {
          const archiveRoot = join(stateDir, 'task-records'), archive = join(archiveRoot, state.id);
          if (!safeAncestors(archiveRoot) || !safeAncestors(archive)) continue;
          if (existsSync(archiveRoot) && existsSync(archive)) {
            if (!lstatSync(archiveRoot).isDirectory() || !lstatSync(archive).isDirectory()) continue;
            rmSync(archive, { recursive: true, force: true });
          }
          rmSync(file);
        }
      } catch { /* Corrupt or foreign records are not cleanup targets. */ }
    }
  }
  restoreRecovery(recovery: RequestRecovery): void { for (const [key, value] of this.state.fileFailures) recovery.fileFailures.set(key, value); }
  saveRecovery(recovery: RequestRecovery): void {
    const failures = [...recovery.fileFailures].slice(-64).map(([key, value]): [string, string] => [key, this.redact(value).slice(0, 1000)]);
    if (JSON.stringify(failures) !== JSON.stringify(this.state.fileFailures)) this.change(next => { next.fileFailures = failures; });
  }
  private change(update: (next: TaskState) => void, working = false): void {
    const next = structuredClone(this.state);
    update(next); if (working) next.revision++;
    const valid = stateSchema.parse(next);
    const text = JSON.stringify(valid);
    if (Buffer.byteLength(text) > taskLimits.stateBytes) throw new Error('task state exceeds storage limit');
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    try { replaceFileSync(temporary, this.file); } finally { rmSync(temporary, { force: true }); }
    this.state = valid;
  }
  private assertArchivePath(): void {
    const stateDir = dirname(dirname(this.file));
    const scopeHash = createHash('sha256').update(this.state.scope).digest('hex');
    if (this.state.id !== taskIdFor(this.state.scope) || resolve(this.file) !== resolve(join(stateDir, 'tasks', `${scopeHash}.json`)) || resolve(this.archive) !== resolve(join(stateDir, 'task-records', this.state.id))) throw new Error('invalid task archive identity');
    if (!safeAncestors(this.archive)) throw new Error('linked task archive path');
  }
  private archiveRecord(kind: 'receipts' | 'artifacts', value: unknown): void {
    const parsed = (kind === 'receipts' ? receiptSchema : artifactSchema).parse(value);
    const root = dirname(this.archive);
    this.assertArchivePath();
    mkdirSync(root, { recursive: true });
    mkdirSync(this.archive, { recursive: true });
    this.assertArchivePath();
    if (!lstatSync(this.archive).isDirectory()) throw new Error('task archive path is not a directory');
    const file = join(this.archive, `${kind}-${parsed.id}.json`);
    if (existsSync(file)) {
      const info = lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 32_768) throw new Error('unsafe task archive record');
      const existing = (kind === 'receipts' ? receiptSchema : artifactSchema).parse(JSON.parse(readFileSync(file, 'utf8')));
      if (existing.id !== parsed.id) throw new Error('task archive filename identity mismatch');
    }
    const text = JSON.stringify(parsed);
    if (Buffer.byteLength(text) > 32_768) throw new Error('task archive record exceeds storage limit');
    const temporary = `${file}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    try { replaceFileSync(temporary, file); } finally { rmSync(temporary, { force: true }); }
  }
  private cold<T>(kind: 'receipts' | 'artifacts', key: string, schema: z.ZodType<T>): T | undefined {
    if (!id.safeParse(key).success) return undefined;
    this.assertArchivePath();
    if (!existsSync(this.archive)) return undefined;
    if (!lstatSync(this.archive).isDirectory()) throw new Error('task archive path is not a directory');
    const file = join(this.archive, `${kind}-${key}.json`);
    if (!existsSync(file)) return undefined;
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 32_768) throw new Error('unsafe task archive record');
    const parsed = schema.parse(JSON.parse(readFileSync(file, 'utf8')));
    if ((parsed as { id?: string }).id !== key) throw new Error('task archive record ID mismatch');
    return parsed;
  }
  private *coldRecords(kind: 'receipts' | 'artifacts'): Generator<TaskState['receipts'][number] | TaskState['artifacts'][number]> {
    this.assertArchivePath();
    if (!existsSync(this.archive)) return;
    if (!lstatSync(this.archive).isDirectory()) throw new Error('task archive path is not a directory');
    const prefix = `${kind}-`;
    for (const name of readdirSync(this.archive).sort()) {
      if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
      const key = name.slice(prefix.length, -5);
      if (!id.safeParse(key).success) throw new Error('invalid task archive filename');
      const record = kind === 'receipts' ? this.cold('receipts', key, receiptSchema) : this.cold('artifacts', key, artifactSchema);
      if (!record) throw new Error('missing task archive record');
      yield record;
    }
  }
  startRequest(request: string, limits: RequestLimits): void {
    if (this.state.request?.id === request) return;
    this.renewRequest(request, limits);
  }
  /** A fresh allowance for the same request, as a checkpoint's successor gets: counts and the deadline start over. */
  renewRequest(request: string, limits: RequestLimits): void {
    this.change(next => {
      next.status = 'active';
      next.request = { id: request, calls: 0, modelCalls: 0, maxCalls: limits.calls, maxModelCalls: limits.modelCalls, deadline: Date.now() + limits.timeoutMs, status: 'active', delegations: 0, maxDelegations: limits.delegations ?? 6, readOnly: limits.readOnly ?? false, continuationDenied: false, juniorCalls: {}, juniorPoolCalls: 0, ...(limits.juniorPool !== undefined ? { maxJuniorPoolCalls: limits.juniorPool } : {}), ...(limits.instructorCalls !== undefined && limits.juniorCalls !== undefined && limits.maxContinuationBatches !== undefined ? { toolBudget: { instructorCalls: 0, instructorGranted: Math.min(limits.calls, limits.instructorCalls), continuationBatches: 0, instructorBatchCalls: limits.instructorCalls, juniorMaxCalls: limits.juniorCalls, maxContinuationBatches: limits.maxContinuationBatches } } : {}) };
    });
  }
  remaining(): { calls: number; modelCalls: number; ms: number } {
    const request = this.state.request;
    if (!request) throw new Error('task request has not started');
    return { calls: Math.max(0, request.maxCalls - request.calls), modelCalls: Math.max(0, request.maxModelCalls - request.modelCalls), ms: Math.max(0, request.deadline - Date.now()) };
  }
  consumeModel(): boolean {
    const remaining = this.remaining();
    if (!remaining.modelCalls || !remaining.ms) return false;
    this.change(next => { next.request!.modelCalls++; });
    return true;
  }
  get delegationExhausted(): boolean { return !this.state.request || this.state.request.delegations >= this.state.request.maxDelegations; }
  /** Calls left for all juniors together; state saved before the junior pool existed shares the instructor's. */
  juniorPoolRemaining(): number {
    const request = this.state.request;
    if (!request) throw new Error('task request has not started');
    return request.maxJuniorPoolCalls === undefined ? this.remaining().calls : Math.max(0, request.maxJuniorPoolCalls - request.juniorPoolCalls);
  }
  juniorCalls(name: string): number { return this.state.request?.juniorCalls[name] ?? 0; }
  consumeJunior(name: string): void { this.change(next => { next.request!.juniorCalls[name] = (next.request!.juniorCalls[name] ?? 0) + 1; }); }
  toolBudget() { return this.state.request?.toolBudget && structuredClone(this.state.request.toolBudget); }
  get continuationDenied(): boolean { return Boolean(this.state.request?.continuationDenied); }
  denyContinuation(): void {
    if (this.state.request && !this.state.request.continuationDenied) this.change(next => { next.request!.continuationDenied = true; });
  }
  grantInstructorBatch(expectedBatch: number): boolean {
    const budget = this.state.request?.toolBudget;
    if (!budget || this.state.request!.continuationDenied || budget.continuationBatches !== expectedBatch || budget.continuationBatches >= budget.maxContinuationBatches) return false;
    const next = Math.min(budget.instructorBatchCalls, this.remaining().calls);
    if (next <= 0) return false;
    this.change(state => { const value = state.request!.toolBudget!; value.continuationBatches++; value.instructorGranted += next; });
    return true;
  }
  consumeDelegation(): boolean {
    if (this.delegationExhausted) return false;
    this.change(next => { next.request!.delegations++; });
    return true;
  }
  saveJunior(junior: z.infer<typeof juniorSchema>, dismiss = false): void {
    this.change(next => {
      const value = juniorSchema.parse({ ...junior, ...(junior.description ? { description: this.redact(junior.description) } : {}), ...(junior.assignment ? { assignment: this.redact(junior.assignment) } : {}), turns: junior.turns.slice(-6).map(turn => ({ user: this.redact(turn.user), assistant: this.redact(turn.assistant).slice(0, 4000) })) });
      next.juniors = next.juniors.filter(item => item.name !== value.name);
      if (!dismiss) {
        next.juniors.push(value);
        if (!next.juniorNames.includes(value.name)) next.juniorNames.push(value.name);
      }
    });
  }
  authorizeArtifacts(actor: TaskActor, references: string[]): void {
    if (references.length > 16 || references.some(ref => { const artifact = this.state.artifacts.find(item => item.id === ref) ?? this.cold('artifacts', ref, artifactSchema); return !artifact || !this.accessible(actor, artifact); })) throw new Error('unknown or inaccessible delegation evidence');
  }
  authorizeEvidence(actor: TaskActor, references: string[]): void {
    if (references.length > 4 || references.some(ref => { const artifact = this.state.artifacts.find(item => item.id === ref) ?? this.cold('artifacts', ref, artifactSchema); const receipt = this.state.receipts.find(item => item.id === ref) ?? this.cold('receipts', ref, receiptSchema); return !(artifact && this.accessible(actor, artifact)) && !(receipt && ['succeeded', 'failed'].includes(receipt.status) && (actor.name === instructor.name || receipt.actor === actor.name)); })) throw new Error('unknown or inaccessible artifact/receipt');
  }
  begin(actor: TaskActor, tool: string, args: unknown, call?: string): string | undefined {
    const remaining = this.remaining();
    if (!remaining.calls || !remaining.ms) return undefined;
    const receipt = `e-${randomUUID()}`;
    const data = (args ?? {}) as { path?: unknown; command?: unknown; url?: unknown; pattern?: unknown; query?: unknown };
    const search = data.pattern ?? data.query;
    const summary = String(data.path ?? data.command ?? data.url ?? '') + (search === undefined ? '' : `; ${String(search)}`);
    this.change(next => {
      next.request!.calls++;
      if (next.receipts.length >= taskLimits.receipts) {
        const removable = next.receipts.findIndex(item => item.status !== 'pending');
        if (removable < 0) throw new Error('too many pending tool calls');
        this.archiveRecord('receipts', next.receipts[removable]);
        next.receipts.splice(removable, 1);
      }
      next.receipts.push({ id: receipt, request: next.request!.id, actor: actor.name, tool, ...(call ? { call } : {}), argsSha256: createHash('sha256').update(JSON.stringify(args ?? {})).digest('hex'), summary: brief(this.redact(summary), 240), excerpt: '', status: 'pending', artifacts: [], at: Date.now() });
    });
    return receipt;
  }
  admit(actor: TaskActor, tool: string, args: unknown, call?: string): string | undefined {
    const request = this.state.request, remaining = this.remaining();
    const pooled = actor.name !== instructor.name && request?.maxJuniorPoolCalls !== undefined;
    if (!request || !(pooled ? this.juniorPoolRemaining() : remaining.calls) || !remaining.ms) return undefined;
    const budget = request.toolBudget;
    if (request.continuationDenied || (actor.name === instructor.name ? Boolean(budget && budget.instructorCalls >= budget.instructorGranted)
      : Boolean(budget && (request.juniorCalls[actor.name] ?? 0) >= budget.juniorMaxCalls))) return undefined;
    const receipt = `e-${randomUUID()}`;
    const data = (args ?? {}) as { path?: unknown; command?: unknown; url?: unknown; pattern?: unknown; query?: unknown };
    const search = data.pattern ?? data.query;
    const summary = String(data.path ?? data.command ?? data.url ?? '') + (search === undefined ? '' : `; ${String(search)}`);
    this.change(next => {
      const req = next.request!; if (pooled) req.juniorPoolCalls++; else req.calls++;
      if (req.toolBudget) {
        if (actor.name === instructor.name) req.toolBudget.instructorCalls++;
        else req.juniorCalls[actor.name] = (req.juniorCalls[actor.name] ?? 0) + 1;
      } else if (actor.name !== instructor.name) req.juniorCalls[actor.name] = (req.juniorCalls[actor.name] ?? 0) + 1;
      if (next.receipts.length >= taskLimits.receipts) { const removable = next.receipts.findIndex(item => item.status !== 'pending'); if (removable < 0) throw new Error('too many pending tool calls'); this.archiveRecord('receipts', next.receipts[removable]); next.receipts.splice(removable, 1); }
      next.receipts.push({ id: receipt, request: req.id, actor: actor.name, tool, ...(call ? { call } : {}), argsSha256: createHash('sha256').update(JSON.stringify(args ?? {})).digest('hex'), summary: brief(this.redact(summary), 240), excerpt: '', status: 'pending', artifacts: [], at: Date.now() });
    });
    return receipt;
  }
  settle(receipt: string, failed: boolean, excerpt = '', origin?: 'file' | 'inventory' | 'saved-output' | 'transcript', source?: EvidenceSource): void {
    this.change(next => {
      const found = next.receipts.find(item => item.id === receipt);
      if (!found || found.status !== 'pending') throw new Error('unknown pending tool receipt');
      found.status = failed ? 'failed' : 'succeeded';
      found.excerpt = this.redact(excerpt).slice(0, 400);
      if (origin) found.origin = origin;
      if (source) found.source = sourceSchema.parse(Object.fromEntries(Object.entries(source).map(([key, value]) => [key, typeof value === 'string' ? this.redact(value).slice(0, key === 'query' ? 200 : 2048) : value])));
      found.sourceEpoch = next.sourceEpoch;
      for (const artifactId of found.artifacts) {
        const artifact = next.artifacts.find(item => item.id === artifactId);
        if (!artifact) continue;
        artifact.producerTool = found.tool; artifact.request = found.request;
        if (found.origin) artifact.origin = found.origin;
        if (found.source) artifact.source = found.source;
        artifact.sourceEpoch = found.sourceEpoch;
      }
    });
  }
  register(actor: TaskActor, producer: string, saved: Saved, kind: Kind): void {
    const path = resolve(saved.path), rel = relative(this.scratch, path);
    if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('artifact is outside this task scratchpad');
    this.change(next => {
      const receipt = next.receipts.find(item => item.id === producer && item.actor === actor.name && item.status === 'pending');
      if (!receipt) throw new Error('artifact producer is unknown, settled or inaccessible');
      const { id, sha256, bytes, lines, complete } = saved;
      const entry = artifactSchema.parse({ id, sha256, bytes, lines, complete, path, kind, actor: actor.name, producer, producerTool: receipt.tool, request: receipt.request, ...(receipt.origin ? { origin: receipt.origin } : {}), ...(receipt.source ? { source: receipt.source } : {}), ...(receipt.sourceEpoch !== undefined ? { sourceEpoch: receipt.sourceEpoch } : {}), at: Date.now() });
      if (next.artifacts.length >= taskLimits.artifacts) {
        const removable = next.artifacts.findIndex(item => next.receipts.find(receipt => receipt.id === item.producer)?.status !== 'pending');
        if (removable < 0) throw new Error('too many artifacts from pending tool calls');
        this.archiveRecord('artifacts', next.artifacts[removable]);
        next.artifacts.splice(removable, 1);
      }
      next.artifacts.push(entry);
      if (receipt.artifacts.length < 8) receipt.artifacts.push(entry.id);
    });
  }
  private accessible(actor: TaskActor, artifact: TaskState['artifacts'][number]): boolean {
    return actor.name === instructor.name || artifact.actor === actor.name || Boolean(actor.artifacts?.includes(artifact.id));
  }
  update(actor: TaskActor, input: TaskUpdate): void {
    if (input.revision !== this.state.revision) throw new Error(`stale state revision; current revision is ${this.state.revision}`);
    this.change(next => {
      const validate = (evidence: string[]) => {
        for (const ref of evidence) {
          const artifactEntry = next.artifacts.find(artifact => artifact.id === ref) ?? this.cold('artifacts', ref, artifactSchema);
          const artifact = Boolean(artifactEntry && this.accessible(actor, artifactEntry));
          const receiptEntry = next.receipts.find(receipt => receipt.id === ref) ?? this.cold('receipts', ref, receiptSchema);
          const receipt = Boolean(receiptEntry && ['succeeded', 'failed'].includes(receiptEntry.status) && (actor.name === instructor.name || receiptEntry.actor === actor.name));
          if (!artifact && !receipt) throw new Error(`unknown or inaccessible artifact/receipt: ${ref}`);
        }
      };
      for (const [key, remove] of [['steps', input.remove_step], ['claims', input.remove_claim]] as const) {
        if (remove) {
          if (next[key].some(item => item.id === remove && item.actor !== actor.name)) throw new Error('cannot remove another actor\'s state');
          // Both record types have the same ownership fields; mutate the array rather than widening its type.
          const index = next[key].findIndex(item => item.id === remove);
          if (index >= 0) next[key].splice(index, 1);
        }
      }
      if (input.step) {
        const step = stepSchema.parse(input.step); validate(step.evidence);
        if (next.steps.some(item => item.id === step.id && item.actor !== actor.name)) throw new Error('step ID belongs to another actor');
        const index = next.steps.findIndex(item => item.id === step.id && item.actor === actor.name);
        const blocker = step.status === 'blocked' && step.blocker ? { ...step.blocker, reason: this.redact(step.blocker.reason), ...(step.blocker.next ? { next: this.redact(step.blocker.next) } : {}) } : undefined;
        const value = { ...step, blocker, goal: this.redact(step.goal), acceptance: this.redact(step.acceptance), actor: actor.name, request: next.request?.id };
        if (index < 0) next.steps.push(value); else next.steps[index] = value;
      }
      if (input.claim) {
        const claim = claimSchema.parse(input.claim); validate(claim.evidence);
        if (next.claims.some(item => item.id === claim.id && item.actor !== actor.name)) throw new Error('claim ID belongs to another actor');
        const index = next.claims.findIndex(item => item.id === claim.id && item.actor === actor.name);
        const value = { ...claim, text: this.redact(claim.text), actor: actor.name, request: next.request?.id };
        if (index < 0) next.claims.push(value); else next.claims[index] = value;
      }
    }, true);
  }
  finish(status: string): void {
    this.change(next => {
      for (const receipt of next.receipts) if (receipt.status === 'pending') receipt.status = 'uncertain';
      if (next.request) next.request.status = status;
      next.status = status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'blocked';
    });
  }
  recordExecution(actor: TaskActor, update: { receipt: string; changedPath?: string; shellUncertain?: boolean; check?: { command: string; status: 'passed' | 'failed' } }): void {
    const receipt = this.state.receipts.find(item => item.id === update.receipt) ?? this.cold('receipts', update.receipt, receiptSchema);
    if (!receipt || receipt.actor !== actor.name) throw new Error('unknown or inaccessible execution receipt');
    this.change(next => {
      if (!next.execution[actor.name] && Object.keys(next.execution).length >= 32) throw new Error('too many execution actors');
      const progress = next.execution[actor.name] ?? { changedFiles: [], unresolvedChecks: [], currentCheck: 'not-run-after-edit' as const, shellUncertain: false, overflow: { changedFiles: 0, unresolvedChecks: 0 } };
      if (update.changedPath !== undefined) {
        const path = resolve(update.changedPath);
        if (path.length > 512) throw new Error('changed path is too long');
        if (!progress.changedFiles.includes(path)) {
          if (progress.changedFiles.length === 16) { progress.changedFiles.shift(); progress.overflow.changedFiles++; }
          progress.changedFiles.push(path);
        }
        next.sourceEpoch++;
        progress.currentCheck = 'not-run-after-edit';
      }
      if (update.shellUncertain) {
        progress.shellUncertain = true;
        next.sourceEpoch++;
        progress.currentCheck = 'not-run-after-edit';
      }
      if (update.check) {
        const completeCommand = this.redact(update.check.command), commandHash = createHash('sha256').update(update.check.command).digest('hex');
        const command = brief(completeCommand, 240);
        next.checks = next.checks.filter(value => (value.commandHash ?? createHash('sha256').update(value.command).digest('hex')) !== commandHash);
        if (next.checks.length === 128) {
          const removable = next.checks.findIndex(value => value.status === 'passed');
          if (removable < 0) throw new Error('too many unresolved checks');
          next.checks.splice(removable, 1); progress.overflow.unresolvedChecks++;
        }
        next.checks.push({ command, commandHash, status: update.check.status, actor: actor.name, epoch: next.sourceEpoch });
        progress.currentCheck = update.check.status;
      }
      next.execution[actor.name] = progress;
    });
  }
  execution(actor: TaskActor): ExecutionState {
    const values = actor.name === instructor.name ? Object.values(this.state.execution) : [this.state.execution[actor.name]].filter((value): value is NonNullable<typeof value> => Boolean(value));
    const checks = this.state.checks.filter(value => actor.name === instructor.name || value.actor === actor.name);
    const unresolved = checks.filter(value => value.status === 'failed');
    const current = checks.filter(value => value.epoch === this.state.sourceEpoch);
    return { changedFiles: [...new Set(values.flatMap(value => value.changedFiles))], unresolvedChecks: unresolved.map(value => value.command), currentCheck: unresolved.length ? 'failed' : current.at(-1)?.status ?? 'not-run-after-edit', shellUncertain: values.some(value => value.shellUncertain) };
  }
  /** One current view, replaced before each inference. Model-authored text is data, never prompt authority. */
  project(actor: TaskActor): string {
    const artifacts = this.state.artifacts.filter(item => this.accessible(actor, item));
    let objective = clip(actor.objective ?? this.state.objective, 800);
    while (JSON.stringify(objective).length > 1000) objective = clip(objective, Math.floor(objective.length / 2));
    const rank: Record<'working' | 'blocked' | 'ready' | 'done', number> = { working: 0, blocked: 1, ready: 2, done: 3 };
    const steps = this.state.steps.filter(item => item.actor === actor.name && item.status !== 'done').sort((a, b) => rank[a.status] - rank[b.status]);
    const claims = this.state.claims.filter(item => item.actor === actor.name), juniors = actor.name === instructor.name ? this.state.juniors : [];
    const recent = this.state.receipts.filter(item => actor.name === instructor.name || item.actor === actor.name), observations = this.observations(actor), execution = this.execution(actor);
    const progress = actor.name === instructor.name ? Object.values(this.state.execution) : [this.state.execution[actor.name]].filter((value): value is NonNullable<typeof value> => Boolean(value));
    const overflow = { changedFiles: progress.reduce((sum, value) => sum + value.overflow.changedFiles, 0), unresolvedChecks: progress.reduce((sum, value) => sum + value.overflow.unresolvedChecks, 0) };
    const omissions: Record<string, number> = { steps: Math.max(0, steps.length - 8), claims: Math.max(0, claims.length - 4), juniors: Math.max(0, juniors.length - 4), recent: Math.max(0, recent.length - 4), observations: Math.max(0, observations.length - 3), artifacts: Math.max(0, artifacts.length - 4), changedFiles: Math.max(0, execution.changedFiles.length - 8) + overflow.changedFiles, unresolvedChecks: Math.max(0, execution.unresolvedChecks.length - 8) + overflow.unresolvedChecks };
    const view = { task: this.state.id, revision: this.state.revision, objective, constraints: this.state.constraints, plan: actor.name === instructor.name ? this.state.plan : undefined, readOnly: this.state.request?.readOnly ?? false,
      budget: this.remaining(), execution: { ...execution, changedFiles: execution.changedFiles.slice(-8), unresolvedChecks: execution.unresolvedChecks.slice(-8), overflow }, omissions,
      steps: steps.slice(0, 8).map(item => ({ ...item, historical: item.request !== this.state.request?.id, goal: brief(item.goal, 160), acceptance: brief(item.acceptance, 160) })),
      claims: claims.slice(-4).map(item => ({ ...item, historical: item.request !== this.state.request?.id, text: brief(item.text, 240) })),
      juniors: actor.name === instructor.name ? juniors.slice(-4).map(({ name, description, agent_type, type, turn, assignment }) => ({ name, description, agent_type, legacyType: type, turn, assignment: assignment && brief(assignment, 240) })) : undefined,
      recent: recent.slice(-4).map(({ id, actor, tool, summary, status, artifacts }) => ({ id, actor, tool, summary, status, artifacts })),
      observations: observations.slice(0, 3),
      artifacts: artifacts.slice(-4).map(({ id, kind, bytes, complete, producer }) => ({ id, kind, bytes, complete, producer })),
    };
    while (JSON.stringify(view).length > taskLimits.projectionChars) {
      if (view.claims.length) { view.claims.shift(); omissions.claims = (omissions.claims ?? 0) + 1; }
      else if (view.recent.length) { view.recent.shift(); omissions.recent = (omissions.recent ?? 0) + 1; }
      else if (view.observations.length) { view.observations.pop(); omissions.observations = (omissions.observations ?? 0) + 1; }
      else if (view.steps.length > 1) { view.steps.pop(); omissions.steps = (omissions.steps ?? 0) + 1; }
      else if (view.artifacts.length) { view.artifacts.shift(); omissions.artifacts = (omissions.artifacts ?? 0) + 1; }
      else if (view.juniors?.length) { view.juniors.shift(); omissions.juniors = (omissions.juniors ?? 0) + 1; }
      else if (view.execution.changedFiles.length) { view.execution.changedFiles.shift(); omissions.changedFiles = (omissions.changedFiles ?? 0) + 1; }
      else if (view.execution.unresolvedChecks.length) { view.execution.unresolvedChecks.shift(); omissions.unresolvedChecks = (omissions.unresolvedChecks ?? 0) + 1; }
      else break;
    }
    const text = JSON.stringify(view);
    if (text.length > taskLimits.projectionChars) throw new Error('task projection exceeds its context allowance');
    return text;
  }
  /** Host-recorded observations work even when a model never opts into bookkeeping. */
  private observations(actor: TaskActor) {
    const distinct = new Map<string, TaskState['receipts'][number]>();
    for (const item of this.state.receipts) {
      const mutableSource = item.origin === 'file' || item.origin === 'inventory';
      if (!item.origin || item.stale || item.uncertainSource || (mutableSource && (item.sourceEpoch ?? 0) !== this.state.sourceEpoch) || !['succeeded', 'failed'].includes(item.status) || (actor.name !== instructor.name && item.actor !== actor.name)) continue;
      distinct.delete(`${item.tool}:${item.summary}`);
      distinct.set(`${item.tool}:${item.summary}`, item);
    }
    const priority = { file: 3, inventory: 2, 'saved-output': 1, transcript: 0 };
    return [...distinct.values()].sort((a, b) => priority[b.origin!] - priority[a.origin!] || b.at - a.at)
      .map(({ id, tool, summary, origin, excerpt, status, request }) => ({ id, tool, source: summary, origin, excerpt: brief(excerpt, 240), status, request }));
  }
  catalog(actor: TaskActor, kind: 'artifacts' | 'receipts' | 'steps' | 'claims', offset = 0, filters: EvidenceFilters = {}): string {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid catalog offset');
    for (const value of Object.values(filters)) if (value !== undefined && (!value || value.length > 200)) throw new Error('invalid catalog filter');
    const hot = kind === 'artifacts' ? this.state.artifacts : kind === 'receipts' ? this.state.receipts : this.state[kind];
    const hotIds = new Set(hot.map(item => item.id)), page: Array<Record<string, unknown>> = [];
    let total = 0;
    const consider = (item: any) => {
      if (kind === 'artifacts' && !this.accessible(actor, item)) return;
      if (kind !== 'artifacts' && actor.name !== instructor.name && item.actor !== actor.name) return;
      let value: Record<string, unknown>;
      const producer = kind === 'artifacts' && (!item.producerTool || !item.request || !item.source || !item.origin)
        ? this.state.receipts.find(receipt => receipt.id === item.producer) ?? this.cold('receipts', item.producer, receiptSchema) : undefined;
      const sourceData = item.source ?? producer?.source;
      const source = sourceData && Object.fromEntries(Object.entries(sourceData).map(([key, field]) => [key, typeof field === 'string' ? brief(field, 24) : field]));
      const artifactOrigin = item.origin ?? producer?.origin, artifactEpoch = item.sourceEpoch ?? producer?.sourceEpoch;
      const filterTool = kind === 'artifacts' ? item.producerTool ?? producer?.tool : item.tool;
      const filterRequest = item.request ?? producer?.request;
      const searchable = kind === 'artifacts' ? { ...item, tool: filterTool, request: filterRequest, source: sourceData } : item;
      if (kind === 'artifacts') value = { id: item.id, kind: item.kind, actor: item.actor, producer: item.producer, tool: brief(item.producerTool ?? producer?.tool ?? '', 32), request: brief(item.request ?? producer?.request ?? '', 32), complete: item.complete, bytes: item.bytes, origin: artifactOrigin, source, stale: (artifactOrigin === 'file' || artifactOrigin === 'inventory') && this.state.sourceEpoch > 0 && artifactEpoch !== this.state.sourceEpoch };
      else if (kind === 'receipts') value = { id: item.id, actor: item.actor, request: brief(item.request, 32), tool: brief(item.tool, 32), summary: brief(item.summary, 48), origin: item.origin, source, status: item.status, stale: Boolean(item.stale || ((item.origin === 'file' || item.origin === 'inventory') && this.state.sourceEpoch > 0 && item.sourceEpoch !== this.state.sourceEpoch)), uncertainSource: Boolean(item.uncertainSource) };
      else if ('goal' in item) value = { id: item.id, actor: item.actor, goal: brief(item.goal, 80), status: item.status, blocker: item.blocker };
      else value = { id: item.id, actor: item.actor, text: brief(item.text, 80), basis: item.basis };
      if (filters.query && !JSON.stringify(searchable).includes(filters.query)) return;
      if (filters.tool && filterTool !== filters.tool) return;
      if (filters.request && filterRequest !== filters.request) return;
      total++;
      if (total - 1 >= offset && page.length < 8) page.push(value);
    };
    if (kind === 'artifacts' || kind === 'receipts') for (const item of this.coldRecords(kind)) if (!hotIds.has(item.id)) consider(item);
    for (const item of hot) consider(item);
    while (true) {
      const next = offset + page.length < total ? offset + page.length : null;
      const text = JSON.stringify({ kind, total, offset, records: page, next });
      if (text.length <= taskLimits.projectionChars) return text;
      if (page.length > 1) { page.pop(); continue; }
      if (page.length === 1) {
        const idValue = page[0]!.id;
        page[0] = { id: idValue };
        continue;
      }
      throw new Error('task catalog response exceeds its context allowance');
    }
  }
  record(actor: TaskActor, record: string): string {
    const item = [...this.state.steps, ...this.state.claims, ...this.state.receipts].find(item => item.id === record) ?? this.cold('receipts', record, receiptSchema);
    const artifact = this.state.artifacts.find(item => item.id === record) ?? this.cold('artifacts', record, artifactSchema);
    if (item && actor.name !== instructor.name && actor.name !== item.actor) throw new Error('unknown or inaccessible state record');
    if (artifact && !this.accessible(actor, artifact)) throw new Error('unknown or inaccessible state record');
    const value = item ?? artifact;
    if (!value) throw new Error('unknown or inaccessible state record');
    return boundedJson(value, taskLimits.projectionChars);
  }
  async artifact(actor: TaskActor, handle: string, options: { offset?: number; limit?: number; search?: string } = {}): Promise<string> {
    const artifact = this.state.artifacts.find(item => item.id === handle) ?? this.cold('artifacts', handle, artifactSchema);
    if (!artifact || !this.accessible(actor, artifact)) throw new Error('unknown, expired or inaccessible artifact');
    const path = resolve(artifact.path), rel = relative(this.scratch, path);
    if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('artifact is outside this task scratchpad');
    // Check every component, including parents of the scratch root. Never follow a planted link.
    let current = path;
    for (;;) {
      const info = await lstat(current);
      if (info.isSymbolicLink() || (info.isFile() && info.nlink !== 1)) throw new Error('linked artifact paths are not allowed');
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    const info = await lstat(path);
    if (!info.isFile() || info.size !== artifact.bytes || info.size > scratchLimits.fileBytes) throw new Error('artifact is missing or changed');
    const bytes = await readFile(path);
    if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Error('artifact is changed');
    const offset = options.offset ?? 1, limit = options.limit ?? 40;
    if (!Number.isInteger(offset) || offset < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100 || (options.search !== undefined && (!options.search || options.search.length > 200))) throw new Error('invalid artifact range or search');
    const text = bytes.toString('utf8');
    const found: string[] = [];
    let start = 0, lineNumber = 1, chars = 0;
    while (start < text.length && found.length < limit && chars < taskLimits.retrievalChars) {
      const newline = text.indexOf('\n', start), end = newline < 0 ? text.length : newline;
      if (lineNumber >= offset) {
        const line = text.slice(start, end), match = options.search === undefined ? -1 : line.indexOf(options.search);
        if (options.search === undefined || match >= 0) {
          // Search must expose the actual match, even when a single giant line would hide it in a head/tail clip.
          const from = Math.max(0, match - 300), to = match + (options.search?.length ?? 0) + 300;
          const shown = match >= 0 && line.length > taskLimits.retrievalChars
            ? `${from ? '[…] ' : ''}${line.slice(from, to)}${to < line.length ? ' […]' : ''} (column ${match + 1})`
            : clip(line, taskLimits.retrievalChars);
          const entry = `${lineNumber}: ${shown}`;
          found.push(entry); chars += entry.length;
        }
      }
      if (newline < 0) break;
      start = end + 1; lineNumber++;
    }
    return clip(`artifact ${handle} (${artifact.complete ? 'complete' : 'incomplete'}, ${artifact.lines} lines)\n${found.join('\n') || 'no matches'}`, taskLimits.retrievalChars);
  }
}
