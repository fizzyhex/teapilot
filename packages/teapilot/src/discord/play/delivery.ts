import type { Clock } from './runtime.js';

type Edit = (current: () => boolean) => Promise<unknown>;

/**
 * One edit in flight, one latest view waiting; transport waits never hold the app's action queue.
 * Channel edits are spaced out for Discord's per-channel limit. An edit answering a click goes through
 * that interaction's own webhook, which the limit does not cover, so it skips the wait.
 */
export class PlayDelivery {
  private pending?: { edit: Edit; now: boolean; done: () => void };
  private revision = 0;
  private busy = false;
  private closed = false;
  private nextAt = 0;
  private cancel?: () => void;

  constructor(private readonly clock: Clock, private readonly interval: number, private readonly failed: (error: unknown) => void) {}

  /** Resolves once this edit is sent, skipped or replaced by a newer one. An edit returning false was skipped. */
  enqueue(edit: Edit, now = false): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.revision++;
    this.pending?.done();
    return new Promise(done => {
      this.pending = { edit, now, done };
      this.flush();
    });
  }

  private flush(): void {
    if (this.closed || this.busy || !this.pending) return;
    const wait = this.pending.now ? 0 : this.nextAt - this.clock.now();
    if (wait > 0) {
      this.cancel ??= this.clock.after(wait, () => { this.cancel = undefined; this.flush(); });
      return;
    }
    this.cancel?.();
    this.cancel = undefined;
    const { edit, now, done } = this.pending;
    const revision = this.revision;
    this.pending = undefined;
    this.busy = true;
    const startedAt = this.clock.now();
    const current = () => !this.closed && revision === this.revision;
    void Promise.resolve().then(() => current() ? edit(current) : false).then(sent => {
      // Preparation can discard an obsolete/unchanged view without spending an edit slot.
      if (sent !== false && !now) this.nextAt = startedAt + this.interval;
    }).catch(error => {
      this.nextAt = this.clock.now() + this.interval;
      this.failed(error);
    }).finally(() => {
      this.busy = false;
      done();
      this.flush();
    });
  }

  close(): void {
    this.closed = true;
    this.pending?.done();
    this.pending = undefined;
    this.cancel?.();
    this.cancel = undefined;
  }
}
