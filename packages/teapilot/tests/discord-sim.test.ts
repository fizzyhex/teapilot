import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IS_COMPONENTS_V2, layout } from 'pretty-send';
import { afterEach, expect, it, vi } from 'vitest';
import { serveDiscord } from '../src/discord/index.js';
import { viewSourcePrefix } from '../src/discord/render.js';
import { PlayRuntime } from '../src/discord/play/runtime.js';
import { PlayStore } from '../src/discord/play/store.js';
import { SkippableClock } from '../scripts/discord-sim/clock.js';
import { checkFiles, checkMessage, checkModal, DiscordRejected } from '../scripts/discord-sim/validate.js';
import { channelId, people, SimError, World } from '../scripts/discord-sim/world.js';
import type { Checkpoint } from '../src/agents/checkpoint.js';
import { completion, fixture, jev, mockServer } from './helpers.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const root = fileURLToPath(new URL('..', import.meta.url));

/** A counter with a form, a timer and a select, the parts of discord.play the simulator has to route. */
const counter = `
import { app, after, button, field, modal, row, select, step } from '@teapilot/discord-play';
export default app({
  participants: 'invoker',
  init: () => ({ count: 0, word: '', pick: '' }),
  update(state, action) {
    if (action.kind === 'button' && action.id === 'add') return { ...state, count: state.count + 1 };
    if (action.kind === 'button' && action.id === 'later') return step(state, after(60000, 'tick'));
    if (action.kind === 'timer') return { ...state, count: state.count + 100 };
    if (action.kind === 'modal') return { ...state, word: action.fields.word };
    if (action.kind === 'select') return { ...state, pick: action.values.join('+') };
    return state;
  },
  view: state => ({ content: 'Count ' + state.count + ' ' + state.word + ' ' + state.pick, rows: [
    row(button('add', 'Add', { style: 'primary' }), button('later', 'Later'), button('say', 'Say', { opens: modal('words', 'Say', [field('word', 'Word', { max: 5 })]) })),
    row(select('pick', ['a', 'b', 'c'], { max: 2 })),
  ] }),
});`;

it('holds messages to what discord.js and Discord accept, and names the field that fails', () => {
  expect(() => checkMessage({ content: 'hi', components: [{ type: 1, components: [{ type: 2, style: 1, label: 'Go', emoji: { name: '🍵' }, custom_id: 'play:a:go' }] }] })).not.toThrow();
  const rejected = (payload: Parameters<typeof checkMessage>[0]) => { try { checkMessage(payload); } catch (error) { expect(error).toBeInstanceOf(DiscordRejected); return (error as Error).message; } return 'accepted'; };
  expect(rejected({ content: '' })).toBe('Cannot send an empty message.');
  expect(rejected({ content: 'x', embeds: [{ title: 'x'.repeat(300) }] })).toBe('embeds[0].title: Invalid string length (expected.length <= 256; got 300 characters)');
  expect(rejected({ content: 'x', components: [{ type: 1, components: [{ type: 2, style: 1, label: 'x'.repeat(81), custom_id: 'a' }] }] })).toMatch(/components\[0\]\.components\[0\]\.label: .*<= 80/);
  expect(rejected({ content: 'x', components: [{ type: 1, components: [{ type: 2, style: 1, custom_id: 'a' }] }] })).toMatch(/label and\/or an emoji/);
  expect(rejected({ content: 'x', components: [{ type: 1, components: [{ type: 2, style: 1, emoji: { name: 'tea' }, custom_id: 'a' }] }] })).toMatch(/not a Unicode emoji/);
  expect(rejected({ content: 'x', components: [{ type: 1, components: [{ type: 2, style: 1, label: 'A', custom_id: 'a' }, { type: 2, style: 1, label: 'B', custom_id: 'a' }] }] })).toMatch(/used twice/);
  expect(rejected({ content: 'x', components: [{ type: 1, components: [{ type: 3, custom_id: 's', options: [{ label: 'a', value: 'a' }], max_values: 2 }] }] })).toMatch(/max_values 2 is above its 1 option/);
  expect(() => checkModal({ custom_id: 'm', title: 'x'.repeat(46), components: [{ type: 1, components: [{ type: 4, custom_id: 'f', label: 'F', style: 1 }] }] })).toThrow(/modal\.title/);
});

it('marks silent assistant commentary with suppress-notifications, not literal @silent text', async () => {
  const world = new World();
  const transport = world.transport(world.channel('channel'));
  await transport.send('checking the files', { silent: true });
  await transport.send('done');
  expect(world.messages[0]).toMatchObject({ content: 'checking the files', flags: 1 << 12 });
  expect(world.messages[1]!.flags).toBeUndefined();
  expect(world.logs.filter(line => line.startsWith('⚠'))).toEqual([]);
});

it('jumps timers forward in order and still lets them fire on their own', async () => {
  const clock = new SkippableClock();
  const fired: string[] = [];
  clock.after(60_000, () => fired.push('minute'));
  clock.after(30_000, () => fired.push('half'));
  const cancel = clock.after(45_000, () => fired.push('cancelled'));
  clock.after(10, () => fired.push('soon'));
  cancel();
  await vi.waitFor(() => expect(fired).toEqual(['soon']));
  expect(clock.advance(60_000)).toBe(2);
  await vi.waitFor(() => expect(fired).toEqual(['soon', 'half', 'minute']));
  expect(clock.now() - Date.now()).toBeGreaterThanOrEqual(59_000);
});

async function playWorld() {
  const world = new World();
  const clock = new SkippableClock();
  const directory = await mkdtemp(join(tmpdir(), 'teapilot-sim-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  let runtime!: PlayRuntime;
  const gateway = await world.connect({ token: 't', allowedUserIds: [people.op.id], channelIds: [channelId], root: directory, startMode: 'ask' },
    { message: vi.fn(), command: vi.fn(), reply: vi.fn(), component: interaction => void runtime.interact(interaction), asides: { keep: vi.fn(), find: vi.fn(), summarise: vi.fn() } }, vi.fn());
  runtime = new PlayRuntime({ store: new PlayStore(directory), surface: gateway.play, log: world.log, clock });
  cleanups.push(() => runtime.close());
  const { record } = await runtime.start({ title: 'Counter', channelId, conversation: 'dm:x', owner: { id: people.op.id, name: 'op' }, source: { kind: 'sandbox', code: counter } });
  return { world, clock, runtime, gateway, record, message: record.messageId! };
}

it('routes clicks, selects and forms from simulated people through the real runtime', async () => {
  const { world, message } = await playWorld();
  expect(world.screen()).toContain('[Add](add, primary) [Later](later) [Say](say)');

  expect(await world.click('op', message, 'add')).toContain('Count 1');
  expect(await world.click('stranger', message, 'add')).toContain('teapilot (only stranger sees this) in #channel:\n  Only @op can use this app.');

  const form = await world.click('op', message, 'say');
  expect(form).toContain('op sees a form:\n  "Say"\n  word: Word (short, required, max 5)');
  await expect(world.submit('op', { word: 'toolong' })).rejects.toThrow(/at most 5/);
  expect(await world.submit('op', { word: 'hey' })).toContain('Count 1 hey');
  await expect(world.submit('op', { word: 'again' })).rejects.toThrow(/no form open/);

  expect(await world.select('op', message, 'pick', ['a', 'c'])).toContain('Count 1 hey a+c');
  await expect(world.select('op', message, 'pick', ['z'])).rejects.toThrow(SimError);
  await expect(world.click('op', message, 'pick')).rejects.toThrow(/use select/);
  await expect(world.click('op', message, 'missing')).rejects.toThrow(/Controls: add, later, say, pick/);
});

it('fires app timers when the clock jumps', async () => {
  const { world, clock, message } = await playWorld();
  await world.click('op', message, 'later');
  expect(clock.advance(60_000)).toBe(1);
  await vi.waitFor(() => expect(world.render(world.find(message))).toContain('Count 100'));
});

it('resends a buried app at the bottom and turns away clicks on the old copy', async () => {
  const { world, clock, runtime, record, message } = await playWorld();
  await world.click('op', message, 'add');
  const { record: moved } = await runtime.resend(record.id, 'dm:x', { channelId });
  const fresh = moved.messageId!;
  expect(fresh).not.toBe(message);
  clock.advance(2000);
  await vi.waitFor(() => expect(world.render(world.find(message))).toContain('This app moved to a newer message below.'));
  expect(world.render(world.find(fresh))).toContain('Count 1');
  expect(world.logs.filter(line => line.startsWith('⚠'))).toEqual([]);
  expect(await world.click('op', fresh, 'add')).toContain('Count 2');
});

it('holds Components V2 answers to Discord\'s rules, shows them, and reads tables back for view source', async () => {
  const rejected = (payload: Parameters<typeof checkMessage>[0]) => { try { checkMessage(payload); checkFiles(payload as never); } catch (error) { expect(error).toBeInstanceOf(DiscordRejected); return (error as Error).message; } return 'accepted'; };
  const v2 = { flags: IS_COMPONENTS_V2 };
  expect(rejected({ ...v2, content: 'hi', components: [{ type: 10, content: 'hi' }] })).toMatch(/cannot have content/);
  expect(rejected({ ...v2, components: [{ type: 11, media: { url: 'https://example.com/a.png' } }] })).toMatch(/only allowed as a section's accessory/);
  expect(rejected({ ...v2, components: Array.from({ length: 41 }, () => ({ type: 14 })) })).toMatch(/41 components; Discord allows 40/);
  expect(rejected({ ...v2, components: [{ type: 13, file: { url: 'attachment://a.py' } }], files: [] })).toMatch(/attachment:\/\/a\.py is not attached/);
  expect(rejected({ ...v2, components: [{ type: 13, file: { url: 'https://example.com/a.py' } }] })).toMatch(/only takes attachment:\/\//);

  const world = new World();
  const resolve = (ref: string) => ref === 'a.png' ? { name: 'a.png', data: Buffer.from('png'), image: true } : ref === 'a.py' ? { name: 'a.py', data: Buffer.from('x'), image: false } : undefined;
  const messages = await layout('see this\n![a](a.png)\n\n---\n\n![a.py]\n\n| item | a | b | c |\n|---|---|---|---|\n| tea | 1 | 2 | 3 |', { resolve, viewSourcePrefix });
  const transport = world.transport(world.channel('channel'));
  for (const message of messages) await transport.answer!(message);
  expect(world.logs.filter(line => line.startsWith('⚠'))).toEqual([]);
  const screen = world.screen('channel');
  expect(screen).toContain('🖼 thumbnail: attachment://a.png');
  expect(screen).toContain('───');
  expect(screen).toContain('📄 file: attachment://a.py');
  expect(await world.click('stranger', 'm2', 'rows')).toContain('| item | a | b | c |\n  | --- | --- | --- | --- |\n  | tea | 1 | 2 | 3 |');
});

it('attaches long table sources privately, including after a restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teapilot-table-source-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const world = new World(directory);
  const settings = { token: 't', allowedUserIds: [people.op.id], channelIds: [channelId], root: directory, startMode: 'ask' as const };
  const handlers = { message: vi.fn(), command: vi.fn(), reply: vi.fn(), component: vi.fn(), asides: { keep: vi.fn(), find: vi.fn(), summarise: vi.fn() } };
  const gateway = await world.connect(settings, handlers, vi.fn());
  const rows = Array.from({ length: 12 }, (_, index) => `| row ${index} | ${'a'.repeat(80)} | ${'b'.repeat(80)} |`).join('\n');
  const [message] = await layout(`| item | a | b |\n|---|---|---|\n${rows}`, { viewSourcePrefix });
  const id = await world.transport(world.channel('channel')).answer!(message!);
  expect(await world.click('op', id, 'columns')).toContain('the table is attached.');
  await gateway.close();
  const restarted = await world.connect(settings, handlers, vi.fn());
  cleanups.push(() => restarted.close());
  const clicked = await world.click('stranger', id, 'columns');
  expect(clicked).toContain('the table is attached.');
  const reply = world.messages.at(-1)!;
  expect(reply.only).toBe('stranger');
  expect(reply.files[0]!.name).toBe('table.md');
  expect(await readFile(reply.files[0]!.path, 'utf8')).toContain(rows);
  expect(world.logs.filter(line => line.startsWith('⚠'))).toEqual([]);
});

it('flags what Discord would reject instead of accepting it', async () => {
  const { world, gateway } = await playWorld();
  await expect(gateway.play.post(channelId, { content: '', embeds: [], components: [], allowedMentions: { parse: [] } })).rejects.toThrow(DiscordRejected);
  expect(world.logs.at(-1)).toBe('⚠ Discord would reject a message in #channel: Cannot send an empty message.');
  await expect(gateway.play.request('GET', '/users/@me')).rejects.toThrow(/does not emulate/);
});

/** Models that build the counter, or return a supplied answer for delivery tests. */
async function models(answer?: string) {
  const f = await fixture(); cleanups.push(f.cleanup);
  let completions = 0;
  const server = await mockServer((_body, request, response) => {
    if (request.url === '/jev') {
      // The router says the request wants an app, which activates discord.play for the turn.
      const end = response.end.bind(response);
      response.end = ((chunk: string) => {
        const raw = JSON.parse(chunk);
        raw.answers['discord.play'] = { type: 'choice', choice: 'yes', probabilities: { yes: 1 }, confidence: 0.99 };
        return end(JSON.stringify(raw));
      }) as typeof response.end;
      jev(response, 'ask.normal');
    }
    else if (request.url?.endsWith('/models')) response.end(JSON.stringify({ data: [{ id: 'fast-test' }, { id: 'capable-test' }] }));
    else {
      // The model writes the app to a workspace file, then starts it from there.
      const steps = [{ tool: { name: 'write', arguments: { path: 'apps/counter.js', content: counter } } }, { tool: { name: 'play_start', arguments: { file: 'apps/counter.js', title: 'Counter' } } }];
      completion(response, answer === undefined ? steps[completions++] ?? { text: 'Your counter is up.' } : { text: answer });
    }
  });
  cleanups.push(server.close);
  f.config.router.endpoint = `${server.url}/jev`;
  for (const model of [f.config.models.fast, f.config.models.capable]) model.baseUrl = `${server.url}/v1`;
  f.config.policy.permissions = [...f.config.policy.permissions.filter(value => value !== 'discord.play'), 'discord.play'];
  return { ...f, server };
}

it('delivers rich answers through the service and keeps both table buttons working after restart', async () => {
  const narrow = '| item | a | b |\n|---|---|---|\n| tea | 1 | 2 |';
  const wide = '| item | a | b | c | d |\n|---|---|---|---|---|\n| tea | 1 | 2 | 3 | 4 |';
  const f = await models(`see the chart\n![chart](chart.png)\n\n---\n\n![script.py]\n\n${narrow}\n\n${wide}`);
  const world = new World(join(f.cwd, 'attachments'));
  const settings = { token: 'simulated-discord-token', allowedUserIds: [people.op.id], channelIds: [channelId], root: f.cwd, startMode: 'ask' as const };
  const serve = () => {
    const controller = new AbortController();
    const done = serveDiscord({ config: f.config, settings, log: world.log, signal: controller.signal, connect: world.connect, stateDir: join(f.cwd, 'discord'), teachat: false });
    return { stop: async () => { controller.abort(); await done; } };
  };
  let service = serve();
  cleanups.push(() => service.stop());
  await vi.waitFor(() => expect(world.connected).toBe(true));
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  world.say('op', 'show these files and tables', undefined, [
    { name: 'chart.png', data: image, contentType: 'image/png' },
    { name: 'script.py', data: Buffer.from('print(1)\n'), contentType: 'text/plain' },
  ]);
  await vi.waitFor(() => expect(world.screen('dm-op')).toContain('Result: completed'), { timeout: 20_000 });
  const rich = world.messages.find(message => message.flags === IS_COMPONENTS_V2)!;
  expect(rich.components.map(component => component.type)).toEqual([9, 14, 13]);
  expect(rich.files.map(file => file.name)).toEqual(['chart.png', 'script.py']);
  expect(await readFile(rich.files[0]!.path)).toEqual(image);
  const tables = world.messages.filter(message => message.embeds.length);
  expect(tables).toHaveLength(2);
  expect(await world.click('stranger', tables[0]!.id, 'columns')).toContain('| tea | 1 | 2 |');
  expect(await world.click('stranger', tables[1]!.id, 'rows')).toContain('| tea | 1 | 2 | 3 | 4 |');
  await service.stop();
  service = serve();
  await vi.waitFor(() => expect(world.connected).toBe(true));
  expect(await world.click('stranger', tables[0]!.id, 'columns')).toContain('| tea | 1 | 2 |');
  expect(await world.click('stranger', tables[1]!.id, 'rows')).toContain('| tea | 1 | 2 | 3 | 4 |');
  expect(world.logs.filter(line => line.startsWith('⚠'))).toEqual([]);
}, 60_000);

it('runs teapilot discord start against the simulator: a model builds an app, people use it, and it survives a restart', async () => {
  const f = await models();
  const world = new World();
  const settings = { token: 'simulated-discord-token', allowedUserIds: [people.op.id], channelIds: [channelId], root: f.cwd, startMode: 'ask' as const };
  const serve = () => {
    const controller = new AbortController();
    const done = serveDiscord({ config: f.config, settings, log: world.log, signal: controller.signal, connect: world.connect, stateDir: join(f.cwd, 'discord'), teachat: false });
    return { stop: async () => { controller.abort(); await done; } };
  };
  let server = serve();
  cleanups.push(() => server.stop());
  await vi.waitFor(() => expect(world.connected).toBe(true));

  world.say('stranger', 'make me a counter');
  world.say('op', 'make me a counter');
  await vi.waitFor(() => expect(world.screen('dm-op')).toContain('Result: completed'), { timeout: 20_000 });
  expect(world.screen('dm-op')).toContain('Your counter is up.');
  expect(world.screen('dm-stranger')).not.toContain('teapilot');
  const card = world.messages.find(message => message.content.startsWith('-# Result: completed'))!;
  expect(card.components[0]!.components.map(control => control.label)).toEqual(['Details']);
  expect(await world.click('op', card.id, 'details')).toMatch(/\(only op sees this\).*\n {2}\*\*Turn details\*\* · completed · 2 steps · \d+s\n {2}accounted \$[\d.]+\n {2}request [\da-f-]+\n {2}- write apps\W+counter\.js \(1 KB\)\n {2}- play\\_start/);
  const app = world.messages.find(message => message.content.startsWith('Count 0'))!;
  expect(app.channel.name).toBe('dm-op');
  expect(await world.click('op', app.id, 'add')).toContain('Count 1');

  await server.stop();
  server = serve();
  await vi.waitFor(() => expect(world.logs).toContain('Loaded 1 discord.play app(s); each one starts again at the next click.'));
  expect(await world.click('op', app.id, 'add')).toContain('Count 2');
}, 60_000);

function discord(args: string[], env: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
    const child = spawn(process.execPath, [resolve(root, 'scripts/agent-discord.mjs'), ...args], { cwd: root, windowsHide: true, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data);
    child.stderr.on('data', data => stderr += data);
    child.on('error', reject);
    child.on('close', code => done({ code, stdout, stderr }));
  });
}

it('drives the simulator from the command line, one call at a time', async () => {
  const f = await models();
  await writeFile(join(f.cwd, 'models.json'), JSON.stringify(f.config.models));
  await writeFile(join(f.cwd, 'policy.json'), JSON.stringify(f.config.policy));
  const env = {
    TEAPILOT_MODELS_FILE: join(f.cwd, 'models.json'), TEAPILOT_POLICY_FILE: join(f.cwd, 'policy.json'), TEAPILOT_STATE_DIR: f.config.stateDir,
    JEV_PROVIDER: 'typesafe', TYPESAFE_API_KEY: 'never-log-this-secret', JEV_API_URL: `${f.server.url}/jev`, WORKSPACE_SANDBOX: 'off',
  };
  const name = `vitest-${process.pid}`;
  cleanups.push(() => discord(['stop', name]));

  const started = await discord(['start', '--name', name, '--config-dir', f.cwd, '--mode', 'chat'], env);
  expect(started.code, started.stderr).toBe(0);
  expect(started.stdout).toContain('Simulated Discord is running.');
  expect((await discord(['say', name, 'make me a counter'])).stdout).toBe('m1 sent by op in #dm-op.\n');
  const turn = await discord(['wait', name, '--for', 'Result: ', '--timeout', '30']);
  expect(turn.code, turn.stdout).toBe(0);
  expect(turn.stdout).toContain('Your counter is up.');
  const id = /^m\d+ teapilot in #dm-op:\n {2}Count 0/m.exec(turn.stdout)?.[0].split(' ')[0];
  expect(id, turn.stdout).toBeDefined();

  expect((await discord(['click', name, id!, 'add'])).stdout).toContain('Count 1');
  const refused = await discord(['click', name, id!, 'nope']);
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain('has no control nope');
  expect((await discord(['click', name, id!, 'say'])).stdout).toContain('op sees a form');
  expect((await discord(['submit', name, '--field', 'word=hi'])).stdout).toContain('Count 1 hi');
  const [app] = (await discord(['apps', name])).stdout.split(/\s+/);
  const details = await discord(['app', name, app!]);
  expect(details.stdout).toContain('## source');
  expect(details.stdout).toContain("participants: 'invoker'");
  expect((await discord(['wait', name, '--for', 'no such output', '--timeout', '1'])).code).toBe(124);

  expect((await discord(['stop', name])).code).toBe(0);
  expect(existsSync(join(tmpdir(), 'teapilot-discord', name))).toBe(false);
}, 120_000);

it('shows a plan as embeds, routes its buttons and change form to the conversation, and edits it in place', async () => {
  const world = new World();
  const press = vi.fn<(action: string, user: { id: string; name: string }, request?: string) => string | undefined>(() => undefined);
  const controls = (actions: Array<'approve' | 'juniors' | 'change'>) => ({ actions, refusal: () => undefined, press });
  const transport = world.transport(world.channel('channel'));
  const embed = (title: string) => [{ title, description: 'steps', color: 0xbabbf1 }];
  const ids = await transport.plan!([embed('Tea')], controls(['approve', 'juniors', 'change']));
  expect(world.render(world.find(ids[0]!))).toContain('[lgtm!](approve, success) [♟️ assign juniors](juniors) [✍️ request change](change)');
  expect(world.render(world.find(ids[0]!))).toContain('(#babbf1)');

  await world.click('op', ids[0]!, 'juniors');
  expect(press).toHaveBeenCalledWith('juniors', { id: people.op.id, name: 'op' });
  expect(await world.click('op', ids[0]!, 'change')).toContain('request: What should change in the plan?');
  await world.submit('op', { request: 'add a kettle' });
  expect(press).toHaveBeenLastCalledWith('change', { id: people.op.id, name: 'op' }, 'add a kettle');

  // A refined plan lands on the same message, and a shorter one deletes the extra messages.
  const grown = await transport.plan!([embed('Tea v2'), embed('more')], controls([]), ids);
  expect(grown[0]).toBe(ids[0]);
  expect(world.find(ids[0]!).edits).toBe(1);
  expect(world.render(world.find(grown[1]!))).not.toContain('lgtm');
  const shrunk = await transport.plan!([embed('Tea v3')], controls([]), grown);
  expect(shrunk).toEqual([grown[0]]);
  expect(() => world.find(grown[1]!)).toThrow(SimError);
});

it('routes checkpoint choices and bounded direction forms through simulated Discord controls', async () => {
  const world = new World();
  await world.connect({ token: 't', allowedUserIds: [people.op.id], channelIds: [channelId], root: '.', startMode: 'ask' }, { message: vi.fn(), command: vi.fn(), reply: vi.fn(), component: vi.fn(), asides: { keep: vi.fn(), find: vi.fn(), summarise: vi.fn() } }, vi.fn());
  const checkpoint: Checkpoint = { version: 1, requestId: 'r', checkpointId: 1, sequence: 1, reason: 'instructor_calls', durability: 'request-local', expiresAt: Date.now() + 30_000, snapshot: { amendments: [], artifacts: [], checks: [], results: [], workers: [], resources: {}, pendingUncertain: [] }, summary: [], continuation: { offerId: 'offer', instructorCalls: 2, activeMs: 1000, freshContext: true } };
  const decide = vi.fn((action: 'continue' | 'redirect' | 'finish_partial', user: string, amendment?: string) => {
    if (user !== people.op.id) return undefined;
    if (action === 'redirect') return { requestId: 'r', checkpointId: 1, action, offerId: 'offer', amendment: amendment ?? '' };
    if (action === 'continue') return { requestId: 'r', checkpointId: 1, action, offerId: 'offer' };
    return { requestId: 'r', checkpointId: 1, action };
  });
  const controller = new AbortController();
  const pending = world.transport(world.channel('channel')).checkpoint!('checkpoint summary', checkpoint, controller.signal, decide, () => ({ text: 'stopping…' }));
  const card = world.messages.at(-1)!;
  expect(card.components[0]!.components.map(control => control.label)).toEqual(['Continue', 'Change direction', 'Finish partial', 'Stop now']);
  expect(await world.click('stranger', card.id, 'continue')).toContain('cannot choose');
  expect(decide).toHaveBeenCalledWith('continue', people.stranger.id);
  expect(await world.click('op', card.id, 'redirect')).toContain('amendment: What should change?');
  await world.submit('op', { amendment: 'Use another approach' });
  expect(decide).toHaveBeenCalledWith('redirect', people.op.id, 'Use another approach');
  await expect(pending).resolves.toMatchObject({ requestId: 'r', action: 'redirect', amendment: 'Use another approach' });
  expect(card.components).toEqual([]);
});
