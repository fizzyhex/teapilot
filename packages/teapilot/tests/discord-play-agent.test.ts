import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runAttempt } from '../src/agents/run.js';
import type { ConversationWorkspace } from '../src/agents/workspace.js';
import { SessionGrants } from '../src/execution/grants.js';
import { runHost } from '../src/host.js';
import { PlayRuntime, type PlaySurface } from '../src/discord/play/runtime.js';
import { PlayStore } from '../src/discord/play/store.js';
import { SpendGovernor } from '../src/inference/budget.js';
import { Telemetry } from '../src/telemetry/outcome.js';
import { WorkspaceStore } from '../src/workspace/store.js';
import { completion, fixture, jev, mockServer } from './helpers.js';
import { RequestRecovery } from '../src/agents/recovery.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const source = `import { app, button, row } from '@teapilot/discord-play';
export default app({ init: () => 0, update: n => n + 1, view: n => ({ content: 'Count ' + n, rows: [row(button('add', 'Add'))] }) });`;
/** The step that writes an app to its workspace file, as a model does before play_start. */
const written = (content = source, path = 'apps/counter.js') => ({ tool: { name: 'write', arguments: { path, content } } });
const owner = { id: '111111111111111111' };

async function setup(handler: Parameters<typeof mockServer>[0]) {
  const f = await fixture(); cleanups.push(f.cleanup);
  const server = await mockServer(handler); cleanups.push(server.close);
  Object.assign(f.config.models.capable, { provider: 'ollama', baseUrl: server.url });
  const telemetry = new Telemetry(f.config.stateDir, 'play-test');
  await telemetry.event('start', {});
  const budget = new SpendGovernor(join(f.config.stateDir, 'spend.jsonl'), 'play-test', f.config.policy.budget);
  const directory = await mkdtemp(join(tmpdir(), 'teapilot-play-agent-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const posts: string[] = [];
  const surface: PlaySurface = { post: vi.fn(async (_channel, payload) => { posts.push(payload.content); return 'm1'; }), edit: vi.fn(async () => undefined), request: vi.fn() };
  const runtime = new PlayRuntime({ store: new PlayStore(join(directory, 'apps')), surface, log: vi.fn() });
  cleanups.push(() => runtime.close());
  const store = WorkspaceStore.at(join(directory, 'state'));
  /** A Discord conversation as the bridge builds it: its workspace, and the play context whose files it is. */
  const workspace = (conversation = 'dm:1'): ConversationWorkspace => ({ store, conversation });
  const playIn = (conversation = 'dm:1') => ({ runtime, channelId: 'c1', conversation, owner, files: workspace(conversation) });
  const turn = (conversation = 'dm:1') => ({ play: playIn(conversation), workspace: workspace(conversation) });
  return { ...f, budget, telemetry, runtime, posts, store, turn, base: { tier: 'normal' as const, workload: 'ask' as const, web: false, approve: async () => true } };
}
const names = (body: any): string[] => (body.tools ?? []).map((tool: any) => tool.function.name);
const last = (body: any) => JSON.stringify(body.messages.at(-1));

it('keeps the testing budget across updates and attempts, then hands gameplay checks to the user', async () => {
  const bodies: any[] = [];
  const steps = [written(),
    { tool: { name: 'play_start', arguments: { file: 'apps/counter.js', title: 'Counter' } } },
    { tool: { name: 'play_test', arguments: { actions: [{ kind: 'button', id: 'add' }] } } },
    { tool: { name: 'play_update', arguments: { title: 'Renamed' } } },
    { tool: { name: 'play_test', arguments: { actions: [{ kind: 'button', id: 'add' }] } } },
    { text: 'Gameplay needs your verification.' },
    { tool: { name: 'play_test', arguments: { actions: [{ kind: 'button', id: 'add' }] } } },
    { text: 'Please check Add increases the counter.' }];
  const f = await setup((body, _req, res) => { bodies.push(body); completion(res, steps[bodies.length - 1]!); });
  const recovery = new RequestRecovery();
  const input = { ...f, ...f.base, activePermissions: ['inference', 'discord.play'] as const, ...f.turn(), recovery };
  const first = await runAttempt({ ...input, activePermissions: [...input.activePermissions], prompt: 'make and check a counter' });
  expect(first.success).toBe(true);
  const second = await runAttempt({ ...input, activePermissions: [...input.activePermissions], prompt: 'continue checking' });
  expect(second.success).toBe(true);
  expect(last(bodies[7])).toContain('automated play-testing is exhausted for this request');
  expect(recovery.playTests).toBe(2);
  const tests = first.steps!.filter(step => step.role === 'toolResult' && step.toolName === 'play_test');
  expect(tests[0]).toMatchObject({ details: { test: { sourceState: 'live', coverage: 'simulation' } } });
});

it('does not publish unchanged code with a demonstrated test defect, even after testing is exhausted', async () => {
  const bodies: any[] = [];
  const steps = [written(),
    { tool: { name: 'play_test', arguments: { file: 'apps/counter.js', actions: [{ kind: 'button', id: 'add' }], expect: [{ path: '', equals: 99 }] } } },
    { tool: { name: 'play_test', arguments: { file: 'apps/counter.js', actions: [{ kind: 'button', id: 'add' }], expect: [{ path: '', equals: 99 }] } } },
    { tool: { name: 'play_test', arguments: { file: 'apps/counter.js', actions: [] } } },
    { tool: { name: 'play_start', arguments: { file: 'apps/counter.js', title: 'Counter' } } },
    { text: 'The check failed; the app has not been posted.' }];
  const f = await setup((body, _req, res) => { bodies.push(body); completion(res, steps[bodies.length - 1]!); });
  const result = await runAttempt({ ...f, ...f.base, activePermissions: ['inference', 'discord.play'], ...f.turn(), prompt: 'check and post a counter' });
  expect(result.success).toBe(true);
  expect(f.posts).toEqual([]);
  expect(last(bodies[5])).toContain('testing exhaustion is not permission to publish broken code');
});

it('gives the play tools and the file tools to a Discord conversation holding discord.play, and starts apps from files', async () => {
  const bodies: any[] = [];
  const steps = [written(), { tool: { name: 'play_start', arguments: { file: 'apps/counter.js', title: 'Counter' } } }, { text: 'Your counter is up.' }];
  const f = await setup((body, _req, res) => { bodies.push(body); completion(res, steps[bodies.length - 1]!); });
  const result = await runAttempt({ ...f, ...f.base, prompt: 'make me a counter', activePermissions: ['inference', 'discord.play'], ...f.turn() });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(names(bodies[0])).toEqual(expect.arrayContaining(['play_start', 'play_update', 'play_test', 'play_inspect', 'play_list', 'play_stop', 'write', 'edit', 'read']));
  // Apps come from files only: no code in arguments, and no edits of their own.
  const start = bodies[0].tools.find((tool: any) => tool.function.name === 'play_start').function.parameters.properties;
  expect(start).not.toHaveProperty('source');
  expect(start).not.toHaveProperty('edits');
  expect(JSON.stringify(bodies[0].messages)).toContain('`discord.play` is active');
  expect(f.posts).toEqual(['Count 0']);
  expect(last(bodies[2])).toMatch(/Started app [a-z0-9]+ \(anyone can play\)/);
  expect(f.runtime.list('dm:1')).toEqual([expect.objectContaining({ file: 'apps/counter.js' })]);
});

it('does not demand an app mutation when a read-only plan mentions changes to a running app', async () => {
  const bodies: any[] = [];
  const steps = [written(), { tool: { name: 'play_start', arguments: { file: 'apps/counter.js', title: 'Counter' } } }, { text: 'counter ready' }, { text: '<plan># counter plan\n1. replace the renderer\n2. verify the changed controls</plan>' }];
  const f = await setup((body, _req, res) => { bodies.push(body); completion(res, steps[bodies.length - 1]!); });
  await runAttempt({ ...f, ...f.base, prompt: 'make counter', activePermissions: ['inference', 'discord.play'], ...f.turn() });
  const original = f.runtime.list('dm:1')[0]!;
  const result = await runAttempt({ ...f, ...f.base, prompt: 'plan a renderer change', activePermissions: ['inference', 'discord.play'], ...f.turn(), readOnly: true, expectsPlan: true });
  expect(result.success).toBe(true);
  expect(bodies).toHaveLength(4);
  expect(result.text).toContain('<plan>');
  expect(JSON.stringify(result.steps)).not.toContain('Your answer says the app changed');
  expect(names(bodies[3])).not.toContain('play_update');
  expect(f.runtime.list('dm:1')[0]).toEqual(original);
});

it('reads "invoker" and mentions inside a participants list, and turns away bad ones before trying the code', async () => {
  const bodies: any[] = [];
  const steps = [
    written(),
    { tool: { name: 'play_start', arguments: { file: 'apps/counter.js', title: 'Counter', participants: ['invoker', 'the other one'] } } },
    { tool: { name: 'play_start', arguments: { file: 'apps/counter.js', title: 'Counter', participants: ['<@222222222222222222>'] } } },
    { text: 'Up for you both.' },
  ];
  const f = await setup((body, _req, res) => { bodies.push(body); completion(res, steps[bodies.length - 1]!); });
  const result = await runAttempt({ ...f, ...f.base, prompt: 'make a counter for me and <@222222222222222222>', activePermissions: ['inference', 'discord.play'], ...f.turn() });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(last(bodies[2])).toContain('Nothing was started: participants must be');
  expect(last(bodies[3])).toContain('participants: [\\"111111111111111111\\",\\"222222222222222222\\"]');
});

it('gives apps the server emoji people pasted, and points out one an app swaps for a lookalike', async () => {
  const bodies: any[] = [];
  const lookalike = source.replace("'Count '", "'🐟 '");
  const pasted = source.replace("'Count '", "ctx.emoji('cod') + ' '").replace('view: n =>', 'view: (n, ctx) =>');
  const steps = [
    written(lookalike, 'apps/cod.js'),
    { tool: { name: 'play_start', arguments: { file: 'apps/cod.js', title: 'Cod' } } },
    { tool: { name: 'edit', arguments: { path: 'apps/cod.js', edits: [{ oldText: "'🐟 '", newText: "ctx.emoji('cod') + ' '" }, { oldText: 'view: n =>', newText: 'view: (n, ctx) =>' }] } } },
    { tool: { name: 'play_update', arguments: {} } },
    { text: 'Done.' },
  ];
  const f = await setup((body, _req, res) => { bodies.push(body); completion(res, steps[bodies.length - 1]!); });
  const result = await runAttempt({ ...f, ...f.base, prompt: 'make a counter that shows <:cod:881267273447407646>', activePermissions: ['inference', 'discord.play'],
    history: [{ user: 'hi <a:wave:726396997648515153>', assistant: 'hello' }], ...f.turn() });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(last(bodies[2])).toContain('the request pasted <:cod:881267273447407646>, which the app never uses');
  const updated = String(bodies[4].messages.at(-1).content);
  expect(updated).toContain('<:cod:881267273447407646> 0');
  expect(updated).not.toContain('never uses');
  const [app] = f.runtime.list('dm:1');
  expect(f.runtime.source(app!.id, 'dm:1')).toMatchObject({ code: pasted });
});

it('changes the newest app with an edit to its file, and names that file to later turns instead of showing its code', async () => {
  const bodies: any[] = [];
  const steps = [
    written(),
    { tool: { name: 'play_start', arguments: { file: 'apps/counter.js', title: 'Counter' } } },
    { tool: { name: 'edit', arguments: { path: 'apps/counter.js', edits: [{ oldText: "'Count '", newText: "'Total '" }] } } },
    { tool: { name: 'play_update', arguments: {} } },
    { text: 'Renamed it.' },
    { tool: { name: 'play_inspect', arguments: {} } },
    { text: 'It counts.' },
  ];
  const f = await setup((body, _req, res) => { bodies.push(body); completion(res, steps[bodies.length - 1]!); });
  const result = await runAttempt({ ...f, ...f.base, prompt: 'make me a counter, then call it a total', activePermissions: ['inference', 'discord.play'], ...f.turn() });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(last(bodies[4])).toContain('Total 0');
  const [app] = f.runtime.list('dm:1');
  expect(f.runtime.source(app!.id, 'dm:1')).toMatchObject({ code: expect.stringContaining("'Total '") });
  // A later turn without the earlier calls still learns the app and its file from the prompt, and play_inspect names the file.
  await runAttempt({ ...f, ...f.base, prompt: 'what does it do?', activePermissions: ['inference', 'discord.play'], ...f.turn() });
  expect(JSON.stringify(bodies[5].messages)).toContain(`Running here: ${app!.id} \\"Counter\\" (apps/counter.js)`);
  expect(last(bodies[6])).toContain('Code: the workspace file apps/counter.js');
  expect(last(bodies[6])).not.toContain('export default');
});

it('turns away a start before its file is written as one wasted call, keeping the tools', async () => {
  const bodies: any[] = [];
  const steps = [
    { tool: { name: 'play_start', arguments: { file: 'apps/counter.js', title: 'Counter' } } },
    written(),
    { tool: { name: 'play_start', arguments: { file: 'apps/counter.js', title: 'Counter' } } },
    { text: 'Done. Press Add.' },
  ];
  const f = await setup((body, _req, res) => { bodies.push(body); completion(res, steps[bodies.length - 1]!); });
  const result = await runAttempt({ ...f, ...f.base, prompt: 'make me a counter', activePermissions: ['inference', 'discord.play'], ...f.turn() });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(last(bodies[1])).toContain('No file named \\"apps/counter.js\\" in the workspace: write the app to it first');
  expect(bodies[1].tools.length).toBeGreaterThan(0);
  expect(f.posts).toEqual(['Count 0']);
  expect(result.text).toBe('Done. Press Add.');
  expect(result.steps!.filter(step => step.role === 'toolResult')).toHaveLength(3);
});

it('dry-runs the running app\'s changed file from its current state', async () => {
  const bodies: any[] = [];
  const steps = [
    written(),
    { tool: { name: 'play_start', arguments: { file: 'apps/counter.js', title: 'Counter' } } },
    { tool: { name: 'edit', arguments: { path: 'apps/counter.js', edits: [{ oldText: "'Count '", newText: "'Total '" }] } } },
    { tool: { name: 'play_update', arguments: {} } },
    { tool: { name: 'play_test', arguments: { actions: [{ kind: 'button', id: 'add' }] } } },
    { text: 'Done.' },
  ];
  const f = await setup((body, _req, res) => { bodies.push(body); completion(res, steps[bodies.length - 1]!); });
  const result = await runAttempt({ ...f, ...f.base, prompt: 'make me a counter', activePermissions: ['inference', 'discord.play'], ...f.turn() });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(last(bodies[5])).toContain('Total 1');
});

it.each([
  { name: 'an explicit file', args: { file: 'apps/counter.js' }, expected: 'Total 6' },
  { name: 'the newest app by default', args: {}, expected: 'Total 6' },
  { name: 'an explicit fresh start', args: { file: 'apps/counter.js', reset: true }, expected: 'Total 100' },
  { name: 'an unrelated file', args: { file: 'apps/other.js' }, expected: 'Count 8' },
])('dry-runs $name before updating in a later turn', async ({ args, expected }) => {
  const bodies: any[] = [];
  const steps = [
    written(source.replace('init: () => 0', 'init: () => 5')),
    { tool: { name: 'play_start', arguments: { file: 'apps/counter.js', title: 'Counter' } } },
    { text: 'Started.' },
    written(source.replace('init: () => 0', 'init: () => 99').replace("'Count '", "'Total '")),
    written(source.replace('init: () => 0', 'init: () => 7'), 'apps/other.js'),
    { tool: { name: 'play_test', arguments: { ...args, actions: [{ kind: 'button', id: 'add' }] } } },
    { text: 'Checked.' },
  ];
  const f = await setup((body, _req, res) => { bodies.push(body); completion(res, steps[bodies.length - 1]!); });
  await runAttempt({ ...f, ...f.base, prompt: 'make a counter', activePermissions: ['inference', 'discord.play'], ...f.turn() });
  const result = await runAttempt({ ...f, ...f.base, prompt: 'check the changed app', activePermissions: ['inference', 'discord.play'], ...f.turn() });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(last(bodies[6])).toContain(expected);
  const [app] = f.runtime.list('dm:1');
  expect(f.runtime.state(app!.id, 'dm:1')).toBe(5);
  expect(f.runtime.source(app!.id, 'dm:1')).toMatchObject({ code: expect.stringContaining("'Count '") });
});

it('renames a running app without changing its code or resetting state', async () => {
  const bodies: any[] = [];
  const steps = [
    written(source.replace('init: () => 0', 'init: () => 5')),
    { tool: { name: 'play_start', arguments: { file: 'apps/counter.js', title: 'Counter' } } },
    { tool: { name: 'play_update', arguments: { title: 'Renamed counter' } } },
    { tool: { name: 'play_inspect', arguments: {} } },
    { text: 'Renamed.' },
  ];
  const f = await setup((body, _req, res) => { bodies.push(body); completion(res, steps[bodies.length - 1]!); });
  const result = await runAttempt({ ...f, ...f.base, prompt: 'make and rename a counter', activePermissions: ['inference', 'discord.play'], ...f.turn() });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(last(bodies[3])).toContain('Updated app');
  expect(last(bodies[4])).toContain('Renamed counter');
  const [app] = f.runtime.list('dm:1');
  expect(app!.title).toBe('Renamed counter');
  expect(f.runtime.state(app!.id, 'dm:1')).toBe(5);
  expect(f.posts).toEqual(['Count 5']);
});

it('answers on the last turn of a play attempt instead of running into the turn limit', async () => {
  const bodies: any[] = [];
  const f = await setup((body, _req, res) => { bodies.push(body); completion(res, body.tools?.length ? { tool: { name: 'play_list', arguments: {} } } : { text: 'Nothing is running yet.' }); });
  f.config.policy.limits.maxTurns = 3;
  const result = await runAttempt({ ...f, ...f.base, prompt: 'what apps are there?', activePermissions: ['inference', 'discord.play'], ...f.turn() });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(bodies).toHaveLength(3);
  expect(bodies[2].tools ?? []).toEqual([]);
  expect(JSON.stringify(bodies[2].messages)).toContain('This is the last turn, so tools are withdrawn');
});

it('replays the tool calls of earlier turns, so a follow-up knows the app and its code', async () => {
  const bodies: any[] = [];
  const steps = [written(), { tool: { name: 'play_start', arguments: { file: 'apps/counter.js', title: 'Counter' } } }, { text: 'Your counter is up.' }, { text: 'Counting down now.' }];
  const f = await setup((body, _req, res) => { bodies.push(body); completion(res, steps[bodies.length - 1]!); });
  const first = await runAttempt({ ...f, ...f.base, prompt: 'make me a counter', activePermissions: ['inference', 'discord.play'], ...f.turn() });
  await runAttempt({ ...f, ...f.base, prompt: 'make it count down', activePermissions: ['inference', 'discord.play'], ...f.turn(),
    history: [{ user: 'make me a counter', assistant: first.text, steps: first.steps }] });
  const replayed = JSON.stringify(bodies[3].messages);
  expect(replayed).toContain('play_start');
  expect(replayed).toMatch(/Started app [a-z0-9]+/);
  expect(replayed).toContain("'Count '");
});

it('returns app mistakes as results to fix, not tool failures, and turns away the same file unchanged', async () => {
  const bodies: any[] = [];
  const steps = [
    written('export default {', 'apps/broken.js'),
    { tool: { name: 'play_start', arguments: { file: 'apps/broken.js', title: 'Broken' } } },
    { tool: { name: 'play_start', arguments: { file: 'apps/broken.js', title: 'Broken' } } },
    { text: 'Fixed it later.' },
  ];
  const f = await setup((body, _req, res) => { bodies.push(body); completion(res, steps[bodies.length - 1]!); });
  const result = await runAttempt({ ...f, ...f.base, prompt: 'make me a game', activePermissions: ['inference', 'discord.play'], ...f.turn() });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(last(bodies[2])).toContain('App problem, nothing was changed');
  expect(last(bodies[2])).toContain('Fix it with edit on apps/broken.js');
  expect(last(bodies[3])).toContain('apps/broken.js is unchanged since it was rejected');
  expect(bodies[3].tools.length).toBeGreaterThan(0);
  expect(f.posts).toEqual([]);
});

it('fixes a rejected app with an edit to its file instead of a rewrite', async () => {
  const bodies: any[] = [];
  const broken = source.replace("button('add', 'Add')", "button('add', 'Add'), button('again', '')");
  const steps = [
    written(broken),
    { tool: { name: 'play_start', arguments: { file: 'apps/counter.js', title: 'Counter' } } },
    { tool: { name: 'edit', arguments: { path: 'apps/counter.js', edits: [{ oldText: ", button('again', '')", newText: '' }] } } },
    { tool: { name: 'play_start', arguments: { file: 'apps/counter.js', title: 'Counter' } } },
    { text: 'Your counter is up.' },
  ];
  const f = await setup((body, _req, res) => { bodies.push(body); completion(res, steps[bodies.length - 1]!); });
  const result = await runAttempt({ ...f, ...f.base, prompt: 'make me a counter', activePermissions: ['inference', 'discord.play'], ...f.turn() });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(last(bodies[2])).toContain('A button needs a label or an emoji');
  expect(last(bodies[4])).toMatch(/Started app [a-z0-9]+/);
  expect(f.posts).toEqual(['Count 0']);
});

it('resends the newest app shown in the channel, even one another conversation started', async () => {
  const bodies: any[] = [];
  const f = await setup((body, _req, res) => {
    bodies.push(body);
    completion(res, bodies.length === 1 ? { tool: { name: 'play_resend', arguments: {} } } : { text: 'Here it is again.' });
  });
  const { record } = await f.runtime.start({ title: 'Counter', channelId: 'c1', conversation: 'dm:1', owner: { id: '111111111111111111' }, source: { kind: 'sandbox', code: source } });
  const result = await runAttempt({ ...f, ...f.base, prompt: 'resend the game, it got buried', activePermissions: ['inference', 'discord.play'],
    play: { runtime: f.runtime, channelId: 'c1', conversation: 'dm:2', owner: { id: '222222222222222222' } } });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(names(bodies[0])).toContain('play_resend');
  expect(JSON.stringify(bodies[0].messages)).toContain(`Running here: ${record.id}`);
  expect(JSON.stringify(bodies[1].messages)).toContain(`Resent app ${record.id}.`);
  expect(f.posts).toEqual(['Count 0', 'Count 0']);
});

it('refuses apps where teapilot has nowhere to post them', async () => {
  const bodies: any[] = [];
  const f = await setup((body, _req, res) => {
    bodies.push(body);
    completion(res, bodies.length === 1 ? { tool: { name: 'play_start', arguments: { file: 'apps/counter.js', title: 'Counter' } } } : { text: 'Cannot here.' });
  });
  await runAttempt({ ...f, ...f.base, prompt: 'make me a counter', activePermissions: ['inference', 'discord.play'], play: { runtime: f.runtime, conversation: 'reply:1' } });
  expect(JSON.stringify(bodies[1].messages)).toContain('nowhere to post them');
  expect(f.posts).toEqual([]);
});

it('lets only Discord conversations request discord.play, and hides the tools until it is active', async () => {
  const bodies: any[] = [];
  const f = await setup((body, _req, res) => { bodies.push(body); completion(res, { text: 'hi' }); });
  const requestCapabilities = vi.fn(async () => false);
  await runAttempt({ ...f, ...f.base, prompt: 'hello', activePermissions: ['inference'], requestCapabilities, play: { runtime: f.runtime, channelId: 'c1', conversation: 'dm:1' } });
  await runAttempt({ ...f, ...f.base, prompt: 'hello', activePermissions: ['inference'], requestCapabilities });
  const [discord, terminal] = bodies.map(body => body.tools.find((tool: any) => tool.function.name === 'request_capabilities'));
  expect(names(bodies[0]).some(name => name.startsWith('play_'))).toBe(false);
  expect(JSON.stringify(discord)).toContain('discord.play');
  expect(JSON.stringify(bodies[0].messages)).toContain('request_capabilities can activate `discord.play`');
  expect(JSON.stringify(terminal)).not.toContain('discord.play');
  expect(JSON.stringify(bodies[1].messages)).not.toContain('discord.play');
});

it('asks the router about discord.play only in Discord, activates it without a prompt, and keeps it for later turns', async () => {
  const questions: any[] = [];
  const tools: string[][] = [];
  const f = await setup((body, req, res) => {
    if (req.url === '/jev') {
      questions.push(body.questions);
      // Only the first routing call says the request wants an app.
      const end = res.end.bind(res);
      res.end = ((chunk: string) => { const raw = JSON.parse(chunk); if (body.questions['discord.play'] && questions.length === 1) raw.answers['discord.play'] = { type: 'choice', choice: 'yes', probabilities: { yes: 1 }, confidence: 0.99 }; return end(JSON.stringify(raw)); }) as typeof res.end;
      jev(res, 'ask.normal');
    } else if (req.url?.endsWith('/models')) res.end('{}');
    else { tools.push(names(body)); completion(res, { text: 'ok' }); }
  });
  f.config.router.endpoint = `${new URL(f.config.models.capable.baseUrl!).origin}/jev`;
  f.config.models.fast.baseUrl = f.config.models.capable.baseUrl;
  const grants = await SessionGrants.create(f.cwd, f.config, 'chat');
  grants.setCaller(() => ({ permissions: ['inference', 'web.search', 'discord.play'], preapproved: ['web.search', 'discord.play'] }));
  const approve = vi.fn(async () => false);
  const play = { runtime: f.runtime, channelId: 'c1', conversation: 'dm:1' };
  const request = { cwd: f.cwd, mode: 'chat' as const, authorization: grants };
  expect((await runHost(f.config, { ...request, prompt: 'lets play tic tac toe', play }, { approve, localProbe: async () => true })).success).toBe(true);
  expect(questions[0]['discord.play']).toMatchObject({ type: 'choice' });
  expect(tools[0]).toContain('play_start');
  expect((await runHost(f.config, { ...request, prompt: 'make it 4x4', play }, { approve, localProbe: async () => true })).success).toBe(true);
  expect(tools[1]).toContain('play_start');
  expect((await runHost(f.config, { ...request, prompt: 'hello' }, { approve, localProbe: async () => true })).success).toBe(true);
  expect(questions[2]['discord.play']).toBeUndefined();
  expect(tools[2]).not.toContain('play_start');
  expect(approve).not.toHaveBeenCalled();
});

it('never asks the router about, routes to or prompts for the repository while it is withheld, and lists nothing to request', async () => {
  const questions: any[] = [];
  const bodies: any[] = [];
  const f = await setup((body, req, res) => {
    if (req.url === '/jev') {
      questions.push(body.questions);
      // A router that would say yes to the repository, if it were asked.
      const end = res.end.bind(res);
      res.end = ((chunk: string) => { const raw = JSON.parse(chunk); raw.answers['repository.read'] = { type: 'choice', choice: 'yes', probabilities: { yes: 1 }, confidence: 0.99 }; return end(JSON.stringify(raw)); }) as typeof res.end;
      jev(res, 'coder.normal');
    } else if (req.url?.endsWith('/models')) res.end('{}');
    else { bodies.push(body); completion(res, { text: 'ok' }); }
  });
  f.config.router.endpoint = `${new URL(f.config.models.capable.baseUrl!).origin}/jev`;
  f.config.models.fast.baseUrl = f.config.models.capable.baseUrl;
  const grants = await SessionGrants.create(f.cwd, f.config, 'chat');
  grants.setCaller(() => ({ permissions: ['inference', 'repository.read', 'repository.write', 'repository.shell', 'web.search', 'discord.play'], preapproved: ['web.search', 'discord.play'] }));
  grants.withhold(['repository.read', 'repository.write', 'repository.shell']);
  const approve = vi.fn(async () => false);
  const result = await runHost(f.config, { cwd: f.cwd, mode: 'chat', authorization: grants, prompt: 'fix the game', play: { runtime: f.runtime, channelId: 'c1', conversation: 'dm:1' } }, { approve, localProbe: async () => true });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(result.capability).toMatch(/^ask\./);
  expect(Object.keys(questions[0]).filter(key => key.startsWith('repository.'))).toEqual([]);
  expect(approve).not.toHaveBeenCalled();
  const request = bodies[0].tools.find((tool: any) => tool.function.name === 'request_capabilities');
  expect(JSON.stringify(request)).not.toContain('repository');
  expect(JSON.stringify(request)).toContain('web.search');
});

it('names an app\'s file by path in a repository, by file in a workspace, and hides the workspace from the repository', async () => {
  const bodies: any[] = [];
  const f = await setup((body, _req, res) => { bodies.push(body); completion(res, { text: 'hi' }); });
  await runAttempt({ ...f, ...f.base, prompt: 'hello', activePermissions: ['inference', 'discord.play'], ...f.turn() });
  await runAttempt({ ...f, ...f.base, prompt: 'hello', activePermissions: ['inference', 'discord.play', 'repository.read'], ...f.turn() });
  const properties = (body: any) => Object.keys(body.tools.find((tool: any) => tool.function.name === 'play_start').function.parameters.properties);
  expect(properties(bodies[0])).toEqual(expect.arrayContaining(['file', 'title']));
  expect(properties(bodies[0])).not.toEqual(expect.arrayContaining(['path']));
  expect(properties(bodies[1])).toEqual(expect.arrayContaining(['path', 'title', 'trusted']));
  expect(properties(bodies[1])).not.toEqual(expect.arrayContaining(['file']));
  expect(JSON.stringify(bodies[1].messages)).not.toContain('.workspace');
  expect(JSON.stringify(bodies[1].messages)).not.toContain('workspace folder');
  expect(JSON.stringify(bodies[0].messages)).toContain('workspace folder');
  for (const body of bodies) {
    const prompt = JSON.stringify(body.messages);
    expect(prompt).not.toMatch(/rather than writing out a plan|Keep it as small|extensive playtesting|Tell people briefly|SDK is a convenience/);
    expect(prompt).toContain('Runtime limits:');
    expect(prompt).toContain('export default app');
    expect(prompt).toContain('ctx.discord.request');
  }
});

it('gives a junior the play tools to build and dry-run apps, but leaves posting to its instructor', async () => {
  const instructor: any[] = [], junior: any[] = [];
  const juniorSteps = [written(), { tool: { name: 'play_test', arguments: { file: 'apps/counter.js', actions: [{ kind: 'button', id: 'add' }] } } }, { tool: { name: 'report', arguments: { status: 'done', summary: 'apps/counter.js is ready.' } } }];
  const f = await setup((body, _req, res) => {
    if (JSON.stringify(body.messages?.[0] ?? '').includes('You are junior ')) { junior.push(body); return completion(res, juniorSteps[junior.length - 1]!); }
    instructor.push(body);
    completion(res, instructor.length === 1 ? { tool: { name: 'delegate_task', arguments: { description: 'Build a counter application', prompt: 'Build a counter app in apps/counter.js.', agent_type: 'write', artifacts: [] } } } : { text: 'Done.' });
  });
  await runAttempt({ ...f, ...f.base, prompt: 'make me a counter', activePermissions: ['inference', 'discord.play'], scratch: join(f.cwd, '.scratch'), ...f.turn() });
  expect(names(junior[0])).toEqual(expect.arrayContaining(['play_test', 'play_inspect', 'report']));
  expect(names(junior[0])).not.toContain('play_update');
  expect(names(junior[0])).not.toContain('play_start');
  expect(JSON.stringify(junior[0].messages)).toContain('Build a counter app in apps/counter.js.');
  expect(last(junior[2])).toContain('state: 1');
  expect(f.posts).toEqual([]);
  expect(names(instructor[0])).toContain('play_start');
});
