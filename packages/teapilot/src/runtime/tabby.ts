import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { mkdir, open, readdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { during } from '../activity.js';
import { exists, type ModelConfig } from '../config.js';
import type { SetupUI } from '../setup/terminal.js';
import { assessNvidia, describeGpu, detectNvidia, runProcess, type NvidiaAssessment, type NvidiaDetection, type ProcessRun } from './nvidia.js';
import { checkDisk } from './ollama.js';
import { tabbyPresets, type PinnedRepository, type TabbyPreset } from './presets.js';
import { tabbyPython, tabbyRequirements } from './tabby-lock.js';
import { RuntimeError, type ProvisionedModel, type RuntimeContext, type RuntimeDriver, type RuntimeInspection, type Suitability } from './types.js';

// Normal setup calls this path Optimized NVIDIA. TabbyAPI and ExLlamaV3 are
// named only in advanced detail and in errors.
export const nvidiaLabel = 'Optimized NVIDIA';

// Used only when uv is not already on PATH; placed inside the install, never system-wide.
const uvRelease = {
  url: 'https://github.com/astral-sh/uv/releases/download/0.11.16/uv-x86_64-pc-windows-msvc.zip',
  sha256: 'dd9d6d6554bfab265bfa98aa8e8a406c5c3a7b97582f93de1f4d48d9154a0395',
};

/**
 * Managed-runtime metadata, kept beside the install and never in ModelConfig.
 * downloads records only downloads that finished, so a folder left by an
 * interrupted download is never mistaken for a usable model.
 */
export interface TabbyInstall {
  runtime: 'tabbyapi'; revision: string; lock: string;
  keys: { api: string; admin: string };
  downloads: Record<string, string>;
  gpu: number;
  /** The preset loaded last; the server loads it again whenever it starts. */
  preset?: string;
}

/** Process, file system and network boundaries, replaced in tests. */
export interface TabbyBoundaries {
  root: string; port: number; platform: NodeJS.Platform; preset: TabbyPreset;
  /** Where TabbyAPI silently moves when its port is taken (port + 1 in its main.py). */
  fallbackPort: number;
  run: ProcessRun;
  /** Whether something accepts TCP connections on a local port. */
  listening(port: number): Promise<boolean>;
  /** Start a detached server process whose output goes to log; resolves with its process ID. */
  launch(executable: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; log: string }): Promise<number>;
  detect(signal: AbortSignal): Promise<NvidiaDetection>;
  fetch: typeof fetch;
  freeBytes(path: string): Promise<number>;
  /** How long to wait for the server, in milliseconds. */
  readyTimeoutMs: number;
}

async function launchDetached(executable: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; log: string }): Promise<number> {
  const log = await open(options.log, 'a', 0o600);
  try {
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env, detached: true, windowsHide: true, shell: false, stdio: ['ignore', log.fd, log.fd] });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    return child.pid!;
  } finally { await log.close(); }
}

/**
 * fetch for the local server without undici's five-minute header and body
 * timeouts: TabbyAPI answers a download only once it has finished, and cancels
 * it, deleting the files, when the request is dropped. The caller's signal
 * still bounds every request. Other URLs use the global fetch.
 */
export function loopbackFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') return globalThis.fetch(input, init);
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: init.method ?? 'GET', headers: Object.fromEntries(new Headers(init.headers)), signal: init.signal ?? undefined }, response => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      const status = response.statusCode ?? 502;
      const body = status === 204 || status === 304 ? (response.resume(), null) : Readable.toWeb(response) as ReadableStream<Uint8Array>;
      resolve(new Response(body, { status, statusText: response.statusMessage, headers }));
    });
    request.once('error', reject);
    request.end(typeof init.body === 'string' ? init.body : undefined);
  });
}

function listening(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port });
    const done = (open: boolean) => { socket.destroy(); resolve(open); };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function freeBytes(path: string): Promise<number> {
  while (!await exists(path)) { const parent = dirname(path); if (parent === path) break; path = parent; }
  const disk = await statfs(path);
  return disk.bavail * disk.bsize;
}

async function folderBytes(path: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
    const child = join(path, entry.name);
    total += entry.isDirectory() ? await folderBytes(child) : await stat(child).then(info => info.size, () => 0);
  }
  return total;
}

/** Children get the environment without credentials meant for TeaPilot or other tools. */
function childEnvironment(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|PASSWORD/i.test(key) && !/^(TEAPILOT|JEV)_/.test(key)));
  return { ...env, ...extra };
}

const quote = (value: string) => JSON.stringify(value.replace(/\\/g, '/'));
const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;
const short = (revision: string) => revision.slice(0, 7);
const lockOf = (revision: string) => createHash('sha256').update(`${revision}\n${tabbyPython}\n${tabbyRequirements}`).digest('hex');

// The ExLlamaV3 backend never fills the card's draft field; /v1/model/draft/list names the loaded drafter.
interface ModelCard { id?: string; parameters?: { max_seq_len?: number; use_vision?: boolean } }

/**
 * TabbyAPI with ExLlamaV3 on one NVIDIA GPU, installed by TeaPilot into a
 * directory it owns, at a pinned revision with a pinned dependency set. The
 * server is driven through its own download and load endpoints, so TeaPilot
 * needs no knowledge of the model file layout.
 */
export class TabbyDriver implements RuntimeDriver {
  readonly id = 'nvidia';
  readonly label = nvidiaLabel;
  readonly ownership = 'managed' as const;
  // Nothing streams while a prompt is read: a cold 110K-token prompt takes ~3.5 minutes on an RTX 3090.
  // The stall timeout resets on every token.
  readonly requestTimeoutMs = 360000;
  constructor(private readonly io: TabbyBoundaries) {}

  get baseUrl(): string { return `http://127.0.0.1:${this.io.port}/v1`; }
  private get paths() {
    const root = this.io.root;
    const venv = join(root, 'venv');
    return {
      root, venv, source: join(root, 'tabbyAPI'), models: join(root, 'models'), metadata: join(root, 'teapilot-install.json'),
      log: join(root, 'server.log'), pid: join(root, 'server.pid'), lock: join(root, 'requirements.lock.txt'),
      python: this.io.platform === 'win32' ? join(venv, 'Scripts', 'python.exe') : join(venv, 'bin', 'python'),
    };
  }

  private async assess(signal: AbortSignal): Promise<NvidiaAssessment> {
    if (this.io.platform !== 'win32') return { suitable: false, reason: 'Optimized NVIDIA currently supports Windows only.' };
    return assessNvidia(await this.io.detect(signal), this.io.preset.hardware);
  }

  async suitability(signal: AbortSignal): Promise<Suitability> {
    const assessment = await this.assess(signal);
    if (!assessment.suitable) return { suitable: false, kind: 'hardware', reason: assessment.reason };
    return { suitable: true, summary: `${assessment.summary}.`, notes: assessment.notes };
  }

  async readInstall(): Promise<TabbyInstall | undefined> {
    try { return JSON.parse(await readFile(this.paths.metadata, 'utf8')) as TabbyInstall; } catch { return undefined; }
  }
  private async saveInstall(install: TabbyInstall): Promise<void> {
    const pending = `${this.paths.metadata}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(pending, `${JSON.stringify(install, null, 2)}\n`, { mode: 0o600 });
    await rename(pending, this.paths.metadata);
  }
  /** A finished install of this exact revision and dependency set. */
  private async installed(install: TabbyInstall | undefined): Promise<boolean> {
    return install?.revision === this.io.preset.runtimeRevision && install.lock === lockOf(install.revision)
      && await exists(this.paths.python) && await exists(join(this.paths.source, 'main.py'));
  }

  private async request(path: string, options: { signal: AbortSignal; key?: string; body?: unknown; timeoutMs?: number; port?: number }): Promise<Response> {
    return this.io.fetch(`http://127.0.0.1:${options.port ?? this.io.port}${path}`, {
      method: options.body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { ...options.key ? { Authorization: `Bearer ${options.key}` } : {}, ...options.body === undefined ? {} : { 'Content-Type': 'application/json' } },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 10000)]),
    });
  }
  private async healthy(signal: AbortSignal, port?: number): Promise<boolean> {
    try { const response = await this.request('/health', { signal, timeoutMs: 3000, port }); await response.body?.cancel(); return response.ok; }
    catch { signal.throwIfAborted(); return false; }
  }
  /** A server that accepts this install's admin key is one TeaPilot started. */
  private async owns(install: TabbyInstall, port: number, signal: AbortSignal): Promise<boolean> {
    try { const response = await this.request('/v1/model/list', { signal, key: install.keys.admin, port }); await response.body?.cancel(); return response.ok; }
    catch { signal.throwIfAborted(); return false; }
  }
  /** What the server names as the drafter once the preset is loaded; an MTP head is named after the model it belongs to. */
  private get drafterId(): string | undefined {
    return this.io.preset.load.mtp ? this.io.preset.model.folder : this.io.preset.drafter?.folder;
  }
  private async loadedDrafter(install: TabbyInstall, signal: AbortSignal): Promise<string | undefined> {
    try {
      const response = await this.request('/v1/model/draft/list', { signal, key: install.keys.api });
      return response.ok ? (await response.json() as { data?: Array<{ id?: string }> }).data?.[0]?.id : (await response.body?.cancel(), undefined);
    } catch { signal.throwIfAborted(); return undefined; }
  }
  /**
   * The port is held, or the recorded server is still loading its model (TabbyAPI
   * binds only after loading). Launching then would load a second copy onto the GPU.
   */
  private async occupied(signal: AbortSignal): Promise<boolean> {
    if (await this.io.listening(this.io.port)) return true;
    const pid = Number(await readFile(this.paths.pid, 'utf8').catch(() => ''));
    if (!pid) return false;
    const found = await this.io.run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], signal).catch(() => undefined);
    return /^"python\.exe"/im.test(found?.stdout ?? '');
  }
  private async waitHealthy(signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.io.readyTimeoutMs;
    while (Date.now() < deadline) {
      if (await this.healthy(signal)) return;
      await delay(1000, undefined, { signal });
    }
    throw new RuntimeError('not-ready', `The Optimized NVIDIA server did not become ready. Its log is ${this.paths.log}.`, await this.logTail());
  }
  /** Waits for a busy or loading server instead of starting another; false when none is there. */
  private async awaitRunning(signal: AbortSignal): Promise<boolean> {
    if (await this.healthy(signal)) return true;
    if (!await this.occupied(signal)) return false;
    await this.waitHealthy(signal);
    return true;
  }
  private async kill(pid: number, signal: AbortSignal): Promise<void> {
    const result = this.io.platform === 'win32'
      ? await this.io.run('taskkill', ['/PID', String(pid), '/T', '/F'], signal)
      : (process.kill(pid), { code: 0, stdout: '' });
    if (result.code !== 0) throw new RuntimeError('runtime', 'The Optimized NVIDIA server could not be stopped.', result.stdout);
  }
  /** The process listening on a local port. */
  private async listener(port: number, signal: AbortSignal): Promise<number | undefined> {
    const result = await this.io.run('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue).OwningProcess`], signal);
    const pid = Number(/^\s*(\d+)\s*$/m.exec(result.stdout)?.[1]);
    return pid > 0 ? pid : undefined;
  }
  private async currentModel(install: TabbyInstall, signal: AbortSignal): Promise<ModelCard | undefined> {
    try {
      const response = await this.request('/v1/model', { signal, key: install.keys.api });
      return response.ok ? await response.json() as ModelCard : (await response.body?.cancel(), undefined);
    } catch { signal.throwIfAborted(); return undefined; }
  }
  /** A server on this port that rejects the admin key belongs to another program. */
  private async folders(install: TabbyInstall, signal: AbortSignal): Promise<string[]> {
    const response = await this.request('/v1/model/list', { signal, key: install.keys.admin }).catch(error => { signal.throwIfAborted(); throw new RuntimeError('not-ready', 'The Optimized NVIDIA server stopped responding.', String(error)); });
    if (response.status === 401 || response.status === 403) throw new RuntimeError('runtime', `Another program is using port ${this.io.port}. Stop it, then rerun setup.`);
    if (!response.ok) throw new RuntimeError('api', `The Optimized NVIDIA server could not list models (HTTP ${response.status}).`);
    const body = await response.json() as { data?: Array<{ id?: string }> };
    return (body.data ?? []).flatMap(item => item.id ? [item.id] : []);
  }
  private async logTail(): Promise<string> {
    return (await readFile(this.paths.log, 'utf8').catch(() => '')).slice(-2000).trim();
  }

  private async exec(executable: string, args: string[], signal: AbortSignal, timeoutMs: number, env: Record<string, string> = {}): Promise<void> {
    const result = await this.io.run(executable, args, AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]), { cwd: this.paths.root, env: childEnvironment(env) });
    if (result.code !== 0) throw new Error(`${executable} ${args[0]} exited with ${result.code}: ${result.stdout.trim().split(/\r?\n/).slice(-3).join(' ')}`);
  }
  private get tar(): string { return this.io.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'; }
  private async download(url: string, path: string, signal: AbortSignal, sha256?: string): Promise<void> {
    const response = await this.io.fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(30 * 60 * 1000)]) });
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (sha256 && createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error(`${url} did not match its pinned checksum`);
    await writeFile(path, bytes);
  }
  private async uv(signal: AbortSignal): Promise<string> {
    const found = await this.io.run('uv', ['--version'], signal).catch(() => undefined);
    if (found?.code === 0) return 'uv';
    const local = join(this.paths.root, 'uv', this.io.platform === 'win32' ? 'uv.exe' : 'uv');
    if (await exists(local)) return local;
    const archive = join(this.paths.root, 'uv.zip');
    await this.download(uvRelease.url, archive, signal, uvRelease.sha256);
    await mkdir(dirname(local), { recursive: true });
    await this.exec(this.tar, ['-xf', archive, '-C', dirname(local)], signal, 60000);
    await rm(archive, { force: true });
    return local;
  }

  private async install(ui: SetupUI, signal: AbortSignal, previous: TabbyInstall | undefined, gpu: number): Promise<TabbyInstall> {
    const revision = this.io.preset.runtimeRevision;
    checkDisk(await this.io.freeBytes(this.paths.root), 10_000_000_000);
    if (!await ui.confirm(`Install the Optimized NVIDIA runtime into ${this.paths.root}? It downloads about 6 GB (Python, PyTorch and ExLlamaV3) and changes nothing outside that folder.`)) {
      throw new RuntimeError('declined', 'Installation declined. Rerun setup or choose another model source.');
    }
    const { root, source, venv, python, lock } = this.paths;
    const uvEnv = { UV_PYTHON_INSTALL_DIR: join(root, 'python'), UV_CACHE_DIR: join(root, 'cache'), UV_NO_CONFIG: '1' };
    try {
      await mkdir(root, { recursive: true });
      const uv = await during(ui, 'Preparing the installer...', () => this.uv(signal));
      await during(ui, 'Downloading the Optimized NVIDIA runtime...', async () => {
        const archive = join(root, 'tabbyAPI.tar.gz');
        await this.download(`https://codeload.github.com/theroyallab/tabbyAPI/tar.gz/${revision}`, archive, signal);
        await rm(source, { recursive: true, force: true }); await mkdir(source, { recursive: true });
        await this.exec(this.tar, ['-xzf', archive, '-C', source, '--strip-components=1'], signal, 5 * 60 * 1000);
        await rm(archive, { force: true });
      });
      await during(ui, 'Installing Python...', () => this.exec(uv, ['venv', venv, '--python', tabbyPython, '--managed-python', '--clear'], signal, 15 * 60 * 1000, uvEnv));
      await writeFile(lock, tabbyRequirements);
      // --no-deps: the lock is complete, so nothing outside it can be resolved in.
      await during(ui, 'Installing PyTorch and ExLlamaV3...', () => this.exec(uv, ['pip', 'install', '--python', python, '--no-deps', '-r', lock], signal, 90 * 60 * 1000, uvEnv));
      if (!await exists(python) || !await exists(join(source, 'main.py'))) throw new Error('the installed files are incomplete');
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError('runtime', `The Optimized NVIDIA runtime could not be installed (TabbyAPI ${short(revision)}). Rerun setup to retry.`, error instanceof Error ? error.message : String(error));
    }
    const install: TabbyInstall = {
      runtime: 'tabbyapi', revision, lock: lockOf(revision), gpu,
      keys: previous?.keys ?? { api: randomBytes(16).toString('hex'), admin: randomBytes(16).toString('hex') },
      downloads: previous?.downloads ?? {}, preset: previous?.preset,
    };
    await this.saveInstall(install);
    return install;
  }

  /** Server settings; once a preset has loaded, the server loads it again on every start. */
  private async configure(install: TabbyInstall): Promise<void> {
    const preset = this.io.preset;
    const loaded = install.preset === preset.id;
    const models = quote(this.paths.models);
    const offload = Boolean(preset.vision && preset.load.visionOffload);
    // Settings the load request cannot carry; API loads take them from these defaults.
    const defaults = ['max_batch_size', 'tool_format', ...offload ? ['vision_offload'] : [], ...preset.load.reserveMiB ? ['autosplit_reserve'] : [], ...preset.load.mtp ? ['draft_mode'] : []];
    await mkdir(this.paths.models, { recursive: true });
    await writeFile(join(this.paths.source, 'config.yml'), [
      '# Written by TeaPilot for its managed Optimized NVIDIA runtime. Rerun teapilot setup to change it.',
      'network:', '  host: 127.0.0.1', `  port: ${this.io.port}`, '  disable_auth: false',
      'model:', `  model_dir: ${models}`, '  inline_model_loading: false',
      ...loaded ? [`  model_name: ${quote(preset.model.folder)}`] : [],
      `  max_seq_len: ${preset.context}`, `  cache_size: ${preset.context}`, `  cache_mode: ${preset.load.cache_mode}`, `  max_batch_size: ${preset.load.max_batch_size}`,
      `  tool_format: ${preset.load.tool_format}`,
      ...preset.vision ? ['  vision: true', ...offload ? ['  vision_offload: true'] : []] : [],
      ...preset.load.reserveMiB ? [`  autosplit_reserve: [${preset.load.reserveMiB}]`] : [],
      `  use_as_default: [${defaults.map(name => `"${name}"`).join(', ')}]`,
      'draft_model:', `  draft_model_dir: ${models}`,
      ...preset.load.mtp ? ['  draft_mode: mtp'] : [],
      ...loaded && preset.drafter ? [`  draft_model_name: ${quote(preset.drafter.folder)}`] : [],
      '',
    ].join('\n'), { mode: 0o600 });
    await writeFile(join(this.paths.source, 'api_tokens.yml'), `api_key: ${install.keys.api}\nadmin_key: ${install.keys.admin}\n`, { mode: 0o600 });
  }

  private async startServer(install: TabbyInstall, signal: AbortSignal): Promise<void> {
    if (((await stat(this.paths.log).catch(() => undefined))?.size ?? 0) > 20_000_000) await rename(this.paths.log, `${this.paths.log}.1`);
    const pid = await this.io.launch(this.paths.python, ['main.py'], {
      cwd: this.paths.source, log: this.paths.log,
      // nvidia-smi numbers GPUs in PCI bus order; CUDA must use the same order to run on the chosen one.
      // Output goes to a file, whose default Windows code page cannot encode the server's box drawing;
      // every line would then add a logging traceback.
      env: childEnvironment({ CUDA_DEVICE_ORDER: 'PCI_BUS_ID', CUDA_VISIBLE_DEVICES: String(install.gpu), PYTHONUNBUFFERED: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }),
    }).catch(async error => { throw new RuntimeError('runtime', 'The Optimized NVIDIA server could not start.', String(error)); });
    await writeFile(this.paths.pid, String(pid));
    await this.waitHealthy(signal);
  }

  /** Install or reuse the runtime, then start the server or reuse the running one. */
  async ensure({ ui, signal }: RuntimeContext): Promise<void> {
    const assessment = await this.assess(signal);
    if (!assessment.suitable) throw new RuntimeError('hardware', assessment.reason);
    ui.log(`GPU: ${assessment.summary}.`);
    for (const note of assessment.notes) ui.log(note);
    const previous = await this.readInstall();
    let install: TabbyInstall;
    if (previous && await this.installed(previous)) {
      install = previous;
      ui.log(`Using the installed Optimized NVIDIA runtime (TabbyAPI ${short(install.revision)}).`);
    } else {
      // A server from an older install holds its files open; stop it before replacing them.
      await this.stop(signal);
      install = await this.install(ui, signal, previous, assessment.gpu.index);
    }
    if (await during(ui, 'Checking for a running Optimized NVIDIA server...', () => this.awaitRunning(signal))) {
      await this.folders(install, signal);
      ui.log('Using the running Optimized NVIDIA server.');
      return;
    }
    await this.configure(install);
    await during(ui, 'Starting the Optimized NVIDIA server...', () => this.startServer(install, signal));
  }

  private async fetchRepository(install: TabbyInstall, repository: PinnedRepository, ui: SetupUI, signal: AbortSignal): Promise<void> {
    // An unrecorded folder is an interrupted or different download; the server refuses to overwrite it.
    await rm(join(this.paths.models, repository.folder), { recursive: true, force: true });
    const folder = join(this.paths.models, repository.folder);
    let last = -1;
    const timer = setInterval(() => void folderBytes(folder).then(bytes => {
      const percent = Math.min(99, Math.floor(bytes / repository.bytes * 100));
      if (percent !== last) { last = percent; ui.log(`Downloading ${repository.folder}: ${percent}%`); }
    }), 2000);
    try {
      const response = await this.request('/v1/download', { signal, key: install.keys.admin, timeoutMs: 6 * 60 * 60 * 1000, body: { repo_id: repository.repository, revision: repository.revision, folder_name: repository.folder } });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { detail?: unknown };
        throw new RuntimeError('download', `Downloading ${repository.repository} failed. Check disk space and the network, then rerun setup to retry.`, typeof body.detail === 'string' ? body.detail : `HTTP ${response.status}`);
      }
      await response.body?.cancel();
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError('download', `Downloading ${repository.repository} was interrupted. Rerun setup to retry.`, String(error));
    } finally { clearInterval(timer); }
    install.downloads[repository.folder] = repository.revision;
    await this.saveInstall(install);
  }

  private async load(install: TabbyInstall, ui: SetupUI, signal: AbortSignal): Promise<void> {
    const preset = this.io.preset;
    const current = await this.currentModel(install, signal);
    if (current?.id === preset.model.folder && current.parameters?.max_seq_len === preset.context && Boolean(current.parameters.use_vision) === Boolean(preset.vision) && await this.loadedDrafter(install, signal) === this.drafterId) {
      ui.log('The model is already loaded.');
      return;
    }
    const failed = (detail: string) => new RuntimeError('load', `The Optimized NVIDIA server could not load ${preset.model.repository}. Close other programs using the GPU, then rerun setup.`, detail);
    let response: Response;
    try {
      response = await this.request('/v1/model/load', { signal, key: install.keys.admin, timeoutMs: 30 * 60 * 1000, body: {
        model_name: preset.model.folder, max_seq_len: preset.context, cache_size: preset.context, cache_mode: preset.load.cache_mode,
        ...preset.vision ? { vision: true } : {},
        ...preset.drafter ? { draft_model: { draft_model_name: preset.drafter.folder } } : {},
      } });
    } catch (error) { signal.throwIfAborted(); throw failed(String(error)); }
    if (!response.ok || !response.body) throw failed(`HTTP ${response.status}: ${(await response.text().catch(() => '')).slice(0, 300)}`);
    let finished = false, pending = '';
    for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
      pending += chunk;
      const lines = pending.split('\n'); pending = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const event = JSON.parse(line.slice(5)) as { error?: { message?: string }; model_type?: string; module?: number; modules?: number; status?: string };
        if (event.error) throw failed(event.error.message ?? 'unknown error');
        if (event.modules) ui.log(`Loading ${event.model_type === 'draft' ? 'drafter' : event.model_type ?? 'model'}: ${Math.floor((event.module ?? 0) / event.modules * 100)}%`);
        if (event.model_type === 'model' && event.status === 'finished') finished = true;
      }
    }
    if (!finished) throw failed('the load stream ended before the model finished loading');
  }

  /** Download (or reuse) the preset's model and drafter, then load them, all before any request. */
  async provision({ ui, signal }: RuntimeContext): Promise<ProvisionedModel[]> {
    const preset = this.io.preset;
    const install = await this.readInstall();
    if (!install) throw new RuntimeError('runtime', 'The Optimized NVIDIA runtime is not installed. Rerun setup.');
    const listed = await this.folders(install, signal);
    const repositories = [preset.model, ...preset.drafter ? [preset.drafter] : []];
    const missing = repositories.filter(item => !(listed.includes(item.folder) && install.downloads[item.folder] === item.revision));
    if (missing.length) {
      const bytes = missing.reduce((total, item) => total + item.bytes, 0);
      checkDisk(await this.io.freeBytes(this.paths.models), bytes * 1.1);
      if (!await ui.confirm(`Download ${missing.map(item => item === preset.drafter ? `the drafter ${item.folder}` : `the model ${item.folder}`).join(' and ')} (about ${gb(bytes)})?`)) {
        throw new RuntimeError('declined', 'Download declined; existing configuration is unchanged.');
      }
      for (const item of missing) await during(ui, `Downloading ${item.folder}...`, () => this.fetchRepository(install, item, ui, signal));
    } else ui.log(`Using the downloaded model${preset.drafter ? ' and drafter' : ''}.`);
    await during(ui, 'Loading the model onto the GPU...', () => this.load(install, ui, signal));
    // The served model must be visible through the OpenAI-compatible API it will be used through.
    const served = await this.request('/v1/models', { signal, key: install.keys.api }).then(response => response.json() as Promise<{ data?: Array<{ id?: string }> }>).catch(() => ({ data: [] }));
    if (!served.data?.some(item => item.id === preset.model.folder)) throw new RuntimeError('api', 'The model loaded, but the server does not list it through its OpenAI-compatible API.');
    install.preset = preset.id;
    await this.saveInstall(install);
    await this.configure(install);
    ui.log('The Optimized NVIDIA server keeps running in the background and holds the GPU. Stop it with teapilot runtime stop; after a restart, start it with teapilot runtime start.');
    return [{
      roles: [preset.role], source: preset.label.replace(/^Capable - /, ''), apiKeyEnv: 'TABBY_API_KEY', apiKey: install.keys.api,
      model: {
        id: preset.model.folder, provider: 'tabbyapi', baseUrl: this.baseUrl, contextTokens: preset.context,
        maxOutputTokens: Math.min(16384, Math.floor(preset.context / 2)), toolCalling: true, vision: Boolean(preset.vision),
        supportsDeveloperRole: false, supportsUsage: true, ...preset.sampling ? { sampling: preset.sampling } : { temperature: 0.2 },
        // Qwen3.8's chat template decides thinking: it is switched off in the template, and its effort levels are template values.
        reasoning: { type: 'chat_template_kwargs', values: { off: { enable_thinking: false }, ...Object.fromEntries((['low', 'medium', 'xhigh'] as const).map(level => [level, { enable_thinking: true, reasoning_effort: level }])) } },
      },
    }];
  }

  /** Start an existing install and wait until its model is loaded, as after a reboot. */
  async start({ ui, signal }: RuntimeContext): Promise<void> {
    const install = await this.readInstall();
    if (!install || !await this.installed(install)) throw new RuntimeError('runtime', 'The Optimized NVIDIA runtime is not installed. Run teapilot setup and choose Optimized NVIDIA.');
    if (await during(ui, 'Checking for a running Optimized NVIDIA server...', () => this.awaitRunning(signal))) await this.folders(install, signal);
    else {
      await this.configure(install);
      await during(ui, 'Starting the Optimized NVIDIA server...', () => this.startServer(install, signal));
    }
    await during(ui, 'Loading the model onto the GPU...', () => this.load(install, ui, signal));
    ui.log(`Optimized NVIDIA is running at ${this.baseUrl}.`);
  }

  async stop(signal: AbortSignal): Promise<void> {
    const install = await this.readInstall();
    const recorded = Number(await readFile(this.paths.pid, 'utf8').catch(() => '')) || undefined;
    // Only a server that accepts this install's admin key is stopped, and it is found by the port it
    // holds: the recorded process ID can belong to a later launch that failed. A second server started
    // while the first was busy moves to the fallback port and holds its own copy of the model.
    if (install) for (const port of [this.io.port, this.io.fallbackPort]) {
      if (!await this.healthy(signal, port)) continue;
      if (port === this.io.port) await this.folders(install, signal);
      else if (!await this.owns(install, port, signal)) continue;
      const pid = await this.listener(port, signal) ?? (port === this.io.port ? recorded : undefined);
      if (pid) await this.kill(pid, signal);
    }
    await rm(this.paths.pid, { force: true });
  }

  async inspect(signal: AbortSignal): Promise<RuntimeInspection> {
    const install = await this.readInstall();
    if (!install) return { ownership: 'managed', ready: false, baseUrl: this.baseUrl, detail: 'not installed' };
    const detection = await this.io.detect(signal);
    const gpu = detection.kind === 'found' ? detection.gpus.find(item => item.index === install.gpu) : undefined;
    const hardware = gpu ? describeGpu(gpu) : 'GPU unavailable';
    const healthy = await this.healthy(signal);
    const current = healthy ? await this.currentModel(install, signal) : undefined;
    const drafter = current?.id ? await this.loadedDrafter(install, signal) : undefined;
    const warnings: string[] = [];
    if (current?.id && this.drafterId && drafter !== this.drafterId) {
      warnings.push('The drafter is not loaded, so generation is slower. Load it with teapilot runtime start.');
    }
    if (await this.healthy(signal, this.io.fallbackPort) && await this.owns(install, this.io.fallbackPort, signal)) {
      warnings.push(`A second Optimized NVIDIA server is running on port ${this.io.fallbackPort} and competing for GPU memory, which makes generation very slow. Stop both with teapilot runtime stop, then run teapilot runtime start.`);
    }
    if ((await this.logTail()).includes('--- Logging error')) {
      warnings.push(`The server log (${this.paths.log}) is filling with logging errors, which slows the server. Restart it with teapilot runtime stop, then teapilot runtime start.`);
    }
    return {
      ownership: 'managed', ready: Boolean(current?.id), version: `TabbyAPI ${short(install.revision)}`, baseUrl: this.baseUrl,
      detail: `${healthy ? current?.id ? `model ${current.id} loaded${drafter ? drafter === current.id ? ' with MTP drafting' : ` with drafter ${drafter}` : ''}` : 'no model loaded' : 'stopped'}; ${hardware}`,
      ...warnings.length ? { warnings } : {},
    };
  }

  async hint(model: ModelConfig, signal: AbortSignal): Promise<string | undefined> {
    if (model.baseUrl.replace(/\/$/, '') !== this.baseUrl) return undefined;
    const install = await this.readInstall();
    if (!install) return 'The Optimized NVIDIA runtime is not installed. Rerun teapilot setup.';
    if (!await this.healthy(signal)) return 'The Optimized NVIDIA server is not running. Start it with teapilot runtime start.';
    if ((await this.currentModel(install, signal))?.id !== model.id) return 'The Optimized NVIDIA server is running without its model. Load it with teapilot runtime start.';
    return undefined;
  }
}

export function tabbyDriver(overrides: Partial<TabbyBoundaries> = {}): TabbyDriver {
  const port = overrides.port ?? 5310;
  return new TabbyDriver({
    root: join(homedir(), '.teapilot', 'runtimes', 'tabbyapi'), port, fallbackPort: port + 1, platform: process.platform, preset: tabbyPresets[0]!,
    run: runProcess, listening, launch: launchDetached, detect: signal => detectNvidia(signal), fetch: loopbackFetch, freeBytes,
    readyTimeoutMs: 10 * 60 * 1000,
    ...overrides,
  });
}
