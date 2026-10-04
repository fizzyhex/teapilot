import { afterEach, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { runHost } from '../src/host.js';
import { TaskStore, instructor } from '../src/workspace/task.js';
import { completion, events, fixture, mockServer } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it.each([undefined, 'off', 'on'] as const)('opts into experimental task state only with on (setting: %s)', async setting => {
  const f = await fixture(); cleanups.push(f.cleanup);
  const config = await loadConfig(f.cwd, setting ? { TEAPILOT_TASK_STATE: setting } : {});
  expect(config.taskState?.enabled).toBe(setting === 'on');
});

it.each(['default', 'omitted', 'off', 'on'] as const)('gates the ledger without disabling scratch files or execution (setting: %s)', async setting => {
  const f = await fixture(); cleanups.push(f.cleanup);
  if (setting === 'omitted') delete f.config.taskState;
  else if (setting !== 'default') f.config.taskState = { enabled: setting === 'on' };
  f.config.routingMode = 'direct';
  const bodies: any[] = [];
  const server = await mockServer((body, _req, res) => {
    bodies.push(body);
    completion(res, bodies.length === 1
      ? { tool: { name: 'read', arguments: { path: 'STATUS.md' } } }
      : { text: 'next: validate the handoff' });
  });
  cleanups.push(server.close);
  Object.assign(f.config.models.capable, { provider: 'ollama', baseUrl: server.url });
  const scratch = join(f.cwd, '.scratch');
  await mkdir(scratch);
  await writeFile(join(scratch, 'STATUS.md'), '## GOAL\nvalidate the handoff\n');
  const result = await runHost(f.config, {
    cwd: f.cwd, scratch, sessionId: 'session', taskId: 'explicit', prompt: 'read STATUS.md and tell me the next step',
    workload: 'ask', tier: 'normal',
  }, { approve: async () => true, localProbe: async () => true });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect((await events(f.config)).find(event => event.type === 'attempt_end')?.toolCalls).toBe(1);
  const names = bodies[0].tools.map((tool: any) => tool.function.name);
  expect(names).toEqual(expect.arrayContaining(['read', 'write', 'delegate_task']));
  const enabled = setting === 'on';
  expect(names.includes('task_state')).toBe(enabled);
  expect(names.includes('artifact_read')).toBe(enabled);
  expect(JSON.stringify(bodies).includes('[task state:')).toBe(enabled);
  expect((await events(f.config)).some(event => event.type === 'task_start')).toBe(enabled);
  expect(existsSync(join(f.config.stateDir, 'tasks'))).toBe(enabled);
  expect(await readdir(join(scratch, 'sessions'))).not.toHaveLength(0);
});

it('leaves existing ledger state untouched when the feature is disabled', async () => {
  const f = await fixture(); cleanups.push(f.cleanup);
  f.config.routingMode = 'direct';
  const scratch = join(f.cwd, '.scratch');
  await mkdir(scratch);
  const scope = JSON.stringify([f.cwd, 'session', 'explicit']);
  const task = TaskStore.open(f.config.stateDir, scope, 'old objective', scratch);
  task.update(instructor, { revision: 0, step: { id: 'old', goal: 'old-ledger-marker', status: 'working' } });
  const directory = join(f.config.stateDir, 'tasks');
  const [file] = await readdir(directory);
  const before = await readFile(join(directory, file!), 'utf8');
  const bodies: any[] = [];
  const server = await mockServer((body, _req, res) => { bodies.push(body); completion(res, { text: 'new answer' }); });
  cleanups.push(server.close);
  Object.assign(f.config.models.capable, { provider: 'ollama', baseUrl: server.url });
  const result = await runHost(f.config, {
    cwd: f.cwd, scratch, sessionId: 'session', taskId: 'explicit', prompt: 'new request', workload: 'ask', tier: 'normal',
  }, { approve: async () => true, localProbe: async () => true });
  expect(result.success).toBe(true);
  expect(JSON.stringify(bodies)).not.toContain('old-ledger-marker');
  expect(await readdir(directory)).toEqual([file]);
  expect(await readFile(join(directory, file!), 'utf8')).toBe(before);
});
