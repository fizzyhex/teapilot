import { link, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { play } from '../src/agents/play.js';
import { assetLimits, collectAssets, sandboxIdentity } from '../src/discord/play/assets.js';
import { PlayRuntime, type PlaySurface } from '../src/discord/play/runtime.js';
import { sandbox } from '../src/discord/play/sandbox.js';
import { PlayStore } from '../src/discord/play/store.js';
import { ExecutionPolicy } from '../src/execution/policy.js';
import { WorkspaceStore } from '../src/workspace/store.js';
import { fixture } from './helpers.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const owner = { id: '111111111111111111' };
const code = `import { app, button, row } from '@teapilot/discord-play';
export default app({
  init: ctx => ({ copied: JSON.parse(ctx.readText('level.json')).name, moves: 0 }),
  update: s => ({ ...s, moves: s.moves + 1 }),
  view: (s, ctx) => ({ content: s.copied + '/' + JSON.parse(ctx.readText('level.json')).name + '/' + s.moves, rows: [row(button('go', 'go'))] })
});`;

async function setup(repository = false) {
  const f = await fixture(); cleanups.push(f.cleanup);
  f.config.policy.permissions = repository ? ['discord.play', 'repository.read', 'repository.write', 'repository.shell'] : ['discord.play'];
  const workspace = WorkspaceStore.at(f.config.stateDir);
  const store = new PlayStore(join(f.config.stateDir, 'apps'));
  const surface: PlaySurface = { post: vi.fn(async () => 'm1'), edit: vi.fn(async () => undefined), request: vi.fn() };
  const runtime = new PlayRuntime({ store, surface, log: vi.fn(), probe: false });
  cleanups.push(() => runtime.close());
  const policy = new ExecutionPolicy(f.cwd, f.config, async () => false);
  const context = { runtime, channelId: 'c1', conversation: 'dm:1', owner, ...(!repository ? { files: { store: workspace, conversation: 'dm:1' } } : {}) };
  const api = () => play(context, f.config, policy, async () => false);
  const call = async (name: string, args: Record<string, unknown>, instance = api()) => {
    const result = await instance.tools.find(tool => tool.name === name)!.execute('asset-test', args);
    return result.content.map(part => part.type === 'text' ? part.text : '').join('\n');
  };
  const put = async (name: string, data: string | Buffer, conversation = 'dm:1') => {
    if (!repository) await workspace.saveAt(conversation, name, Buffer.from(data), 'teapilot');
    else { const path = join(f.cwd, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, data); }
  };
  await put('apps/game.js', code);
  await put('data/first.json', '{"name":"first"}');
  return { ...f, runtime, store, workspace, surface, api, call, put, entry: repository ? { path: 'apps/game.js' } : { file: 'apps/game.js' } };
}

it.each([false, true])('snapshots assets and refreshes asset-only edits without replacing saved state (repository=%s)', async repository => {
  const f = await setup(repository);
  const selected = { 'level.json': 'data/first.json' };
  expect(await f.call('play_start', { ...f.entry, title: 'maze', assets: selected })).toContain('first/first/0');
  const id = f.runtime.list('dm:1')[0]!.id;
  await f.put('data/first.json', '{"name":"second"}');
  expect(f.runtime.source(id, 'dm:1')).toMatchObject({ assets: { 'level.json': '{"name":"first"}' } });
  expect(await f.call('play_test', { ...(repository ? { path: './apps/game.js' } : { file: './apps/game.js' }), actions: [] })).toContain('first/second/0');
  expect(f.runtime.source(id, 'dm:1')).toMatchObject({ assets: { 'level.json': '{"name":"first"}' } });
  expect(await f.call('play_update', { ...(repository ? { path: './apps/game.js' } : { file: './apps/game.js' }) })).toContain('first/second/0');
  expect(f.runtime.assetFiles(id, 'dm:1')).toEqual(selected);
  expect(await f.call('play_update', { reset: true })).toContain('second/second/0');
  const inspected = await f.call('play_inspect', {});
  expect(inspected).toContain('data/first.json');
  expect(inspected).toContain('"bytes":17');
  expect(inspected).not.toContain('{\\"name\\":\\"second\\"}');
  expect(await f.call('play_update', {})).toContain('Nothing to change');
});

it('replaces selections, persists mapping-only changes, clears them, and does not inherit on a different entry file', async () => {
  const f = await setup();
  await f.call('play_start', { ...f.entry, title: 'maze', assets: { 'level.json': 'data/first.json', spare: 'data/first.json' } });
  const id = f.runtime.list('dm:1')[0]!.id;
  await f.put('data/copy.json', '{"name":"first"}');
  expect(await f.call('play_update', { assets: { 'level.json': 'data/copy.json' } })).toContain('Updated app');
  expect(f.store.all()[0]!.assetFiles).toEqual({ 'level.json': 'data/copy.json' });
  expect(f.runtime.source(id, 'dm:1')).toMatchObject({ assets: { 'level.json': '{"name":"first"}' } });
  expect(Object.keys((f.runtime.source(id, 'dm:1') as { assets: Record<string, string> }).assets)).toEqual(['level.json']);
  await f.put('apps/other.js', code);
  expect(await f.call('play_test', { file: 'apps/other.js', actions: [] })).toContain('is not declared');
  expect(await f.call('play_update', { file: 'apps/other.js' })).toContain('is not declared');
  expect(f.runtime.file(id, 'dm:1')).toBe('apps/game.js');
  expect(await f.call('play_update', { assets: {} })).toContain('is not declared');
  expect(f.runtime.assetFiles(id, 'dm:1')).toEqual({ 'level.json': 'data/copy.json' });
  await f.put('apps/game.js', `export default app({ init: () => ({}), update: s => s, view: () => ({ content: 'no assets' }) });`);
  expect(await f.call('play_update', { assets: {} })).toContain('Updated app');
  expect(f.runtime.assetFiles(id, 'dm:1')).toEqual({});
  expect(f.runtime.source(id, 'dm:1')).toMatchObject({ assets: {} });
  await f.put('apps/empty.js', `export default app({ init: () => ({}), update: s => s, view: () => ({ content: 'no assets' }) });`);
  expect(await f.call('play_update', { file: 'apps/empty.js' })).toContain('Updated app');
  expect(f.runtime.file(id, 'dm:1')).toBe('apps/empty.js');
});

it('allows retrying the same code after fixing a rejected data file and preserves a live snapshot on failure', async () => {
  const f = await setup();
  await f.put('data/first.json', 'not json');
  const api = f.api();
  const args = { ...f.entry, title: 'maze', assets: { 'level.json': 'data/first.json' } };
  expect(await f.call('play_start', args, api)).toContain('App problem');
  expect(await f.call('play_start', args, api)).toContain('unchanged since it was rejected');
  await f.put('data/first.json', '{"name":"fixed"}');
  expect(await f.call('play_start', args, api)).toContain('Started app');
  const before = f.store.all()[0]!;
  await f.put('data/first.json', 'broken again');
  expect(await f.call('play_update', {})).toContain('App problem');
  expect(f.store.all()[0]).toEqual(before);
  await f.put('data/first.json', Buffer.from([0xff]));
  expect(await f.call('play_update', {})).toContain('valid UTF-8');
  expect(f.store.all()[0]).toEqual(before);
});

it('recovers persisted snapshots after the original files are deleted, and reports names without exposing asset text', async () => {
  const f = await setup();
  await f.call('play_start', { ...f.entry, title: 'maze', assets: { 'level.json': 'data/first.json' } });
  const id = f.runtime.list('dm:1')[0]!.id;
  f.runtime.close();
  await rm(f.workspace.folder('dm:1'), { recursive: true });
  const runtime = new PlayRuntime({ store: f.store, surface: f.surface, log: vi.fn(), probe: false });
  cleanups.push(() => runtime.close());
  expect(await runtime.recover()).toBe(1);
  const updates: string[] = [];
  await runtime.interact({ playId: id, controlId: 'go', kind: 'button', user: owner,
    openModal: async () => undefined, reply: async () => undefined, defer: async () => undefined,
    update: async payload => { updates.push(payload.content); }, followUp: async () => undefined,
  });
  expect(updates).toEqual(['first/first/1']);
  expect(runtime.assetFiles(id, 'dm:1')).toEqual({ 'level.json': 'data/first.json' });
});

it('keeps workspace assets conversation-scoped and rejects invalid paths, links, binary data and missing files', async () => {
  const f = await setup();
  await f.put('private.json', '{"name":"private"}', 'dm:other');
  for (const name of ['private.json', '../data/first.json', '/data/first.json', 'missing.json']) {
    expect(await f.call('play_start', { ...f.entry, title: 'maze', assets: { 'level.json': name } })).toContain('App problem');
  }
  await f.put('binary.dat', Buffer.from([0, 1]));
  expect(await f.call('play_start', { ...f.entry, title: 'maze', assets: { 'level.json': 'binary.dat' } })).toContain('NUL');
  await f.put('big.txt', 'x'.repeat(assetLimits.fileBytes + 1));
  expect(await f.call('play_start', { ...f.entry, title: 'maze', assets: { 'level.json': 'big.txt' } })).toContain('exceeds');
  const path = join(f.workspace.folder('dm:1'), 'data', 'first.json');
  await link(path, join(f.workspace.folder('dm:1'), 'linked.json'));
  expect(await f.call('play_start', { ...f.entry, title: 'maze', assets: { 'level.json': 'data/first.json' } })).toContain('not a plain file');
});

it('enforces repository policy for assets and refuses linked directories', async () => {
  const f = await setup(true);
  for (const path of ['../outside.json', '.env', '.state/private.json']) {
    await expect(f.call('play_start', { ...f.entry, title: 'maze', assets: { 'level.json': path } })).rejects.toThrow();
  }
  await symlink(join(f.cwd, 'data'), join(f.cwd, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(f.call('play_start', { ...f.entry, title: 'maze', assets: { 'level.json': 'linked/first.json' } })).rejects.toThrow('Linked paths');
});

it('collects arbitrary-extension UTF-8 and empty text, validates limits and logical names, and never evaluates asset text', async () => {
  const f = await setup(true);
  await f.put('empty.map', '');
  await f.put('world.map', '🧱 hello');
  const texts = await collectAssets({ empty: 'empty.map', world: 'world.map' }, async name => join(f.cwd, name));
  expect(texts).toEqual({ empty: '', world: '🧱 hello' });
  for (const name of ['', '/absolute', '../escape', 'a/../b', 'a\\b', 'a:b', 'a//b', 'a\0b']) {
    await expect(collectAssets({ [name]: 'empty.map' }, async name => join(f.cwd, name))).rejects.toThrow('invalid asset name');
  }
  await expect(collectAssets(Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`a${i}`, 'empty.map'])), async name => join(f.cwd, name))).rejects.toThrow('at most 32');
  await f.put('max.map', 'x'.repeat(assetLimits.fileBytes));
  await expect(collectAssets(Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`a${i}`, 'max.map'])), async name => join(f.cwd, name))).rejects.toThrow('combined');
  const engine = await sandbox(`export default app({ init: ctx => [ctx.readText('empty'), ctx.readText('__proto__'), ctx.readText('script')], update: s => s, view: () => ({ content: 'ok' }) });`, Object.fromEntries([['empty', ''], ['__proto__', 'safe'], ['script', 'globalThis.process = 1; throw new Error("boom")']]));
  try {
    const result = await engine.call('init', { ctx: { now: 1, invoker: owner, participants: 'everyone', emojis: {}, seed: 1 } });
    expect(result.value).toEqual(['', 'safe', 'globalThis.process = 1; throw new Error("boom")']);
  } finally { engine.dispose(); }
  expect(sandboxIdentity({ code: ' x ', assets: { b: '2', a: '1' } })).toBe(sandboxIdentity({ code: 'x', assets: { a: '1', b: '2' } }));
});

it('exposes the asset workflow in prompts/tool schemas without enabling async or other imports', async () => {
  const f = await setup();
  const api = f.api();
  expect(api.systemPrompt).not.toContain('ctx.readText');
  expect(api.systemPrompt).toContain('no async, filesystem, network or other imports');
  expect(api.tools.find(tool => tool.name === 'play_update')!.description).toContain('data already copied into state is not replaced');
  for (const name of ['play_start', 'play_test', 'play_update']) {
    expect(api.tools.find(tool => tool.name === name)!.parameters).toHaveProperty('properties.assets');
    expect(JSON.stringify(api.tools.find(tool => tool.name === name)!.parameters)).toContain('ctx.readText(name)');
  }
  await expect(sandbox(code, { bad: 'x'.repeat(assetLimits.fileBytes + 1) })).rejects.toThrow('exceeds');
});

it('fits the maximum snapshot in sandbox memory and retains assets when a failed call rebuilds the realm', async () => {
  // Control characters exercise the worst JSON-escaping expansion when embedding the snapshot.
  const assets = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`a${i}`, '\x01'.repeat(assetLimits.fileBytes)]));
  const engine = await sandbox(`export default app({
    init: ctx => [ctx.readText('a0').length, ctx.readText('a3').length],
    update: (s, a, ctx) => { if (a.id === 'boom') throw new Error('boom'); return ctx.readText('a1').length; },
    view: () => ({ content: 'ok' })
  });`, assets);
  const ctx = { now: 1, invoker: owner, participants: 'everyone' as const, emojis: {}, seed: 1 };
  try {
    expect((await engine.call('init', { ctx })).value).toEqual([assetLimits.fileBytes, assetLimits.fileBytes]);
    await expect(engine.call('update', { ctx, state: null, action: { kind: 'button', id: 'boom', user: owner } })).rejects.toThrow('boom');
    expect((await engine.call('update', { ctx, state: null, action: { kind: 'button', id: 'go', user: owner } })).value).toBe(assetLimits.fileBytes);
  } finally { engine.dispose(); }
});
