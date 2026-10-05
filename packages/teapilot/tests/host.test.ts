import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { runHost } from '../src/host.js';
import { SessionGrants } from '../src/execution/grants.js';
import { completion, events, fixture, jev, mockServer, type Handler } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup(handler: Handler) {
  const f = await fixture(); cleanups.push(f.cleanup);
  const server = await mockServer(handler); cleanups.push(server.close);
  f.config.router.endpoint = `${server.url}/jev`;
  f.config.models.fast.baseUrl = `${server.url}/fast/v1`;
  f.config.models.capable.baseUrl = `${server.url}/capable/v1`;
  return f;
}

describe('real JevRouter SDK + pi loop with mock HTTP providers', () => {
  it('acknowledges a stop before execution without workspace warnings', async () => {
    const f = await fixture(); cleanups.push(f.cleanup);
    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'do a task', signal: AbortSignal.abort() }, {
      approve: async () => true, localProbe: async () => true,
    });
    expect(result).toMatchObject({ success: false, status: 'cancelled', text: 'stopped', interruption: { reason: 'cancelled', edits: [], shellRan: false } });
  });

  it.each(['write', 'bash'])('retains partial-work facts when stopped after %s', async tool => {
    const controller = new AbortController();
    const f = await setup((_body, req, res) => {
      if (req.url === '/jev') jev(res, 'coder.normal');
      else if (req.url?.endsWith('/models')) res.end('{}');
      else completion(res, { tool: tool === 'write'
        ? { name: 'write', arguments: { path: 'partial.txt', content: 'keep me\n' } }
        : { name: 'bash', arguments: { command: 'echo partial work' } } });
    });
    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'make a change', signal: controller.signal }, {
      approve: async () => true, localProbe: async () => true,
      onEvent: event => { if (event.type === 'tool_execution_end' && event.tool === tool) controller.abort(); },
    });
    expect(controller.signal.aborted).toBe(true);
    expect(result.status).toBe('cancelled');
    expect(result.text).not.toMatch(/Incomplete:|Next:|rollback|retry/);
    if (tool === 'write') {
      expect(result.text).toContain('stopped — edits to `partial.txt` are still there.');
      expect(result.text).toContain('those edits haven’t been checked.');
      expect(result.interruption?.edits).toEqual([{ path: 'partial.txt', size: 8 }]);
      expect(await readFile(join(f.cwd, 'partial.txt'), 'utf8')).toBe('keep me\n');
    } else {
      expect(result.text).toContain('stopped — commands ran, so there may be changes.');
      expect(result.interruption).toMatchObject({ shellRan: true, edits: [] });
    }
  });

  it('routes follow-ups using recent history while dropping oversized older turns', async () => {
    let routedHistory: unknown;
    const recent = { user: 'Suggest two changes to this repository.', assistant: 'First: rename a variable. Second: add validation.' };
    const f = await setup((body, req, res) => {
      if (req.url === '/jev') { routedHistory = body.state.context.history; jev(res, 'coder.normal'); }
      else completion(res, { text: 'Inspected the requested change.' });
    });
    f.config.policy.limits.maxPromptChars = 20000;
    f.config.models.capable.contextTokens = 32768;
    const result = await runHost(f.config, {
      cwd: f.cwd, prompt: 'Implement the second option',
      history: [{ user: '旧'.repeat(14000), assistant: 'Earlier discussion' }, recent],
    }, { approve: async () => false, localProbe: async () => true });
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(routedHistory).toEqual([recent]);
  });

  it('cancels pending routing, releases the lock, and retains the charge despite a late reply', async () => {
    const f = await fixture(); cleanups.push(f.cleanup);
    const controller = new AbortController();
    let resolveRoute!: (value: any) => void;
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const approve = vi.fn(async () => true);
    const pending = runHost(f.config, { cwd: f.cwd, prompt: 'Explain a topic', workload: 'ask', signal: controller.signal }, {
      approve, localProbe: async () => true,
      provider: { name: 'pending', decide: (_request, signal) => {
        expect(signal).toBe(controller.signal);
        markStarted();
        return new Promise(resolve => { resolveRoute = resolve; });
      } },
    });
    await started;
    controller.abort();
    const result = await pending;
    expect(result.status).toBe('cancelled');
    expect(result.attempts).toBe(0);
    expect(result.spentUsd).toBe(f.config.router.maxCallUsd);
    expect(approve).not.toHaveBeenCalled();
    await expect(stat(join(f.config.stateDir, 'run.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    const ledger = await readFile(join(f.config.stateDir, 'spend.jsonl'), 'utf8');
    resolveRoute({ answers: {}, usage: { cost: 0 } });
    await new Promise(resolve => setImmediate(resolve));
    expect(await readFile(join(f.config.stateDir, 'spend.jsonl'), 'utf8')).toBe(ledger);
  });

  it('routes ask with no filesystem/shell tools, records receipts and actual usage', async () => {
    let sentTools: string[] = [];
    const f = await setup((body, req, res) => {
      if (req.url === '/jev') { expect(body.questions.tool.criteria['ask.normal']).toContain('context_tokens'); jev(res, 'ask.normal'); }
      else if (req.url?.endsWith('/models')) { res.end('{}'); }
      else { sentTools = body.tools.map((tool: any) => tool.function.name); completion(res, { text: 'A clear explanation.', cost: 0 }); }
    });
    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Explain dependency injection' }, { approve: async () => false });
    expect(result.success).toBe(true);
    expect(result.capability).toBe('ask.normal');
    expect(sentTools).toEqual(['request_escalation']);
    const receipt = JSON.parse(await readFile(result.receipts[0]!, 'utf8'));
    expect(receipt.provenance.candidate_snapshot_hash).toMatch(/^sha256:/);
    expect(receipt.raw_jev.answers.tool.choice).toBe('ask.normal');
    const usage = (await events(f.config)).find(e => e.type === 'usage' && e.stage === 'inference');
    expect(usage.usage.totalTokens).toBe(140);
    expect(usage.firstTokenMs).toEqual(expect.any(Number));
  });

  it('returns an explicit non-success partial host result for an undecided checkpoint', async () => {
    let inference = 0;
    const f = await setup((_body, req, res) => {
      if (req.url === '/jev') jev(res, 'coder.normal');
      else if (req.url?.endsWith('/models')) res.end('{}');
      else if (++inference === 1) completion(res, { tool: { name: 'read', arguments: { path: 'evidence.txt' } } });
      else completion(res, { text: 'Read one file; no check was run.' });
    });
    await writeFile(join(f.cwd, 'evidence.txt'), 'bounded fact');
    f.config.policy.limits.instructorToolCalls = 1;
    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Inspect the evidence.', workload: 'coder' }, {
      approve: async () => true, localProbe: async () => true,
      onCheckpoint: async checkpoint => ({ requestId: checkpoint.requestId, checkpointId: checkpoint.checkpointId, action: 'finish_partial' }),
    });
    expect(result).toMatchObject({ success: false, status: 'partial', checkpoint: { reason: 'instructor_calls', durability: 'request-local' } });
    expect(result.text).toContain('work is partial, not complete');
    expect(result.checkpoint?.snapshot.results.length).toBeGreaterThan(0);
    expect(result.checkpoint?.snapshot.results[0]).toMatchObject({ ref: expect.stringMatching(/^(receipt|toolcall|saved-output):/), summary: expect.stringContaining('read succeeded') });
    expect(inference).toBe(2);
  });

  it('coder uses pi read/write tools and receives AGENTS.md', async () => {
    let calls = 0;
    const f = await setup((body, req, res) => {
      if (req.url === '/jev') jev(res, 'coder.normal');
      else if (req.url?.endsWith('/models')) res.end('{}');
      else {
        expect(JSON.stringify(body.messages)).toContain('Use semicolons in this project');
        calls++;
        if (calls === 1) completion(res, { tool: { name: 'read', arguments: { path: 'input.txt' } } });
        else if (calls === 2) { expect(JSON.stringify(body.messages)).toContain('old value'); completion(res, { tool: { name: 'write', arguments: { path: 'output.txt', content: 'updated value' } } }); }
        else completion(res, { text: 'Created output.txt; tests were not run.' });
      }
    });
    await writeFile(join(f.cwd, 'AGENTS.md'), 'Use semicolons in this project');
    await writeFile(join(f.cwd, 'input.txt'), 'old value');
    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Implement the requested change' }, { approve: async () => false });
    expect(result.success).toBe(true);
    expect(result.capability).toBe('coder.normal');
    expect(await readFile(join(f.cwd, 'output.txt'), 'utf8')).toBe('updated value');
    expect(calls).toBe(3);
  });

  it.each([false, true])('requires verification after test failures escalate (repair: %s)', async repair => {
    let routes = 0, localCalls = 0, cloudCalls = 0;
    const command = 'node --test failing.test.cjs';
    const f = await setup((body, req, res) => {
      if (req.url === '/jev') jev(res, ++routes === 1 ? 'coder.normal' : 'coder.reasoning');
      else if (req.url?.endsWith('/models')) res.end('{}');
      else if (body.reasoning_effort === 'none') { localCalls++; completion(res, { tool: { name: 'bash', arguments: { command } } }); }
      else {
        cloudCalls++;
        expect(body.model).toBe('capable-test');
        expect(body.reasoning_effort).toBe('low');
        // Both tiers run on the capable model, so the retry carries on from the failing run itself, told why it stopped.
        expect(JSON.stringify(body.messages)).toContain('That attempt stopped (test failures). It carries on here with low reasoning');
        expect(JSON.stringify(body.messages)).toContain(command);
        expect(JSON.stringify(body.messages)).not.toContain('Previous attempt stopped');
        if (repair && cloudCalls === 1) completion(res, { tool: { name: 'write', arguments: { path: 'failing.test.cjs', content: '// repaired' } } });
        else if (repair && cloudCalls === 2) completion(res, { tool: { name: 'bash', arguments: { command } } });
        else completion(res, { text: 'Resolved using the economy model.', cost: 0.00004 });
      }
    });
    f.config.policy.execution.trustedCommands = [command];
    f.config.policy.escalation.maxEscalations = 1;
    await writeFile(join(f.cwd, 'failing.test.cjs'), 'throw new Error("test failed");');
    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Fix the failing tests' }, { approve: async () => false });
    expect(result.success).toBe(repair);
    expect(result.check).toBe(repair ? 'passed' : 'failed');
    expect(result.status).toBe(repair ? 'completed' : 'test_failures');
    expect(result.capability).toBe('coder.reasoning');
    expect(localCalls).toBe(2);
    expect(cloudCalls).toBe(repair ? 3 : 1);
    expect(result.receipts).toHaveLength(2);
    expect((await events(f.config)).find(e => e.type === 'escalation')).toMatchObject({ from: 'coder.normal', to: 'coder.reasoning', reason: 'test_failures' });
  });

  it('starts a retry on another model afresh, from the handoff rather than the first model’s messages', async () => {
    let routes = 0;
    const bodies: any[] = [];
    const f = await setup((body, req, res) => {
      if (req.url === '/jev') jev(res, ++routes === 1 ? 'ask.fast' : 'ask.normal');
      else if (req.url?.endsWith('/models')) res.end('{}');
      else if (req.url?.startsWith('/fast/')) completion(res, { text: 'The answer begins', finish: 'length' });
      else { bodies.push(body); completion(res, { text: 'The whole answer.' }); }
    });
    f.config.models.fast.enabled = true;
    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Explain the change' }, { approve: async () => false, localProbe: async () => true });
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.capability).toBe('ask.normal');
    const sent = JSON.stringify(bodies[0].messages);
    expect(sent).toContain('Previous attempt stopped: unsupported');
    expect(sent).not.toContain('That attempt stopped');
  });

  it('does not escalate a successful difficult local request', async () => {
    let routes = 0;
    const f = await setup((_body, req, res) => {
      if (req.url === '/jev') { routes++; jev(res, 'coder.normal'); }
      else if (req.url?.endsWith('/models')) res.end('{}');
      else completion(res, { text: 'Completed the difficult analysis.' });
    });
    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Solve a very difficult architecture problem' }, { approve: async () => false });
    expect(result.success).toBe(true);
    expect(routes).toBe(1);
    expect((await events(f.config)).some(e => e.type === 'escalation')).toBe(false);
  });

  it('keeps local reasoning profiles available within the routing budget', async () => {
    let inference = 0;
    const f = await setup((_body, req, res) => {
      if (req.url === '/jev') jev(res, 'coder.reasoning', 0.99, { 'coder.reasoning': 0.9, 'coder.normal': 0.1 });
      else if (req.url?.endsWith('/models')) res.end('{}');
      else { inference++; expect(req.url).toContain('/capable'); completion(res, { text: 'Local fallback.' }); }
    });
    f.config.policy.budget.requestUsd = 0.01;
    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Inspect code' }, { approve: async () => false });
    expect(result.capability).toBe('coder.reasoning');
    expect(inference).toBe(1);
    const receipt = JSON.parse(await readFile(result.receipts[0]!, 'utf8'));
    expect(receipt.decision.candidates.find((c: any) => c.id === 'coder.reasoning').router.filtered).toBe(false);
  });

  it('low confidence falls back within an explicit workload', async () => {
    let inference = 0;
    const f = await setup((_body, req, res) => {
      if (req.url === '/jev') jev(res, 'coder.normal', 0.1);
      else if (req.url?.endsWith('/models')) res.end('{}');
      else { inference++; completion(res, { text: 'Completed with host fallback.' }); }
    });

    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Edit code', workload: 'coder' }, { approve: async () => true });
    expect(result.success).toBe(true);
    expect(result.capability).toBe('coder.normal');
    expect(inference).toBe(1);
    expect((await events(f.config)).find(e => e.type === 'routing_fallback')).toMatchObject({ capability: 'coder.normal', reason: 'low_confidence' });
  });

  it('low confidence continues a bare hosted prompt as dialogue without asking for access', async () => {
    let inference = 0, approvals = 0;
    const f = await setup((_body, req, res) => {
      if (req.url === '/jev') jev(res, 'coder.normal', 0.1);
      else if (req.url?.endsWith('/models')) res.end('{}');
      else { inference++; completion(res, { text: 'Hi!' }); }
    });

    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'hi!' }, { approve: async () => { approvals++; return true; } });
    expect(result.success).toBe(true);
    expect(result.capability?.startsWith('ask.')).toBe(true);
    expect(inference).toBe(1);
    expect(approvals).toBe(0);
    expect((await events(f.config)).find(e => e.type === 'routing_fallback')).toMatchObject({ reason: 'low_confidence' });
  });

  it('missing permissions prevent execution even when routing is confident', async () => {
    let inference = 0;
    const f = await setup((_body, req, res) => {
      if (req.url === '/jev') jev(res, 'coder.normal', 0.99);
      else if (req.url?.endsWith('/models')) res.end('{}');
      else { inference++; completion(res, {}); }
    });

    f.config.policy.permissions = [];
    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Edit code', workload: 'coder' }, { approve: async () => true });
    expect(result.success).toBe(false);
    expect(inference).toBe(0);
  });

  it('honors JevRouter confirmation and denies noninteractive execution', async () => {
    let inference = 0, approvals = 0;
    const f = await setup((_body, req, res) => {
      if (req.url === '/jev') jev(res, 'coder.normal');
      else if (req.url?.endsWith('/models')) res.end('{}');
      else { inference++; completion(res, {}); }
    });
    f.config.policy.router.confirmation_risk_levels.push('medium');
    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Edit code' }, { approve: async () => { approvals++; return false; } });
    expect(result.status).toBe('approval_denied');
    expect(approvals).toBe(1);
    expect(inference).toBe(0);
  });

  it('bounds an endless model loop and never executes a denied shell command', async () => {
    let inference = 0;
    const f = await setup((_body, req, res) => {
      if (req.url === '/jev') jev(res, 'coder.normal');
      else if (req.url?.endsWith('/models')) res.end('{}');
      else { inference++; completion(res, { tool: { name: 'bash', arguments: { command: 'echo unsafe' } } }); }
    });
    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Run a command' }, { approve: async () => false });
    expect(result.status).toBe('approval_denied');
    expect(inference).toBe(1);
    expect(result.attempts).toBe(1);
  });

  it('stops repeated ineffective reads at a host checkpoint before the hard turn limit', async () => {
    let calls = 0;
    const f = await setup((body, req, res) => {
      if (req.url === '/jev') jev(res, 'coder.normal');
      else if (req.url?.endsWith('/models')) res.end('{}');
      else { calls++; completion(res, (body.tools ?? []).length ? { tool: { name: 'read', arguments: { path: 'input.txt' } } } : { text: 'The repeated reads yielded no new evidence.' }); }
    });
    await writeFile(join(f.cwd, 'input.txt'), 'same content');
    f.config.policy.limits.maxTurns = 2;
    f.config.policy.escalation.maxEscalations = 0;
    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Inspect files' }, { approve: async () => false });
    expect(result.status, JSON.stringify(result)).toBe('partial');
    expect(calls).toBe(2);
  });

  it('reports unavailable local execution without charging an execution fee', async () => {
    let calls = 0;
    const f = await setup((_body, req, res) => {
      if (req.url === '/jev') jev(res, 'coder.reasoning');
      else if (req.url?.endsWith('/models')) { res.writeHead(503); res.end('{}'); }
      else { calls++; completion(res, { noUsage: true, tool: { name: 'read', arguments: { path: 'input.txt' } } }); }
    });
    await writeFile(join(f.cwd, 'input.txt'), 'hello');
    f.config.router.maxCallUsd = 0.00001;
    f.config.policy.budget.requestUsd = 0.01;
    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Inspect files' }, { approve: async () => false });
    expect(result.status).toBe('unavailable');
    expect(calls).toBe(0);
    expect(result.spentUsd).toBeCloseTo(0.00001);
  });

  it('uses JevRouter OpenRouter Decisions adapter and preserves its envelope', async () => {
    const f = await setup((body, req, res) => {
      if (req.url === '/jev') {
        expect(body.model).toBe('~typesafe/jev-latest');
        expect(req.headers.authorization).toBe('Bearer fixture-jev-secret');
        jev(res, 'ask.normal');
      } else if (req.url?.endsWith('/models')) res.end('{}');
      else completion(res, { text: 'OpenRouter route worked.' });
    });
    f.config.router.provider = 'openrouter';
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => nativeFetch(String(input) === 'https://openrouter.ai/api/alpha/decisions' ? f.config.router.endpoint! : input, init));
    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Explain a topic' }, { approve: async () => false });
    expect(result.success).toBe(true);
    const receipt = JSON.parse(await readFile(result.receipts[0]!, 'utf8'));
    expect(receipt.raw_jev._openrouter.provider).toBe('openrouter');
  });

  it('bounds oversized project instructions before model execution', async () => {
    let calls = 0;
    const f = await setup((_body, req, res) => {
      if (req.url === '/jev') jev(res, 'coder.normal');
      else if (req.url?.endsWith('/models')) res.end('{}');
      else { calls++; completion(res, {}); }
    });
    await writeFile(join(f.cwd, 'AGENTS.md'), 'Project guidance. '.repeat(2000));
    f.config.models.capable.contextTokens = 16384;
    f.config.policy.escalation.maxEscalations = 0;
    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Inspect code' }, { approve: async () => false });
    expect(result.status).toBe('completed');
    expect(calls).toBe(1);
    expect(result.spentUsd).toBe(0.00001);
  });

  it('blocks tools at the request-call limit and returns a checkpoint partial', async () => {
    let calls = 0;
    const f = await setup((body, req, res) => {
      if (req.url === '/jev') jev(res, 'coder.normal');
      else if (req.url?.endsWith('/models')) res.end('{}');
      else { calls++; completion(res, (body.tools ?? []).length ? { tool: { name: 'read', arguments: { path: 'input.txt' } } } : { text: 'The request call limit was reached; no more reads ran.' }); }
    });
    await writeFile(join(f.cwd, 'input.txt'), 'hello');
    f.config.policy.limits.maxToolCalls = 1;
    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Inspect code' }, { approve: async () => false });
    expect(result.status, JSON.stringify(result)).toBe('partial');
    expect(calls).toBe(2);
    expect((await events(f.config)).filter(e => e.type === 'tool')).toHaveLength(1);
  });

  it('scales reasoning effort without changing the capable model identity', async () => {
    let routes = 0, approvals = 0;
    const efforts: string[] = [];
    const f = await setup((body, req, res) => {
      if (req.url === '/jev') jev(res, ['ask.normal', 'ask.reasoning', 'ask.deep'][routes++]!);
      else if (req.url?.endsWith('/models')) res.end('{}');
      else {
        efforts.push(body.reasoning_effort);
        completion(res, body.reasoning_effort === 'medium' ? { text: 'Answered with evidence.' } : { tool: { name: 'request_escalation', arguments: { reason: 'uncertainty' } } });
      }
    });
    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Answer a question' }, { approve: async approval => { expect(approval.kind).toBe('route'); approvals++; return true; } });
    expect(result.success).toBe(true);
    expect(result.capability).toBe('ask.deep');
    expect(approvals).toBe(0);
    expect(efforts).toEqual(['none', 'low', 'medium']);
    expect(result.attempts).toBe(3);
  });

  it('steps down to less reasoning when a reply runs out of tokens while still thinking', async () => {
    let routes = 0;
    const efforts: string[] = [];
    const f = await setup((body, req, res) => {
      if (req.url === '/jev') jev(res, ['ask.deep', 'ask.reasoning'][routes++]!);
      else if (req.url?.endsWith('/models')) res.end('{}');
      else {
        efforts.push(body.reasoning_effort);
        completion(res, body.reasoning_effort === 'medium' ? { reasoning: 'Consider every alternative again...', text: '', finish: 'length' } : { text: 'Answered briefly.' });
      }
    });
    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Answer a question' }, { approve: async () => true });
    expect(result.success).toBe(true);
    expect(result.capability).toBe('ask.reasoning');
    expect(efforts).toEqual(['medium', 'low']);
    expect((await events(f.config)).find(e => e.type === 'escalation')).toMatchObject({ from: 'ask.deep', to: 'ask.reasoning', reason: 'overthinking' });
  });

  it('exposes search only on opt-in and passes source snippets back to ask', async () => {
    let calls = 0, searches = 0;
    const f = await setup((body, req, res) => {
      if (req.url === '/jev') jev(res, 'ask.normal');
      else if (req.url?.endsWith('/models')) res.end('{}');
      else if (req.url?.startsWith('/search?')) { searches++; res.end(JSON.stringify({ results: [{ title: 'Source', url: 'https://example.com/source', content: 'Evidence' }] })); }
      else if (++calls === 1) {
        expect(body.tools.map((tool: any) => tool.function.name)).toEqual(['web_search', 'web_read', 'request_escalation']);
        completion(res, { tool: { name: 'web_search', arguments: { query: 'current facts' } } });
      } else { expect(JSON.stringify(body.messages)).toContain('https://example.com/source'); completion(res, { text: 'Evidence [Source](https://example.com/source)' }); }
    });
    f.config.searchUrl = new URL(f.config.router.endpoint!).origin;
    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Research current facts', web: true }, { approve: async () => false });
    expect(result.success).toBe(true);
    expect(searches).toBe(2);
  });

  it('lists observed file edits with their size even when the workload label never becomes coder.*', async () => {
    // Mirrors the reviewed session: JevRouter's low-confidence fallback keeps the
    // workload at ask.normal, but a mid-run capability grant still writes a file.
    let calls = 0, checkpointDecisions = 0;
    const f = await fixture(); cleanups.push(f.cleanup);
    const server = await mockServer((body, _req, res) => {
      calls++;
      if (calls === 1) completion(res, { tool: { name: 'request_capabilities', arguments: { permissions: ['repository.write'] } } });
      else if (calls === 2) completion(res, { text: 'Capability was granted; continue with the requested file.' });
      else if (calls === 3) completion(res, { tool: { name: 'write', arguments: { path: 'granted.txt', content: 'approved\n' } } });
      else completion(res, (body.tools ?? []).length ? { tool: { name: 'read', arguments: { path: 'granted.txt' } } } : { text: 'The file was written; further reads did not run.' });
    });
    cleanups.push(server.close);
    f.config.routingMode = 'direct';
    f.config.models.capable.baseUrl = server.url;
    f.config.policy.limits.maxToolCalls = 2;
    const grants = await SessionGrants.create(f.cwd, f.config, 'chat');
    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Create granted.txt', mode: 'chat', authorization: grants }, {
      localProbe: async () => true,
      approve: async approval => approval.kind === 'capability',
      onCheckpoint: async checkpoint => ++checkpointDecisions === 1
        ? { requestId: checkpoint.requestId, checkpointId: checkpoint.checkpointId, action: 'continue', offerId: checkpoint.continuation!.offerId }
        : { requestId: checkpoint.requestId, checkpointId: checkpoint.checkpointId, action: 'finish_partial' },
    });
    expect(result.capability).toBe('ask.normal');
    expect(result.status).toBe('partial');
    expect(result.checkpoint?.snapshot.artifacts).toContainEqual(expect.objectContaining({ ref: 'file:granted.txt' }));
    expect(result.text).toContain('work is partial, not complete');
    expect(await readFile(join(f.cwd, 'granted.txt'), 'utf8')).toBe('approved\n');
  });

  it('goes on without search when web access is granted mid-request but search is down', async () => {
    const bodies: any[] = [];
    const f = await fixture(); cleanups.push(f.cleanup);
    const server = await mockServer((body, _req, res) => {
      bodies.push(body);
      if (bodies.length === 1) completion(res, { tool: { name: 'request_capabilities', arguments: { permissions: ['web.search'] } } });
      else completion(res, { text: 'from what I have' });
    });
    cleanups.push(server.close);
    f.config.routingMode = 'direct';
    f.config.models.capable.baseUrl = server.url;
    f.config.searchUrl = 'http://127.0.0.1:1';
    if (!f.config.policy.permissions.includes('web.search')) f.config.policy.permissions.push('web.search');
    const grants = await SessionGrants.create(f.cwd, f.config, 'chat');
    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Plan from these links', mode: 'chat', authorization: grants }, {
      localProbe: async () => true,
      approve: async approval => approval.kind === 'capability',
    });
    expect(result.status).not.toBe('approval_denied');
    expect(JSON.stringify(bodies[1].messages)).toContain('Unavailable for this request: web.search');
    expect(result.text).toContain('Web search was unavailable. This answer is unverified');
  });

  it('returns a host-only partial checkpoint when the current request cannot fit context', async () => {
    const f = await setup((_body, req, res) => {
      if (req.url === '/jev') jev(res, 'ask.normal');
      else if (req.url?.endsWith('/models')) res.end('{}');
      else completion(res, { text: 'unused' });
    });
    f.config.models.capable.contextTokens = 16384;
    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'x!'.repeat(6000) }, { approve: async () => false });
    expect(result.status).toBe('partial');
    expect(result.success).toBe(false);
    expect(result.checkpoint?.reason).toBe('context_pressure');
    expect(result.text).toContain('work is partial, not complete');
  });

  it('asks the first routing call which teachat identity fits and returns the answer', async () => {
    const identities = { pip: 'Quick questions and explanations.', oona: 'Research and long writing jobs.' };
    const answer = { type: 'choice', choice: 'oona', probabilities: { oona: 0.8, pip: 0.2 }, confidence: 0.9 };
    const questions: any[] = [];
    const f = await setup((body, req, res) => {
      if (req.url === '/jev') {
        questions.push(body.questions);
        // The same routing answers, plus the identity answer when it was asked.
        const end = res.end.bind(res);
        res.end = ((chunk: string) => { const raw = JSON.parse(chunk); if (body.questions.teachat_identity) raw.answers.teachat_identity = answer; return end(JSON.stringify(raw)); }) as typeof res.end;
        jev(res, 'ask.normal');
      } else if (req.url?.endsWith('/models')) res.end('{}');
      else completion(res, { text: 'Here is an overview.' });
    });
    const grants = await SessionGrants.create(f.cwd, f.config, 'chat');
    const asked = await runHost(f.config, { cwd: f.cwd, prompt: 'Write up the research', mode: 'chat', authorization: grants, teachatIdentities: identities }, { approve: async () => false, localProbe: async () => true });
    expect(asked.success).toBe(true);
    expect(questions[0].teachat_identity).toMatchObject({ type: 'choice', criteria: identities });
    expect(asked.teachatIdentity).toEqual({ choice: 'oona', probabilities: { oona: 0.8, pip: 0.2 }, confidence: 0.9 });
    const plain = await runHost(f.config, { cwd: f.cwd, prompt: 'Write up the research', mode: 'chat', authorization: grants }, { approve: async () => false, localProbe: async () => true });
    expect(plain.success).toBe(true);
    expect(questions[1].teachat_identity).toBeUndefined();
    expect(plain.teachatIdentity).toBeUndefined();
  });

  it('does not retry an interrupted local request or expose provider errors', async () => {
    let calls = 0;
    const f = await setup((_body, req, res) => {
      if (req.url === '/jev') jev(res, 'ask.reasoning');
      else if (req.url?.endsWith('/models')) res.end('{}');
      else { calls++; res.writeHead(500); res.end('upstream failed fixture-cloud-secret'); }
    });
    f.config.policy.escalation.maxEscalations = 0;
    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Answer a question' }, { approve: async () => false });
    expect(result.success).toBe(false);
    expect(calls).toBe(1);
    expect(result.spentUsd).toBeCloseTo(0.00001);
    expect(JSON.stringify(await events(f.config))).not.toContain('fixture-cloud-secret');
    expect(result.text).not.toContain('fixture-cloud-secret');
  });
});
