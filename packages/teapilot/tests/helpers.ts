import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { loadConfig, type Config } from '../src/config.js';

export async function fixture(): Promise<{ config: Config; cwd: string; cleanup: () => Promise<void> }> {
  const cwd = await mkdtemp(join(tmpdir(), 'teapilot-test-'));
  const config = await loadConfig(cwd, {});
  config.stateDir = join(cwd, '.state');
  config.router.apiKey = 'fixture-jev-secret';
  config.secrets = { fast: undefined, capable: undefined };
  Object.assign(config.models.fast, { id: 'fast-test', reasoningEfforts: ['off'] });
  Object.assign(config.models.capable, { id: 'capable-test', enabled: true, reasoningEfforts: ['off', 'low', 'medium'] });
  config.policy.limits.requestTimeoutMs = 5000;
  config.policy.limits.attemptTimeoutMs = 10000;
  // Unit tests never start the real sandbox; tests/sandbox.integration.test.ts does.
  config.workspace = { sandbox: 'off', allowedDomains: [], deniedDomains: [] };
  // Unrelated mock-provider tests keep their original tool/context budgets; skills.test.ts opts in explicitly.
  config.skills = { enabled: false };
  return { config, cwd, cleanup: () => rm(cwd, { recursive: true, force: true }) };
}
export type Handler = (body: any, request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
export async function mockServer(handler: Handler): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const part of request) raw += part;
    try { await handler(raw ? JSON.parse(raw) : {}, request, response); }
    catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing mock server address');
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((done, reject) => { server.close(error => error ? reject(error) : done()); server.closeAllConnections(); }) };
}
export function jev(response: ServerResponse, selected: string, confidence = 0.99, probabilities?: Record<string, number>, web: Partial<Record<'web.explicit' | 'web.volatile' | 'web.low_risk' | 'web.search', 'yes' | 'no'>> = {}, webConfidence = confidence,
  /** Conversational-mode answers by key without `conversation.`; when given, unlisted signals answer no. */
  conversation?: Record<string, 'yes' | 'no' | 'unclear'>): void {
  response.setHeader('Content-Type', 'application/json');
  const all = Object.fromEntries(['coder.fast', 'coder.normal', 'coder.reasoning', 'coder.deep', 'ask.fast', 'ask.normal', 'ask.reasoning', 'ask.deep'].map(id => [id, id === selected ? 1 : 0]));
  const choice = (value: string) => ({ type: 'choice', choice: value, probabilities: { [value]: 1 }, confidence });
  const repository = selected.startsWith('coder.');
  response.end(JSON.stringify({ answers: {
    tool: { type: 'choice', choice: selected, probabilities: { ...all, ...probabilities }, confidence },
    'repository.read': choice(repository ? 'yes' : 'no'), 'repository.write': choice('no'), 'repository.shell': choice('no'), 'web.search': choice(web['web.search'] ?? 'no'),
    ...Object.fromEntries((['web.explicit', 'web.volatile', 'web.low_risk'] as const).map(key => [key, { ...choice(web[key] ?? 'no'), confidence: webConfidence }])),
    execution_tier: choice(selected.split('.')[1] ?? 'normal'), relatedness: choice('related'),
    ...(conversation && Object.fromEntries(['threat', 'personal', 'existential', 'banter', 'romance', 'task', 'make'].map(key => [`conversation.${key}`, choice(conversation[key] ?? 'no')]))),
  }, usage: { input_tokens: 100, output_tokens: 0, cost: 0.00001 } }));
}
export function completion(response: ServerResponse, options: { text?: string; tool?: { name: string; arguments: unknown }; cost?: number; noUsage?: boolean; model?: string; reasoning?: string; finish?: 'length' }): void {
  response.setHeader('Content-Type', 'text/event-stream');
  const common = { id: 'mock-chat', object: 'chat.completion.chunk', created: 1, model: options.model ?? 'mock-model' };
  const delta = options.tool ? { role: 'assistant', ...(options.text !== undefined ? { content: options.text } : {}), tool_calls: [{ index: 0, id: `call-${Date.now()}`, type: 'function', function: { name: options.tool.name, arguments: JSON.stringify(options.tool.arguments) } }] } : { role: 'assistant', content: options.text ?? 'Done.' };
  const chunk = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
  if (options.reasoning) chunk({ ...common, choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: options.reasoning }, finish_reason: null }] });
  chunk({ ...common, choices: [{ index: 0, delta, finish_reason: null }] });
  chunk({ ...common, choices: [{ index: 0, delta: {}, finish_reason: options.finish ?? (options.tool ? 'tool_calls' : 'stop') }], ...(!options.noUsage ? { usage: { prompt_tokens: 120, completion_tokens: 20, total_tokens: 140, ...(options.cost !== undefined ? { cost: options.cost } : {}) } } : {}) });
  response.end('data: [DONE]\n\n');
}
export async function events(config: Config): Promise<any[]> {
  return (await readFile(join(config.stateDir, 'outcomes.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
}
