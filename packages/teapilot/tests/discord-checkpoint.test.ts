import { afterEach, expect, it, vi } from 'vitest';
import type { Checkpoint, CheckpointDecision } from '../src/agents/checkpoint.js';
import { Conversation, TurnQueue, type ConversationOptions, type DiscordTransport } from '../src/discord/bridge.js';
import type { HostResult } from '../src/host.js';

const checkpoint: Checkpoint = { version: 1, requestId: 'r1', checkpointId: 4, sequence: 1, reason: 'instructor_calls', durability: 'request-local', expiresAt: Date.now() + 60_000,
  snapshot: { amendments: [], artifacts: [], checks: [], results: [], workers: [], resources: {}, pendingUncertain: [] }, summary: ['test failed: 0 passed, 1 failed', 'no app published'], modelHandoff: 'try changing the parser', continuation: { offerId: 'lease-2', instructorCalls: 3, activeMs: 90_000, freshContext: true } };
const result: HostResult = { requestId: 'r1', success: false, status: 'partial', text: 'incomplete; draft retained, no app published.', spentUsd: 0, receipts: [], attempts: 1 };
const chats: Array<{ chat: Conversation; controller: AbortController }> = [];
afterEach(async () => { for (const { chat, controller } of chats.splice(0)) { controller.abort(); await chat.done; } });

function setup(run: ConversationOptions['run'], override: Partial<DiscordTransport> = {}) {
  let decide!: (action: 'continue' | 'redirect' | 'finish_partial', user: string, amendment?: string) => CheckpointDecision | undefined;
  let stop!: (user: string) => { text: string };
  let finish!: (decision: CheckpointDecision | undefined) => void;
  const rendered: string[] = [];
  const transport: DiscordTransport = {
    send: vi.fn(async () => 'answer'), edit: vi.fn(async () => {}), typing: vi.fn(),
    card: vi.fn(async (text: string) => { rendered.push(text); return 'status'; }),
    askApproval: vi.fn(async () => false),
    checkpoint: vi.fn((text, _cp, signal, choose, stopTurn) => { rendered.push(text); decide = choose; stop = stopTurn; return new Promise<CheckpointDecision | undefined>(resolve => { finish = resolve; signal.addEventListener('abort', () => resolve(undefined), { once: true }); }); }),
    ...override,
  };
  const controller = new AbortController();
  const chat = new Conversation({ key: 'room', transport, request: { prompt: '', cwd: '.', mode: 'code', signal: controller.signal }, maxPromptChars: 1000, queue: new TurnQueue(), run, redact: value => value, log: vi.fn(), access: { roleOf: (id: string) => id === 'op' ? 'operator' : id === 'asker' ? 'user' : undefined, adminFor: () => undefined, callerFor: () => () => ({ permissions: [] }) } as never, cardDelayMs: 0, progressIntervalMs: 0 });
  chats.push({ chat, controller });
  return { chat, controller, decide: () => decide, stop: () => stop, finish: (decision: CheckpointDecision | undefined) => finish(decision), rendered, transport };
}

it('hands the checkpoint callback through the real Conversation run seam and separates facts from model proposal', async () => {
  let decision: CheckpointDecision | undefined;
  const state = setup(async (_request, deps) => { decision = await deps.onCheckpoint!(checkpoint, new AbortController().signal); return result; });
  state.chat.push('do the task', { sender: 'asker' });
  await vi.waitFor(() => expect(state.decide()).toBeTypeOf('function'));
  expect(state.rendered.join('\n')).toContain('test failed: 0 passed, 1 failed');
  expect(state.rendered.join('\n')).toContain('model proposal (unverified): try changing the parser');
  expect(state.rendered.join('\n')).toContain('3 instructor calls, 2m active, fresh context');
  await vi.waitFor(() => expect(state.rendered.some(text => text.includes('checkpoint — awaiting your choice'))).toBe(true));
  expect(state.decide()('continue', 'stranger')).toBeUndefined();
  expect(state.decide()('redirect', 'op', 'use a different parser')).toEqual({ requestId: 'r1', checkpointId: 4, action: 'redirect', offerId: 'lease-2', amendment: 'use a different parser' });
  expect(state.decide()('finish_partial', 'asker')).toEqual({ requestId: 'r1', checkpointId: 4, action: 'finish_partial' });
  expect(state.stop()('stranger').text).toContain('Only the person who asked');
  const chosen = state.decide()('continue', 'asker');
  expect(chosen).toEqual({ requestId: 'r1', checkpointId: 4, action: 'continue', offerId: 'lease-2' });
  state.finish(chosen);
  await vi.waitFor(() => expect(state.transport.send).toHaveBeenCalledWith(result.text));
  expect(decision).toEqual(chosen);
});

it('fails closed without a continuation offer and returns the exact partial decision', async () => {
  let partialDecision: CheckpointDecision | undefined;
  const state = setup(async (_request, deps) => { const noOffer = { ...checkpoint, continuation: undefined }; partialDecision = await deps.onCheckpoint!(noOffer, new AbortController().signal); return result; });
  state.chat.push('do it', { sender: 'asker' });
  await vi.waitFor(() => expect(state.transport.checkpoint).toHaveBeenCalled());
  expect(state.rendered.join('\n')).toContain('no continuation window remains');
  expect(state.decide()('continue', 'asker')).toBeUndefined();
  expect(state.decide()('redirect', 'asker', 'new plan')).toBeUndefined();
  const partial = state.decide()('finish_partial', 'asker');
  state.finish(partial);
  await vi.waitFor(() => expect(state.transport.send).toHaveBeenCalled());
  expect(partialDecision).toEqual({ requestId: 'r1', checkpointId: 4, action: 'finish_partial' });

});
