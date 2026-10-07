import { expect, it, vi } from 'vitest';
import { PlayDelivery } from '../src/discord/play/delivery.js';
import type { Clock } from '../src/discord/play/runtime.js';

function clock() {
  let now = 0;
  const timers = new Set<{ at: number; run(): void }>();
  const clock: Clock = { now: () => now, after(ms, run) {
    const timer = { at: now + ms, run }; timers.add(timer);
    return () => { timers.delete(timer); };
  } };
  return { clock, timers, advance(ms: number) {
    now += ms;
    for (const timer of [...timers]) if (timer.at <= now) { timers.delete(timer); timer.run(); }
  } };
}
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

it('throttles with a trailing latest update, rather than replaying intermediate views', async () => {
  const time = clock(), seen: number[] = [];
  const delivery = new PlayDelivery(time.clock, 2000, vi.fn());
  delivery.enqueue(async () => { seen.push(1); });
  await settle();
  delivery.enqueue(async () => { seen.push(2); });
  delivery.enqueue(async () => { seen.push(3); });
  expect(time.timers.size).toBe(1);
  time.advance(1999); await settle(); expect(seen).toEqual([1]);
  delivery.enqueue(async () => { seen.push(4); });
  time.advance(1); await settle(); expect(seen).toEqual([1, 4]);
  delivery.close();
});

it('keeps only the latest pending edit during transport backpressure', async () => {
  const time = clock(), seen: number[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const delivery = new PlayDelivery(time.clock, 2000, vi.fn());
  delivery.enqueue(async () => { seen.push(1); await held; });
  await settle();
  for (let i = 2; i <= 100; i++) delivery.enqueue(async () => { seen.push(i); });
  time.advance(5000); await settle(); expect(seen).toEqual([1]);
  release(); await settle(); expect(seen).toEqual([1, 100]);
  delivery.close();
});

it('reports failures without preventing delivery of the next view', async () => {
  const time = clock(), failed = vi.fn(), next = vi.fn(async () => {});
  const delivery = new PlayDelivery(time.clock, 2000, failed);
  delivery.enqueue(async () => { throw new Error('discord unavailable'); });
  await settle();
  delivery.enqueue(next);
  await settle(); expect(failed).toHaveBeenCalledOnce(); expect(next).not.toHaveBeenCalled();
  time.advance(2000); await settle(); expect(next).toHaveBeenCalledOnce();
  delivery.close();
});

it('cancels trailing work on shutdown', async () => {
  const time = clock(), next = vi.fn(async () => {});
  const delivery = new PlayDelivery(time.clock, 2000, vi.fn());
  delivery.enqueue(async () => {}); await settle();
  delivery.enqueue(next); delivery.close();
  expect(time.timers.size).toBe(0);
  time.advance(2000); delivery.enqueue(next); await settle();
  expect(next).not.toHaveBeenCalled();
});

it('does not start a scheduled edit after shutdown', async () => {
  const time = clock(), edit = vi.fn(async () => {});
  const delivery = new PlayDelivery(time.clock, 2000, vi.fn());
  delivery.enqueue(edit); delivery.close(); await settle();
  expect(edit).not.toHaveBeenCalled();
});

it('counts transport time toward the edit interval', async () => {
  const time = clock(), next = vi.fn(async () => {});
  let release!: () => void;
  const delivery = new PlayDelivery(time.clock, 2000, vi.fn());
  delivery.enqueue(() => new Promise<void>(resolve => { release = resolve; }));
  await settle();
  delivery.enqueue(next);
  time.advance(1500); release(); await settle();
  time.advance(499); await settle(); expect(next).not.toHaveBeenCalled();
  time.advance(1); await settle(); expect(next).toHaveBeenCalledOnce();
  delivery.close();
});

it('skips superseded preparation without delaying the latest view', async () => {
  const time = clock(), seen: number[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const delivery = new PlayDelivery(time.clock, 2000, vi.fn());
  delivery.enqueue(async current => {
    await held;
    if (!current()) return false;
    seen.push(1);
  });
  await settle();
  delivery.enqueue(async () => { seen.push(2); });
  release(); await settle();
  expect(seen).toEqual([2]);
  expect(time.timers.size).toBe(0);
  delivery.close();
});

it('takes the latest view even before preparation starts', async () => {
  const time = clock(), seen: number[] = [];
  const delivery = new PlayDelivery(time.clock, 2000, vi.fn());
  delivery.enqueue(async () => { seen.push(1); });
  delivery.enqueue(async () => { seen.push(2); });
  await settle();
  expect(seen).toEqual([2]);
  delivery.close();
});

it('sends an edit answering a click at once, without spending the channel interval', async () => {
  const time = clock(), seen: number[] = [];
  const delivery = new PlayDelivery(time.clock, 2000, vi.fn());
  delivery.enqueue(async () => { seen.push(1); });
  await settle();
  delivery.enqueue(async () => { seen.push(2); });
  expect(time.timers.size).toBe(1);
  // The click replaces the waiting channel edit and goes out now.
  const answered = delivery.enqueue(async () => { seen.push(3); }, true);
  await answered;
  expect(seen).toEqual([1, 3]);
  expect(time.timers.size).toBe(0);
  delivery.enqueue(async () => { seen.push(4); });
  time.advance(1999); await settle(); expect(seen).toEqual([1, 3]);
  time.advance(1); await settle(); expect(seen).toEqual([1, 3, 4]);
  delivery.close();
});

it('settles an edit that a newer one replaces before it is sent', async () => {
  const time = clock(), first = vi.fn(async () => {});
  let release!: () => void;
  const delivery = new PlayDelivery(time.clock, 0, vi.fn());
  delivery.enqueue(() => new Promise<void>(resolve => { release = resolve; }));
  await settle();
  const replaced = delivery.enqueue(first, true);
  delivery.enqueue(async () => {}, true);
  await replaced;
  expect(first).not.toHaveBeenCalled();
  release();
  delivery.close();
});
