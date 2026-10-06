import { expect, it, vi } from 'vitest';
import { RequestAllowance, resolveToolBudget } from '../src/agents/allowance.js';

const limits = { calls: 12, modelCalls: 8, timeoutMs: 1000, delegations: 2 };
it('shares tool, model, delegation and junior accounting without durable task state', () => {
  const allowance = new RequestAllowance(limits);
  expect(allowance.consumeTool()).toBe(true);
  expect(allowance.consumeTool('junior-alfa')).toBe(true);
  expect(allowance.consumeTool('junior-alfa')).toBe(true);
  expect(allowance.usedBy('junior-alfa')).toBe(2);
  // Juniors draw from their own pool, the request's size unless set.
  expect(allowance.remaining().calls).toBe(11);
  expect(allowance.juniorRemaining()).toBe(10);
  expect(allowance.consumeDelegation()).toBe(true);
  expect(allowance.consumeDelegation()).toBe(true);
  expect(allowance.consumeDelegation()).toBe(false);
  for (let index = 0; index < 8; index++) expect(allowance.consumeModel()).toBe(true);
  expect(allowance.consumeModel()).toBe(false);
  for (let index = 0; index < 11; index++) expect(allowance.consumeTool()).toBe(true);
  expect(allowance.consumeTool()).toBe(false);
  expect(allowance.consumeTool('junior-alfa')).toBe(true);
});

it('keeps the junior pool apart from the instructor pool, so neither starves the other', () => {
  const allowance = new RequestAllowance({ calls: 4, modelCalls: 8, timeoutMs: 1000, delegations: 6 }, undefined, { juniorPool: 3 });
  for (let index = 0; index < 4; index++) expect(allowance.consumeTool()).toBe(true);
  expect(allowance.consumeTool()).toBe(false);
  expect(allowance.callsRemainingFor('junior-alfa')).toBe(3);
  for (let index = 0; index < 3; index++) expect(allowance.consumeTool('junior-alfa')).toBe(true);
  expect(allowance.consumeTool('junior-bravo')).toBe(false);
  expect(allowance.poolRemaining('junior-bravo')).toBe(0);
  expect(allowance.remaining().calls).toBe(0);
  const config = { policy: { limits: { maxToolCalls: 40, planningToolCalls: 24 } } } as any;
  expect(resolveToolBudget(config).juniorPool).toBe(40);
  expect(resolveToolBudget(config, { readOnly: true }).juniorPool).toBe(24);
  expect(resolveToolBudget({ policy: { limits: { ...config.policy.limits, juniorPoolCalls: 60 } } } as any).juniorPool).toBe(60);
});
it('does not pause the shared deadline for juniors or compaction', () => {
  vi.useFakeTimers();
  try {
    const allowance = new RequestAllowance(limits);
    vi.advanceTimersByTime(1001);
    expect(allowance.consumeTool('junior-alfa')).toBe(false);
    expect(allowance.consumeModel()).toBe(false);
    expect(allowance.usedBy('junior-alfa')).toBe(0);
  } finally { vi.useRealTimers(); }
});

it('renews only instructor grants, with two bounded batches and a request-local denial latch', async () => {
  const allowance = new RequestAllowance({ calls: 5, modelCalls: 8, timeoutMs: 1000, delegations: 6 }, undefined,
    { instructorCalls: 2, juniorCalls: 2, maxContinuationBatches: 2 });
  const approve = vi.fn(async () => true);
  expect(allowance.consumeTool()).toBe(true);
  expect(allowance.consumeTool()).toBe(true);
  expect(await allowance.ensureInstructor(undefined, approve)).toBe('ready');
  expect(approve).toHaveBeenCalledTimes(1);
  expect(allowance.consumeTool('junior-one')).toBe(true);
  expect(allowance.consumeTool('junior-one')).toBe(true);
  expect(allowance.consumeTool('junior-one')).toBe(false);
  expect(allowance.consumeTool()).toBe(true);
  expect(allowance.consumeTool()).toBe(true);
  expect(await allowance.ensureInstructor(undefined, approve)).toBe('ready');
  expect(allowance.consumeTool()).toBe(true);
  expect(allowance.consumeTool()).toBe(false);
  expect(await allowance.ensureInstructor(undefined, approve)).toBe('exhausted');
  expect(approve).toHaveBeenCalledTimes(2);
});

it('denial cannot prompt repeatedly or admit further instructor calls in the same process', async () => {
  const allowance = new RequestAllowance({ calls: 4, modelCalls: 4, timeoutMs: 1000, delegations: 2 }, undefined,
    { instructorCalls: 1, maxContinuationBatches: 2 });
  const approve = vi.fn(async () => false);
  expect(allowance.consumeTool()).toBe(true);
  expect(await allowance.ensureInstructor(undefined, approve)).toBe('denied');
  expect(await allowance.ensureInstructor(undefined, approve)).toBe('denied');
  expect(allowance.consumeTool()).toBe(false);
  expect(approve).toHaveBeenCalledTimes(1);
});

it('keeps aggregate hard capacity and planning initial grants separate from instructor sublimits', async () => {
  const allowance = new RequestAllowance({ calls: 40, modelCalls: 8, timeoutMs: 1000, delegations: 6 }, undefined,
    { instructorCalls: 20, maxContinuationBatches: 2 });
  const approve = vi.fn(async () => true);
  for (let index = 0; index < 20; index++) expect(allowance.consumeTool()).toBe(true);
  expect(await allowance.ensureInstructor(undefined, approve)).toBe('ready');
  expect(allowance.callsRemainingFor()).toBe(20);
  expect(approve).toHaveBeenCalledTimes(1);

  const config = { policy: { limits: { maxToolCalls: 24, instructorToolCalls: 20, juniorToolCalls: 20, maxContinuationBatches: 2 } } } as any;
  expect(resolveToolBudget(config, { readOnly: true })).toMatchObject({ instructorCalls: 24, maxContinuationBatches: 0 });
  expect(resolveToolBudget(config, { side: true })).toMatchObject({ instructorCalls: 24, maxContinuationBatches: 0 });
});

it('fairly reserves queued delegations, keeps sibling capacity unavailable, refuses a duplicate name past its cap, and releases suffixes', () => {
  const allowance = new RequestAllowance({ calls: 60, modelCalls: 20, timeoutMs: 1000, delegations: 4 }, undefined,
    { instructorCalls: 60, juniorCalls: 20, maxContinuationBatches: 0 });
  allowance.reserveQueuedTools([
    { id: 'one', name: 'delegate_task' }, { id: 'two', name: 'delegate_task' },
  ]);
  expect(allowance.reservedJuniorCalls('one')).toBe(20);
  expect(allowance.reservedJuniorCalls('two')).toBe(20);
  expect(allowance.bindReservation('one', 'junior-a')).toBe(true);
  expect(allowance.canAdmitTool('child-tool', 'junior-a', 'one')).toBe(true);
  expect(allowance.canAdmitTool('child-tool', 'junior-a', 'two')).toBe(false);
  for (let i = 0; i < 20; i++) {
    expect(allowance.consumeTool('junior-a')).toBe(true);
    allowance.commitToolAdmission('child-tool', 'junior-a', 'one');
  }
  expect(allowance.reservedJuniorCalls('two')).toBe(20);
  allowance.finishQueuedBatch();
  expect(allowance.canAdmitTool('free-call')).toBe(true);

  allowance.reserveQueuedTools([
    { id: 'same-a', name: 'delegate_task', junior: 'junior-x' },
    { id: 'same-b', name: 'delegate_task', junior: 'junior-x' },
  ]);
  // One junior's cap is not split into shares too small to work: the duplicate is refused.
  expect(allowance.reservedJuniorCalls('same-a')).toBe(20);
  expect(allowance.reservedJuniorCalls('same-b')).toBe(0);

  const tight = new RequestAllowance({ calls: 9, modelCalls: 20, timeoutMs: 1000, delegations: 4 }, undefined,
    { instructorCalls: 9, juniorCalls: 20, maxContinuationBatches: 0 });
  tight.reserveQueuedTools([{ id: 'first', name: 'delegate_task' }, { id: 'suffix', name: 'delegate_task' }]);
  // Too few for two juniors to work: the first gets a workable share, the suffix is refused.
  expect(tight.reservedJuniorCalls('first')).toBe(8);
  expect(tight.reservedJuniorCalls('suffix')).toBe(0);
});
