import type { TaskStore } from '../workspace/task.js';
import type { Approve } from '../execution/policy.js';
import type { Config } from '../config.js';

export interface ToolBudgetLimits { instructorCalls?: number; juniorCalls?: number; juniorPool?: number; maxContinuationBatches?: number }
/** Fewer calls than this cannot work and still report, so a junior is not started with them. */
export const juniorMinCalls = 8;
export interface QueuedToolCall { id: string; name: string; junior?: string }
interface Reservation { pendingCall: boolean; junior?: string; juniorCalls: number }
/** The one policy resolver used when durable request state and the runtime allowance are created. */
export function resolveToolBudget(config: Config, scope: { readOnly?: boolean; casual?: boolean; side?: boolean; junior?: boolean } = {}) {
  const limits = config.policy.limits;
  const excluded = Boolean(scope.readOnly || scope.casual || scope.side || scope.junior);
  return {
    instructorCalls: excluded ? limits.maxToolCalls : Math.min(limits.maxToolCalls, limits.instructorToolCalls ?? 20),
    juniorCalls: limits.juniorToolCalls ?? 20,
    // Juniors draw from a pool of their own, so an instructor's work never starves the next junior.
    juniorPool: Math.min(limits.juniorPoolCalls ?? limits.maxToolCalls, scope.readOnly ? limits.planningToolCalls ?? planningCallLimit : Infinity),
    maxContinuationBatches: excluded ? 0 : limits.maxContinuationBatches ?? 2,
  };
}

/** Request-local accounting also works without a scratchpad or durable task state. */
export class RequestAllowance {
  private calls = 0;
  private models = 0;
  private delegations = 0;
  private instructorCalls = 0;
  private granted: number;
  private batches = 0;
  private juniorCalls = new Map<string, number>();
  private juniorPoolUsed = 0;
  private renewal?: Promise<'ready' | 'denied' | 'exhausted'>;
  private refused = false;
  private reservations = new Map<string, Reservation>();
  private finishingReserve = 0;
  readonly deadline: number;
  readonly instructorBatchCalls: number;
  readonly juniorMaxCalls: number;
  readonly juniorPool: number;
  readonly maxContinuationBatches: number;
  explorationCompactions = new Map<string, number>();
  constructor(readonly limits: { calls: number; modelCalls: number; timeoutMs: number; delegations: number }, readonly task?: TaskStore, budget: ToolBudgetLimits = {}) {
    this.deadline = Date.now() + limits.timeoutMs;
    const saved = task?.toolBudget();
    this.instructorBatchCalls = saved?.instructorBatchCalls ?? (task && !saved ? limits.calls : budget.instructorCalls ?? limits.calls);
    this.juniorMaxCalls = saved?.juniorMaxCalls ?? budget.juniorCalls ?? 20;
    this.juniorPool = budget.juniorPool ?? limits.calls;
    this.maxContinuationBatches = saved?.maxContinuationBatches ?? budget.maxContinuationBatches ?? 0;
    this.granted = saved?.instructorGranted ?? (task && !saved ? limits.calls : Math.min(limits.calls, this.instructorBatchCalls));
    this.instructorCalls = saved?.instructorCalls ?? 0;
    this.batches = saved?.continuationBatches ?? 0;
  }
  remaining() {
    return this.task?.remaining() ?? { calls: Math.max(0, this.limits.calls - this.calls), modelCalls: Math.max(0, this.limits.modelCalls - this.models), ms: Math.max(0, this.deadline - Date.now()) };
  }
  /** Calls left for all juniors together. */
  juniorRemaining(): number { return this.task?.juniorPoolRemaining() ?? Math.max(0, this.juniorPool - this.juniorPoolUsed); }
  /** The pool an actor's calls come from: the junior pool for juniors, the request's for the instructor. */
  poolRemaining(actor?: string): number { return actor ? this.juniorRemaining() : this.remaining().calls; }
  callsRemainingFor(actor?: string): number {
    if (actor) return Math.max(0, Math.min(this.juniorMaxCalls - this.usedBy(actor), this.juniorRemaining()));
    const remaining = this.remaining().calls;
    const saved = this.task?.toolBudget();
    if (this.task && !saved) return remaining;
    if (saved) return Math.max(0, Math.min(saved.instructorGranted - saved.instructorCalls, remaining));
    return Math.max(0, Math.min(this.granted - this.instructorCalls, remaining));
  }
  get instructorGranted(): number { return this.task?.toolBudget()?.instructorGranted ?? this.granted; }
  /** Reserve only calls already present in a completed assistant response. */
  reserveQueuedTools(calls: QueuedToolCall[]): void {
    this.releaseReservations();
    const capacity = this.remaining().calls;
    for (const call of calls) this.reservations.set(call.id, { pendingCall: true, ...(call.name === 'delegate_task' ? { junior: call.junior } : {}), juniorCalls: 0 });
    const slots = calls.length;
    this.finishingReserve = Math.min(4, Math.max(0, capacity - slots));
    let pool = this.juniorRemaining();
    const delegates = calls.filter(call => call.name === 'delegate_task');
    for (let index = 0; index < delegates.length; index++) {
      const call = delegates[index]!;
      const countLeft = delegates.length - index;
      const fairShare = pool >= juniorMinCalls ? Math.max(juniorMinCalls, Math.floor(pool / countLeft)) : 0;
      const reservedForName = call.junior ? [...this.reservations.values()].filter(item => item.junior === call.junior).reduce((sum, item) => sum + item.juniorCalls, 0) : 0;
      const maximum = Math.max(0, this.juniorMaxCalls - (call.junior ? this.usedBy(call.junior) : 0) - reservedForName);
      const allocation = Math.min(fairShare, maximum);
      if (allocation < juniorMinCalls) break; // This ID and the suffix are refused deterministically.
      this.reservations.get(call.id)!.juniorCalls = allocation;
      pool -= allocation;
    }
  }
  reservedJuniorCalls(id: string): number { return this.reservations.get(id)?.juniorCalls ?? 0; }
  hasReservation(id: string): boolean { return this.reservations.has(id); }
  bindReservation(id: string, junior: string): boolean {
    const held = this.reservations.get(id);
    if (!held || held.junior && held.junior !== junior) return false;
    const otherHeld = [...this.reservations.entries()].filter(([key, value]) => key !== id && value.junior === junior).reduce((sum, [, value]) => sum + value.juniorCalls, 0);
    held.junior = junior;
    const available = Math.max(0, this.juniorMaxCalls - this.usedBy(junior) - otherHeld);
    held.juniorCalls = Math.min(held.juniorCalls, available);
    return held.juniorCalls >= juniorMinCalls;
  }
  canAdmitTool(callId: string, actor?: string, reservationId?: string): boolean {
    if (!this.poolRemaining(actor) || !this.remaining().ms) return false;
    if (actor) {
      const held = reservationId ? this.reservations.get(reservationId) : undefined;
      return Boolean(held && held.junior === actor && held.juniorCalls > 0 && this.usedBy(actor) < this.juniorMaxCalls);
    }
    if (this.reservations.get(callId)?.pendingCall) return true;
    return this.remaining().calls > this.reservedCalls();
  }
  /** Commit the reservation only after durable/task or in-memory admission succeeded. */
  commitToolAdmission(callId: string, actor?: string, reservationId?: string): void {
    if (actor && reservationId) {
      const held = this.reservations.get(reservationId)!;
      held.juniorCalls--;
    } else {
      const held = this.reservations.get(callId);
      if (held?.pendingCall) held.pendingCall = false;
    }
  }
  releaseReservation(id: string): void { this.reservations.delete(id); }
  releaseReservations(): void { this.reservations.clear(); this.finishingReserve = 0; }
  private reservedCalls(): number {
    return this.finishingReserve + [...this.reservations.values()].reduce((sum, item) => sum + (item.pendingCall ? 1 : 0), 0);
  }
  private juniorCallsHeld(): number { return [...this.reservations.values()].reduce((sum, item) => sum + item.juniorCalls, 0); }
  /** What a new junior could get now; none when the instructor has no call left to delegate with. */
  availableDelegationCapacity(): number {
    if (this.remaining().calls <= this.reservedCalls()) return 0;
    return Math.max(0, Math.min(this.juniorMaxCalls, this.juniorRemaining() - this.juniorCallsHeld()));
  }
  /** Reclaim unused capacity after a response batch so skipped calls cannot strand the request. */
  finishQueuedBatch(): void { this.releaseReservations(); }
  async ensureInstructor(signal?: AbortSignal, approve?: Approve): Promise<'ready' | 'denied' | 'exhausted'> {
    if (this.denied) return 'denied';
    if (signal?.aborted) return 'exhausted';
    if (this.task && !this.task.toolBudget()) return 'ready';
    if (this.callsRemainingFor() > 0) return 'ready';
    if (!this.maxContinuationBatches || this.batches >= this.maxContinuationBatches || this.task && !this.task.toolBudget()) return 'exhausted';
    if (!approve) return 'exhausted';
    if (!this.renewal) this.renewal = this.renew(signal, approve).finally(() => { this.renewal = undefined; });
    return this.renewal;
  }
  private async renew(signal: AbortSignal | undefined, approve: Approve): Promise<'ready' | 'denied' | 'exhausted'> {
    const batch = this.batches;
    if (this.remaining().calls <= 0 || this.remaining().ms <= 0) return 'exhausted';
    const capacity = Math.min(this.instructorBatchCalls, this.remaining().calls);
    const approved = await approve({ kind: 'continuation_budget', summary: `allow up to ${capacity} more instructor calls?`, details: `Hard request calls remaining: ${this.remaining().calls}. Existing time, model-call, spend, delegation, and per-junior limits still apply.`, signal });
    if (signal?.aborted || this.remaining().calls <= 0 || this.remaining().ms <= 0) return 'exhausted';
    if (!approved) { this.refused = true; this.task?.denyContinuation(); return 'denied'; }
    if (this.task) {
      if (!this.task.grantInstructorBatch(batch)) return 'exhausted';
      this.granted = this.task.toolBudget()!.instructorGranted;
      this.batches = this.task.toolBudget()!.continuationBatches;
    } else {
      const grant = Math.min(this.instructorBatchCalls, this.remaining().calls);
      if (grant <= 0 || this.batches !== batch) return 'exhausted';
      this.granted += grant; this.batches++;
    }
    return 'ready';
  }
  consumeTool(actor?: string): boolean {
    if (this.denied || !this.poolRemaining(actor) || !this.remaining().ms || (actor ? this.usedBy(actor) >= this.juniorMaxCalls : this.callsRemainingFor() <= 0)) return false;
    if (!this.task) { if (actor) this.juniorPoolUsed++; else this.calls++; }
    if (actor) { this.juniorCalls.set(actor, this.usedBy(actor) + 1); this.task?.consumeJunior(actor); }
    else this.instructorCalls++;
    return true;
  }
  recordAdmitted(actor?: string): void {
    if (this.task) return;
    if (actor) { this.juniorPoolUsed++; this.juniorCalls.set(actor, this.usedBy(actor) + 1); }
    else { this.calls++; this.instructorCalls++; }
  }
  consumeModel(): boolean {
    if (this.task) return this.task.consumeModel();
    if (!this.remaining().modelCalls || !this.remaining().ms) return false;
    this.models++; return true;
  }
  usedBy(junior: string): number { return this.task?.juniorCalls(junior) ?? this.juniorCalls.get(junior) ?? 0; }
  get denied(): boolean { return this.refused || Boolean(this.task?.continuationDenied); }
  get delegationExhausted(): boolean { return this.task ? this.task.delegationExhausted : this.delegations >= this.limits.delegations; }
  consumeDelegation(): boolean {
    if (this.delegationExhausted) return false;
    if (this.task) return this.task.consumeDelegation();
    this.delegations++; return true;
  }
}

export const planningCallLimit = 24;
