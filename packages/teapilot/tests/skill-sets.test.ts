import { afterEach, expect, it, vi } from 'vitest';
import { pack, type Header } from 'tar-stream';
import { gzipSync } from 'node:zlib';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SkillCache, extractSkills, githubTransport, skillCacheLimits, verifySkillText, type SkillTransport } from '../src/skills/cache.js';
import { SkillStore } from '../src/skills/store.js';
import { defaultSkillSets, normalizeSets, repositorySource, starterSets } from '../src/skills/settings.js';
import { skillTools } from '../src/agents/skills.js';
import { loadConfig } from '../src/config.js';
import { fixture } from './helpers.js';
import { commandDefinitions, commandText } from '../src/discord/commands.js';
import { runAttempt } from '../src/agents/run.js';
import { TaskStore } from '../src/workspace/task.js';
import { SpendGovernor } from '../src/inference/budget.js';
import { Telemetry } from '../src/telemetry/outcome.js';
import { completion, mockServer } from './helpers.js';
import { serveDiscord } from '../src/discord/index.js';
import { AccessStore } from '../src/discord/access-store.js';
import { channelId, people, World } from '../scripts/discord-sim/world.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const revision1 = '1'.repeat(40), revision2 = '2'.repeat(40);
const skill = (body = 'fixture instructions') => `---\nname: example\ndescription: Read fixture evidence carefully.\n---\n${body}\n`;
async function archive(entries: Array<{ name: string; body?: string | Buffer; type?: Header['type']; linkname?: string }>): Promise<Buffer> {
  const stream = pack(), chunks: Buffer[] = [];
  const done = (async () => { for await (const chunk of stream) { if (!Buffer.isBuffer(chunk)) throw new Error('invalid fixture'); chunks.push(chunk); } return gzipSync(Buffer.concat(chunks)); })();
  for (const entry of entries) stream.entry({ name: entry.name, ...(entry.type ? { type: entry.type } : {}), ...(entry.linkname ? { linkname: entry.linkname } : {}) }, entry.body ?? '');
  stream.finalize(); return done;
}
async function setup() {
  const f = await fixture(); cleanups.push(f.cleanup);
  let current = revision1, now = 0, failing = false;
  let tar = await archive([{ name: 'repository/skills/example/SKILL.md', body: skill() }, { name: 'repository/skills/example/scripts/helper.py', body: 'raise Exception("must not run")\n' }]);
  const transport: SkillTransport = { revision: vi.fn(async () => { if (failing) throw new Error('offline fixture'); return current; }), archive: vi.fn(async () => tar) };
  const cache = new SkillCache(f.config.stateDir, transport, () => now);
  return { ...f, transport, cache, settings: { enabled: true, refreshMs: 1000 },
    revision: (value: string) => { current = value; }, time: (value: number) => { now = value; }, fail: () => { failing = true; },
    archive: (value: Buffer) => { tar = value; } };
}

it('defaults to tea-skills, keeps Anthropic opt-in, and canonicalizes repository URLs and pins', async () => {
  expect(defaultSkillSets()).toEqual([{ source: 'gh:fizzyhex/tea-skills' }]);
  expect(starterSets).toEqual(['gh:fizzyhex/tea-skills', 'gh:anthropics/skills']);
  expect(repositorySource({ source: 'https://github.com/FizzyHex/tea-skills.git#feature/test' })).toMatchObject({ id: 'gh:fizzyhex/tea-skills#feature/test', path: 'skills' });
  expect(repositorySource({ source: 'gh:owner/repo', path: 'nested/skills' }).id).toBe('gh:owner/repo?path=nested/skills');
  const f = await setup();
  await writeFile(join(f.cwd, 'skills.json'), JSON.stringify({ sets: [{ source: 'gh:anthropics/skills', include: ['pdf'] }], offline: true }));
  expect((await loadConfig(f.cwd, {})).skills).toMatchObject({ enabled: true, offline: true, sets: [{ source: 'gh:anthropics/skills', include: ['pdf'] }] });
  expect((await loadConfig(f.cwd, { TEAPILOT_SKILLS_OFFLINE: 'off' })).skills?.offline).toBe(false);
});

it('loads a hosted catalog without Git, reads supporting files, and makes zero warm network calls', async () => {
  const f = await setup(), catalog = await f.cache.catalog(f.settings);
  expect(catalog.warnings).toEqual([]);
  expect(catalog.skills).toEqual([{ id: 'gh:fizzyhex/tea-skills::example', name: 'example', description: 'Read fixture evidence carefully.', set: starterSets[0], revision: revision1 }]);
  expect(await verifySkillText(catalog, catalog.skills[0]!.id, 'scripts/helper.py')).toContain('must not run');
  expect(skillTools(catalog).prompt).not.toContain('fixture instructions');
  await f.cache.catalog(f.settings); await f.cache.catalog(f.settings);
  expect(f.transport.revision).toHaveBeenCalledTimes(1); expect(f.transport.archive).toHaveBeenCalledTimes(1);
});

it('reuses validated snapshots after restart with all networking disabled', async () => {
  const f = await setup(); await f.cache.catalog(f.settings);
  const unavailable: SkillTransport = { revision: vi.fn(async () => { throw new Error('network must not run'); }), archive: vi.fn(async () => { throw new Error('network must not run'); }) };
  const restarted = new SkillCache(f.config.stateDir, unavailable, () => 10 ** 12);
  const catalog = await restarted.catalog({ enabled: true, offline: true }, { offline: false });
  expect(catalog.warnings).toEqual([]);
  expect(await verifySkillText(catalog, catalog.skills[0]!.id, 'SKILL.md')).toContain('fixture instructions');
  expect(unavailable.revision).not.toHaveBeenCalled(); expect(unavailable.archive).not.toHaveBeenCalled();
});

it('continues without skills on an offline first install and preserves local-directory provisioning', async () => {
  const f = await setup(), catalog = await f.cache.catalog({ enabled: true, offline: true });
  expect(catalog.skills).toEqual([]); expect(catalog.warnings.join(' ')).toContain('unavailable offline');
  expect(f.transport.revision).not.toHaveBeenCalled();
  const directory = join(f.cwd, 'local'); await mkdir(join(directory, 'example'), { recursive: true }); await writeFile(join(directory, 'example', 'SKILL.md'), skill());
  expect((await f.cache.catalog({ enabled: true, offline: true, directory })).skills[0]!.id).toBe('example');
});

it('serves the old immutable revision while a background update adopts the new revision between requests', async () => {
  const f = await setup(), original = await f.cache.catalog(f.settings);
  f.revision(revision2); f.time(2000);
  f.archive(await archive([{ name: 'repo/skills/example/SKILL.md', body: skill('new instructions') }]));
  const stale = await f.cache.catalog(f.settings);
  expect(stale.skills[0]!.revision).toBe(revision1);
  await f.cache.refresh(defaultSkillSets()[0]!, true);
  const updated = await f.cache.catalog(f.settings);
  expect(updated.skills[0]!.revision).toBe(revision2);
  expect(await verifySkillText(original, original.skills[0]!.id, 'SKILL.md')).toContain('fixture instructions');
  expect(await verifySkillText(updated, updated.skills[0]!.id, 'SKILL.md')).toContain('new instructions');
});

it('retains a good offline snapshot after network failure and backs off background retries', async () => {
  const f = await setup(); await f.cache.catalog(f.settings);
  f.fail(); f.time(2000); await f.cache.catalog(f.settings);
  await expect(f.cache.refresh(defaultSkillSets()[0]!, true)).rejects.toThrow('offline fixture');
  const stale = await f.cache.catalog(f.settings);
  expect(stale.skills[0]!.revision).toBe(revision1); expect(stale.warnings.join(' ')).toContain('using cached');
  expect(f.transport.revision).toHaveBeenCalledTimes(2);
  expect((await new SkillCache(f.config.stateDir, f.transport).catalog({ enabled: true, offline: true })).skills[0]!.revision).toBe(revision1);
});

it.each(['invalid metadata', 'truncated archive', 'linked entry'])('never publishes an update with %s', async failure => {
  const f = await setup(); await f.cache.catalog(f.settings); f.revision(revision2);
  f.archive(failure === 'invalid metadata' ? await archive([{ name: 'repo/skills/example/SKILL.md', body: 'not frontmatter' }]) : failure === 'truncated archive' ? Buffer.from('broken gzip') : await archive([{ name: 'repo/skills/example/link', type: 'symlink', linkname: '/secret' }]));
  await expect(f.cache.refresh(defaultSkillSets()[0]!, true)).rejects.toThrow();
  const catalog = await f.cache.catalog({ enabled: true, offline: true });
  expect(catalog.skills[0]!.revision).toBe(revision1);
  expect((await readdir(join(f.config.stateDir, 'skill-sets'))).some(name => name.startsWith('.download-') || name === '.update-lock')).toBe(false);
});

it('deduplicates concurrent fetches for the same set', async () => {
  const f = await setup(); await Promise.all(Array.from({ length: 8 }, () => f.cache.refresh(defaultSkillSets()[0]!, true)));
  expect(f.transport.revision).toHaveBeenCalledTimes(1); expect(f.transport.archive).toHaveBeenCalledTimes(1);
});

it('queues different sources without rejecting simultaneous refreshes', async () => {
  const f = await setup();
  await Promise.all(starterSets.map(source => f.cache.refresh({ source }, true)));
  expect(f.transport.archive).toHaveBeenCalledTimes(2);
  expect((await f.cache.catalog({ enabled: true, offline: true }, { sets: starterSets.map(source => ({ source })) })).skills).toHaveLength(2);
});

it('backs off an unavailable source even when it has never had a snapshot', async () => {
  const f = await setup(); f.fail();
  await f.cache.catalog(f.settings); await f.cache.catalog(f.settings);
  expect(f.transport.revision).toHaveBeenCalledTimes(1);
  expect((await f.cache.catalog({ enabled: true, offline: true })).warnings.join(' ')).toContain('offline fixture');
});

it('cancels refreshes on surface shutdown without replacing the good snapshot or leaving staging files', async () => {
  const f = await setup(); await f.cache.catalog(f.settings);
  f.revision(revision2);
  const started = new Promise<void>(resolve => {
    vi.mocked(f.transport.archive).mockImplementationOnce(async (_source, _revision, signal) => {
      resolve();
      return new Promise<Uint8Array>((_done, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
  });
  const job = f.cache.refresh(defaultSkillSets()[0]!, true);
  const rejected = expect(job).rejects.toMatchObject({ name: 'AbortError' });
  await started; await f.cache.close(); await rejected;
  const catalog = await f.cache.catalog({ enabled: true, offline: true });
  expect(catalog.warnings).toEqual([]); expect(catalog.skills[0]!.revision).toBe(revision1);
  expect((await readdir(join(f.config.stateDir, 'skill-sets'))).some(name => name.startsWith('.'))).toBe(false);
});

it('supports nested skill layouts and explicit repository-root directories', async () => {
  const f = await setup();
  f.archive(await archive([{ name: 'repo/examples/tools/example/SKILL.md', body: skill() }]));
  const catalog = await f.cache.catalog(f.settings, { sets: [{ source: 'gh:owner/custom', path: '.' }] });
  expect(catalog.skills[0]!.id).toBe('gh:owner/custom?path=.::examples/tools/example');
  expect(await verifySkillText(catalog, catalog.skills[0]!.id, 'SKILL.md')).toContain('fixture instructions');
});

it('pins a full commit without a revision lookup and never refreshes it in the background', async () => {
  const f = await setup(), sets = [{ source: `${starterSets[0]}#${revision1}` }];
  await f.cache.catalog(f.settings, { sets }); f.time(10 ** 12); await f.cache.catalog(f.settings, { sets });
  expect(f.transport.revision).not.toHaveBeenCalled(); expect(f.transport.archive).toHaveBeenCalledTimes(1);
});

it('makes no network calls for disabled sets or an empty skill selection', async () => {
  const f = await setup();
  expect((await f.cache.catalog({ enabled: false })).skills).toEqual([]);
  expect((await f.cache.catalog(f.settings, { sets: [] })).skills).toEqual([]);
  expect((await f.cache.catalog(f.settings, { sets: [{ source: starterSets[0], include: [] }] })).skills).toEqual([]);
  expect(f.transport.revision).not.toHaveBeenCalled();
});

it('gives juniors the same frozen catalog after upstream changes and persists source provenance', async () => {
  const f = await setup(), catalog = await f.cache.catalog(f.settings), id = catalog.skills[0]!.id;
  f.config.skills = { enabled: true, offline: true };
  let instructorTurns = 0, juniorTurns = 0;
  const bodies: any[] = [];
  const server = await mockServer(async (body, _request, response) => {
    bodies.push(body);
    const junior = body.tools.some((tool: any) => tool.function.name === 'report');
    if (junior) {
      completion(response, ++juniorTurns === 1 ? { tool: { name: 'skill', arguments: { id } } } : { tool: { name: 'report', arguments: { status: 'done', summary: 'Read the original fixture skill.' } } });
    } else if (++instructorTurns === 1) {
      f.revision(revision2); f.archive(await archive([{ name: 'repo/skills/example/SKILL.md', body: skill('updated upstream instructions') }]));
      await f.cache.refresh(defaultSkillSets()[0]!, true);
      completion(response, { tool: { name: 'delegate_task', arguments: { description: 'Inspect frozen skill', prompt: 'Read the example skill.', agent_type: 'research', artifacts: [] } } });
    } else completion(response, { text: 'done' });
  }); cleanups.push(server.close);
  Object.assign(f.config.models.capable, { provider: 'ollama', baseUrl: server.url });
  const scratch = join(f.cwd, '.scratch'), task = TaskStore.open(f.config.stateDir, 'frozen-catalog', 'inspect', scratch);
  task.startRequest('frozen', { calls: 50, modelCalls: 50, timeoutMs: 60000 });
  const result = await runAttempt({ config: f.config, skillCatalog: catalog, cwd: f.cwd, tier: 'normal', workload: 'coder', prompt: 'inspect', web: false, scratch, task,
    budget: new SpendGovernor(join(f.config.stateDir, 'spend.jsonl'), 'frozen', f.config.policy.budget), telemetry: new Telemetry(f.config.stateDir, 'frozen'), approve: async () => false });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(juniorTurns).toBe(2);
  expect(JSON.stringify(bodies)).toContain('fixture instructions');
  expect(JSON.stringify(bodies)).not.toContain('updated upstream instructions');
  expect(task.snapshot().artifacts.find(artifact => artifact.producerTool === 'skill')?.source?.skill).toEqual({ id, file: 'SKILL.md', set: starterSets[0], revision: revision1 });
});

it('keeps colliding names source-qualified and enforces per-skill selection at retrieval', async () => {
  const f = await setup();
  const catalog = await f.cache.catalog(f.settings, { sets: [...defaultSkillSets(), { source: starterSets[1] }] });
  expect(catalog.skills.map(metadata => metadata.id)).toEqual([`${starterSets[0]}::example`, `${starterSets[1]}::example`]);
  const filtered = await f.cache.catalog(f.settings, { sets: [{ source: starterSets[0], exclude: ['example'] }, { source: starterSets[1], include: ['example'] }] });
  const tool = skillTools(filtered).tools[0]!;
  await expect(tool.execute('call', { id: `${starterSets[0]}::example` })).rejects.toThrow('unknown skill ID');
  await expect(tool.execute('call', { id: `${starterSets[1]}::example` })).resolves.toMatchObject({ details: { skill: { set: starterSets[1], revision: revision1 } } });
});

it('detects tampered cached supporting files', async () => {
  const f = await setup(), catalog = await f.cache.catalog(f.settings), id = catalog.skills[0]!.id, location = catalog.locations![id]!;
  await writeFile(join(location.root, location.folder, 'scripts/helper.py'), 'tampered');
  await expect(verifySkillText(catalog, id, 'scripts/helper.py')).rejects.toThrow('integrity');
});

it('retains repository license notices alongside per-skill license files', async () => {
  const f = await setup();
  f.archive(await archive([
    { name: 'repo/LICENSE', body: 'repository license' },
    { name: 'repo/skills/example/SKILL.md', body: skill() },
    { name: 'repo/skills/example/LICENSE.txt', body: 'individual skill license' },
  ]));
  const catalog = await f.cache.catalog(f.settings), id = catalog.skills[0]!.id;
  expect(catalog.warnings).toEqual([]);
  expect(await readFile(join(catalog.locations![id]!.root, '.repository/LICENSE'), 'utf8')).toBe('repository license');
  expect(await verifySkillText(catalog, id, 'LICENSE.txt')).toBe('individual skill license');
});

it.each(['../escape', '/absolute', 'repo/skills/../escape', 'repo/skills/C:bad', 'repo/skills/example/CON', 'repo/skills/example/back\\slash', 'repo/skills/example/trailing.'])('refuses unsafe archive path %s', async name => {
  const f = await setup(), directory = join(f.cwd, 'extract'); await mkdir(directory);
  await expect(extractSkills(await archive([{ name, body: 'no' }]), directory, 'skills')).rejects.toThrow();
});

it('bounds downloads and rejects duplicate paths instead of overwriting them', async () => {
  const f = await setup(), directory = join(f.cwd, 'extract'); await mkdir(directory);
  await expect(extractSkills(new Uint8Array(skillCacheLimits.downloadBytes + 1), directory, 'skills')).rejects.toThrow('invalid');
  await expect(extractSkills(await archive([{ name: 'repo/skills/a/file', body: 'one' }, { name: 'repo/skills/a/FILE', body: 'two' }]), directory, 'skills')).rejects.toThrow('duplicate');
});

it.each(['http://github.com/a/b', 'https://127.0.0.1/a/b', 'https://user:secret@github.com/a/b', 'https://github.com:8443/a/b', 'https://github.com/a/b?url=secret', 'gh:owner/../secret', 'gh:owner/repo#../secret'])('rejects unsafe source %s before networking', source => {
  expect(() => repositorySource({ source })).toThrow();
});

it('never follows redirects from either fixed GitHub endpoint', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('redirect', { status: 302, headers: { Location: 'http://127.0.0.1/secret' } }));
  const source = repositorySource(defaultSkillSets()[0]!);
  await expect(githubTransport.revision(source, new AbortController().signal)).rejects.toThrow('302');
  await expect(githubTransport.archive(source, revision1, new AbortController().signal)).rejects.toThrow('302');
  expect(fetcher.mock.calls.every(([, options]) => options?.redirect === 'error')).toBe(true);
});

it('resolves only the tiny SHA response rather than downloading full commit patches', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(`${revision1}\n`));
  expect(await githubTransport.revision(repositorySource(defaultSkillSets()[0]!), new AbortController().signal)).toBe(revision1);
  expect(fetcher.mock.calls[0]![1]?.headers).toMatchObject({ Accept: 'application/vnd.github.sha' });
});

it('supports personal defaults, isolated conversations and one fixed choice for shared conversations', async () => {
  const f = await setup(), store = new SkillStore(f.config.stateDir, f.settings, f.cache);
  const alice = { userId: 'alice', operator: false }, bob = { userId: 'bob', operator: false };
  await store.command(`enable ${starterSets[1]} personal`, alice);
  expect(store.effective({ ...alice, conversation: 'shared' }).sets).toHaveLength(2);
  expect(store.effective({ ...bob, conversation: 'shared' }).sets).toHaveLength(2);
  expect(store.effective({ ...bob, conversation: 'bob-solo' }).sets).toEqual(defaultSkillSets());
  await store.command(`disable ${starterSets[0]} personal`, alice);
  expect(store.effective({ ...alice, conversation: 'shared' }).sets).toHaveLength(2);
  expect(store.effective({ ...alice, conversation: 'alice-new' }).sets).toEqual([{ source: starterSets[1] }]);
  const restart = new SkillStore(f.config.stateDir, f.settings, f.cache);
  expect(restart.effective({ ...bob, conversation: 'shared' }).sets).toHaveLength(2);
  restart.fork('shared', 'fork'); expect(restart.effective({ ...bob, conversation: 'fork' }).sets).toHaveLength(2);
});

it('allows users to add arbitrary public repositories only within their scope and reserves global choices for operators', async () => {
  const f = await setup(), store = new SkillStore(f.config.stateDir, f.settings, f.cache), user = { userId: 'user', operator: false };
  await store.command('add gh:someone/custom personal', user);
  expect(store.effective(user).sets).toContainEqual({ source: 'gh:someone/custom' });
  await expect(store.command('add gh:someone/custom global', user)).rejects.toThrow('only operators');
  expect(store.effective({ operator: true }).sets).toEqual(defaultSkillSets());
  await store.command(`enable ${starterSets[1]} global`, { operator: true });
  expect(store.effective({ userId: 'other', operator: false }).sets).toHaveLength(2);
});

it('selects individual skills, disables whole sets, and resets inheritance explicitly', async () => {
  const f = await setup(), store = new SkillStore(f.config.stateDir, f.settings, f.cache), caller = { userId: 'user', conversation: 'solo', operator: false };
  await store.command(`enable ${starterSets[1]}::example`, caller);
  expect(store.effective(caller).sets?.[1]).toEqual({ source: starterSets[1], include: ['example'], exclude: undefined });
  await store.command(`disable ${starterSets[0]}::example`, caller);
  expect(store.effective(caller).sets?.[0]?.exclude).toEqual(['example']);
  const list = await store.command(`list ${starterSets[0]}`, caller); expect(list).toContain(`off ${starterSets[0]}::example`);
  await store.command(`disable ${starterSets[0]}`, caller);
  expect(store.effective(caller).sets).toHaveLength(1);
  await store.command('reset', caller); expect(store.effective(caller).sets).toEqual(defaultSkillSets());
  await store.command('offline on', caller); await expect(store.command('update', caller)).rejects.toThrow('offline');
});

it('does not silently overwrite damaged selections and bounds the number of selected sets', async () => {
  const f = await setup(), store = new SkillStore(f.config.stateDir, f.settings, f.cache);
  expect(() => normalizeSets(Array.from({ length: 17 }, (_, index) => ({ source: `gh:owner/repo${index}` })))).toThrow('at most');
  await mkdir(f.config.stateDir, { recursive: true }); await writeFile(store.file, 'broken');
  await expect(store.command('reset global', { operator: true })).rejects.toThrow('unreadable');
  expect(await readFile(store.file, 'utf8')).toBe('broken');
});

it('registers Discord skill controls everywhere and preserves targets and scopes in command routing', () => {
  expect(commandDefinitions.find(command => command.name === 'skills')).toMatchObject({ integration_types: [0, 1], contexts: [0, 1, 2] });
  expect(commandText('skills', 'enable', 'gh:anthropics/skills::pdf', 'personal')).toBe('/skills enable gh:anthropics/skills::pdf personal');
  expect(commandText('skills', 'offline', 'on', 'global')).toBe('/skills offline on global');
});

it('routes private Discord choices through real requests, isolates users, and restores choices after restart', async () => {
  const f = await setup();
  await f.cache.catalog(f.settings, { sets: starterSets.map(source => ({ source })) });
  f.config.skills = { enabled: true, offline: true }; f.config.routingMode = 'direct'; f.config.models.fast.enabled = false;
  const bodies: any[] = [];
  const server = await mockServer((body, request, response) => {
    if (request.url?.endsWith('/models')) { response.end(JSON.stringify({ data: [{ id: f.config.models.capable.id }] })); return; }
    bodies.push(body); completion(response, { text: 'done' });
  }); cleanups.push(server.close);
  Object.assign(f.config.models.capable, { provider: 'ollama', baseUrl: server.url });
  const selections = join(f.cwd, 'discord'), world = new World();
  AccessStore.at(selections, [people.op.id], f.config.policy.permissions).addUser(people.user.id, people.op.id);
  const settings = { token: 'simulated-discord-token', allowedUserIds: [people.op.id], channelIds: [channelId], root: f.cwd, startMode: 'ask' as const };
  let turns = 0;
  const start = () => {
    const controller = new AbortController();
    const done = serveDiscord({ config: f.config, settings, stateDir: selections, log: world.log, signal: controller.signal, connect: world.connect, teachat: false, onTurnEnd: () => { turns++; } });
    return async () => { controller.abort(); await done; };
  };
  let stop = start(); cleanups.push(() => stop());
  await vi.waitFor(() => expect(world.connected).toBe(true));
  expect(await world.slash('user', `/skills enable ${starterSets[1]} personal`)).toContain('enabled');
  expect(await world.slash('user', `/skills enable ${starterSets[1]} global`)).toContain('only operators');
  expect(await world.slash('stranger', '/skills list')).toContain('not allowed');
  world.say('user', 'inspect the available skills');
  await vi.waitFor(() => expect(turns).toBe(1), { timeout: 10000 });
  expect(JSON.stringify(bodies.at(-1))).toContain(`${starterSets[0]}::example`);
  expect(JSON.stringify(bodies.at(-1))).toContain(`${starterSets[1]}::example`);
  world.say('op', 'inspect the available skills');
  await vi.waitFor(() => expect(turns).toBe(2), { timeout: 10000 });
  expect(JSON.stringify(bodies.at(-1))).toContain(`${starterSets[0]}::example`);
  expect(JSON.stringify(bodies.at(-1))).not.toContain(`${starterSets[1]}::example`);
  expect(await world.slash('user', `/skills disable ${starterSets[0]} conversation`)).toContain('disabled');
  await stop(); stop = start();
  await vi.waitFor(() => expect(world.connected).toBe(true));
  world.say('user', 'inspect the choices again');
  await vi.waitFor(() => expect(turns).toBe(3), { timeout: 10000 });
  expect(JSON.stringify(bodies.at(-1))).not.toContain(`${starterSets[0]}::example`);
  expect(JSON.stringify(bodies.at(-1))).toContain(`${starterSets[1]}::example`);
  expect(world.logs.filter(line => line.startsWith('⚠'))).toEqual([]);
}, 30000);
