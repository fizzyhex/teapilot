import { afterEach, expect, it, vi } from 'vitest';
import { configureSearch } from '../src/setup/search.js';
import { followManagedSearch, ManagedSearch, searchIdentity } from '../src/setup/searxng.js';
import type { SetupUI } from '../src/setup/terminal.js';
import { fixture, mockServer } from './helpers.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); for (const fn of cleanup.splice(0).reverse()) await fn(); });
const signal = () => new AbortController().signal;
function ui(inputs: string[] = [], choice = 1): SetupUI {
  return { input: vi.fn(async () => inputs.shift() ?? ''), choose: vi.fn(async () => choice), confirm: vi.fn(async () => true), log: vi.fn() };
}
it('invalid and blank search URLs recover without touching existing settings or sending queries', async () => {
  const f = await fixture(); cleanup.push(f.cleanup);
  f.config.searchUrl = 'https://previous.example';
  const env = { SEARCH_BASE_URL: f.config.searchUrl };
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const terminal = ui(['not-a-url', 'http://user:password@example.com', '']);
  await configureSearch(f.config, env, f.cwd, terminal, signal());
  expect(f.config.searchUrl).toBe('https://previous.example');
  expect(env.SEARCH_BASE_URL).toBe(f.config.searchUrl);
  expect(fetch).not.toHaveBeenCalled();
  expect(terminal.input).toHaveBeenCalledTimes(3);
});
it('only activates search after consent and a successful JSON check', async () => {
  const f = await fixture(); cleanup.push(f.cleanup);
  const server = await mockServer((_body, _req, res) => { res.end(JSON.stringify({ results: [] })); }); cleanup.push(server.close);
  const env: Record<string, string> = {};
  const terminal = ui([server.url]);
  terminal.confirm = async () => false;
  await configureSearch(f.config, env, f.cwd, terminal, signal());
  expect(env.SEARCH_BASE_URL).toBeUndefined();
  await configureSearch(f.config, env, f.cwd, ui([server.url]), signal());
  expect(env.SEARCH_BASE_URL).toBe(server.url);
  expect(f.config.policy.permissions).toContain('web.search');
});
it('failed search leaves a working prior configuration untouched', async () => {
  const f = await fixture(); cleanup.push(f.cleanup);
  f.config.searchUrl = 'https://previous.example';
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
  const terminal = ui(['http://localhost:8888']);
  terminal.confirm = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
  await configureSearch(f.config, {}, f.cwd, terminal, signal());
  expect(f.config.searchUrl).toBe('https://previous.example');
});
it('refuses to manage an unrelated container with a colliding name', async () => {
  const run = vi.fn(async (_exe: string, args: string[]) => {
    if (args[0] === 'context') return 'unix:///var/run/docker.sock';
    if (args[0] === 'info') return 'linux';
    if (args[0] === 'ps') return 'container-id';
    if (args[0] === 'inspect') return JSON.stringify([{ Config: { Labels: {} } }]);
    throw new Error('Unexpected mutation');
  });
  vi.stubEnv('DOCKER_HOST', '');
  await expect(new ManagedSearch('.', signal(), run).manage('remove', ui())).rejects.toThrow('not owned');
  expect(run.mock.calls.some(([, args]) => args[0] === 'rm')).toBe(false);
});
it('does not mistake Docker daemon failures for missing containers', async () => {
  const run = vi.fn(async () => { throw new Error('daemon unavailable'); });
  await expect(new ManagedSearch('.', signal(), run).inspect()).rejects.toThrow('daemon unavailable');
  expect(run).toHaveBeenCalledTimes(1);
});
it('rejects remotely hosted Docker and publicly published search ports', async () => {
  vi.stubEnv('DOCKER_HOST', 'ssh://remote');
  const service = new ManagedSearch('.', signal(), async () => 'unix:///var/run/docker.sock');
  await expect(service.available()).rejects.toThrow('local Docker');
  expect(() => service.url({ Id: 'id', Config: {}, State: { Running: true }, NetworkSettings: { Ports: { '8080/tcp': [{ HostIp: '0.0.0.0', HostPort: '8888' }] } } })).toThrow('127.0.0.1');
  expect(searchIdentity('.').name).not.toBe(searchIdentity('../different-profile').name);
});

it('creates localhost-only search with JSON enabled and reuses the owned container', async () => {
  const f = await fixture(); cleanup.push(f.cleanup);
  vi.stubEnv('DOCKER_HOST', '');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('ok')));
  const identity = searchIdentity(f.cwd);
  let created = false;
  const run = vi.fn(async (_exe: string, args: string[]) => {
    if (args[0] === 'context') return 'unix:///var/run/docker.sock';
    if (args[0] === 'info') return 'linux';
    if (args[0] === 'ps') return created ? 'id' : '';
    if (args[0] === 'run') { created = true; return 'id'; }
    if (args[0] === 'inspect') return JSON.stringify([{ Id: 'id', Config: { Labels: { 'org.teapilot.search-profile': identity.owner } }, State: { Running: true }, NetworkSettings: { Ports: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '49152' }] } } }]);
    return '';
  });
  const service = new ManagedSearch(f.cwd, signal(), run);
  expect(await service.start(() => {})).toBe('http://127.0.0.1:49152');
  const settings = await readFile(join(identity.directory, 'settings.yml'), 'utf8');
  expect(settings).toContain('- json');
  expect(settings).toMatch(/secret_key: "[a-f0-9]{64}"/);
  const creation = run.mock.calls.find(([, args]) => args[0] === 'run')![1];
  expect(creation).toContain('127.0.0.1::8080');
  await service.start(() => {});
  expect(run.mock.calls.filter(([, args]) => args[0] === 'run')).toHaveLength(1);
  expect(await readFile(join(identity.directory, 'settings.yml'), 'utf8')).toBe(settings);
  const terminal = ui(); terminal.confirm = async () => false;
  expect(await service.manage('remove', terminal)).toBe(false);
  expect(run.mock.calls.some(([, args]) => args[0] === 'rm')).toBe(false);
  await service.manage('stop', ui());
  expect(run.mock.calls.some(([, args]) => args[0] === 'stop' && args[1] === 'id')).toBe(true);
});

it('follows a managed container to its new port after a restart, and leaves other search alone', async () => {
  const f = await fixture(); cleanup.push(f.cleanup);
  const server = await mockServer((_body, _req, res) => { res.end('{"results":[]}'); }); cleanup.push(server.close);
  f.config.source = { directory: f.cwd, reason: 'test', overrides: [] };
  f.config.policy.permissions.push('web.search');
  const identity = searchIdentity(f.cwd);
  const port = new URL(server.url).port;
  const run = vi.fn(async (_exe: string, args: string[]) => {
    if (args[0] === 'ps') return 'id';
    if (args[0] === 'inspect') return JSON.stringify([{ Id: 'id', Config: { Labels: { 'org.teapilot.search-profile': identity.owner } }, State: { Running: true }, NetworkSettings: { Ports: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: port }] } } }]);
    return '';
  });
  f.config.searchUrl = 'http://127.0.0.1:1';
  expect(await followManagedSearch(f.config, signal(), run)).toBe(true);
  expect(f.config.searchUrl).toBe(`http://127.0.0.1:${port}`);
  // Already there: nothing to follow.
  expect(await followManagedSearch(f.config, signal(), run)).toBe(false);
  run.mockClear();
  f.config.searchUrl = 'https://search.example';
  expect(await followManagedSearch(f.config, signal(), run)).toBe(false);
  expect(f.config.searchUrl).toBe('https://search.example');
  expect(run).not.toHaveBeenCalled();
});
