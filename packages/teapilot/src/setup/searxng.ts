import { during } from '../activity.js';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Config } from '../config.js';
import { command } from '../runtime/process.js';
import { searchQuery } from '../search.js';
import type { SetupUI } from './terminal.js';

const ownerLabel = 'org.teapilot.search-profile';
export function searchIdentity(directory: string) {
  const path = resolve(directory);
  const owner = createHash('sha256').update(process.platform === 'win32' ? path.toLowerCase() : path).digest('hex');
  return { owner, name: `teapilot-search-${owner.slice(0, 12)}`, directory: join(path, 'searxng') };
}
export type DockerCommand = typeof command;
/**
 * Moves a profile's local search URL to where its managed container answers now, after a restart gave it a new port.
 * Returns whether the URL changed. Search elsewhere, or not managed by this profile, is left alone.
 */
export async function followManagedSearch(config: Config, signal?: AbortSignal, run: DockerCommand = command): Promise<boolean> {
  if (!config.source || !config.searchUrl || new URL(config.searchUrl).hostname !== '127.0.0.1') return false;
  try {
    const url = await new ManagedSearch(config.source.directory, signal ?? new AbortController().signal, run).running();
    if (!url || url === config.searchUrl) return false;
    await searchQuery(url, 'teapilot connectivity check', signal);
    config.searchUrl = url;
    return true;
  } catch { signal?.throwIfAborted(); return false; }
}
interface Container { Id: string; Config: { Labels?: Record<string, string> }; State: { Running: boolean }; NetworkSettings: { Ports: Record<string, Array<{ HostIp: string; HostPort: string }> | null> } }

export class ManagedSearch {
  readonly identity;
  constructor(directory: string, private readonly signal: AbortSignal, private readonly run: DockerCommand = command) { this.identity = searchIdentity(directory); }
  private docker(args: string[], timeout = 30000) { return this.run('docker', args, AbortSignal.any([this.signal, AbortSignal.timeout(timeout)])); }
  async available() {
    const context = await this.docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
    const host = process.env.DOCKER_CONTEXT ? context : process.env.DOCKER_HOST || context;
    if (!/^(unix:\/\/|npipe:\/\/)/.test(host)) throw new Error('Managed search requires a local Docker context. Connect a remote SearXNG URL instead.');
    const os = await this.docker(['info', '--format', '{{.OSType}}']);
    if (os !== 'linux') throw new Error('Switch Docker to Linux containers before setting up search.');
  }
  async inspect(): Promise<Container | undefined> {
    // List first: a daemon failure must never be mistaken for a missing container.
    const id = await this.docker(['ps', '-aq', '--filter', `name=^/${this.identity.name}$`]);
    if (!id) return undefined;
    const [container] = JSON.parse(await this.docker(['inspect', id])) as Container[];
    if (container?.Config.Labels?.[ownerLabel] !== this.identity.owner) throw new Error('A container with this name is not owned by this TeaPilot profile.');
    return container;
  }
  url(container: Container): string {
    const ports = container.NetworkSettings.Ports['8080/tcp'];
    if (ports?.length !== 1 || ports[0]?.HostIp !== '127.0.0.1' || !/^\d+$/.test(ports[0].HostPort)) throw new Error('Managed search must publish only on 127.0.0.1.');
    return `http://127.0.0.1:${ports[0].HostPort}`;
  }
  /** Where this profile's search answers now, if it is running. Its host port changes every time the container starts. */
  async running(): Promise<string | undefined> {
    const container = await this.inspect();
    return container?.State.Running ? this.url(container) : undefined;
  }
  async start(log: (message: string) => void): Promise<string> {
    await this.available();
    let container = await this.inspect();
    if (!container) {
      await mkdir(this.identity.directory, { recursive: true });
      const settings = join(this.identity.directory, 'settings.yml');
      await writeFile(settings, `use_default_settings: true\nserver:\n  secret_key: "${randomBytes(32).toString('hex')}"\n  limiter: false\n  image_proxy: false\nsearch:\n  formats:\n    - html\n    - json\n`, { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      log('Downloading SearXNG and starting local search...');
      await this.docker(['run', '-d', '--name', this.identity.name, '--label', `${ownerLabel}=${this.identity.owner}`, '--restart', 'unless-stopped', '-p', '127.0.0.1::8080', '--mount', `type=bind,source=${this.identity.directory},target=/etc/searxng`, 'docker.io/searxng/searxng:latest'], 10 * 60 * 1000);
    } else if (!container.State.Running) {
      await this.docker(['start', container.Id]);
    }
    container = await this.inspect();
    if (!container) throw new Error('Search container was not created.');
    const url = this.url(container);
    log('Waiting for local search to become ready...');
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const response = await fetch(`${url}/healthz`, { signal: AbortSignal.any([this.signal, AbortSignal.timeout(2000)]), redirect: 'error' });
        await response.body?.cancel();
        if (response.ok) return url;
      } catch { this.signal.throwIfAborted(); }
      await delay(1000, undefined, { signal: this.signal });
    }
    throw new Error('Search did not become ready. Check Docker logs, then retry setup.');
  }
  async manage(action: string, ui: SetupUI): Promise<boolean> {
    if (!['status', 'start', 'stop', 'remove'].includes(action)) throw new Error('Use teapilot search status|start|stop|remove.');
    await during(ui, 'Checking Docker...', () => this.available());
    if (action === 'start') {
      if (!await ui.confirm('Start local search (downloads SearXNG if needed) and send a connectivity query to external search engines?')) return false;
      const url = await during(ui, 'Starting local search...', () => this.start(ui.log));
      await during(ui, 'Checking search connectivity...', () => searchQuery(url, 'teapilot connectivity check', this.signal));
      ui.log(`Search: PASS at ${url}. Rerun setup to connect this service to the profile.`);
      return true;
    }
    const container = await during(ui, 'Checking local search...', () => this.inspect());
    if (!container) { ui.log('Local search is not installed for this profile.'); return action !== 'status'; }
    if (action === 'status') {
      ui.log(`Local search: ${container.State.Running ? 'running' : 'stopped'}${container.State.Running ? ` at ${this.url(container)}` : ''}.`);
      return container.State.Running;
    }
    if (action === 'remove' && !await ui.confirm('Remove this profile’s search container? Local settings and the downloaded image will be retained.')) return false;
    await during(ui, action === 'stop' ? 'Stopping local search...' : 'Removing local search...', () => this.docker(action === 'stop' ? ['stop', container.Id] : ['rm', '-f', container.Id]));
    ui.log(`Local search ${action === 'stop' ? 'stopped' : 'removed'}. Ordinary ask/code remain available. Rerun setup to change search settings.`);
    return true;
  }
}
