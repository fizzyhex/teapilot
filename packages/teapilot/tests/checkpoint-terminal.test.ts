import { afterEach, expect, it, vi } from 'vitest';
import type { Checkpoint } from '../src/agents/checkpoint.js';
import { terminalCheckpointDecision } from '../src/setup/terminal.js';

const checkpoint: Checkpoint = { version: 1, requestId: 'r2', checkpointId: 2, sequence: 1, reason: 'attempt_time', durability: 'request-local', expiresAt: 1000,
  snapshot: { amendments: [], artifacts: [], checks: [], results: [], workers: [], resources: {}, pendingUncertain: [] }, summary: ['check still failing'], continuation: { offerId: 'lease-3', instructorCalls: 4, activeMs: 120_000, freshContext: true } };
const ui = (choice: number, amendment = '  narrow the fix  ') => ({ choose: vi.fn(async () => choice), input: vi.fn(async () => amendment) });
afterEach(() => vi.useRealTimers());
const pendingChoice = (_message: string, _choices: string[], _fallback: number, signal: AbortSignal | undefined): Promise<number> =>
  new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));

it('offers continue, bounded redirect, and honest partial as distinct terminal choices', async () => {
  const signal = new AbortController().signal;
  const more = ui(0);
  await expect(terminalCheckpointDecision(checkpoint, more, signal, { interactive: true, json: false, now: () => 1 })).resolves.toEqual({ requestId: 'r2', checkpointId: 2, action: 'continue', offerId: 'lease-3' });
  const redirect = ui(1);
  await expect(terminalCheckpointDecision(checkpoint, redirect, signal, { interactive: true, json: false, now: () => 1 })).resolves.toEqual({ requestId: 'r2', checkpointId: 2, action: 'redirect', offerId: 'lease-3', amendment: 'narrow the fix' });
  expect(redirect.input).toHaveBeenCalledWith('What should change? (blank keeps the checkpoint paused)', undefined, false, expect.any(AbortSignal));
  const partial = ui(2);
  await expect(terminalCheckpointDecision(checkpoint, partial, signal, { interactive: true, json: false, now: () => 1 })).resolves.toEqual({ requestId: 'r2', checkpointId: 2, action: 'finish_partial' });
  expect(partial.input).not.toHaveBeenCalled();
});

it('fails closed for missing offers, blank amendment, expiry, abort, noninteractive, and JSON', async () => {
  const signal = new AbortController().signal;
  const missing = ui(0);
  await expect(terminalCheckpointDecision({ ...checkpoint, continuation: undefined }, missing, signal, { interactive: true, json: false, now: () => 1 })).resolves.toEqual({ requestId: 'r2', checkpointId: 2, action: 'finish_partial' });
  expect(missing.choose).toHaveBeenCalledWith('Checkpoint paused. Use Change direction to steer this task; ordinary messages start the next turn.', ['Finish partial'], 0, expect.any(AbortSignal));
  const blankThenValid = ui(1);
  blankThenValid.input.mockResolvedValueOnce('').mockResolvedValueOnce('new bounded direction');
  await expect(terminalCheckpointDecision(checkpoint, blankThenValid, signal, { interactive: true, json: false, now: () => 1 })).resolves.toEqual({ requestId: 'r2', checkpointId: 2, action: 'redirect', offerId: 'lease-3', amendment: 'new bounded direction' });
  expect(blankThenValid.input).toHaveBeenCalledTimes(2);
  await expect(terminalCheckpointDecision(checkpoint, ui(0), signal, { interactive: true, json: false, now: () => 1000 })).resolves.toBeUndefined();
  await expect(terminalCheckpointDecision(checkpoint, ui(0), signal, { interactive: false, json: false, now: () => 1 })).resolves.toBeUndefined();
  await expect(terminalCheckpointDecision(checkpoint, ui(0), signal, { interactive: true, json: true, now: () => 1 })).resolves.toBeUndefined();
  const aborted = new AbortController(); aborted.abort();
  const neverShown = ui(0);
  await expect(terminalCheckpointDecision(checkpoint, neverShown, aborted.signal, { interactive: true, json: false, now: () => 1 })).resolves.toBeUndefined();
  expect(neverShown.choose).not.toHaveBeenCalled();
});

it('aborts a pending terminal choice and clears its expiry timer', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const pendingUI = { choose: vi.fn(pendingChoice), input: vi.fn(async () => '') };
  const pending = terminalCheckpointDecision({ ...checkpoint, expiresAt: Date.now() + 60_000 }, pendingUI, controller.signal, { interactive: true, json: false });
  expect(vi.getTimerCount()).toBe(1);
  controller.abort();
  await expect(pending).resolves.toBeUndefined();
  expect(pendingUI.choose.mock.calls[0]?.[3]?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('expires while terminal input is still pending instead of accepting late input', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const pendingUI = { choose: vi.fn(pendingChoice), input: vi.fn(async () => '') };
  const pending = terminalCheckpointDecision({ ...checkpoint, expiresAt: Date.now() + 100 }, pendingUI, controller.signal, { interactive: true, json: false });
  await vi.advanceTimersByTimeAsync(100);
  await expect(pending).resolves.toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});
