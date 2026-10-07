import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { MessagePayload } from '../src/discord/play/render.js';
import { hashFile, PlayRuntime, systemClock, type Clock, type Consultant, type Pictures, type PlayInteraction, type PlaySurface } from '../src/discord/play/runtime.js';
import { PlayStore } from '../src/discord/play/store.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const owner = { id: '111111111111111111', name: 'owner' };
const friend = '222222222222222222';
const stranger = '333333333333333333';

it('repost clicks preserve state, bypass player restrictions, and retire interaction-hosted copies', async () => {
  const { runtime, store } = await setup();
  const edit = vi.fn(async (_payload: MessagePayload) => {});
  const { record } = await runtime.start({ title: 'Counter', channelId: 'c', conversation: 'conv', owner, participants: 'invoker', source: { kind: 'sandbox', code: counter }, post: async () => ({ id: 'original', edit }) });
  await runtime.interact(act(record.id, 'add', owner.id, { messageId: 'original' }).interaction);
  const post = vi.fn(async (_payload: MessagePayload) => ({ id: 'reposted', edit }));
  const click = act(record.id, '', stranger, { kind: 'resend', messageId: 'original', post });
  await runtime.interact(click.interaction);
  expect(click.seen.deferred).toBe(true);
  expect(post).toHaveBeenCalledOnce();
  expect(record.state).toMatchObject({ count: 1 });
  expect(record.messageId).toBe('reposted');
  expect(store.all()[0]!.messageId).toBe('reposted');
  await vi.waitFor(() => expect(click.seen.updates).toContainEqual(expect.objectContaining({ content: expect.stringContaining('moved'), components: [] })));
  const stale = act(record.id, '', stranger, { kind: 'resend', messageId: 'original', post });
  await runtime.interact(stale.interaction);
  expect(stale.seen.replies.join('')).toContain('moved');
  expect(post).toHaveBeenCalledOnce();
  await runtime.interact(act(record.id, 'add', owner.id, { messageId: 'reposted' }).interaction);
  expect(record.state).toMatchObject({ count: 2 });
});

it('pastes an app into another channel, retires the old copy, and respects that channel\'s app limit', async () => {
  const { runtime, surface, edits } = await setup();
  const { record } = await start(runtime);
  await runtime.interact(act(record.id, 'add', owner.id, { messageId: 'message-1' }).interaction);
  const paste = act(record.id, '', owner.id, { kind: 'paste', channelId: 'channel-2' });
  await runtime.interact(paste.interaction);
  expect(paste.seen.followUps).toEqual([]);
  expect(record.channelId).toBe('channel-2');
  expect(record.state).toMatchObject({ count: 1 });
  expect(surface.post).toHaveBeenLastCalledWith('channel-2', expect.objectContaining({ content: expect.stringContaining('1') }));
  await vi.waitFor(() => expect(edits.at(-1)).toMatchObject({ content: '-# This app moved to another channel.', components: [] }));
  for (let index = 0; index < 5; index++) await runtime.start({ title: 'Full', channelId: 'channel-3', conversation: 'dm:1', owner, source: { kind: 'sandbox', code: counter } });
  const refused = act(record.id, '', owner.id, { kind: 'paste', channelId: 'channel-3' });
  await runtime.interact(refused.interaction);
  expect(refused.seen.followUps.join('')).toContain('could not paste this app: That channel already has 5 apps running');
  expect(record.channelId).toBe('channel-2');
});

it('reports fresh/live state, idle and skipped actions without claiming correctness', async () => {
  const { runtime } = await setup();
  const source = { kind: 'sandbox' as const, code: counter };
  const simulation = await runtime.testDetailed(source, [{ kind: 'button', id: 'missing' }, { kind: 'button', id: 'add' }], owner);
  expect(simulation).toMatchObject({ sourceState: 'init', coverage: 'simulation', completed: 1, skipped: 1, errors: [], assertions: { passed: 0, failed: 0 } });
  expect(simulation.text).toContain('simulation only');
  const live = await runtime.testDetailed(source, [{ kind: 'button', id: 'add' }], owner, { state: { count: 10, said: '' }, expect: [{ path: 'count', equals: 11 }] });
  expect(live).toMatchObject({ sourceState: 'live', coverage: 'assertions', assertions: { passed: 1, failed: 0 } });
  expect(live.text).toContain('inherited live state');
});

it('reports runtime errors and failed explicit assertions as failed checks', async () => {
  const { runtime } = await setup();
  const source = { kind: 'sandbox' as const, code: counter };
  const broken = await runtime.testDetailed(source, [{ kind: 'button', id: 'boom' }, { kind: 'button', id: 'add' }], owner, { expect: [{ path: 'count', equals: 0 }] });
  expect(broken).toMatchObject({ completed: 0, errors: [{ step: 1, message: expect.stringContaining('kaboom') }], assertions: { passed: 0, failed: 1 } });
  const wrong = await runtime.testDetailed(source, [{ kind: 'button', id: 'add' }], owner, { expect: [{ path: 'count', equals: 99 }] });
  expect(wrong).toMatchObject({ errors: [], assertions: { passed: 0, failed: 1 } });
  expect(wrong.text).toContain('assertion failed: state.count');
});

/** A counter with every feature the runtime has to route: buttons, a modal, timers, consults, private notes and finishing. */
const counter = `
import { app, button, row, step, after, cancel, consult, ephemeral, finish, modal, field } from '@teapilot/discord-play';
export default app({
  participants: 'everyone',
  init: () => ({ count: 0, said: '' }),
  update(state, action) {
    if (action.kind === 'button' && action.id === 'add') return { ...state, count: state.count + 1 };
    if (action.kind === 'button' && action.id === 'boom') throw new Error('kaboom');
    if (action.kind === 'button' && action.id === 'hint') return step(state, ephemeral('psst'));
    if (action.kind === 'button' && action.id === 'soon') return step(state, after(2000, 'tick'));
    if (action.kind === 'button' && action.id === 'never') return step(state, after(2000, 'tick'), cancel('tick'));
    if (action.kind === 'button' && action.id === 'ask') return step(state, consult('judge', 'is ' + state.count + ' big?'));
    if (action.kind === 'button' && action.id === 'end') return step(state, finish('Final: ' + state.count));
    if (action.kind === 'timer') return { ...state, count: state.count + 100 };
    if (action.kind === 'consult') return { ...state, said: action.text ?? 'error: ' + action.error };
    if (action.kind === 'modal') return { ...state, said: action.fields.word };
    return state;
  },
  view: state => ({ content: state.count + ' ' + state.said, rows: [
    row(button('add', 'Add'), button('boom', 'Boom'), button('hint', 'Hint'), button('soon', 'Soon'), button('never', 'Never')),
    row(button('ask', 'Ask'), button('end', 'End'), button('say', 'Say', { opens: modal('words', 'Say', [field('word', 'Word')]) })),
  ] }),
});`;

/** A clock started by init(), which runs from the post until the app hibernates. */
const ticker = `
import { app, button, row, step, after } from '@teapilot/discord-play';
export default app({
  init: () => step({ n: 0 }, after(2000, 'tick')),
  update(state, action) {
    if (action.kind === 'timer') return step({ n: state.n + 1 }, after(2000, 'tick'));
    return state;
  },
  view: state => ({ content: 'n' + state.n, rows: [row(button('poke', 'Poke'))] }),
});`;

/** A clock that outlives the ten minutes an app stays awake for. */
const slow = `
import { app, button, row, step, after } from '@teapilot/discord-play';
export default app({
  init: () => ({ n: 0 }),
  update(state, action) {
    if (action.kind === 'button' && action.id === 'go') return step(state, after(20 * 60000, 'tick'));
    if (action.kind === 'timer') return { ...state, n: state.n + 1 };
    return state;
  },
  view: state => ({ content: 'n' + state.n, rows: [row(button('go', 'Go'), button('poke', 'Poke'))] }),
});`;

async function setup(options: { consult?: Consultant; clock?: Clock; directory?: string; probe?: boolean; pictures?: Pictures } = {}) {
  const directory = options.directory ?? await mkdtemp(join(tmpdir(), 'teapilot-play-'));
  if (!options.directory) cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const posts: MessagePayload[] = [];
  const edits: MessagePayload[] = [];
  const surface: PlaySurface = {
    post: vi.fn(async (_channel: string, payload: MessagePayload) => { posts.push(payload); return 'message-1'; }),
    edit: vi.fn(async (_channel: string, _message: string, payload: MessagePayload) => { edits.push(payload); }),
    request: vi.fn(async (method: string, route: string) => ({ echoed: `${method} ${route}` })),
  };
  const log = vi.fn();
  const store = new PlayStore(directory);
  const runtime = new PlayRuntime({ store, surface, log, consult: options.consult, clock: options.clock, probe: options.probe ?? false, pictures: options.pictures, discordEditMs: 0 });
  cleanups.push(() => runtime.close());
  return { directory, store, runtime, surface, posts, edits, log };
}

function act(playId: string, controlId: string, user = owner.id, extra: Partial<PlayInteraction> = {}) {
  const seen = { replies: [] as string[], followUps: [] as string[], updates: [] as MessagePayload[], modals: [] as unknown[], deferred: false };
  const interaction: PlayInteraction = {
    playId, controlId, kind: 'button', user: { id: user },
    openModal: async payload => { seen.modals.push(payload); },
    reply: async content => { seen.replies.push(content); },
    defer: async () => { seen.deferred = true; },
    update: async payload => { seen.updates.push(payload); },
    followUp: async content => { seen.followUps.push(content); },
    ...extra,
  };
  return { interaction, seen };
}
const start = (runtime: PlayRuntime, extra: { participants?: 'everyone' | 'invoker' | string[]; code?: string } = {}) =>
  runtime.start({ title: 'Counter', channelId: 'channel-1', conversation: 'dm:1', owner, source: { kind: 'sandbox', code: extra.code ?? counter }, participants: extra.participants });

it('posts the first view and edits it in place on each click', async () => {
  const { runtime, posts, store } = await setup();
  const { record, preview } = await start(runtime);
  expect(posts[0]!.content).toBe('0 ');
  expect(preview).toContain('[Add](add)');
  const { interaction, seen } = act(record.id, 'add', friend);
  await runtime.interact(interaction);
  expect(seen.deferred).toBe(true);
  expect(seen.updates[0]!.content).toBe('1 ');
  expect(store.all()[0]).toMatchObject({ state: { count: 1 }, messageId: 'message-1', status: 'running' });
});

it('keeps the controls to the chosen participants', async () => {
  const { runtime } = await setup();
  const { record } = await start(runtime, { participants: [owner.id, friend] });
  const outsider = act(record.id, 'add', stranger);
  await runtime.interact(outsider.interaction);
  expect(outsider.seen.replies[0]).toBe(`This app is for <@${owner.id}>, <@${friend}>.`);
  expect(outsider.seen.deferred).toBe(false);
  const mine = await start(runtime, { participants: 'invoker' });
  const other = act(mine.record.id, 'add', friend);
  await runtime.interact(other.interaction);
  expect(other.seen.replies[0]).toBe(`Only <@${owner.id}> can use this app.`);
});

it('runs simultaneous clicks one at a time', async () => {
  const { runtime, store } = await setup();
  const { record } = await start(runtime);
  const clicks = Array.from({ length: 5 }, () => act(record.id, 'add'));
  await Promise.all(clicks.map(click => runtime.interact(click.interaction)));
  expect(store.all()[0]!.state).toEqual({ count: 5, said: '' });
  // Views that a newer one overtakes before they are sent are skipped; every click is still answered.
  await vi.waitFor(() => expect(clicks.flatMap(click => click.seen.updates).at(-1)!.content).toBe('5 '));
  expect(clicks.every(click => click.seen.deferred)).toBe(true);
});

it('keeps browser state processing independent of a blocked Discord interaction edit', async () => {
  const { runtime, surface } = await setup();
  const { record } = await start(runtime);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const update = vi.fn(async () => { await blocked; });
  const click = act(record.id, 'add', owner.id, { update });
  try {
    await runtime.interact(click.interaction);
    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
    await runtime.browserPress(record.id, 'add', owner);
    await runtime.browserPress(record.id, 'add', owner);
    expect(runtime.state(record.id, 'dm:1')).toMatchObject({ count: 3 });
    expect(surface.edit).not.toHaveBeenCalled();
  } finally { release(); }
  await vi.waitFor(() => expect(surface.edit).toHaveBeenCalledOnce());
  expect(vi.mocked(surface.edit).mock.calls[0]![2].content).toBe('3 ');
});

it('coalesces pending views into the final disabled view even when Discord is blocked', async () => {
  const { runtime, surface } = await setup();
  const { record } = await start(runtime);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(surface.edit).mockImplementationOnce(async () => { await blocked; });
  try {
    await runtime.browserPress(record.id, 'add', owner);
    await runtime.browserPress(record.id, 'add', owner);
    await runtime.stop(record.id, 'dm:1', 'done');
    expect(surface.edit).toHaveBeenCalledTimes(1);
    expect((await runtime.browserView(record.id, owner)).status).toBe('finished');
  } finally { release(); }
  await vi.waitFor(() => expect(surface.edit).toHaveBeenCalledTimes(2));
  const final = vi.mocked(surface.edit).mock.calls[1]![2];
  expect(final.content).toBe('2 \n-# done');
  expect(final.components.flatMap(row => row.components).every(control => control.disabled)).toBe(true);
});

it('keeps private replies but skips unchanged Discord views', async () => {
  const { runtime, surface } = await setup();
  const { record } = await start(runtime);
  const hint = act(record.id, 'hint');
  await runtime.interact(hint.interaction);
  expect(hint.seen.followUps).toEqual(['psst']);
  expect(hint.seen.updates).toEqual([]);
  await runtime.browserPress(record.id, 'add', owner);
  await vi.waitFor(() => expect(surface.edit).toHaveBeenCalledOnce());
  await runtime.browserPress(record.id, 'hint', owner);
  await runtime.browserPress(record.id, 'hint', owner);
  expect(surface.edit).toHaveBeenCalledOnce();
});

it('retries an unchanged view after a failed delivery', async () => {
  const { runtime, surface, log } = await setup();
  const { record } = await start(runtime);
  vi.mocked(surface.edit).mockRejectedValueOnce(new Error('offline'));
  await runtime.browserPress(record.id, 'add', owner);
  await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining('offline')));
  await runtime.browserPress(record.id, 'hint', owner);
  await vi.waitFor(() => expect(surface.edit).toHaveBeenCalledTimes(2));
  expect(vi.mocked(surface.edit).mock.calls.map(call => call[2].content)).toEqual(['1 ', '1 ']);
});

it('drops a stale prepared image and sends only the latest state', async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const render = vi.fn(async (_conversation: string, spec: { name: string }) => ({ name: spec.name, data: Buffer.from('image') }));
  const { runtime, surface } = await setup({ pictures: { check() {}, render } });
  const { record } = await start(runtime, { code: `
    import { app, button, row, embed, picture } from '@teapilot/discord-play';
    export default app({ init: () => 0, update: s => s + 1,
      view: s => ({ content: String(s), embeds: [embed({ image: picture('board.png') })], rows: [row(button('add', 'add'))] }) });` });
  render.mockImplementationOnce(async (_conversation, spec) => { await blocked; return { name: spec.name, data: Buffer.from('old') }; });
  try {
    await runtime.browserPress(record.id, 'add', owner);
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(2));
    await runtime.browserPress(record.id, 'add', owner);
    await runtime.browserPress(record.id, 'add', owner);
    expect(runtime.state(record.id, 'dm:1')).toBe(3);
    expect(surface.edit).not.toHaveBeenCalled();
  } finally { release(); }
  await vi.waitFor(() => expect(surface.edit).toHaveBeenCalledOnce());
  expect(vi.mocked(surface.edit).mock.calls[0]![2]).toMatchObject({ content: '3', files: [{ data: Buffer.from('image') }] });
  expect(render).toHaveBeenCalledTimes(3); // Initial post, discarded frame, latest frame.
});

it('keeps pictures the message already shows instead of uploading them again', async () => {
  let bytes = 'board';
  const render = vi.fn(async (_conversation: string, spec: { name: string }) => ({ name: spec.name, data: Buffer.from(bytes) }));
  const { runtime, surface, edits } = await setup({ pictures: { check() {}, render } });
  let uploaded = 0;
  vi.mocked(surface.edit).mockImplementation(async (_channel, _message, payload) => {
    edits.push(payload);
    return [...(payload.keep ?? []).map(id => ({ id, name: 'board.png' })), ...(payload.files ?? []).map(file => ({ id: `a${++uploaded}`, name: file.name }))];
  });
  const { record } = await start(runtime, { code: `
    import { app, button, row, embed, picture } from '@teapilot/discord-play';
    export default app({ init: () => 0, update: s => s + 1,
      view: s => ({ content: String(s), embeds: [embed({ image: picture('board.png') })], rows: [row(button('add', 'add'))] }) });` });
  await runtime.browserPress(record.id, 'add', owner);
  await vi.waitFor(() => expect(edits).toHaveLength(1));
  await runtime.browserPress(record.id, 'add', owner);
  await vi.waitFor(() => expect(edits).toHaveLength(2));
  bytes = 'moved';
  await runtime.browserPress(record.id, 'add', owner);
  await vi.waitFor(() => expect(edits).toHaveLength(3));
  expect(edits.map(edit => ({ content: edit.content, files: edit.files?.map(file => file.data.toString()), keep: edit.keep })))
    .toEqual([{ content: '1', files: ['board'], keep: undefined }, { content: '2', files: [], keep: ['a1'] }, { content: '3', files: ['moved'], keep: undefined }]);
});

it('answers a click with its new view in one response', async () => {
  const { runtime } = await setup();
  const { record } = await start(runtime);
  const responses: MessagePayload[] = [];
  const click = act(record.id, 'add', owner.id, { respond: async payload => { responses.push(payload); } });
  await runtime.interact(click.interaction);
  await vi.waitFor(() => expect(responses.map(payload => payload.content)).toEqual(['1 ']));
  expect(click.seen.deferred).toBe(false);
  expect(click.seen.updates).toEqual([]);
  // A click that changes nothing on the message is still acknowledged.
  const hint = act(record.id, 'hint', owner.id, { respond: async payload => { responses.push(payload); } });
  await runtime.interact(hint.interaction);
  expect(hint.seen.followUps).toEqual(['psst']);
  expect(hint.seen.deferred).toBe(true);
  expect(responses).toHaveLength(1);
});

it('defers a click when its view cannot be sent in time, then edits', async () => {
  const { runtime, surface } = await setup();
  const { record } = await start(runtime);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(surface.edit).mockImplementationOnce(async () => { await blocked; });
  const respond = vi.fn(async () => {});
  const click = act(record.id, 'add', owner.id, { respond });
  try {
    await runtime.browserPress(record.id, 'add', owner);
    await vi.waitFor(() => expect(surface.edit).toHaveBeenCalledOnce());
    await runtime.interact(click.interaction);
    await vi.waitFor(() => expect(click.seen.deferred).toBe(true), { timeout: 3000 });
  } finally { release(); }
  await vi.waitFor(() => expect(click.seen.updates.map(payload => payload.content)).toEqual(['2 ']));
  expect(respond).not.toHaveBeenCalled();
});

it('does not deduplicate a return to the old view while a different edit is in flight', async () => {
  const { runtime, surface } = await setup();
  const { record } = await start(runtime);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(surface.edit).mockImplementationOnce(async () => { await blocked; });
  try {
    await runtime.browserPress(record.id, 'add', owner);
    await vi.waitFor(() => expect(surface.edit).toHaveBeenCalledOnce());
    await runtime.update(record.id, 'dm:1', undefined, true);
  } finally { release(); }
  await vi.waitFor(() => expect(surface.edit).toHaveBeenCalledTimes(2));
  expect(vi.mocked(surface.edit).mock.calls.map(call => call[2].content)).toEqual(['1 ', '0 ']);
});

it('retires the old message after its in-flight edit without sending its pending view to the new message', async () => {
  const { runtime, surface } = await setup();
  const { record } = await start(runtime);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(surface.edit).mockImplementationOnce(async () => { await blocked; });
  vi.mocked(surface.post).mockResolvedValueOnce('message-2');
  try {
    await runtime.browserPress(record.id, 'add', owner);
    await runtime.browserPress(record.id, 'add', owner);
    await runtime.resend(record.id, 'dm:1', { channelId: 'channel-1' });
    await runtime.browserPress(record.id, 'add', owner);
    await vi.waitFor(() => expect(vi.mocked(surface.edit).mock.calls.some(call => call[1] === 'message-2' && call[2].content === '3 ')).toBe(true));
  } finally { release(); }
  await vi.waitFor(() => expect(surface.edit).toHaveBeenCalledTimes(3));
  const old = vi.mocked(surface.edit).mock.calls.filter(call => call[1] === 'message-1');
  expect(old.map(call => call[2].content)).toEqual(['1 ', '-# This app moved to a newer message below.']);
});

it('changes nothing when the app throws, and tells only the person who clicked', async () => {
  const { runtime, store } = await setup();
  const { record } = await start(runtime);
  await runtime.interact(act(record.id, 'add').interaction);
  const boom = act(record.id, 'boom');
  await runtime.interact(boom.interaction);
  expect(boom.seen.updates).toEqual([]);
  expect(boom.seen.followUps[0]).toMatch(/nothing changed.*kaboom/s);
  const saved = store.all()[0]!;
  expect(saved.state).toEqual({ count: 1, said: '' });
  expect(saved.log.at(-1)).toMatchObject({ action: expect.stringContaining('boom'), error: expect.stringContaining('kaboom') });
});

it('refuses controls that are not in the current view', async () => {
  const { runtime } = await setup();
  const { record } = await start(runtime);
  const ghost = act(record.id, 'missing');
  await runtime.interact(ghost.interaction);
  expect(ghost.seen.replies).toEqual(['That control is no longer available.']);
  const unknown = act('nope', 'add');
  await runtime.interact(unknown.interaction);
  expect(unknown.seen.replies).toEqual(['This app has ended.']);
});

it('sends private notes to the person who acted', async () => {
  const { runtime } = await setup();
  const { record } = await start(runtime);
  const hint = act(record.id, 'hint', friend);
  await runtime.interact(hint.interaction);
  expect(hint.seen.followUps).toEqual(['psst']);
});

it('opens a form without running the app, then applies its submission', async () => {
  const { runtime } = await setup();
  const { record } = await start(runtime);
  const open = act(record.id, 'say');
  await runtime.interact(open.interaction);
  expect(open.seen.deferred).toBe(false);
  expect(open.seen.modals[0]).toMatchObject({ custom_id: `play:${record.id}:words`, title: 'Say' });
  const submit = act(record.id, 'words', owner.id, { kind: 'modal', fields: { word: 'hello' } });
  await runtime.interact(submit.interaction);
  expect(submit.seen.updates[0]!.content).toBe('0 hello');
  const stale = act(record.id, 'other-form', owner.id, { kind: 'modal', fields: {} });
  await runtime.interact(stale.interaction);
  expect(stale.seen.replies).toEqual(['That control is no longer available.']);
});

it('finishes with every control disabled and ignores later clicks', async () => {
  const { runtime, store } = await setup();
  const { record } = await start(runtime);
  const end = act(record.id, 'end');
  await runtime.interact(end.interaction);
  const final = end.seen.updates[0]!;
  expect(final.content).toBe('0 \n-# Final: 0');
  expect(final.components.flatMap(row => row.components).every(control => control.disabled === true)).toBe(true);
  expect(store.all()[0]).toMatchObject({ status: 'finished', note: 'Final: 0' });
  const late = act(record.id, 'add');
  await runtime.interact(late.interaction);
  expect(late.seen.replies).toEqual(['This app has ended.']);
});

it('fires timers, cancels them, and hibernates them across a restart', async () => {
  let clock = Date.now();
  const first = await setup({ clock: { ...systemClock, now: () => clock } });
  const { record } = await start(first.runtime);
  await first.runtime.interact(act(record.id, 'never').interaction);
  expect(first.store.all()[0]!.timers).toEqual([]);
  await first.runtime.interact(act(record.id, 'soon').interaction);
  expect(first.store.all()[0]!.timers).toEqual([{ id: 'tick', ms: 2000, dueAt: clock + 2000 }]);
  // Shutting down puts the wait away rather than spending it while nothing is running.
  first.runtime.close();
  expect(first.store.all()[0]!.timers).toEqual([{ id: 'tick', ms: 2000 }]);
  // A new process a minute later: the app comes back hibernating, so the overdue timer does not fire.
  clock += 60_000;
  const second = await setup({ clock: { ...systemClock, now: () => clock }, directory: first.directory });
  expect(await second.runtime.recover()).toBe(1);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(second.edits).toEqual([]);
  expect(second.store.all()[0]!.timers).toEqual([{ id: 'tick', ms: 2000 }]);
  // The first click starts it again, with the two seconds it was holding.
  const click = act(record.id, 'add');
  await second.runtime.interact(click.interaction);
  expect(click.seen.updates[0]!.content).toBe('1 ');
  expect(second.store.all()[0]!.timers).toEqual([{ id: 'tick', ms: 2000, dueAt: clock + 2000 }]);
});

it('runs a clock from init(), hibernates it after ten idle minutes, and starts it again at the next click', async () => {
  let now = 1_000_000;
  const due: Array<{ at: number; run: () => void }> = [];
  const clock: Clock = { now: () => now, after(ms, run) { const entry = { at: now + ms, run }; due.push(entry); return () => { if (due.includes(entry)) due.splice(due.indexOf(entry), 1); }; } };
  const advance = (ms: number) => { now += ms; for (const entry of due.filter(item => item.at <= now)) { due.splice(due.indexOf(entry), 1); entry.run(); } };
  const { runtime, store } = await setup({ clock });
  const { record } = await start(runtime, { code: ticker });

  // Posting counts as playing, so the clock runs straight away.
  expect(store.all()[0]!.timers).toEqual([{ id: 'tick', ms: 2000, dueAt: now + 2000 }]);
  advance(2000);
  await vi.waitFor(() => expect(store.all()[0]!.state).toMatchObject({ n: 1 }));

  // Ten minutes with nobody playing: it hibernates holding the two seconds it had left, and stops costing anything.
  advance(10 * 60_000);
  await vi.waitFor(() => expect(store.all()[0]!.timers).toEqual([{ id: 'tick', ms: 2000 }]));
  const ticked = store.all()[0]!.state as { n: number };
  expect(due).toHaveLength(0);
  advance(60 * 60_000);
  expect(store.all()[0]!.state).toMatchObject({ n: ticked.n });

  // The next click starts it again, from the click and not from where it stopped.
  await runtime.interact(act(record.id, 'poke').interaction);
  expect(store.all()[0]!.timers).toEqual([{ id: 'tick', ms: 2000, dueAt: now + 2000 }]);
  advance(2000);
  await vi.waitFor(() => expect(store.all()[0]!.state).toMatchObject({ n: ticked.n + 1 }));
});

it('keeps an app awake while it is being played', async () => {
  let now = 1_000_000;
  const due: Array<{ at: number; run: () => void }> = [];
  const clock: Clock = { now: () => now, after(ms, run) { const entry = { at: now + ms, run }; due.push(entry); return () => { if (due.includes(entry)) due.splice(due.indexOf(entry), 1); }; } };
  const advance = (ms: number) => { now += ms; for (const entry of due.filter(item => item.at <= now)) { due.splice(due.indexOf(entry), 1); entry.run(); } };
  const { runtime, store } = await setup({ clock });
  const { record } = await start(runtime, { code: slow });
  await runtime.interact(act(record.id, 'go').interaction);

  const due20 = store.all()[0]!.timers[0]!.dueAt;

  // A click every nine minutes never lets the ten run out, so the twenty minute clock is never put away.
  advance(9 * 60_000);
  await runtime.interact(act(record.id, 'poke').interaction);
  advance(9 * 60_000);
  await runtime.interact(act(record.id, 'poke').interaction);
  expect(store.all()[0]!.timers).toEqual([{ id: 'tick', ms: 20 * 60_000, dueAt: due20 }]);

  // So it comes due at the twenty minutes it asked for, and not later.
  advance(2 * 60_000);
  await vi.waitFor(() => expect(store.all()[0]!.state).toMatchObject({ n: 1 }));
});

it('keeps the wait a hibernating clock had left, instead of counting it against the clock', async () => {
  let now = 1_000_000;
  const due: Array<{ at: number; run: () => void }> = [];
  const clock: Clock = { now: () => now, after(ms, run) { const entry = { at: now + ms, run }; due.push(entry); return () => { if (due.includes(entry)) due.splice(due.indexOf(entry), 1); }; } };
  const advance = (ms: number) => { now += ms; for (const entry of due.filter(item => item.at <= now)) { due.splice(due.indexOf(entry), 1); entry.run(); } };
  const { runtime, store } = await setup({ clock });
  const hosted: MessagePayload[] = [];
  const post = vi.fn(async (payload: MessagePayload) => { hosted.push(payload); return { id: 'reply-1', edit: async (next: MessagePayload) => { hosted.push(next); } }; });
  const { record } = await runtime.start({ title: 'Slow', channelId: 'channel-1', conversation: 'reply:1', owner, source: { kind: 'sandbox', code: slow }, post });

  // A twenty minute clock, started by a click, outlives the ten minutes the app stays awake for.
  await runtime.interact(act(record.id, 'go').interaction);
  expect(store.all()[0]!.timers).toEqual([{ id: 'tick', ms: 20 * 60_000, dueAt: now + 20 * 60_000 }]);
  advance(10 * 60_000);
  // It hibernates there with ten minutes left, rather than waiting on an hour nobody is watching.
  await vi.waitFor(() => expect(store.all()[0]!.timers).toEqual([{ id: 'tick', ms: 10 * 60_000 }]));
  expect(due).toHaveLength(0);
  advance(60 * 60_000);
  expect(store.all()[0]!.state).toMatchObject({ n: 0 });

  // The next click hands back that hour, leaving the ten minutes the clock had left.
  await runtime.interact(act(record.id, 'poke').interaction);
  expect(store.all()[0]!.timers).toEqual([{ id: 'tick', ms: 10 * 60_000, dueAt: now + 10 * 60_000 }]);
  advance(10 * 60_000);
  await vi.waitFor(() => expect(store.all()[0]!.state).toMatchObject({ n: 1 }));
});

it('runs an app posted through an interaction, and holds its timers while it hibernates', async () => {
  let now = 1_000_000;
  const due: Array<{ at: number; run: () => void }> = [];
  const clock: Clock = { now: () => now, after(ms, run) { const entry = { at: now + ms, run }; due.push(entry); return () => { if (due.includes(entry)) due.splice(due.indexOf(entry), 1); }; } };
  const advance = (ms: number) => { now += ms; for (const entry of due.filter(item => item.at <= now)) { due.splice(due.indexOf(entry), 1); entry.run(); } };
  const { runtime, surface, store } = await setup({ clock });
  const hosted: MessagePayload[] = [];
  const post = vi.fn(async (payload: MessagePayload) => { hosted.push(payload); return { id: 'reply-1', edit: async (next: MessagePayload) => { hosted.push(next); } }; });
  const { record } = await runtime.start({ title: 'Counter', channelId: 'channel-1', conversation: 'reply:1', owner, source: { kind: 'sandbox', code: counter }, post });
  expect(hosted[0]!.content).toBe('0 ');
  expect(store.all()[0]).toMatchObject({ messageId: 'reply-1', viaInteraction: true });

  // While it is being played, a click's own interaction shows what its timer does.
  const first = act(record.id, 'soon');
  await runtime.interact(first.interaction);
  advance(2000);
  await vi.waitFor(() => expect(first.seen.updates.at(-1)?.content).toBe('100 '));

  // Nobody plays for ten minutes, so it hibernates; the interaction that could edit it expires soon after.
  advance(15 * 60_000);
  expect(first.seen.updates).toHaveLength(1); // Scheduling the timer did not change the view.
  expect((await runtime.update(record.id, 'reply:1', undefined, false)).preview).toContain('shows this change at the next click');

  // The next click brings a new interaction: its action shows, and the app runs again from there.
  const next = act(record.id, 'add');
  await runtime.interact(next.interaction);
  expect(next.seen.updates[0]!.content).toBe('101 ');
  const again = act(record.id, 'soon');
  await runtime.interact(again.interaction);
  advance(2000);
  await vi.waitFor(() => expect(again.seen.updates.at(-1)?.content).toBe('201 '));
  expect(surface.post).not.toHaveBeenCalled();
  expect(surface.edit).not.toHaveBeenCalled();
});

it('browser play wakes timers after Discord webhook expiry without renewing the webhook', async () => {
  let now = 1_000_000;
  const due: Array<{ at: number; run: () => void }> = [];
  const clock: Clock = { now: () => now, after(ms, run) { const entry = { at: now + ms, run }; due.push(entry); return () => { if (due.includes(entry)) due.splice(due.indexOf(entry), 1); }; } };
  const advance = (ms: number) => { now += ms; for (const entry of due.filter(item => item.at <= now)) { due.splice(due.indexOf(entry), 1); entry.run(); } };
  const { runtime, store } = await setup({ clock });
  const edit = vi.fn(async () => {});
  const { record } = await runtime.start({ title: 'counter', channelId: 'channel', conversation: 'reply:1', owner, source: { kind: 'sandbox', code: counter }, post: async () => ({ id: 'reply', edit }) });
  advance(15 * 60_000);
  const changed = vi.fn(); const unsubscribe = runtime.subscribe(changed);
  await runtime.browserPress(record.id, 'soon', owner);
  advance(2000);
  await vi.waitFor(() => expect(store.all()[0]!.state).toMatchObject({ count: 100 }));
  expect(changed).toHaveBeenCalledWith(record.id);
  expect(edit).not.toHaveBeenCalled();
  expect((await runtime.browserView(record.id, owner)).discordStale).toBe(true);
  unsubscribe();
});

it('resends a buried app with its state, points the old copy at it, and turns away clicks there', async () => {
  const { runtime, surface, posts, edits, store, log } = await setup();
  const { record } = await start(runtime);
  await runtime.interact(act(record.id, 'add').interaction);
  vi.mocked(surface.post).mockImplementationOnce(async (_channel, payload) => { posts.push(payload); return 'message-2'; });
  const { preview } = await runtime.resend(record.id, 'dm:1', { channelId: 'channel-1' });
  expect(preview).toContain('[Add](add)');
  expect(posts.at(-1)!.content).toBe('1 ');
  await vi.waitFor(() => expect(edits.at(-1)).toMatchObject({ content: '-# This app moved to a newer message below.', components: [] }));
  expect(store.all()[0]).toMatchObject({ id: record.id, messageId: 'message-2', state: { count: 1 } });
  expect(store.all()[0]!.log.at(-1)).toMatchObject({ action: 'resend' });
  expect(log).not.toHaveBeenCalled();

  const stale = act(record.id, 'add', owner.id, { messageId: 'message-1' });
  await runtime.interact(stale.interaction);
  expect(stale.seen.replies).toEqual(['This app moved to a newer message below.']);
  expect(store.all()[0]!.state).toMatchObject({ count: 1 });
  const fresh = act(record.id, 'add', owner.id, { messageId: 'message-2' });
  await runtime.interact(fresh.interaction);
  expect(fresh.seen.updates[0]!.content).toBe('2 ');
});

it('lets anyone in the channel resend an app, and resends a finished one with its controls disabled', async () => {
  const { runtime, posts } = await setup();
  const { record } = await start(runtime);
  await expect(runtime.resend(record.id, 'dm:2', { channelId: 'channel-9' })).rejects.toThrow('No app');
  await runtime.resend(record.id, 'dm:2', { channelId: 'channel-1' });
  await runtime.interact(act(record.id, 'end', owner.id, { messageId: 'message-1' }).interaction);
  await runtime.resend(record.id, 'dm:1', { channelId: 'channel-1' });
  expect(posts.at(-1)!.content).toBe('0 \n-# Final: 0');
  expect(posts.at(-1)!.components.flatMap(row => row.components).every(control => control.disabled === true)).toBe(true);
});

it('resends through a new interaction, which starts a hibernating app again', async () => {
  let now = 1_000_000;
  const due: Array<{ at: number; run: () => void }> = [];
  const clock: Clock = { now: () => now, after(ms, run) { const entry = { at: now + ms, run }; due.push(entry); return () => { if (due.includes(entry)) due.splice(due.indexOf(entry), 1); }; } };
  const advance = (ms: number) => { now += ms; for (const entry of due.filter(item => item.at <= now)) { due.splice(due.indexOf(entry), 1); entry.run(); } };
  const { runtime, store } = await setup({ clock });
  const hosted = (id: string, seen: MessagePayload[]) => vi.fn(async (payload: MessagePayload) => { seen.push(payload); return { id, edit: async (next: MessagePayload) => { seen.push(next); } }; });
  const first: MessagePayload[] = [], second: MessagePayload[] = [];
  const { record } = await runtime.start({ title: 'Slow', channelId: 'channel-1', conversation: 'reply:1', owner, source: { kind: 'sandbox', code: slow }, post: hosted('reply-1', first) });
  await runtime.interact(act(record.id, 'go').interaction);

  // It hibernates with ten of its twenty minutes left, and its message is out of reach by the time it is resent.
  advance(10 * 60_000);
  await vi.waitFor(() => expect(store.all()[0]!.timers).toEqual([{ id: 'tick', ms: 10 * 60_000 }]));
  advance(5 * 60_000);
  expect(store.all()[0]!.timers).toEqual([{ id: 'tick', ms: 10 * 60_000 }]);

  // The new message is somewhere to play again, so the clock picks up the ten minutes it was holding.
  await runtime.resend(record.id, 'reply:1', { channelId: 'channel-1', post: hosted('reply-2', second) });
  expect(store.all()[0]).toMatchObject({ messageId: 'reply-2', viaInteraction: true });
  expect(store.all()[0]!.timers).toEqual([{ id: 'tick', ms: 10 * 60_000, dueAt: now + 10 * 60_000 }]);
  advance(10 * 60_000);
  await vi.waitFor(() => expect(second.at(-1)?.content).toBe('n1'));
});

it('asks the model through consult and caps it', async () => {
  const consult = vi.fn<Consultant>(async (_play, prompt) => `answer to ${prompt}`);
  const { runtime, edits, log } = await setup({ consult });
  const { record } = await start(runtime);
  // A consult still running refuses the next one, so each click waits for the last answer to land first.
  const answered = () => log.mock.calls.filter(([line]) => String(line).includes('answered')).length;
  await runtime.interact(act(record.id, 'ask').interaction);
  await vi.waitFor(() => expect(edits.at(-1)?.content).toBe('0 answer to is 0 big?'));
  expect(consult).toHaveBeenCalledWith({ title: 'Counter', owner, channelId: 'channel-1', conversation: 'dm:1' }, 'is 0 big?');
  for (let index = 2; index <= 20; index++) {
    await runtime.interact(act(record.id, 'ask').interaction);
    await vi.waitFor(() => expect(answered()).toBe(index));
  }
  await runtime.interact(act(record.id, 'ask').interaction);
  await vi.waitFor(() => expect(edits.at(-1)?.content).toContain('used its 20 consults'));
  expect(consult).toHaveBeenCalledTimes(20);
});

it('scopes management to the conversation that started the app', async () => {
  const { runtime, edits } = await setup();
  const { record } = await start(runtime);
  expect(runtime.list('dm:1')).toEqual([{ id: record.id, title: 'Counter', status: 'running' }]);
  expect(runtime.list('dm:2')).toEqual([]);
  expect(() => runtime.inspect(record.id, 'dm:2')).toThrow(/No app/);
  expect(JSON.parse(runtime.inspect(record.id, 'dm:1'))).toMatchObject({ status: 'running', state: { count: 0 } });
  await runtime.stop(record.id, 'dm:1', 'Closed by the host.');
  expect(edits.at(-1)!.content).toBe('0 \n-# Closed by the host.');
});

it('swaps code in place and keeps state unless told to reset', async () => {
  const { runtime, edits } = await setup();
  const { record } = await start(runtime);
  await runtime.interact(act(record.id, 'add').interaction);
  const doubled = counter.replace("content: state.count + ' ' + state.said", "content: 'x' + state.count * 2");
  await runtime.update(record.id, 'dm:1', { kind: 'sandbox', code: doubled }, false);
  expect(edits.at(-1)!.content).toBe('x2');
  await runtime.update(record.id, 'dm:1', undefined, true);
  expect(edits.at(-1)!.content).toBe('x0');
});

it('fills in top-level state a new version adds in init, keeping the rest', async () => {
  const { runtime, edits } = await setup();
  const { record } = await start(runtime);
  await runtime.interact(act(record.id, 'add').interaction);
  // The new version keeps a list of scores that the running state never had.
  const scored = counter.replace("init: () => ({ count: 0, said: '' })", "init: () => ({ count: 0, said: '', scores: [] })")
    .replace("content: state.count + ' ' + state.said", "content: state.count + ' scores ' + state.scores.length");
  const { preview } = await runtime.update(record.id, 'dm:1', { kind: 'sandbox', code: scored }, false);
  expect(edits.at(-1)!.content).toBe('1 scores 0');
  expect(preview).toContain('Note: The kept state gained scores from the new init()');
});

it('dry-runs new top-level defaults while preserving existing live state', async () => {
  const { runtime } = await setup();
  const code = counter.replace("count: 0, said: ''", "count: 99, said: '', scores: { best: 9 }")
    .replace("state.count + ' ' + state.said", "state.count + ' ' + state.scores.best");
  const kept = { count: 5, said: '' };
  const preview = await runtime.test({ kind: 'sandbox', code }, [{ kind: 'button', id: 'add' }], owner, { state: kept });
  expect(preview).toContain('6 9');
  expect(preview).toContain('"scores":{"best":9}');
  expect(kept).toEqual({ count: 5, said: '' });
});

it('refuses a broken app before posting anything', async () => {
  const { runtime, posts } = await setup();
  await expect(start(runtime, { code: counter.replace("content: state.count + ' ' + state.said", "content: 5") })).rejects.toThrow(/Message content must be a string/);
  await expect(start(runtime, { code: 'export default {' })).rejects.toThrow();
  expect(posts).toEqual([]);
});

it('accepts views in shapes whose meaning is clear, and drops empty rows', async () => {
  const { runtime, posts } = await setup();
  const loose = counter.replace(/view: state => \(\{[\s\S]*\}\),\n\}\);/, "view: state => [embed({ title: 'n' + state.count }), [button('add', 'Add')], row(), button('end', 'End')],\n});").replace('finish, modal', 'finish, modal, embed');
  const { record } = await start(runtime, { code: loose });
  expect(posts[0]!.embeds).toHaveLength(1);
  expect(posts[0]!.components.map(row => row.components.length)).toEqual([1, 1]);
  await runtime.interact(act(record.id, 'add').interaction);
  expect(runtime.inspect(record.id, 'dm:1')).toContain('"count":1');
});

it('tries every control, and what it sets off, before posting or replacing an app', async () => {
  const { runtime, posts } = await setup({ probe: true });
  await expect(start(runtime)).rejects.toThrow(/using \[Boom\]: update\(\) threw: Error: kaboom/);
  const late = counter.replace("return { ...state, count: state.count + 100 }", "throw new Error('late')");
  await expect(start(runtime, { code: late.replace("button('boom', 'Boom'), ", '') })).rejects.toThrow(/using \[Soon\], then timer tick: .*late/);
  const trusting = counter.replace("said: action.text ?? 'error: ' + action.error", "said: JSON.parse(action.text).word");
  await expect(start(runtime, { code: trusting.replace("button('boom', 'Boom'), ", '') })).rejects.toThrow(/using \[Ask\], then an answer to consult judge: .*SyntaxError/);
  expect(posts).toEqual([]);
  const { record, preview } = await start(runtime, { code: counter.replace("button('boom', 'Boom'), ", '') });
  expect(preview).toContain('Note: using [End] calls finish(), which ends the app and disables [Add], [Hint]');
  expect(preview).not.toContain('nothing will move on its own');
  const still = counter.replace("button('boom', 'Boom'), ", '').replace("button('soon', 'Soon'), button('never', 'Never')", "button('hint2', 'Hint 2')");
  expect((await start(runtime, { code: still })).preview).toContain('Note: The code handles timers, but no timer is pending');
  // Timer handling written without after() at all is still noticed, since its code is never tried.
  const handled = still.replace(/after\(/g, 'later(');
  expect((await start(runtime, { code: handled })).preview).toContain('Note: The code handles timers');
  const whisper = counter.replace("button('boom', 'Boom'), ", '').replace("return { ...state, count: state.count + 100 }", "return step(state, ephemeral('tick'))");
  expect((await start(runtime, { code: whisper })).preview).toContain('Note: using [Soon], then timer tick returns ephemeral(), but no one pressed anything');
  await expect(runtime.update(record.id, 'dm:1', { kind: 'sandbox', code: counter }, false)).rejects.toThrow(/kaboom/);
  expect(posts).toHaveLength(4);
});

it('notes controls that change nothing and :shortcodes: that Discord would show as text', async () => {
  const { runtime } = await setup({ probe: true });
  // Controls that ignore whoever presses them first, such as a game nobody can join.
  const inert = counter.replace(/row\(button\('ask'.*\),\n/, '').replace("button('add', 'Add'), button('boom', 'Boom'), button('hint', 'Hint'), button('soon', 'Soon'), button('never', 'Never')", "button('left', 'Left'), button('right', 'Right')");
  expect((await start(runtime, { code: inert })).preview).toContain('Note: Using [Left], [Right] changed nothing');
  const coded = counter.replace("button('boom', 'Boom'), ", '').replace("content: state.count + ' ' + state.said", "content: ':man_fairy: <:tea:123456789012345678> 12:30:00 ' + state.count");
  const { preview: shown } = await start(runtime, { code: coded });
  expect(shown).toContain('Note: The view shows :man_fairy: as plain text');
  expect(shown).toMatch(/Note: The view shows :man_fairy: as plain text: /);
  expect(shown).not.toContain('inside a code block');
  // Server emoji inside backticks reach Discord as their raw text.
  const boxed = counter.replace("button('boom', 'Boom'), ", '').replace("content: state.count + ' ' + state.said", "content: '```\\n⬜<:tea:123456789012345678>\\n``` `<a:wave:726396997648515153>` ' + state.count");
  expect((await start(runtime, { code: boxed })).preview).toContain('Note: The view puts <:tea:123456789012345678> <a:wave:726396997648515153> inside a code block or inline code');
});

it('turns away an app no one can do anything with', async () => {
  const { runtime, posts } = await setup({ probe: true });
  // A turn-based game waiting for a current player that only a button could have chosen.
  const stuck = `import { app } from '@teapilot/discord-play';
export default app({ init: () => ({ current: null }), update: state => state, view: () => ({ content: 'Waiting for a player to act...' }) });`;
  await expect(start(runtime, { code: stuck })).rejects.toThrow(/its view has no controls, and no timer or consult is on its way/);
  // Controls written where nothing reads them are named.
  const misplaced = `import { app, button } from '@teapilot/discord-play';
export default app({ init: () => ({}), update: state => state, view: () => ({ content: 'board', controls: [button('left', 'Left')] }), controls: [button('right', 'Right')] });`;
  await expect(start(runtime, { code: misplaced })).rejects.toThrow(/It ignores `controls`: a view is .* Controls go in view\(\)'s rows, not on app\(\)\./);
  expect(posts).toEqual([]);
});

it('notes timers that nothing tried from the current state schedules', async () => {
  const { runtime } = await setup({ probe: true });
  // A morning timer only the start button schedules, in an app that is already past its start.
  const code = `import { app, button, row, step, after } from '@teapilot/discord-play';
export default app({
  init: () => ({ n: 0, started: true }),
  update(state, action) {
    if (action.kind === 'button' && action.id === 'start') return step(state, after(2000, 'tick'), after(60000, 'morning'));
    if (action.kind === 'button') return step({ ...state, n: state.n + 1 }, after(2000, 'tick'));
    if (action.kind === 'timer' && action.id === 'tick') return step(state, after(2000, 'tick'));
    return state;
  },
  view: state => ({ content: String(state.n), rows: [row(state.started ? button('go', 'Go') : button('start', 'Start'))] }),
});`;
  const { record, preview } = await start(runtime, { code });
  expect(preview).toContain('Nothing tried from the current state schedules after(…, "morning")');
  expect(preview).not.toContain('"tick"');
  // Once an app runs, init() never runs again, so an update can start the timer itself.
  expect((await runtime.update(record.id, 'dm:1', undefined, false)).preview).toContain('call play_update with timers: [{ id: "morning", ms: 2000 }]');
  const { preview: kicked } = await runtime.update(record.id, 'dm:1', undefined, false, [{ id: 'morning', ms: 60_000 }]);
  expect(kicked).not.toContain('Nothing tried');
  expect(runtime.inspect(record.id, 'dm:1')).toContain('"id":"morning"');
  await expect(runtime.update(record.id, 'dm:1', undefined, false, [{ id: 'fast', ms: 10 }])).rejects.toThrow(/after\(\) takes 2000 ms/);
});

it('dry-runs an app with scripted actions', async () => {
  const { runtime, posts } = await setup();
  const transcript = await runtime.test({ kind: 'sandbox', code: counter }, [{ kind: 'button', id: 'add' }, { kind: 'button', id: 'soon' }, { kind: 'button', id: 'boom' }, { kind: 'button', id: 'add' }], owner, { steps: true });
  expect(transcript).toContain('## 1. button add\nstate: {"count":1,"said":""}');
  expect(transcript).toContain('effects: [{"type":"after","id":"tick","ms":2000}]');
  expect(transcript).toMatch(/## 3\. button boom\nerror: .*kaboom/);
  expect(transcript).not.toContain('## 4.');
  expect(posts).toEqual([]);
  // Actions that change nothing are counted, since the final state alone hides them.
  const idle = await runtime.test({ kind: 'sandbox', code: counter }, [{ kind: 'button', id: 'add' }, { kind: 'button', id: 'say' }, { kind: 'button', id: 'say' }], owner);
  expect(idle).toContain('(final of 3 actions; 2 of 3 actions changed nothing;');
  // A control the view does not show is skipped and named, so a wrong id is not mistaken for an app that ignores it.
  const wrong = await runtime.test({ kind: 'sandbox', code: counter }, [{ kind: 'button', id: 'open' }, { kind: 'button', id: 'add' }], owner);
  expect(wrong).toContain('Skipped, no such control on screen at that point: 1. button open (on screen: add, boom, hint, soon, never, ask, end, say).');
  expect(wrong).toContain('state: {"count":1,"said":""}');
  // A running app's state, so a dry run of an update shows what its players will get.
  const resumed = await runtime.test({ kind: 'sandbox', code: counter }, [{ kind: 'button', id: 'add' }], owner, { state: { count: 5, said: '' }, steps: true });
  expect(resumed).toContain('## current state\nstate: {"count":5,"said":""}');
  expect(resumed).toContain('## 1. button add\nstate: {"count":6,"said":""}');
});

it('runs a trusted app as Node with Discord calls through the host, and pauses it when the file changes', async () => {
  const { runtime, surface, directory } = await setup();
  const file = join(directory, 'trusted-app.ts');
  await writeFile(file, `import { app, button, row } from '@teapilot/discord-play';
import { platform } from 'node:os';
export default app({
  init: () => ({ os: platform(), echo: '' }),
  async update(state: { os: string; echo: string }, _action, ctx) { return { ...state, echo: JSON.stringify(await ctx.discord!.request('GET', '/users/@me')) }; },
  view: (state: { os: string; echo: string }) => ({ content: state.os + ' ' + state.echo, rows: [row(button('go', 'Go'))] }),
});`);
  const { record } = await runtime.start({ title: 'Trusted', channelId: 'channel-1', conversation: 'dm:1', owner, source: { kind: 'trusted', path: file, sha256: await hashFile(file) } });
  const click = act(record.id, 'go');
  await runtime.interact(click.interaction);
  expect(click.seen.updates[0]!.content).toBe(`${process.platform} {"echoed":"GET /users/@me"}`);
  expect(surface.request).toHaveBeenCalledWith('GET', '/users/@me', undefined);
  runtime.close();

  await writeFile(file, 'export default {};');
  const restarted = await setup({ directory });
  expect(await restarted.runtime.recover()).toBe(0);
  expect(restarted.store.all()[0]).toMatchObject({ status: 'paused', note: expect.stringContaining('file changed') });
  expect(restarted.edits.at(-1)!.components.flatMap(row => row.components).every(control => control.disabled)).toBe(true);
  const blocked = act(record.id, 'go');
  await restarted.runtime.interact(blocked.interaction);
  expect(blocked.seen.replies[0]).toMatch(/paused/);
}, 30_000);
