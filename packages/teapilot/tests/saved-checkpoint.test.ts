import { afterEach, expect, it, vi } from 'vitest';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Checkpoint } from '../src/agents/checkpoint.js';
import { runHost } from '../src/host.js';
import { SessionGrants } from '../src/execution/grants.js';
import { CheckpointStore, checkpointCommand } from '../src/workspace/checkpoint.js';
import { completion, events, fixture, jev, mockServer } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const checkpoint: Checkpoint = { version: 1, requestId: 'old-request', checkpointId: 1, sequence: 1, reason: 'request_calls', durability: 'request-local', expiresAt: 0,
  summary: ['partial work'], snapshot: { originalObjective: 'inspect evidence', amendments: ['keep the public api'], artifacts: [{ ref: 'file:evidence.txt' }], checks: [{ ref: 'check:test', status: 'passed' }], results: [], workers: [], resources: { requestCallsRemaining: 0 }, pendingUncertain: ['verify current files'] },
  continuation: { offerId: 'expired-offer', instructorCalls: 3, activeMs: 10000, freshContext: false } };

it('persists recoverable state without a continuation lease and enforces root, scope, channel and requester', async () => {
  const f = await fixture(); cleanups.push(f.cleanup);
  const store = new CheckpointStore(f.config.stateDir);
  const caller = { root: f.cwd, scope: 'room', channel: 'channel', owner: 'asker' };
  const saved = store.save(checkpoint, { ...caller, prompt: 'inspect evidence', workload: 'coder' });
  const restarted = new CheckpointStore(f.config.stateDir);
  expect(restarted.list(caller).map(item => item.id)).toEqual([saved.id]);
  expect(restarted.read(saved.id).checkpoint).not.toHaveProperty('continuation');
  for (const other of [{ root: 'elsewhere' }, { scope: 'elsewhere' }, { channel: 'elsewhere' }, { owner: 'stranger' }]) {
    expect(() => restarted.authorize(saved, { ...caller, ...other })).toThrow('different');
    expect(restarted.list({ ...caller, ...other })).toEqual([]);
  }
  expect(() => restarted.authorize(saved, { ...caller, owner: 'op', operator: true })).not.toThrow();
  expect(() => restarted.read('../outside')).toThrow('invalid');
  restarted.settle(saved.id, 'finished');
  expect(restarted.list(caller)).toEqual([]);
});

it('parses only explicit reopening commands', () => {
  expect(checkpointCommand('resume my work')).toBeUndefined();
  expect(checkpointCommand('/checkpoint')).toEqual({ action: 'list' });
  expect(checkpointCommand('/checkpoint redirect id keep it small')).toEqual({ action: 'redirect', id: 'id', amendment: 'keep it small' });
  expect(() => checkpointCommand('/checkpoint redirect id')).toThrow('use /checkpoint');
  expect(() => checkpointCommand('/checkpoint resume id extra')).toThrow('use /checkpoint');
});

it('expiry releases the host lock, keeps a saved checkpoint, and never runs another provider call', async () => {
  const f = await fixture(); cleanups.push(f.cleanup);
  let calls = 0;
  const server = await mockServer((_body, req, res) => {
    if (req.url === '/jev') jev(res, 'coder.normal');
    else if (req.url?.endsWith('/models')) res.end('{}');
    else if (++calls === 1) completion(res, { tool: { name: 'read', arguments: { path: 'evidence.txt' } } });
    else completion(res, { text: 'read evidence; work is partial' });
  }); cleanups.push(server.close);
  f.config.router.endpoint = `${server.url}/jev`;
  f.config.models.capable.baseUrl = `${server.url}/capable/v1`;
  f.config.models.fast.baseUrl = `${server.url}/fast/v1`;
  f.config.policy.limits.instructorToolCalls = 1;
  await writeFile(join(f.cwd, 'evidence.txt'), 'evidence');
  // Drive the existing checkpoint expiry timer, not a model or live personal profile.
  const schedule = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => schedule(callback, delay && delay > 59000 && delay <= 60000 ? 10 : delay, ...args)) as typeof setTimeout);
  let shown: Readonly<Checkpoint> | undefined;
  const result = await runHost(f.config, { cwd: f.cwd, prompt: 'inspect evidence fixture-jev-secret', workload: 'coder' }, {
    approve: async () => true, localProbe: async () => true,
    onCheckpoint: async (cp, signal) => {
      shown = cp;
      expect(Object.isFrozen(cp)).toBe(true);
      const saved = new CheckpointStore(f.config.stateDir).read(cp.savedId!);
      expect(saved.status).toBe('pending');
      expect(saved.prompt).not.toContain('fixture-jev-secret');
      return new Promise(resolve => signal.addEventListener('abort', () => resolve(undefined), { once: true }));
    },
  });
  expect(result).toMatchObject({ success: false, status: 'partial', checkpointAvailable: true, checkpoint: { savedId: shown!.savedId, durability: 'saved' } });
  expect(result.text).toContain(`/checkpoint resume ${shown!.savedId}`);
  expect(calls).toBe(2);
  await expect(stat(join(f.config.stateDir, 'run.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  const saved = new CheckpointStore(f.config.stateDir).read(shown!.savedId!);
  expect(saved.status).toBe('available');
  expect(saved.checkpoint.snapshot.results.length).toBeGreaterThan(0);
});

it.each(['resume', 'redirect'] as const)('%s explicitly starts one new bounded request from persisted evidence with current permissions', async action => {
  const f = await fixture(); cleanups.push(f.cleanup);
  let calls = 0, sent = '';
  let toolNames: string[] = [];
  const server = await mockServer((body, req, res) => {
    if (req.url === '/jev') jev(res, 'coder.normal');
    else if (req.url?.endsWith('/models')) res.end('{}');
    else { calls++; sent = JSON.stringify(body.messages); toolNames = body.tools.map((item: any) => item.function.name); completion(res, { text: 'reviewed the remaining work' }); }
  }); cleanups.push(server.close);
  f.config.router.endpoint = `${server.url}/jev`;
  f.config.models.capable.baseUrl = `${server.url}/capable/v1`;
  f.config.models.fast.baseUrl = `${server.url}/fast/v1`;
  f.config.policy.permissions = ['inference', 'repository.read'];
  const store = new CheckpointStore(f.config.stateDir);
  const saved = store.save(checkpoint, { root: await realpath(f.cwd), scope: 'terminal', prompt: 'inspect evidence', correction: 'do not rename symbols', workload: 'coder', constraints: ['keep public api'] });
  const request = { cwd: f.cwd, prompt: '', checkpointAction: { action, id: saved.id, ...(action === 'redirect' ? { amendment: 'only inspect the parser' } : {}) } };
  const deps = { approve: async () => true, localProbe: async () => true };
  const result = await runHost(f.config, request, deps);
  expect(result.requestId).not.toBe(checkpoint.requestId);
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(calls).toBe(1);
  expect(sent).toContain('inspect evidence');
  expect(sent).toContain('verify current files');
  expect(sent).toContain('may be stale');
  expect(sent).toContain('do not rename symbols');
  expect(sent).not.toContain('expired-offer');
  if (action === 'redirect') expect(sent).toContain('only inspect the parser');
  expect(toolNames).not.toContain('write'); expect(toolNames).not.toContain('bash');
  expect(new CheckpointStore(f.config.stateDir).read(saved.id)).toMatchObject({ status: 'resumed', executionId: result.requestId });
  expect((await events(f.config)).find(item => item.type === 'checkpoint_reopened')).toMatchObject({ previousRequestId: 'old-request', action });
  await expect(runHost(f.config, request, deps)).rejects.toThrow('already handled');
  expect(calls).toBe(1);
});

it('list and finish require no inference, leave files intact and cannot finish twice', async () => {
  const f = await fixture(); cleanups.push(f.cleanup);
  const store = new CheckpointStore(f.config.stateDir);
  const saved = store.save(checkpoint, { root: await realpath(f.cwd), scope: 'terminal', prompt: 'inspect evidence', workload: 'coder' });
  await writeFile(join(f.cwd, 'evidence.txt'), 'keep me');
  const provider = { name: 'must not run', decide: vi.fn() };
  const deps = { approve: vi.fn(), provider };
  expect((await runHost(f.config, { cwd: f.cwd, prompt: '', checkpointAction: { action: 'list' } }, deps)).text).toContain(saved.id);
  const request = { cwd: f.cwd, prompt: '', checkpointAction: { action: 'finish' as const, id: saved.id } };
  expect(await runHost(f.config, request, deps)).toMatchObject({ success: true, spentUsd: 0, attempts: 0 });
  expect(await readFile(join(f.cwd, 'evidence.txt'), 'utf8')).toBe('keep me');
  expect(provider.decide).not.toHaveBeenCalled(); expect(deps.approve).not.toHaveBeenCalled();
  await expect(runHost(f.config, request, deps)).rejects.toThrow('already handled');
});

it('keeps reopening available when current grants block execution before any attempt', async () => {
  const f = await fixture(); cleanups.push(f.cleanup);
  const store = new CheckpointStore(f.config.stateDir);
  const saved = store.save(checkpoint, { root: await realpath(f.cwd), scope: 'terminal', prompt: 'inspect evidence', workload: 'coder' });
  const grants = await SessionGrants.create(f.cwd, f.config, 'code');
  grants.revoke('inference');
  const result = await runHost(f.config, { cwd: f.cwd, prompt: '', authorization: grants, checkpointAction: { action: 'resume', id: saved.id } }, { approve: async () => false });
  expect(result).toMatchObject({ success: false, status: 'blocked', attempts: 0, checkpointAvailable: true, checkpoint: { savedId: saved.id } });
  expect(store.read(saved.id).status).toBe('available');
});

it('reopens through the standalone CLI without a prompt, including direct routing after restart', async () => {
  const f = await fixture(); cleanups.push(f.cleanup);
  let calls = 0;
  const server = await mockServer((_body, req, res) => {
    if (req.url?.endsWith('/models')) res.end('{}');
    else { calls++; completion(res, { text: 'remaining work reviewed' }); }
  }); cleanups.push(server.close);
  for (const model of [f.config.models.fast, f.config.models.capable]) model.baseUrl = `${server.url}/v1`;
  f.config.policy.permissions = ['inference', 'repository.read'];
  await writeFile(join(f.cwd, 'models.json'), JSON.stringify(f.config.models));
  await writeFile(join(f.cwd, 'policy.json'), JSON.stringify(f.config.policy));
  const saved = new CheckpointStore(f.config.stateDir).save(checkpoint, { root: await realpath(f.cwd), scope: 'terminal', prompt: 'inspect evidence', workload: 'coder' });
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const root = fileURLToPath(new URL('..', import.meta.url));
  const command = (action: string[]) => promisify(execFile)(process.execPath, ['--import', 'tsx', '--conditions=teapilot-source', cli, 'checkpoint', ...action, '--cwd', f.cwd, '--config-dir', f.cwd, '--json', '--tier', 'normal'], { cwd: root, timeout: 30000, env: { ...process.env, TEAPILOT_STATE_DIR: f.config.stateDir, TEAPILOT_MODELS_FILE: join(f.cwd, 'models.json'), TEAPILOT_POLICY_FILE: join(f.cwd, 'policy.json'), TEAPILOT_ROUTING_MODE: 'direct', WORKSPACE_SANDBOX: 'off' } });
  expect(JSON.parse((await command(['list'])).stdout).text).toContain(saved.id);
  expect(calls).toBe(0);
  const result = JSON.parse((await command(['resume', saved.id])).stdout);
  expect(result).toMatchObject({ success: true, text: 'remaining work reviewed' });
  expect(result.requestId).not.toBe('old-request');
  expect(calls).toBe(1);
}, 60000);
