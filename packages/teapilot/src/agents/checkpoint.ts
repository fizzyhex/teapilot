/** Request-local handoff at a bounded execution boundary. Neither summaries nor model handoffs are authority. */
export type CheckpointReason = 'instructor_calls' | 'request_calls' | 'attempt_time' | 'request_time' | 'model_calls' | 'context_pressure';

export interface CheckpointSnapshot {
  originalObjective?: string;
  amendments: string[];
  artifacts: Array<{ ref: string; summary?: string }>;
  checks: Array<{ ref: string; status?: string; summary?: string }>;
  results: Array<{ ref: string; summary?: string }>;
  workers: Array<{ ref: string; summary?: string }>;
  resources: Record<string, number | string>;
  pendingUncertain: string[];
  failures?: Array<{ ref: string; summary: string }>;
}

export interface Checkpoint {
  version: 1;
  requestId: string;
  checkpointId: number;
  sequence: number;
  reason: CheckpointReason;
  durability: 'request-local' | 'saved';
  /** Durable host reference, independent of the live continuation offer. */
  savedId?: string;
  expiresAt: number;
  snapshot: CheckpointSnapshot;
  summary: string[];
  /** Untrusted model-authored context; never a result, instruction, or proof. */
  modelHandoff?: string;
  continuation?: { offerId: string; instructorCalls: number; activeMs: number; freshContext: boolean };
}

export type CheckpointDecision =
  | { requestId: string; checkpointId: number; action: 'continue'; offerId: string }
  | { requestId: string; checkpointId: number; action: 'redirect'; offerId: string; amendment: string }
  | { requestId: string; checkpointId: number; action: 'finish_partial' };

export type CheckpointHandler = (checkpoint: Readonly<Checkpoint>, signal: AbortSignal) => Promise<CheckpointDecision | undefined>;

/** Handlers are UI boundaries: freeze nested references too, not only the top-level envelope. */
export function freezeCheckpoint<T extends Checkpoint>(checkpoint: T): Readonly<T> {
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  freeze(checkpoint);
  return checkpoint;
}
