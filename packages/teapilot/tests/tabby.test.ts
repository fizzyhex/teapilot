import { afterEach, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadConfig } from '../src/config.js';
import { isRuntimeError, type RuntimeContext } from '../src/runtime/index.js';
import { manageRuntimes } from '../src/runtime/manage.js';
import type { NvidiaDetection, ProcessRun } from '../src/runtime/nvidia.js';
import { ollamaDriver } from '../src/runtime/ollama.js';
import { tabbyPresets } from '../src/runtime/presets.js';
import { tabbyRequirements } from '../src/runtime/tabby-lock.js';
import { loopbackFetch, tabbyDriver, type TabbyBoundaries, type TabbyInstall } from '../src/runtime/tabby.js';
import { setup } from '../src/setup/index.js';
import type { SetupUI } from '../src/setup/terminal.js';
import { completion, mockServer } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const preset = tabbyPresets[0]!;
const rtx3090: NvidiaDetection = { kind: 'found', gpus: [{ index: 0, name: 'NVIDIA GeForce RTX 3090', memoryMiB: 24576, driver: '610.60' }] };
const signal = () => new AbortController().signal;

function ui(overrides: Partial<SetupUI> = {}): SetupUI & { lines: string[] } {
  const lines: string[] = [];
  return { lines, log: text => lines.push(text), input: async () => '', choose: async () => 0, confirm: async () => true, ...overrides };
}

interface Tabby {
  up: boolean; foreign?: boolean; folders: Set<string>;
  loaded?: { id: string; max_seq_len: number; draft?: string; vision?: boolean };
  downloadError?: string; loadError?: string;
  requests: Array<{ path: string; body: any; auth?: string }>;
  chats: any[];
}

/** TabbyAPI's HTTP surface as the driver uses it, plus chat completions for live checks. */
async function tabbyServer(root: string) {
  const state: Tabby = { up: false, folders: new Set(), requests: [], chats: [] };
  const sse = (response: ServerResponse, events: unknown[]) => { response.setHeader('Content-Type', 'text/event-stream'); for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`); response.end(); };
  const server = await mockServer(async (body, request: IncomingMessage, response) => {
    const path = request.url ?? '';
    if (!state.up) { request.socket.destroy(); return; }
    state.requests.push({ path, body, auth: request.headers.authorization });
    if (path === '/health') { response.end('{"status":"healthy","issues":[]}'); return; }
    const keys = existsSync(join(root, 'teapilot-install.json')) ? (JSON.parse(await readFile(join(root, 'teapilot-install.json'), 'utf8')) as TabbyInstall).keys : undefined;
    const admin = !state.foreign && request.headers.authorization === `Bearer ${keys?.admin}`;
    const api = admin || (!state.foreign && request.headers.authorization === `Bearer ${keys?.api}`);
    if (!api) { response.writeHead(401); response.end('{"detail":"Invalid API key"}'); return; }
    if (path === '/v1/model/list') { response.end(JSON.stringify({ object: 'list', data: [...state.folders].map(id => ({ id })) })); return; }
    if (path === '/v1/models') { response.end(JSON.stringify({ object: 'list', data: state.loaded ? [{ id: state.loaded.id }] : [] })); return; }
    if (path === '/v1/model') {
      if (!state.loaded) { response.writeHead(503); response.end('{}'); return; }
      // Like the ExLlamaV3 backend, the card never names the drafter.
      response.end(JSON.stringify({ id: state.loaded.id, parameters: { max_seq_len: state.loaded.max_seq_len, use_vision: Boolean(state.loaded.vision) }, draft: null }));
      return;
    }
    if (path === '/v1/model/draft/list') { response.end(JSON.stringify({ object: 'list', data: state.loaded?.draft ? [{ id: state.loaded.draft }] : [] })); return; }
    if (!admin && ['/v1/download', '/v1/model/load'].includes(path)) { response.writeHead(401); response.end('{}'); return; }
    if (path === '/v1/download') {
      if (state.downloadError) { response.writeHead(400); response.end(JSON.stringify({ detail: state.downloadError })); return; }
      await mkdir(join(root, 'models', body.folder_name), { recursive: true });
      await writeFile(join(root, 'models', body.folder_name, 'weights.bin'), 'x');
      state.folders.add(body.folder_name);
      response.end(JSON.stringify({ download_path: join(root, 'models', body.folder_name) }));
      return;
    }
    if (path === '/v1/model/load') {
      if (state.loadError) { sse(response, [{ model_type: 'draft', module: 1, modules: 2, status: 'processing' }, { error: { message: state.loadError } }]); return; }
      // An MTP head comes from the server settings and is named after its model.
      const mtp = (await readFile(join(root, 'tabbyAPI', 'config.yml'), 'utf8').catch(() => '')).includes('draft_mode: mtp');
      state.loaded = { id: body.model_name, max_seq_len: body.max_seq_len, draft: body.draft_model?.draft_model_name ?? (mtp ? body.model_name : undefined), vision: body.vision };
      sse(response, [
        { model_type: 'draft', module: 1, modules: 1, status: 'finished' },
        { model_type: 'model', module: 32, modules: 64, status: 'processing' },
        { model_type: 'model', module: 64, modules: 64, status: 'finished' },
      ]);
      return;
    }
    if (path === '/v1/chat/completions') { state.chats.push(body); completion(response, { text: 'TEAPILOT_OK' }); return; }
    response.writeHead(404); response.end('{}');
  });
  cleanups.push(server.close);
  return { state, port: Number(new URL(server.url).port) };
}

/** A driver whose every process, download and GPU query is simulated. */
async function harness(overrides: Partial<TabbyBoundaries> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'teapilot-tabby-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const tabby = await tabbyServer(root);
  // Where TabbyAPI goes when the port is taken; down unless a test starts a stray there.
  const stray = await tabbyServer(root);
  const commands: string[][] = [];
  const launches: Array<{ executable: string; args: string[]; options: { cwd: string; env: NodeJS.ProcessEnv; log: string } }> = [];
  const run: ProcessRun = vi.fn(async (executable, args, _signal, options) => {
    commands.push([executable.replace(/^.*[\\/]/, ''), ...args]);
    // Simulate what the real programs leave behind.
    if (args[0] === '-xzf') { const target = args[args.indexOf('-C') + 1]!; await writeFile(join(target, 'main.py'), ''); }
    if (args[0] === 'venv') { const python = join(args[1]!, 'Scripts', 'python.exe'); await mkdir(join(python, '..'), { recursive: true }); await writeFile(python, ''); }
    void options;
    return { code: 0, stdout: 'ok' };
  });
  const fetch: typeof globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://')) return new Response('archive bytes');
    return loopbackFetch(input, init);
  });
  const boundaries: Partial<TabbyBoundaries> = {
    root, port: tabby.port, fallbackPort: stray.port, platform: 'win32', run, fetch, readyTimeoutMs: 3000,
    detect: async () => rtx3090, freeBytes: async () => 1e12, listening: async () => tabby.state.up,
    launch: async (executable, args, options) => { launches.push({ executable, args, options }); tabby.state.up = true; return 4242; },
    ...overrides,
  };
  return { root, tabby, stray, commands, launches, run, fetch, boundaries, driver: tabbyDriver(boundaries) };
}
const context = (setupUI: SetupUI = ui()): RuntimeContext => ({ ui: setupUI, signal: signal() });
const install = async (root: string) => JSON.parse(await readFile(join(root, 'teapilot-install.json'), 'utf8')) as TabbyInstall;

it('installs a pinned runtime, starts it, downloads and loads the preset as separate steps', async () => {
  vi.stubEnv('SOME_API_KEY', 'must-not-reach-children');
  const h = await harness();
  const prompts = ui();
  expect(await h.driver.suitability(signal())).toEqual({ suitable: true, summary: 'NVIDIA GeForce RTX 3090 (GPU 0, 24 GB, driver 610.60).', notes: [] });
  await h.driver.ensure(context(prompts));
  // Runtime: pinned source, isolated Python and the locked dependency set.
  expect(h.commands).toEqual([
    ['uv', '--version'],
    ['tar.exe', '-xzf', join(h.root, 'tabbyAPI.tar.gz'), '-C', join(h.root, 'tabbyAPI'), '--strip-components=1'],
    ['uv', 'venv', join(h.root, 'venv'), '--python', '3.12', '--managed-python', '--clear'],
    ['uv', 'pip', 'install', '--python', join(h.root, 'venv', 'Scripts', 'python.exe'), '--no-deps', '-r', join(h.root, 'requirements.lock.txt')],
  ]);
  expect(vi.mocked(h.fetch).mock.calls.map(call => String(call[0])).filter(url => url.startsWith('https://'))).toEqual([`https://codeload.github.com/theroyallab/tabbyAPI/tar.gz/${preset.runtimeRevision}`]);
  expect(await readFile(join(h.root, 'requirements.lock.txt'), 'utf8')).toBe(tabbyRequirements);
  expect(tabbyRequirements).toMatch(/^exllamav3 @ https:\/\/github\.com\/turboderp-org\/exllamav3\/releases\/download\/v1\.5\.1\//m);
  // Server: started once on the chosen GPU, without credentials in its environment.
  expect(h.launches).toHaveLength(1);
  expect(h.launches[0]).toMatchObject({ executable: join(h.root, 'venv', 'Scripts', 'python.exe'), args: ['main.py'], options: { cwd: join(h.root, 'tabbyAPI'), env: { CUDA_DEVICE_ORDER: 'PCI_BUS_ID', CUDA_VISIBLE_DEVICES: '0', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } } });
  expect(h.launches[0]!.options.env.SOME_API_KEY).toBeUndefined();
  const config = await readFile(join(h.root, 'tabbyAPI', 'config.yml'), 'utf8');
  expect(config).toContain(`port: ${h.tabby.port}`);
  expect(config).toContain('host: 127.0.0.1');
  expect(config).toContain('cache_size: 114688');
  expect(config).toContain('tool_format: qwen3_coder');
  expect(config).toContain('autosplit_reserve: [1536]');
  expect(config).toContain('draft_mode: mtp');
  expect(config).toContain('use_as_default: ["max_batch_size", "tool_format", "autosplit_reserve", "draft_mode"]');
  expect(config).toContain('vision: true');
  expect(config).not.toContain('vision_offload');
  expect(config).not.toContain('model_name');
  expect(h.tabby.state.requests.filter(item => item.path === '/v1/download')).toEqual([]);

  const provisioned = await h.driver.provision(context(prompts));
  const saved = await install(h.root);
  const downloads = h.tabby.state.requests.filter(item => item.path === '/v1/download');
  expect(downloads.map(item => item.body)).toEqual([
    { repo_id: 'Honkware/Qwen3.8-27B-heretic-ara-exl3-4.0bpw', revision: '1d09f16a35dc3c23b9634741bf61e6c746fcce21', folder_name: preset.model.folder },
  ]);
  expect(downloads.every(item => item.auth === `Bearer ${saved.keys.admin}`)).toBe(true);
  expect(h.tabby.state.requests.find(item => item.path === '/v1/model/load')!.body).toEqual({
    model_name: preset.model.folder, max_seq_len: 114688, cache_size: 114688, cache_mode: 'Q8', vision: true,
  });
  expect(saved.downloads).toEqual({ [preset.model.folder]: preset.model.revision });
  expect(prompts.lines).toContain('Loading model: 50%');
  // A restart loads the same deployment without setup.
  expect(await readFile(join(h.root, 'tabbyAPI', 'config.yml'), 'utf8')).toContain(`model_name: "${preset.model.folder}"`);
  expect(await readFile(join(h.root, 'tabbyAPI', 'config.yml'), 'utf8')).toContain('tool_format: qwen3_coder');
  // Setup receives an ordinary OpenAI-compatible model; the key is kept apart from it.
  expect(provisioned).toEqual([{
    roles: ['capable'], source: expect.any(String), apiKeyEnv: 'TABBY_API_KEY', apiKey: saved.keys.api,
    model: {
      id: preset.model.folder, provider: 'tabbyapi', baseUrl: `http://127.0.0.1:${h.tabby.port}/v1`, contextTokens: 114688, maxOutputTokens: 16384,
      toolCalling: true, vision: true, supportsDeveloperRole: false, supportsUsage: true, sampling: preset.sampling,
      reasoning: { type: 'chat_template_kwargs', values: { off: { enable_thinking: false }, low: { enable_thinking: true, reasoning_effort: 'low' }, medium: { enable_thinking: true, reasoning_effort: 'medium' }, xhigh: { enable_thinking: true, reasoning_effort: 'xhigh' } } },
    },
  }]);
  // Normal setup output names the path, not the server behind it.
  expect(prompts.lines.join('\n')).not.toMatch(/tabby|exllama/i);
});

it('reuses a healthy managed install, its downloads and its loaded model', async () => {
  const h = await harness();
  await h.driver.ensure(context()); await h.driver.provision(context());
  const confirm = vi.fn(async () => true);
  const again = await harness();
  // Same install directory and running server, new process and network boundaries.
  const reuse = tabbyDriver({ ...h.boundaries, run: again.run, launch: again.boundaries.launch });
  h.tabby.state.requests.length = 0;
  await reuse.ensure(context(ui({ confirm })));
  await reuse.provision(context(ui({ confirm })));
  expect(again.commands).toEqual([]);
  expect(again.launches).toEqual([]);
  expect(confirm).not.toHaveBeenCalled();
  expect(h.tabby.state.requests.map(item => item.path)).not.toContain('/v1/download');
  expect(h.tabby.state.requests.map(item => item.path)).not.toContain('/v1/model/load');

  // After a restart the server is started again, and loads the model itself from its config.
  h.tabby.state.up = false; h.tabby.state.loaded = { id: preset.model.folder, max_seq_len: 114688, draft: preset.model.folder, vision: true };
  const launch = vi.fn(async () => { h.tabby.state.up = true; return 1; });
  await tabbyDriver({ ...h.boundaries, launch }).start(context());
  expect(launch).toHaveBeenCalledTimes(1);
});

it('never reuses a download it did not see finish', async () => {
  const h = await harness();
  await h.driver.ensure(context());
  // A folder left by an interrupted download is listed by the server but not recorded.
  h.tabby.state.folders.add(preset.model.folder);
  await mkdir(join(h.root, 'models', preset.model.folder), { recursive: true });
  await writeFile(join(h.root, 'models', preset.model.folder, 'partial'), 'x');
  await h.driver.provision(context());
  expect(h.tabby.state.requests.filter(item => item.path === '/v1/download').map(item => item.body.folder_name)).toEqual([preset.model.folder]);
  expect(existsSync(join(h.root, 'models', preset.model.folder, 'partial'))).toBe(false);
});

it('classifies every failure layer without matching message text', async () => {
  const kind = async (promise: Promise<unknown>) => { const error = await promise.catch(caught => caught); return isRuntimeError(error) ? error.kind : error; };

  const noGpu = await harness({ detect: async () => ({ kind: 'no-gpu' }) });
  expect(await noGpu.driver.suitability(signal())).toMatchObject({ suitable: false, kind: 'hardware', reason: expect.stringContaining('No NVIDIA GPU') });
  expect(await kind(noGpu.driver.ensure(context()))).toBe('hardware');
  expect(await (await harness({ platform: 'linux' })).driver.suitability(signal())).toMatchObject({ suitable: false, reason: expect.stringContaining('Windows') });

  const declined = await harness();
  expect(await kind(declined.driver.ensure(context(ui({ confirm: async () => false }))))).toBe('declined');
  expect(declined.commands).toEqual([]);

  const broken = await harness({ run: async (_executable, args) => ({ code: args[0] === 'pip' ? 1 : 0, stdout: 'No matching distribution' }) });
  const failed = await broken.driver.ensure(context()).catch(error => error);
  expect(failed).toMatchObject({ kind: 'runtime', detail: expect.stringContaining('No matching distribution') });

  const tampered = await harness({ run: async (_executable, args) => ({ code: args[0] === '--version' ? 1 : 0, stdout: '' }) });
  expect(await tampered.driver.ensure(context()).catch(error => error)).toMatchObject({ kind: 'runtime', detail: expect.stringContaining('checksum') });

  const silent = await harness({ launch: async (_executable, _args, options) => { await writeFile(options.log, 'CUDA out of memory'); return 1; }, readyTimeoutMs: 1200 });
  expect(await silent.driver.ensure(context()).catch(error => error)).toMatchObject({ kind: 'not-ready', detail: 'CUDA out of memory' });

  const download = await harness();
  await download.driver.ensure(context());
  download.tabby.state.downloadError = 'Connection reset';
  expect(await download.driver.provision(context()).catch(error => error)).toMatchObject({ kind: 'download', detail: 'Connection reset' });
  expect((await install(download.root)).downloads).toEqual({});

  const load = await harness();
  await load.driver.ensure(context());
  load.tabby.state.loadError = 'CUDA out of memory';
  expect(await load.driver.provision(context()).catch(error => error)).toMatchObject({ kind: 'load', detail: 'CUDA out of memory' });

  // A server on the port that rejects this install's admin key is someone else's.
  const foreign = await harness();
  await foreign.driver.ensure(context());
  foreign.tabby.state.foreign = true;
  expect(await kind(foreign.driver.ensure(context()))).toBe('runtime');
});

it('reports state cheaply, gives hints for its own endpoint, and stops only its own server', async () => {
  const h = await harness();
  expect(await h.driver.inspect(signal())).toMatchObject({ ready: false, detail: 'not installed' });
  await h.driver.ensure(context()); const [provisioned] = await h.driver.provision(context());
  const model = { ...(await loadConfig(h.root, {})).models.capable, ...provisioned!.model };
  expect(await h.driver.inspect(signal())).toMatchObject({ ready: true, version: `TabbyAPI ${preset.runtimeRevision.slice(0, 7)}`, detail: `model ${preset.model.folder} loaded with MTP drafting; NVIDIA GeForce RTX 3090 (GPU 0, 24 GB, driver 610.60)` });
  expect((await h.driver.inspect(signal())).warnings).toBeUndefined();
  expect(h.tabby.state.requests.map(item => item.path)).not.toContain('/v1/chat/completions');
  expect(await h.driver.hint(model, signal())).toBeUndefined();
  expect(await h.driver.hint({ ...model, baseUrl: 'http://127.0.0.1:1/v1' }, signal())).toBeUndefined();
  h.tabby.state.loaded = undefined;
  expect(await h.driver.hint(model, signal())).toContain('running without its model');

  await h.driver.stop(signal());
  expect(h.commands.at(-1)).toEqual(['taskkill', '/PID', '4242', '/T', '/F']);
  expect(existsSync(join(h.root, 'server.pid'))).toBe(false);
  h.tabby.state.up = false;
  expect(await h.driver.hint(model, signal())).toContain('teapilot runtime start');
  const before = h.commands.length;
  await writeFile(join(h.root, 'server.pid'), '999');
  await h.driver.stop(signal());
  expect(h.commands).toHaveLength(before);
});

it('waits for a busy or still-loading server instead of loading a second copy of the model', async () => {
  const h = await harness();
  await h.driver.ensure(context()); await h.driver.provision(context());
  const launch = vi.fn(async () => { h.tabby.state.up = true; return 1; });
  const comesBack = () => setTimeout(() => { h.tabby.state.up = true; }, 1200);

  // The port is held, but /health does not answer in time.
  h.tabby.state.up = false; comesBack();
  await tabbyDriver({ ...h.boundaries, launch, listening: async () => true }).start(context());
  // Not bound yet: the recorded server is still loading its model.
  h.tabby.state.up = false; comesBack();
  const run: ProcessRun = async executable => ({ code: 0, stdout: executable === 'tasklist' ? '"python.exe","4242","Console","1","31,000,000 K"' : '' });
  await tabbyDriver({ ...h.boundaries, launch, run }).ensure(context());
  expect(launch).not.toHaveBeenCalled();

  // A stale process ID that now belongs to another program does not block a start.
  h.tabby.state.up = false;
  await tabbyDriver({ ...h.boundaries, launch, run: async () => ({ code: 0, stdout: '"notepad.exe","4242"' }) }).start(context());
  expect(launch).toHaveBeenCalledTimes(1);
});

it('reports and stops a second server of its own on the fallback port, never a foreign one', async () => {
  const h = await harness();
  await h.driver.ensure(context()); await h.driver.provision(context());
  h.stray.state.up = true;
  const warnings = async () => (await h.driver.inspect(signal())).warnings ?? [];
  expect(await warnings()).toEqual([expect.stringContaining(`second Optimized NVIDIA server is running on port ${h.stray.port}`)]);

  const listeners: Record<string, string> = { [h.tabby.port]: '4242\r\n', [h.stray.port]: '5151\r\n' };
  const commands: string[][] = [];
  const run: ProcessRun = async (executable, args) => { commands.push([executable, ...args]); return { code: 0, stdout: executable === 'powershell' ? listeners[/-LocalPort (\d+)/.exec(args.at(-1)!)![1]!]! : '' }; };
  await tabbyDriver({ ...h.boundaries, run }).stop(signal());
  expect(commands.filter(command => command[0] === 'taskkill')).toEqual([['taskkill', '/PID', '4242', '/T', '/F'], ['taskkill', '/PID', '5151', '/T', '/F']]);

  commands.length = 0;
  h.stray.state.foreign = true;
  expect(await warnings()).toEqual([]);
  await tabbyDriver({ ...h.boundaries, run }).stop(signal());
  expect(commands.filter(command => command[0] === 'taskkill')).toEqual([['taskkill', '/PID', '4242', '/T', '/F']]);
});

it('stops the server holding the port even when the recorded process ID is from a launch that failed', async () => {
  const h = await harness();
  await h.driver.ensure(context());
  await writeFile(join(h.root, 'server.pid'), '38616');
  const commands: string[][] = [];
  const run: ProcessRun = async (executable, args) => { commands.push([executable, ...args]); return { code: 0, stdout: executable === 'powershell' ? '32664\r\n' : '' }; };
  await tabbyDriver({ ...h.boundaries, run }).stop(signal());
  expect(commands.filter(command => command[0] === 'taskkill')).toEqual([['taskkill', '/PID', '32664', '/T', '/F']]);
});

it('reloads a model running without its drafter, and warns about it and about a log full of errors', async () => {
  const h = await harness();
  await h.driver.ensure(context()); await h.driver.provision(context());
  h.tabby.state.loaded!.draft = undefined;
  await writeFile(join(h.root, 'server.log'), 'UnicodeEncodeError\n--- Logging error in Loguru Handler #1 ---\n');
  expect((await h.driver.inspect(signal())).warnings).toEqual([expect.stringContaining('drafter is not loaded'), expect.stringContaining('logging errors')]);
  h.tabby.state.requests.length = 0;
  await h.driver.start(context());
  expect(h.tabby.state.loaded!.draft).toBe(preset.model.folder);
  expect((await h.driver.inspect(signal())).warnings).toEqual([expect.stringContaining('logging errors')]);
});

it('downloads and loads a separate drafter when a preset names one', async () => {
  const drafter = { repository: 'example/drafter', revision: 'abc123', folder: 'drafter', bytes: 1000 };
  const h = await harness({ preset: { ...preset, drafter, load: { ...preset.load, mtp: false } } });
  await h.driver.ensure(context());
  expect(await readFile(join(h.root, 'tabbyAPI', 'config.yml'), 'utf8')).not.toContain('draft_mode:');
  await h.driver.provision(context());
  expect(h.tabby.state.requests.filter(item => item.path === '/v1/download').map(item => item.body.folder_name)).toEqual([preset.model.folder, 'drafter']);
  expect(h.tabby.state.requests.find(item => item.path === '/v1/model/load')?.body).toMatchObject({ draft_model: { draft_model_name: 'drafter' } });
  expect(await readFile(join(h.root, 'tabbyAPI', 'config.yml'), 'utf8')).toContain('draft_model_name: "drafter"');
  expect((await h.driver.inspect(signal())).detail).toContain('loaded with drafter drafter');
});

it('reloads a model running without vision, and keeps vision offload to the server settings', async () => {
  const h = await harness();
  await h.driver.ensure(context()); await h.driver.provision(context());
  h.tabby.state.loaded!.vision = false;
  h.tabby.state.requests.length = 0;
  await h.driver.provision(context());
  expect(h.tabby.state.requests.find(item => item.path === '/v1/model/load')?.body).toMatchObject({ vision: true });
  expect(h.tabby.state.loaded!.vision).toBe(true);
  const offloaded = await harness({ preset: { ...preset, load: { ...preset.load, visionOffload: true } } });
  await offloaded.driver.ensure(context());
  const config = await readFile(join(offloaded.root, 'tabbyAPI', 'config.yml'), 'utf8');
  expect(config).toContain('vision_offload: true');
  expect(config).toContain('use_as_default: ["max_batch_size", "tool_format", "vision_offload", "autosplit_reserve", "draft_mode"]');
});

it('sets a large server log aside before starting the server', async () => {
  const h = await harness();
  await mkdir(h.root, { recursive: true });
  await writeFile(join(h.root, 'server.log'), Buffer.alloc(20_000_001));
  await h.driver.ensure(context());
  expect(existsSync(join(h.root, 'server.log.1'))).toBe(true);
  expect(existsSync(join(h.root, 'server.log'))).toBe(false);
});

it('sets up Optimized NVIDIA end to end: only verified reasoning tiers are enabled, and fast stays separate', async () => {
  const h = await harness();
  const directory = join(h.root, 'profile');
  vi.stubEnv('TEAPILOT_STATE_DIR', join(h.root, 'state'));
  const prompts = ui({ choose: async (message, choices) => message === 'Model source' ? choices.indexOf('Optimized NVIDIA') : message.startsWith('Web search') ? 2 : 0 });
  const runtimes = { ollama: { ...ollamaDriver, suitability: async () => ({ suitable: true as const, summary: '' }) }, nvidia: h.driver };
  await setup({ directory, runtimes }, prompts, signal());
  expect(prompts.lines.join('\n')).toContain('Configuration saved');
  const saved = await loadConfig(directory, {});
  expect(saved.models.fast.enabled).toBe(false);
  expect(saved.models.capable).toMatchObject({ enabled: true, provider: 'tabbyapi', id: preset.model.folder, reasoningEfforts: ['off', 'low', 'medium', 'xhigh'] });
  expect(saved.secrets.capable).toBe((await install(h.root)).keys.api);
  expect(JSON.stringify(saved.models)).not.toContain((await install(h.root)).keys.api);
  // Every probe carried the template switch for its tier; nothing was appended to prompts.
  expect(h.tabby.state.chats.map(body => body.chat_template_kwargs)).toEqual(expect.arrayContaining([{ enable_thinking: false }, { enable_thinking: true, reasoning_effort: 'low' }, { enable_thinking: true, reasoning_effort: 'medium' }, { enable_thinking: true, reasoning_effort: 'xhigh' }]));
  // Qwen's sampling travels with every request; probes alone decode greedily.
  expect(h.tabby.state.chats.every(body => body.top_k === 20 && body.temperature === 0)).toBe(true);
  // The review shows the normal tier dropping to its own reply length once reasoning verifies; context is shared.
  expect(prompts.lines.join('\n')).toContain('Tiers:     normal 114,688 / 4,096 output · reasoning 114,688 / 8,192 output · deep 114,688 / 16,384 output');
  expect(await manageRuntimes('status', saved, prompts, signal(), runtimes)).toBe(true);
}, 60000);

it('talks to the local server without a header deadline of its own, bounded only by the caller', async () => {
  const server = await mockServer(async (body, request, response) => {
    if (request.url === '/slow') { await new Promise(done => setTimeout(done, 300)); response.writeHead(201, { 'x-kind': 'slow' }); response.write('{"ok":'); await new Promise(done => setTimeout(done, 50)); response.end(`${JSON.stringify(body)}}`); return; }
    if (request.url === '/empty') { response.writeHead(204); response.end(); return; }
    response.end(JSON.stringify({ method: request.method, auth: request.headers.authorization }));
  });
  cleanups.push(server.close);
  const slow = await loopbackFetch(`${server.url}/slow`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"repo_id":"x"}' });
  expect([slow.status, slow.headers.get('x-kind'), await slow.json()]).toEqual([201, 'slow', { ok: { repo_id: 'x' } }]);
  expect(await (await loopbackFetch(`${server.url}/`, { headers: { Authorization: 'Bearer k' } })).json()).toEqual({ method: 'GET', auth: 'Bearer k' });
  expect((await loopbackFetch(`${server.url}/empty`)).status).toBe(204);
  await expect(loopbackFetch(`${server.url}/slow`, { signal: AbortSignal.timeout(50) })).rejects.toThrow();
});
