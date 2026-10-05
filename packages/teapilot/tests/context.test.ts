import { afterEach, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { completion, events, fixture, mockServer } from './helpers.js';
import { runAttempt } from '../src/agents/run.js';
import { SpendGovernor } from '../src/inference/budget.js';
import { Telemetry } from '../src/telemetry/outcome.js';
import { calibratedTokens, estimateInputTokens, estimateTextTokens, MAX_PAYLOAD_BYTES } from '../src/inference/context.js';
import { streamSpeed, wellFormed } from '../src/inference/providers.js';

it('measures decode speed from the first to the last streamed token, apart from the wait for the first', () => {
  // 101 tokens: the first at 900 ms, the last one second later.
  expect(streamSpeed({ sent: 100, firstChoice: 1000, lastChoice: 2000 }, 101)).toEqual({ firstTokenMs: 900, outputTokensPerSecond: 100 });
  expect(streamSpeed({ sent: 100, firstChoice: 1000, lastChoice: 1000 }, 1)).toEqual({ firstTokenMs: 900 });
  expect(streamSpeed({ sent: 100 }, 50)).toEqual({});
});

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup(handler: Parameters<typeof mockServer>[0]) {
  const f = await fixture(); cleanups.push(f.cleanup);
  const server = await mockServer(handler); cleanups.push(server.close);
  Object.assign(f.config.models.capable, { provider: 'ollama', baseUrl: server.url, contextTokens: 32768, maxOutputTokens: 16384 });
  const telemetry = new Telemetry(f.config.stateDir, 'context-test');
  await telemetry.event('start', {});
  const budget = new SpendGovernor(join(f.config.stateDir, 'spend.jsonl'), 'context-test', f.config.policy.budget);
  return { ...f, budget, telemetry };
}

it.each([false, true])('completes several coding tool round trips at 16k (web=%s)', async web => {
  const bodies: any[] = [];
  const f = await setup((body, _req, res) => {
    bodies.push(body);
    const steps = [
      { name: 'ls', arguments: { path: '.' } },
      { name: 'read', arguments: { path: 'notes.txt' } },
      { name: 'write', arguments: { path: 'web-pong/index.html', content: '<html>Pong</html>\n' } },
      { name: 'read', arguments: { path: 'web-pong/index.html' } },
    ];
    completion(res, bodies.length <= steps.length ? { tool: steps[bodies.length - 1]! } : { text: 'Created and verified.' });
  });
  f.config.searchUrl = 'http://unused.test';
  if (!f.config.policy.permissions.includes('web.search')) f.config.policy.permissions.push('web.search');
  await mkdir(join(f.cwd, 'web-pong'));
  await writeFile(join(f.cwd, 'notes.txt'), 'Keep the game self contained.\n'.repeat(120));
  const result = await runAttempt({ ...f, tier: 'normal', workload: 'coder', prompt: 'Read notes.txt and create web-pong/index.html, then read it to verify.', web, approve: async () => true });
  expect(result, JSON.stringify(result)).toMatchObject({ success: true, turns: 5, toolCalls: 4 });
  expect(await readFile(join(f.cwd, 'web-pong/index.html'), 'utf8')).toContain('Pong');
  expect(bodies.some(body => Buffer.byteLength(JSON.stringify(body)) > 8 * 1024)).toBe(true);
  expect(bodies[0].tools.some((tool: any) => tool.function.name === 'web_search')).toBe(web);
  const admissions = (await events(f.config)).filter(e => e.type === 'context_admission');
  expect(admissions).toHaveLength(5);
  expect(admissions.every(e => e.estimatedInputTokens + e.reservedOutputTokens <= 16384 && !e.rejection)).toBe(true);
  expect(f.budget.spent().request).toBe(0);
});

it('treats a tier’s reply limit as a ceiling for each call, not room held back from the input', async () => {
  const bodies: any[] = [];
  const f = await setup((body, _req, res) => { bodies.push(body); completion(res, { text: 'ok' }); });
  const ask = (prompt: string) => runAttempt({ ...f, tier: 'deep', workload: 'ask', web: false, approve: async () => true, prompt });
  expect(await ask('hello')).toMatchObject({ success: true });
  expect(bodies[0].max_tokens).toBe(16384);
  // About 20k tokens in: holding back all 16k for the reply refused this; now the reply gets the room that is left.
  expect(await ask('word '.repeat(8000))).toMatchObject({ success: true });
  const [, large] = (await events(f.config)).filter(e => e.type === 'context_admission');
  expect(large.estimatedInputTokens + 16384).toBeGreaterThan(32768);
  expect(large).toMatchObject({ reservedOutputTokens: 8192, maxOutputTokens: 32768 - large.estimatedInputTokens });
  expect(bodies[1].max_tokens).toBe(32768 - large.estimatedInputTokens);
  // A context-admission failure is handed to the host as an honest, non-success checkpoint.
  expect(await ask('word '.repeat(12000))).toMatchObject({ success: false, stopped: 'checkpoint', checkpoint: { reason: 'context_pressure' } });
  expect(bodies).toHaveLength(2);
});

it('continues after context pressure with tools on the fresh request and stops on an irreducible objective', async () => {
  const bodies: any[] = [];
  let listed = false;
  const f = await setup((body, _req, res) => {
    bodies.push(body);
    const declarations = (body.tools ?? []).map((tool: any) => tool.function.name);
    if (!listed && declarations.includes('ls')) { listed = true; completion(res, { tool: { name: 'ls', arguments: { path: '.' } } }); }
    else completion(res, { text: listed ? 'Listed the current directory.' : 'tools were missing from the fresh request' });
  });
  Object.assign(f.config.models.capable, { contextTokens: 16384, maxOutputTokens: 1024 });
  const bulk = 'obsolete history '.repeat(10_000);
  await writeFile(join(f.cwd, 'checkpoint-visible-file.txt'), 'present\n');
  const accepted = await runAttempt({ ...f, tier: 'normal', workload: 'coder', prompt: 'List the files in the current directory.', currentRequest: 'List the files in the current directory.', web: false,
    resume: { messages: [{ role: 'user', content: bulk, timestamp: Date.now() }] }, approve: async () => true,
    onCheckpoint: async checkpoint => {
      expect(checkpoint.reason).toBe('context_pressure');
      expect(checkpoint.continuation?.freshContext).toBe(true);
      return { requestId: checkpoint.requestId, checkpointId: checkpoint.checkpointId, action: 'redirect', offerId: checkpoint.continuation!.offerId, amendment: 'NEW-AMENDMENT-DO-NOT-EDIT' };
    } });
  expect(accepted, JSON.stringify(accepted)).toMatchObject({ success: true, text: 'Listed the current directory.', toolCalls: 1 });
  expect(bodies).toHaveLength(2);
  expect(bodies[0].tools.length).toBeGreaterThan(0);
  expect(JSON.stringify(bodies[0])).not.toContain('obsolete history');
  expect(JSON.stringify(bodies[0])).toContain('List the files in the current directory.');
  expect(JSON.stringify(bodies[0])).toContain('NEW-AMENDMENT-DO-NOT-EDIT');
  expect(bodies[0].tools.map((tool: any) => tool.function.name)).toContain('ls');
  expect(JSON.stringify(bodies[1].messages)).toContain('checkpoint-visible-file.txt');
  expect(JSON.stringify(bodies[1])).not.toContain('obsolete history');

  const huge = await runAttempt({ ...f, tier: 'normal', workload: 'ask', prompt: 'word '.repeat(12_000), web: false, approve: async () => true,
    onCheckpoint: async checkpoint => {
      expect(checkpoint.reason).toBe('context_pressure');
      expect(checkpoint.continuation).toBeUndefined();
      return undefined;
    } });
  expect(huge).toMatchObject({ success: false, stopped: 'checkpoint', checkpoint: { reason: 'context_pressure' } });
});

it.each([400, 404, 422])('keeps provider HTTP %s separate from local overflow', async status => {
  let calls = 0;
  const f = await setup((_body, _req, res) => { calls++; res.writeHead(status); res.end('{}'); });
  const input = { ...f, tier: 'normal' as const, workload: 'ask' as const, web: false, approve: async () => true };
  expect(await runAttempt({ ...input, prompt: 'hello' })).toMatchObject({ stopped: 'unsupported' });
  expect(await runAttempt({ ...input, prompt: 'x!'.repeat(20000) })).toMatchObject({ success: false, stopped: 'checkpoint', checkpoint: { reason: 'context_pressure' } });
  expect(calls).toBe(1);
  expect((await events(f.config)).some(e => e.type === 'provider_http_error' && e.status === status)).toBe(true);
});

it('records server load failures but never echoes other provider error bodies', async () => {
  const load = "llama-server process has terminated: exit status 1: error loading model: check_tensor_dims: tensor 'blk.64.attn_norm.weight' not found";
  for (const [message, expected] of [[load, load], ['invalid request: SECRET_PROMPT_TEXT', undefined]] as const) {
    const f = await setup((_body, _req, res) => { res.writeHead(500); res.end(JSON.stringify({ error: { message } })); });
    await runAttempt({ ...f, tier: 'normal', workload: 'ask', web: false, prompt: 'hello', approve: async () => true });
    const failure = (await events(f.config)).find(e => e.type === 'provider_http_error');
    expect(failure).toMatchObject({ status: 500 });
    expect(failure?.detail).toBe(expected);
  }
});

it('lets a steadily streaming reply outlast the request timeout, but stops a stalled one', async () => {
  const common = { id: 'slow', object: 'chat.completion.chunk', created: 1, model: 'mock-model' };
  const f = await setup(async (body, _req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    const chunk = (value: unknown) => res.write(`data: ${JSON.stringify(value)}\n\n`);
    const stall = JSON.stringify(body.messages).includes('stall');
    for (let i = 0; i < 6; i++) {
      await new Promise(done => setTimeout(done, stall && i === 1 ? 1500 : 250));
      if (res.destroyed) return;
      chunk({ ...common, choices: [{ index: 0, delta: { role: 'assistant', content: 'word ' }, finish_reason: null }] });
    }
    chunk({ ...common, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 } });
    res.end('data: [DONE]\n\n');
  });
  f.config.policy.limits.requestTimeoutMs = 1000;
  const input = { ...f, tier: 'normal' as const, workload: 'ask' as const, web: false, approve: async () => true };
  expect(await runAttempt({ ...input, prompt: 'go' })).toMatchObject({ success: true });
  expect(await runAttempt({ ...input, prompt: 'stall' })).toMatchObject({ success: false, stopped: 'timeout' });
});

it('keeps local inference free when providers omit usage', async () => {
  let calls = 0;
  const f = await setup((_body, _req, res) => { calls++; completion(res, { noUsage: true }); });
  const input = { ...f, tier: 'normal' as const, workload: 'ask' as const, web: false, prompt: 'hello', approve: async () => true };
  expect((await runAttempt(input)).success).toBe(true);
  expect(f.budget.spent().request).toBe(0);
  expect((await runAttempt(input)).success).toBe(true);
  expect(calls).toBe(2);
});

it('rejects an unreasonable transport payload before inference or reservation', async () => {
  let calls = 0;
  const f = await setup((_body, _req, res) => { calls++; completion(res, {}); });
  const result = await runAttempt({ ...f, tier: 'normal', workload: 'ask', web: false,
    prompt: 'x'.repeat(MAX_PAYLOAD_BYTES), approve: async () => true });
  expect(result.stopped).toBe('payload_limit');
  expect(calls).toBe(0);
  await expect(readFile(f.budget.path)).rejects.toThrow();
});

it('counts Unicode, punctuation, schemas and framing rather than JSON escape bytes', () => {
  expect(estimateTextTokens('你好🙂')).toBe(Buffer.byteLength('你好🙂'));
  expect(estimateTextTokens('{}!?')).toBe(4);
  const messages = [{ role: 'user', content: 'hello\nworld' }];
  expect(estimateInputTokens(JSON.stringify({ messages, tools: [{ description: 'search' }] }))).toBeGreaterThan(estimateInputTokens(JSON.stringify({ messages })));
  expect(estimateInputTokens(JSON.stringify({ messages, model: 'x'.repeat(20000) }))).toBe(estimateInputTokens(JSON.stringify({ messages })));
  expect(estimateTextTokens(`\n${' '.repeat(12)}return;`)).toBe(4);
});

// A self-contained game page shaped like the one that tripped admission:
// 4-space indentation, inline CSS and JS.
function indentedPage(bytes: number): string {
  const head = '<!DOCTYPE html>\n<html lang="en">\n<head>\n    <meta charset="UTF-8">\n    <title>Pong</title>\n    <style>\n        body {\n            margin: 0;\n            background: #111;\n            display: flex;\n            justify-content: center;\n        }\n        canvas { border: 2px solid #fff; }\n    </style>\n</head>\n<body>\n    <canvas id="game" width="800" height="600"></canvas>\n    <script>\n        const canvas = document.getElementById(\'game\');\n        const ctx = canvas.getContext(\'2d\');\n        const keys = {};\n        document.addEventListener(\'keydown\', event => { keys[event.key] = true; });\n\n';
  const block = (i: number) => `        // Paddle ${i}: move within bounds, then bounce the ball off its face.
        function updatePaddle${i}(paddle, ball, deltaTime) {
            if (keys.ArrowUp && paddle.y > 0) {
                paddle.y -= PADDLE_SPEED * deltaTime;
            } else if (keys.ArrowDown && paddle.y < canvas.height - paddle.height) {
                paddle.y += PADDLE_SPEED * deltaTime;
            }
            if (ball.x - ball.radius < paddle.x + paddle.width && ball.y > paddle.y) {
                ball.dx = Math.abs(ball.dx) * 1.05;
                ball.dy += (ball.y - (paddle.y + paddle.height / 2)) * 0.1;
            }
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(paddle.x, paddle.y, paddle.width, paddle.height);
        }

`;
  let page = head;
  for (let i = 0; Buffer.byteLength(page) < bytes; i++) page += block(i);
  return `${page}    </script>\n</body>\n</html>\n`;
}

// Script tool calls, then a final answer. `usage` maps request bytes to reported
// prompt tokens; the local model in the review reported ~4.2 bytes per token.
async function scripted(steps: { name: string; arguments: unknown }[], usage?: (bytes: number) => number) {
  let calls = 0;
  const f = await setup((body, _req, res) => {
    const step = steps[calls++];
    res.setHeader('Content-Type', 'text/event-stream');
    const common = { id: 'mock-chat', object: 'chat.completion.chunk', created: 1, model: 'mock-model' };
    const delta = step ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${calls}`, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.arguments) } }] } : { role: 'assistant', content: 'Done.' };
    const prompt = usage?.(Buffer.byteLength(JSON.stringify(body)));
    res.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: step ? 'tool_calls' : 'stop' }], ...(prompt === undefined ? {} : { usage: { prompt_tokens: prompt, completion_tokens: 20, total_tokens: prompt + 20 } }) })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  // These measure how the bare page fits, so no tip (agents/tips.ts) rides on the result.
  f.config.tips = { enabled: false };
  const result = await runAttempt({ ...f, tier: 'normal', workload: 'coder', web: false, prompt: 'Create a self-contained Pong game in index.html.', approve: async () => true });
  return { f, result, admissions: (await events(f.config)).filter(e => e.type === 'context_admission') };
}
const write = (content: string) => ({ name: 'write', arguments: { path: 'index.html', content } });

it('admits a written 13 KB indented page at 32k with 4k reserved output', async () => {
  const page = indentedPage(13 * 1024);
  const { f, result, admissions } = await scripted([write(page)]);
  expect(result, JSON.stringify(result)).toMatchObject({ success: true, toolCalls: 1 });
  expect(await readFile(join(f.cwd, 'index.html'), 'utf8')).toBe(page);
  expect(admissions).toHaveLength(2);
  expect(admissions[1].payloadBytes).toBeGreaterThan(20000);
  expect(admissions.every(e => e.method === 'conservative-lexical' && !e.rejection && e.contextTokens === 32768 && e.reservedOutputTokens === 4096 && e.estimatedInputTokens + 4096 <= 32768)).toBe(true);
});

it('admits a page in a tool call and result, and rejects clearly oversized code', () => {
  const payload = (content: string) => JSON.stringify({ messages: [
    { role: 'system', content: 'You are a careful coding agent. Read before editing, verify after writing, and report what changed.\n'.repeat(80) },
    { role: 'user', content: 'Create a self-contained Pong game in index.html.' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'index.html', content }) } }] },
    { role: 'tool', tool_call_id: 'call-1', content: `Successfully wrote ${Buffer.byteLength(content)} bytes to index.html` },
  ] });
  const fits = payload(indentedPage(13 * 1024));
  expect(Buffer.byteLength(fits)).toBeGreaterThan(22000);
  expect(estimateInputTokens(fits) + 4096).toBeLessThanOrEqual(16384);
  expect(estimateInputTokens(payload(indentedPage(120 * 1024))) + 4096).toBeGreaterThan(16384);
});

it('calibrates from reported input within an attempt, bounded below', async () => {
  expect(calibratedTokens(10000)).toBe(10000);
  expect(calibratedTokens(10000, { estimated: 5000, reported: 3000 })).toBe(6600);
  expect(calibratedTokens(10000, { estimated: 5000, reported: 10 })).toBe(6000);
  expect(calibratedTokens(10000, { estimated: 5000, reported: 50000 })).toBe(20000);
  // Written and read back: the call retains the page while the read result is bounded.
  // Earlier provider counts calibrate the next request without removing the admission floor.
  const page = indentedPage(13 * 1024);
  const twice = await scripted([write(page), { name: 'read', arguments: { path: 'index.html' } }], bytes => Math.ceil(bytes / 4));
  expect(twice.result, JSON.stringify(twice.result)).toMatchObject({ success: true, toolCalls: 2 });
  const last = twice.admissions.at(-1);
  expect(twice.admissions.map(e => e.method)).toEqual(['conservative-lexical', 'calibrated-lexical', 'calibrated-lexical']);
  expect(last.payloadBytes).toBeGreaterThan(25000);
  expect(last.estimatedInputTokens).toBeLessThan(last.lexicalTokens);
  expect(last.estimatedInputTokens + 4096).toBeLessThanOrEqual(16384);
  // A tiny provider report cannot admit ~120 KB of code: the floor still rejects it.
  const large = await scripted([write(indentedPage(120 * 1024))], () => 10);
  expect(large.result).toMatchObject({ success: false, stopped: 'checkpoint', checkpoint: { reason: 'context_pressure' } });
  expect(large.admissions.at(-1)).toMatchObject({ method: 'calibrated-lexical', rejection: 'context_limit' });
});

it('sends well-formed text, since some model servers fail a whole request on half an emoji', () => {
  const cut = '🟫🧑‍🌾'.slice(0, 3);
  expect(wellFormed({ messages: [{ content: [cut, 'ok 🌽'] }] })).toEqual({ messages: [{ content: ['🟫�', 'ok 🌽'] }] });
});
