import { afterEach, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { completion, events, fixture, mockServer } from './helpers.js';
import { lostCallNotice, runAttempt } from '../src/agents/run.js';
import { RequestRecovery } from '../src/agents/recovery.js';
import { runHost } from '../src/host.js';
import { SpendGovernor } from '../src/inference/budget.js';
import { Telemetry } from '../src/telemetry/outcome.js';
import { RequestAllowance } from '../src/agents/allowance.js';
import { TaskStore } from '../src/workspace/task.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup(handler: Parameters<typeof mockServer>[0]) {
  const f = await fixture(); cleanups.push(f.cleanup);
  const server = await mockServer(handler); cleanups.push(server.close);
  Object.assign(f.config.models.capable, { provider: 'ollama', baseUrl: server.url });
  const telemetry = new Telemetry(f.config.stateDir, 'run-test');
  await telemetry.event('start', {});
  const budget = new SpendGovernor(join(f.config.stateDir, 'spend.jsonl'), 'run-test', f.config.policy.budget);
  return { ...f, budget, telemetry };
}
function multiCompletion(response: import('node:http').ServerResponse, tools: Array<{ id: string; name: string; arguments: unknown }>): void {
  response.setHeader('Content-Type', 'text/event-stream');
  const common = { id: 'multi-tool', object: 'chat.completion.chunk', created: 1, model: 'mock-model' };
  const chunk = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
  chunk({ ...common, choices: [{ index: 0, delta: { role: 'assistant', content: '', tool_calls: tools.map((tool, index) => ({ index, id: tool.id, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } })) }, finish_reason: null }] });
  chunk({ ...common, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  response.end('data: [DONE]\n\n');
}

it('records the written file size and the largest observed tool payload', async () => {
  let calls = 0;
  const content = `<html>${'x'.repeat(200)}</html>`;
  const f = await setup((_body, _req, res) => {
    calls++;
    completion(res, calls === 1 ? { tool: { name: 'write', arguments: { path: 'index.html', content } } } : { text: 'Created index.html.' });
  });
  const result = await runAttempt({ ...f, tier: 'normal', workload: 'coder', web: false, approve: async () => true, prompt: 'Create index.html' });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(result.changedFiles).toEqual(['index.html']);
  expect(result.fileSizes).toEqual({ 'index.html': Buffer.byteLength(content) });
  expect(result.largestToolResult?.tool).toBe('write');
  expect(await readFile(join(f.cwd, 'index.html'), 'utf8')).toBe(content);
});

it('reserves known sibling delegations before the first junior can spend their capacity', async () => {
  let parentCalls = 0, firstJuniorCalls = 0, juniorCount = 0;
  const seenJuniorNames = new Set<string>();
  const f = await setup((body, _req, res) => {
    const messages = body.messages ?? [];
    const system = messages.filter((message: any) => message.role === 'system').map((message: any) => message.content).join('\n');
    const junior = system.match(/You are junior ([^.]*)\./)?.[1];
    if (junior) {
      if (!seenJuniorNames.has(junior)) { seenJuniorNames.add(junior); juniorCount++; }
      if (juniorCount === 1 && firstJuniorCalls === 0) {
        firstJuniorCalls = 6;
        multiCompletion(res, Array.from({ length: 6 }, (_, index) => ({ id: `read-${index}`, name: 'read', arguments: { path: `source-${index}.txt` } })));
      } else completion(res, { tool: { name: 'report', arguments: { status: 'done', summary: 'read the source' } } });
      return;
    }
    if (++parentCalls === 1) multiCompletion(res, [
      { id: 'delegate-a', name: 'delegate_task', arguments: { description: 'Read source first', prompt: 'Read source.txt and report.', agent_type: 'research', artifacts: [] } },
      { id: 'delegate-b', name: 'delegate_task', arguments: { description: 'Read source second', prompt: 'Read source.txt and report.', agent_type: 'research', artifacts: [] } },
    ]);
    else completion(res, { text: 'Both juniors reported.' });
  });
  for (let index = 0; index < 6; index++) await writeFile(join(f.cwd, `source-${index}.txt`), `source evidence ${index}`);
  const scratch = join(f.config.stateDir, 'workspaces', 'session', '.scratch');
  await mkdir(scratch, { recursive: true });
  f.config.policy.limits.maxToolCalls = 20;
  const result = await runAttempt({ ...f, tier: 'normal', workload: 'coder', web: false, approve: async () => true, prompt: 'Delegate two independent reads.', scratch });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(juniorCount).toBe(2);
  const delegated = (await events(f.config)).filter(event => event.type === 'delegate');
  expect(delegated).toHaveLength(2);
  expect(delegated[0]).toMatchObject({ allocation: 7, toolCalls: 7 });
  expect(delegated[1].toolCalls).toBeGreaterThanOrEqual(1);
});

it('pauses the instructor attempt while a post-junior checkpoint decision waits', async () => {
  let parentCalls = 0, approvalDelay = 0, batchesAtDecision = -1;
  const f = await setup((body, _req, res) => {
    const system = (body.messages ?? []).filter((message: any) => message.role === 'system').map((message: any) => message.content).join('\n');
    if (system.includes('You are junior')) completion(res, { tool: { name: 'report', arguments: { status: 'done', summary: 'finished' } } });
    else if (++parentCalls === 1) completion(res, { tool: { name: 'delegate_task', arguments: { description: 'Read source', prompt: 'Read and report.', agent_type: 'research', artifacts: [] } } });
    else completion(res, { text: 'Continued after approval.' });
  });
  const scratch = join(f.config.stateDir, 'workspaces', 'session', '.scratch');
  await mkdir(scratch, { recursive: true });
  f.config.policy.limits.attemptTimeoutMs = 1000;
  f.config.policy.limits.maxJuniorTurns = 3;
  const allowance = new RequestAllowance({ calls: 10, modelCalls: 50, timeoutMs: 10_000, delegations: 3 }, undefined,
    { instructorCalls: 1, juniorCalls: 20, maxContinuationBatches: 1 });
  const result = await runAttempt({ ...f, tier: 'normal', workload: 'coder', web: false, prompt: 'Delegate a read and continue.', scratch, allowance,
    approve: async () => true,
    onCheckpoint: async checkpoint => {
      batchesAtDecision = allowance.continuationBatchesUsed;
      expect(checkpoint.snapshot.workers.some(worker => worker.ref.startsWith('worker:'))).toBe(true);
      const started = Date.now();
      await new Promise(resolve => setTimeout(resolve, 1200));
      approvalDelay = Date.now() - started;
      return { requestId: checkpoint.requestId, checkpointId: checkpoint.checkpointId, action: 'continue', offerId: checkpoint.continuation!.offerId };
    } });
  expect(approvalDelay).toBeGreaterThan(1000);
  expect(batchesAtDecision).toBe(0);
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(result.text).toContain('Continued');
});

it('warns before the instructor lease ends, pauses at a checkpoint, and resumes with the same request counters', async () => {
  let providerCalls = 0;
  const checkpointWait = { start: 0, end: 0, providerCallsWhileWaiting: 0 };
  const f = await setup((_body, _req, res) => {
    const call = ++providerCalls;
    if (call <= 3) completion(res, { tool: { name: 'read', arguments: { path: `checkpoint-${call}.txt` } } });
    else completion(res, { text: call === 4 ? 'Three reads are complete; no check was run. Next: inspect the requested change.' : 'Finished from the inspected evidence.' });
  });
  for (let index = 1; index <= 3; index++) await writeFile(join(f.cwd, `checkpoint-${index}.txt`), `evidence ${index}`);
  const allowance = new RequestAllowance({ calls: 10, modelCalls: 20, timeoutMs: 60_000, delegations: 2 }, undefined,
    { instructorCalls: 4, juniorCalls: 20, maxContinuationBatches: 1 });
  const result = await runAttempt({ ...f, tier: 'normal', workload: 'coder', web: false, approve: async () => true, prompt: 'Read three independent files and report.', allowance,
    onCheckpoint: async checkpoint => {
      checkpointWait.start++;
      checkpointWait.providerCallsWhileWaiting = providerCalls;
      expect(checkpoint).toMatchObject({ reason: 'instructor_calls', durability: 'request-local', continuation: { instructorCalls: 4 } });
      await new Promise(resolve => setTimeout(resolve, 30));
      checkpointWait.end++;
      return { requestId: checkpoint.requestId, checkpointId: checkpoint.checkpointId, action: 'continue', offerId: checkpoint.continuation!.offerId };
    } });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(result.toolCalls).toBe(3);
  expect(allowance.remaining()).toMatchObject({ calls: 7, modelCalls: 15 });
  expect(allowance.remaining().ms).toBeLessThan(59_950);
  expect(allowance.continuationBatchesUsed).toBe(1);
  expect(checkpointWait).toEqual({ start: 1, end: 1, providerCallsWhileWaiting: 4 });
  expect(providerCalls).toBe(5);
});

it('declares no handoff tools and redeclares real tools before a checkpoint resume without legacy autoapproval', async () => {
  const toolSets: string[][] = [];
  let providerCalls = 0, legacyApprovals = 0, batchesAtCheckpoint = -1;
  const f = await setup((body, _req, res) => {
    providerCalls++;
    const declared = (body.tools ?? []).map((tool: any) => tool.function.name);
    toolSets.push(declared);
    if (providerCalls === 1) {
      if (!declared.includes('read')) return completion(res, { text: 'read was not declared' });
      completion(res, { tool: { name: 'read', arguments: { path: 'checkpoint-1.txt' } } });
    } else if (providerCalls === 2) {
      if (declared.length) return completion(res, { text: 'handoff unexpectedly had tools' });
      completion(res, { text: 'one read completed; no check was run.' });
    } else {
      if (!declared.includes('read')) return completion(res, { text: 'resume tools were not declared' });
      completion(res, { text: 'Continued with the original objective.' });
    }
  });
  await writeFile(join(f.cwd, 'checkpoint-1.txt'), 'evidence');
  const allowance = new RequestAllowance({ calls: 10, modelCalls: 20, timeoutMs: 60_000, delegations: 2 }, undefined,
    { instructorCalls: 1, juniorCalls: 20, maxContinuationBatches: 1 });
  const result = await runAttempt({ ...f, tier: 'normal', workload: 'coder', web: false, prompt: 'Inspect the file.', allowance,
    approve: async () => { legacyApprovals++; return true; },
    onCheckpoint: async checkpoint => {
      batchesAtCheckpoint = allowance.continuationBatchesUsed;
      expect(checkpoint.modelHandoff).toContain('one read completed');
      expect(checkpoint.snapshot.results).toContainEqual(expect.objectContaining({ ref: expect.stringMatching(/^(receipt|toolcall|saved-output):/), summary: expect.stringContaining('read succeeded') }));
      return { requestId: checkpoint.requestId, checkpointId: checkpoint.checkpointId, action: 'continue', offerId: checkpoint.continuation!.offerId };
    } });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(toolSets).toHaveLength(3);
  expect(toolSets[0]).toContain('read');
  expect(toolSets[1]).toEqual([]);
  expect(toolSets[2]).toContain('read');
  expect(batchesAtCheckpoint).toBe(0);
  expect(legacyApprovals).toBe(0);
});

it('stops with a host checkpoint when no explicit decision handler is present', async () => {
  let providerCalls = 0, toolCalls = 0;
  const f = await setup((_body, _req, res) => {
    if (++providerCalls === 1) completion(res, { tool: { name: 'read', arguments: { path: 'checkpoint-partial.txt' } } });
    else completion(res, { text: 'one file was inspected; no verification was run.' });
  });
  await writeFile(join(f.cwd, 'checkpoint-partial.txt'), 'known evidence');
  const allowance = new RequestAllowance({ calls: 10, modelCalls: 20, timeoutMs: 60_000, delegations: 2 }, undefined,
    { instructorCalls: 1, juniorCalls: 20, maxContinuationBatches: 0 });
  const result = await runAttempt({ ...f, tier: 'normal', workload: 'coder', web: false, approve: async () => true, prompt: 'Inspect the file.', allowance,
    onEvent: event => { if (event.type === 'tool_execution_end' && event.tool === 'read') toolCalls++; } });
  expect(result).toMatchObject({ success: false, stopped: 'checkpoint', checkpoint: { reason: 'instructor_calls', durability: 'request-local' } });
  expect(result.text).toContain('one file was inspected');
  expect(toolCalls).toBe(1);
  expect(providerCalls).toBe(2);
  expect(allowance.remaining().calls).toBe(9);
});

it('accepts a redirect amendment without replacing the original objective and rejects stale checkpoint identities', async () => {
  let providerCalls = 0, redirectedMessages = '';
  const f = await setup((body, _req, res) => {
    const call = ++providerCalls;
    if (call === 1) completion(res, { tool: { name: 'read', arguments: { path: 'redirect-evidence.txt' } } });
    else if (call === 2) completion(res, { text: 'Read the source; no check was run.' });
    else { redirectedMessages = JSON.stringify(body.messages); completion(res, { text: 'Applied the amendment while retaining the original task.' }); }
  });
  await writeFile(join(f.cwd, 'redirect-evidence.txt'), 'source fact');
  const allowance = new RequestAllowance({ calls: 10, modelCalls: 20, timeoutMs: 60_000, delegations: 2 }, undefined,
    { instructorCalls: 1, juniorCalls: 20, maxContinuationBatches: 1 });
  const redirected = await runAttempt({ ...f, tier: 'normal', workload: 'coder', web: false, prompt: 'Inspect the source.', currentRequest: 'Original host objective: inspect the source.', approve: async () => true, allowance,
    onCheckpoint: async checkpoint => ({ requestId: checkpoint.requestId, checkpointId: checkpoint.checkpointId, action: 'redirect', offerId: checkpoint.continuation!.offerId, amendment: 'focus the report on deployment risks' }) });
  expect(redirected.success).toBe(true);
  expect(redirectedMessages).toContain('Original host objective: inspect the source.');
  expect(redirectedMessages).toContain('focus the report on deployment risks');

  let staleCalls = 0;
  const stale = await setup((_body, _req, res) => {
    staleCalls++;
    completion(res, staleCalls === 1 ? { tool: { name: 'read', arguments: { path: 'redirect-evidence.txt' } } } : { text: 'partial handoff' });
  });
  await writeFile(join(stale.cwd, 'redirect-evidence.txt'), 'source fact');
  const staleAllowance = new RequestAllowance({ calls: 10, modelCalls: 20, timeoutMs: 60_000, delegations: 2 }, undefined,
    { instructorCalls: 1, juniorCalls: 20, maxContinuationBatches: 1 });
  const partial = await runAttempt({ ...stale, tier: 'normal', workload: 'coder', web: false, prompt: 'Inspect the source.', approve: async () => true, allowance: staleAllowance,
    onCheckpoint: async checkpoint => ({ requestId: checkpoint.requestId, checkpointId: checkpoint.checkpointId + 1, action: 'continue', offerId: checkpoint.continuation!.offerId }) });
  expect(partial).toMatchObject({ success: false, stopped: 'checkpoint' });
  expect(staleCalls).toBe(2);
  expect(staleAllowance.continuationBatchesUsed).toBe(0);
});

it('rejects a late checkpoint decision even when its request and offer ids match', async () => {
  let providerCalls = 0;
  const f = await setup((_body, _req, res) => {
    providerCalls++;
    completion(res, providerCalls === 1 ? { tool: { name: 'read', arguments: { path: 'redirect-evidence.txt' } } } : { text: 'handoff facts' });
  });
  await writeFile(join(f.cwd, 'redirect-evidence.txt'), 'source fact');
  const allowance = new RequestAllowance({ calls: 10, modelCalls: 20, timeoutMs: 60_000, delegations: 2 }, undefined,
    { instructorCalls: 1, juniorCalls: 20, maxContinuationBatches: 1 });
  const now = Date.now;
  let result;
  try {
    result = await runAttempt({ ...f, tier: 'normal', workload: 'coder', web: false, prompt: 'Inspect the source.', approve: async () => true, allowance,
      onCheckpoint: async checkpoint => {
        Date.now = () => checkpoint.expiresAt + 1;
        return { requestId: checkpoint.requestId, checkpointId: checkpoint.checkpointId, action: 'continue', offerId: checkpoint.continuation!.offerId };
      } });
  } finally { Date.now = now; }
  expect(result).toMatchObject({ success: false, stopped: 'checkpoint' });
  expect(providerCalls).toBe(2);
  expect(allowance.continuationBatchesUsed).toBe(0);
});

it('cancellation during a checkpoint decision wins over a late continue and admits no extra tool', async () => {
  let providerCalls = 0;
  const f = await setup((body, _req, res) => {
    providerCalls++;
    completion(res, (body.tools ?? []).some((tool: any) => tool.function.name === 'read') ? { tool: { name: 'read', arguments: { path: 'source.txt' } } } : { text: 'one read completed; stop before continuing.' });
  });
  await writeFile(join(f.cwd, 'source.txt'), 'source');
  const scratch = join(f.config.stateDir, 'workspaces', 'session', '.scratch');
  await mkdir(scratch, { recursive: true });
  const task = TaskStore.open(f.config.stateDir, 'cancel-after-gate', 'read source', scratch);
  task.startRequest('cancel-request', { calls: 10, modelCalls: 50, timeoutMs: 10_000, instructorCalls: 1, juniorCalls: 20, maxContinuationBatches: 2 });
  const controller = new AbortController();
  const result = await runAttempt({ ...f, tier: 'normal', workload: 'coder', web: false, prompt: 'Read source.', scratch, task, signal: controller.signal,
    approve: async () => true,
    onCheckpoint: async checkpoint => {
      queueMicrotask(() => controller.abort());
      return { requestId: checkpoint.requestId, checkpointId: checkpoint.checkpointId, action: 'continue', offerId: checkpoint.continuation!.offerId };
    } });
  expect(result.stopped, JSON.stringify(result)).toBe('cancelled');
  expect(providerCalls).toBe(2);
  expect(task.remaining().calls).toBe(9);
  expect(task.snapshot().receipts).toHaveLength(1);
  expect(task.toolBudget()).toMatchObject({ instructorCalls: 1, instructorGranted: 1, continuationBatches: 0 });
});

it('does not execute queued tool suffix after the grant ends and returns a checkpoint partial', async () => {
  let providerCalls = 0, continuationApprovals = 0;
  const f = await setup((_body, _req, res) => {
    providerCalls++;
    if (providerCalls === 1) multiCompletion(res, [
      { id: 'read-first', name: 'read', arguments: { path: 'first.txt' } },
      { id: 'read-second', name: 'read', arguments: { path: 'second.txt' } },
    ]);
    else completion(res, { text: 'I read the first file; the second read was not approved, so this is my partial synthesis.' });
  });
  await writeFile(join(f.cwd, 'first.txt'), 'first evidence');
  await writeFile(join(f.cwd, 'second.txt'), 'second evidence');
  const scratch = join(f.config.stateDir, 'workspaces', 'session', '.scratch');
  await mkdir(scratch, { recursive: true });
  const task = TaskStore.open(f.config.stateDir, 'denied-queued-tools', 'synthesize source', scratch);
  task.startRequest('denied-request', { calls: 10, modelCalls: 40, timeoutMs: 20_000, instructorCalls: 1, juniorCalls: 20, maxContinuationBatches: 2 });
  const result = await runAttempt({ ...f, tier: 'normal', workload: 'coder', web: false, prompt: 'Read both files and summarize.', scratch, task,
    approve: async approval => {
      if (approval.kind === 'continuation_budget') { continuationApprovals++; return false; }
      return true;
    } });
  expect(result.success, JSON.stringify(result)).toBe(false);
  expect(result.stopped).toBe('checkpoint');
  expect(result.text).toContain('partial synthesis');
  expect(providerCalls).toBe(2);
  expect(continuationApprovals).toBe(0);
  expect(task.snapshot().request).toMatchObject({ calls: 1, continuationDenied: false });
  expect(task.snapshot().receipts).toHaveLength(1);
  expect(task.snapshot().receipts[0]).toMatchObject({ tool: 'read', status: 'succeeded' });
  expect(result.toolCalls).toBe(1);
});

it('streams redacted reasoning to callers that ask, and says what a tool is about to run', async () => {
  let calls = 0;
  const f = await setup((_body, _req, res) => {
    calls++;
    completion(res, calls === 1 ? { reasoning: 'check with hunter2', tool: { name: 'read', arguments: { path: 'missing.txt' } } } : { text: 'Nothing there.' });
  });
  f.config.secrets = { ...f.config.secrets, fast: 'hunter2' };
  const reasoning: string[] = [];
  const starts: unknown[] = [];
  await runAttempt({ ...f, tier: 'normal', workload: 'coder', web: false, approve: async () => true, prompt: 'read it',
    onReasoning: text => reasoning.push(text), onEvent: event => { if (event.type === 'tool_execution_start') starts.push(event); } });
  expect(reasoning.join('')).toBe('check with [REDACTED]');
  expect(starts).toEqual([{ type: 'tool_execution_start', tool: 'read', path: 'missing.txt' }]);
});

it('does not size a failed write and records no observed edit', async () => {
  const f = await setup((_body, _req, res) => completion(res, { text: 'No tools used.' }));
  const result = await runAttempt({ ...f, tier: 'normal', workload: 'ask', web: false, approve: async () => true, prompt: 'hello' });
  expect(result.success).toBe(true);
  expect(result.changedFiles).toEqual([]);
  expect(result.fileSizes).toEqual({});
});

/** A reply that ends to call a tool but carries no call, as a model server sends when it cannot parse one. */
function lostCall(res: import('node:http').ServerResponse, eosReason?: string, tool?: { name: string; arguments: unknown }, rawArguments?: string) {
  res.setHeader('Content-Type', 'text/event-stream');
  const common = { id: 'mock-chat', object: 'chat.completion.chunk', created: 1, model: 'mock-model' };
  res.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: 'assistant', content: '', ...(tool ? { tool_calls: [{ index: 0, id: 'partial', type: 'function', function: { name: tool.name, arguments: rawArguments ?? JSON.stringify(tool.arguments) } }] } : {}) }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls', ...(eosReason ? { eos_reason: eosReason } : {}) }] })}\n\n`);
  res.end('data: [DONE]\n\n');
}

it('asks again after a tool call the server announced but did not send, then gives up as a provider error', async () => {
  const bodies: any[] = [];
  const f = await setup((body, _req, res) => { bodies.push(body); if (bodies.length === 1) lostCall(res); else completion(res, { text: 'Hello.' }); });
  const result = await runAttempt({ ...f, tier: 'normal', workload: 'ask', web: false, approve: async () => true, prompt: 'hello' });
  expect(result.success).toBe(true);
  expect(JSON.stringify(bodies[1].messages)).toContain('announced a tool call but sent no usable call');

  const stuck = await setup((_body, _req, res) => lostCall(res));
  const failed = await runAttempt({ ...stuck, tier: 'normal', workload: 'ask', web: false, approve: async () => true, prompt: 'hello' });
  expect(failed.success).toBe(false);
  expect(failed.reason).toBe('provider_error');
  expect(failed.turns).toBe(3);
  expect(failed.ending).toMatchObject({ stopReason: 'toolUse', textChars: 0 });
});

it('diagnoses provider token loops and never executes even parsed loop-truncated mutations', async () => {
  const bodies: any[] = [];
  const f = await setup((body, _req, res) => {
    bodies.push(body);
    if (bodies.length === 1) lostCall(res, 'loop_detected', { name: 'write', arguments: { path: 'unsafe.txt', content: 'partial' } });
    else completion(res, { text: 'The generation loop stopped; nothing changed.' });
  });
  const result = await runAttempt({ ...f, tier: 'normal', workload: 'coder', web: false, approve: async () => true, prompt: 'write a file' });
  expect(result.success).toBe(true);
  expect(result.toolCalls).toBe(0);
  expect(JSON.stringify(bodies[1].messages)).toContain('detected a token loop');
  await expect(readFile(join(f.cwd, 'unsafe.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await events(f.config)).find(event => event.type === 'provider_termination')).toMatchObject({ eosReason: 'loop_detected', toolData: true, parsedCalls: 1 });
});

it('keeps missing-call recovery limits across attempts on the same model', async () => {
  const f = await setup((_body, _req, res) => lostCall(res, 'loop_detected'));
  const recovery = new RequestRecovery();
  const input = { ...f, tier: 'normal' as const, workload: 'ask' as const, web: false, approve: async () => true, prompt: 'hello', recovery };
  expect((await runAttempt(input)).turns).toBe(3);
  expect((await runAttempt(input)).turns).toBe(1);
});

it.each(['max_new_tokens', 'malformed'])('never executes %s tool arguments even if pi can salvage a partial call', async cause => {
  let calls = 0;
  const f = await setup((_body, _req, res) => {
    if (++calls === 1) lostCall(res, cause === 'malformed' ? undefined : cause,
      { name: 'write', arguments: { path: 'unsafe.txt', content: 'partial' } },
      cause === 'malformed' ? '{"path":"unsafe.txt","content":"partial' : undefined);
    else completion(res, { text: 'Nothing was written.' });
  });
  const result = await runAttempt({ ...f, tier: 'normal', workload: 'coder', web: false, approve: async () => true, prompt: 'write a file' });
  expect(result.success).toBe(true);
  expect(result.toolCalls).toBe(0);
  await expect(readFile(join(f.cwd, 'unsafe.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await events(f.config)).find(event => event.type === 'provider_termination')).toMatchObject(cause === 'malformed' ? { malformedTools: true } : { eosReason: cause });
});

it('reports a confirmed provider loop without blaming size or retrying it under another tier name', async () => {
  const f = await setup((_body, _req, res) => lostCall(res, 'loop_detected'));
  f.config.routingMode = 'direct';
  const result = await runHost(f.config, { cwd: f.cwd, workload: 'ask', tier: 'normal', prompt: 'hello' }, { approve: async () => true, localProbe: async () => true });
  expect(result).toMatchObject({ success: false, attempts: 1, status: 'escalation_unavailable' });
  expect(result.text).toContain('the provider stopped a token loop');
  expect(result.text).not.toContain('raise maxOutputTokens');
});

it('distinguishes token limits, malformed protocol and unknown missing calls without guessing size', () => {
  expect(lostCallNotice({ finishReason: 'length', toolData: false, parsedCalls: 0, outputLimit: 100 })).toContain('output-token limit');
  expect(lostCallNotice({ toolData: true, parsedCalls: 0, outputLimit: 100 })).toContain('no usable call remained');
  expect(lostCallNotice()).toContain('cause is unknown');
});

it('does not count identical writes and edits as changes or invalidate a successful check', async () => {
  let calls = 0;
  const f = await setup((_body, _req, res) => {
    calls++;
    completion(res, calls === 1 ? { tool: { name: 'write', arguments: { path: 'same.txt', content: 'same\n' } } }
      : calls === 2 ? { tool: { name: 'edit', arguments: { path: 'same.txt', edits: [{ oldText: 'same', newText: 'same' }] } } }
      : { text: 'The file was already correct; nothing changed.' });
  });
  await writeFile(join(f.cwd, 'same.txt'), 'same\n');
  const result = await runAttempt({ ...f, tier: 'normal', workload: 'coder', web: false, approve: async () => true, prompt: 'check this file' });
  expect(result.success).toBe(true);
  expect(result.changedFiles).toEqual([]);
  expect(result.fileSizes).toEqual({});
  expect(JSON.stringify(result.steps)).toContain('no change: oldText and newText are identical');
});

it('does not inject generic workflow tips for ordinary file writes', async () => {
  const bodies: any[] = [];
  const f = await setup((body, _req, res) => {
    bodies.push(body);
    const files = ['a.py', 'b.py', 'c.py'];
    completion(res, bodies.length <= files.length ? { tool: { name: 'write', arguments: { path: files[bodies.length - 1], content: 'print(1)\n' } } } : { text: 'Done.' });
  });
  const result = await runAttempt({ ...f, tier: 'normal', workload: 'coder', web: false, approve: async () => true, prompt: 'Write three scripts' });
  expect(result.success, JSON.stringify(result)).toBe(true);
  const sent = JSON.stringify(bodies.at(-1).messages);
  expect(sent).not.toContain('[tip]');
  expect((await events(f.config)).filter(event => event.type === 'tip')).toEqual([]);
});
