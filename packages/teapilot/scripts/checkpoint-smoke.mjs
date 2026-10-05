#!/usr/bin/env node
// Disposable local OpenAI-compatible fixture for the checkpoint transport smoke.
// It deliberately scripts tool calls; it is not a model-quality test.
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = process.env.TEMP ?? join(process.env.LOCALAPPDATA ?? process.cwd(), 'Temp');
const base = join(tempRoot, 'opencode', 'checkpoint-smoke');
const port = Number(process.env.CHECKPOINT_SMOKE_PORT ?? 17643);
const usage = `Usage:
  node packages/teapilot/scripts/checkpoint-smoke.mjs init
  node packages/teapilot/scripts/checkpoint-smoke.mjs serve
  node packages/teapilot/scripts/checkpoint-smoke.mjs health
  node packages/teapilot/scripts/checkpoint-smoke.mjs reset
  node packages/teapilot/scripts/checkpoint-smoke.mjs clean

init makes an isolated profile and scratch repository at ${base}; serve runs a zero-cost fake model on 127.0.0.1:${port}.
health reports fake-model request/action counters; reset clears scripted action state (not the request counter/log).
No personal config is read. Stop the fake server with Ctrl-C, stop any driver session, then run clean.`;

function init() {
  const config = join(base, 'profile');
  const workspace = join(base, 'repo');
  mkdirSync(config, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const models = JSON.parse(readFileSync(join(repo, 'config', 'models.example.json'), 'utf8'));
  for (const model of Object.values(models)) {
    model.provider = 'ollama';
    model.baseUrl = `http://127.0.0.1:${port}/v1`;
    model.inputUsdPerMillion = 0;
    model.outputUsdPerMillion = 0;
  }
  models.fast.enabled = false;
  models.capable.id = 'checkpoint-smoke-local';
  writeFileSync(join(config, 'models.json'), `${JSON.stringify(models, null, 2)}\n`);
  const policy = JSON.parse(readFileSync(join(repo, 'config', 'policy.example.json'), 'utf8'));
  policy.limits.maxToolCalls = 20;
  policy.limits.instructorToolCalls = 2;
  policy.limits.maxContinuationBatches = 3;
  policy.limits.maxTurns = 30;
  policy.limits.attemptTimeoutMs = 600_000;
  policy.limits.requestTimeoutMs = 15_000;
  writeFileSync(join(config, 'policy.json'), `${JSON.stringify(policy, null, 2)}\n`);
  writeFileSync(join(config, '.env'), 'TEAPILOT_ROUTING_MODE=direct\nTEAPILOT_STATE_DIR=state\nTEAPILOT_TASK_STATE=off\nTEAPILOT_DELEGATION=off\nTEAPILOT_SKILLS=off\nTEAPILOT_COMPACTION=off\n');
  writeFileSync(join(base, 'requests.jsonl'), '');
  writeFileSync(join(base, 'README.txt'), [
    'Disposable checkpoint smoke fixture. No real model or personal config is used.',
    `Config: ${config}`, `Scratch repo: ${workspace}`, `Isolated state: ${join(config, 'state')}`, 'Model request log: requests.jsonl',
    'Run the fake server in one terminal: node packages/teapilot/scripts/checkpoint-smoke.mjs serve',
    'Discord smoke from the checkout root:',
    `node packages/teapilot/scripts/agent-discord.mjs start --name cpsmoke --root "${workspace}" --config-dir "${config}" --mode ask --ttl 900`,
    'In another terminal: node packages/teapilot/scripts/agent-discord.mjs say cpsmoke "Create checkpoint-before.txt with before, then checkpoint-before-2.txt with before-2, and after I continue create checkpoint-after.txt. Use one write call per file."',
    'Wait for a checkpoint card. Run checkpoint-smoke.mjs health, wait while paused, run health again (providerRequests must not increase), then click its Continue control (c0). Inspect repo files and profile/state/outcomes.jsonl.',
    'For redirect, first run checkpoint-smoke.mjs reset, repeat, click Change direction (c1), then submit amendment=Create redirect-smoke.txt instead. The scripted next write uses redirect-smoke.txt.',
    'For partial, reset and repeat, then click Finish partial (c2). Check health shows no later model request and no post-checkpoint file.',
    'Driver commands: agent-discord.mjs screen cpsmoke; dump cpsmoke; scratch cpsmoke; stop cpsmoke. Message ids are dynamic.',
    `Terminal smoke from checkout root: node packages/teapilot/scripts/agent-terminal.mjs start --name cpsmoke-term -- --config-dir "${config}" code --cwd "${workspace}" "Create checkpoint-before.txt with before, then checkpoint-before-2.txt with before-2, and after I continue create checkpoint-after.txt. Use one write call per file."; use wait/screen, choose a checkpoint action in the TUI, then stop.`,
    'After stop, Ctrl-C the server and run `node packages/teapilot/scripts/checkpoint-smoke.mjs clean`.',
  ].join('\n') + '\n');
  console.log(`prepared isolated fixture at ${base}`);
}

function serve() {
  mkdirSync(base, { recursive: true });
  let providerRequests = 0;
  let actionIndex = 0;
  let handoffTurns = 0;
  let requestsWithTools = 0;
  let undeclaredActionCount = 0;
  let lastRequestTools = [];
  let lastAttemptedAction;
  let redirectTarget;
  const actions = [
    { name: 'write', arguments: { path: 'checkpoint-before.txt', content: 'before\n' } },
    { name: 'write', arguments: { path: 'checkpoint-before-2.txt', content: 'before-2\n' } },
    { name: 'write', arguments: { path: 'checkpoint-after.txt', content: 'after\n' } },
    { name: 'write', arguments: { path: 'checkpoint-after-2.txt', content: 'after-2\n' } },
  ];
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'checkpoint-smoke-local', object: 'model', owned_by: 'local-fixture' }] }));
      return;
    }
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ providerRequests, actionIndex, handoffTurns, requestsWithTools, undeclaredActionCount,
        lastRequestTools, lastAttemptedAction: lastAttemptedAction ?? null, redirectTarget: redirectTarget ?? null }));
      return;
    }
    if (req.method === 'POST' && req.url === '/reset') {
      actionIndex = 0;
      redirectTarget = undefined;
      lastRequestTools = [];
      lastAttemptedAction = undefined;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ reset: true, providerRequests, actionIndex }));
      return;
    }
    if (req.method !== 'POST' || !/\/chat\/completions$/.test(req.url ?? '')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unknown local fixture endpoint' }));
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let request;
      try { request = JSON.parse(body); }
      catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid JSON' }));
        return;
      }
      const id = ++providerRequests;
      const messages = Array.isArray(request.messages) ? request.messages : [];
      const userContent = messages.filter(message => message?.role === 'user').at(-1)?.content;
      const textOf = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(part => part?.text ?? '').join('\n') : '';
      const newestUser = textOf(userContent);
      const markerName = newestUser.match(/\b(?=[A-Za-z0-9._-]*(?:redirect|direction|target))[A-Za-z0-9][A-Za-z0-9._-]*\.txt\b/i)?.[0];
      if (markerName) redirectTarget = markerName;
      const declaredTools = Array.isArray(request.tools) ? request.tools.filter(tool => tool?.type === 'function' && typeof tool.function?.name === 'string').map(tool => tool.function.name) : [];
      const handoffOnly = declaredTools.length === 0;
      lastRequestTools = declaredTools;
      if (handoffOnly) handoffTurns++;
      else requestsWithTools++;
      writeFileSync(join(base, 'requests.jsonl'), `${JSON.stringify({ id, at: new Date().toISOString(), handoffOnly, declaredTools, newestUser })}\n`, { flag: 'a' });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const common = { id: `checkpoint-smoke-${id}`, object: 'chat.completion.chunk', created: 1, model: 'checkpoint-smoke-local' };
      const chunk = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
      // Checkpoint handoff turns can be tool-free: they must not consume the
      // scripted next action, which belongs to the user's later decision.
      const action = handoffOnly ? undefined : actions[actionIndex];
      if (action) {
        lastAttemptedAction = action.name;
        if (!declaredTools.includes(action.name)) {
          undeclaredActionCount++;
          const content = `Fixture protocol mismatch: next scripted tool ${action.name} is not declared by this request. No tool call was emitted; available tools: ${declaredTools.join(', ') || 'none'}.`;
          chunk({ ...common, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] });
          chunk({ ...common, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 80, completion_tokens: 18, total_tokens: 98 } });
          res.end('data: [DONE]\n\n');
          return;
        }
        const scripted = redirectTarget ? { ...action, arguments: { ...action.arguments, path: redirectTarget } } : action;
        actionIndex++;
        chunk({ ...common, choices: [{ index: 0, delta: { role: 'assistant', content: '', tool_calls: [{ index: 0, id: `smoke-call-${id}`, type: 'function', function: { name: scripted.name, arguments: JSON.stringify(scripted.arguments) } }] }, finish_reason: null }] });
        chunk({ ...common, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        const content = handoffOnly ? 'Handoff turn: no new scripted action was emitted. Existing tool results have not been independently verified.' : 'The scripted smoke actions are complete; this is not an acceptance claim.';
        chunk({ ...common, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] });
        chunk({ ...common, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 80, completion_tokens: 18, total_tokens: 98 } });
      }
      res.end('data: [DONE]\n\n');
    });
  });
  server.listen(port, '127.0.0.1', () => console.log(`fake local model listening on http://127.0.0.1:${port}/v1; log: ${join(base, 'requests.jsonl')} (Ctrl-C to stop)`));
  process.on('SIGINT', () => server.close(() => process.exit(0)));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}

const command = process.argv[2];
if (command === 'init') init();
else if (command === 'serve') serve();
else if (command === 'clean') {
  if (resolve(base) !== resolve(tempRoot, 'opencode', 'checkpoint-smoke')) throw new Error('refusing unexpected cleanup path');
  rmSync(base, { recursive: true, force: true });
  console.log(`removed ${base}`);
} else if (command === 'health' || command === 'reset') {
  const endpoint = command === 'health' ? '/health' : '/reset';
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, { method: command === 'health' ? 'GET' : 'POST' });
  if (!response.ok) throw new Error(`fixture ${command} failed: HTTP ${response.status}`);
  console.log(JSON.stringify(await response.json()));
} else console.log(usage);
