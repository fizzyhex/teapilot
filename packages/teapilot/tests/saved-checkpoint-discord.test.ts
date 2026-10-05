import { afterEach, expect, it, vi } from 'vitest';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { serveDiscord } from '../src/discord/index.js';
import { CheckpointStore } from '../src/workspace/checkpoint.js';
import { channelId, people, World } from '../scripts/discord-sim/world.js';
import { completion, fixture, jev, mockServer } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it.each(['resume', 'redirect', 'finish'] as const)('saved %s controls and direction forms work after Discord service restart', async action => {
  const f = await fixture(); cleanups.push(f.cleanup);
  let calls = 0, messages = '';
  const provider = await mockServer((body, req, res) => {
    if (req.url === '/jev') jev(res, 'ask.normal');
    else if (req.url?.endsWith('/models')) res.end('{}');
    else { calls++; messages = JSON.stringify(body.messages); completion(res, { text: 'remaining work reviewed' }); }
  }); cleanups.push(provider.close);
  f.config.router.endpoint = `${provider.url}/jev`;
  for (const model of [f.config.models.fast, f.config.models.capable]) model.baseUrl = `${provider.url}/v1`;
  const world = new World();
  const store = new CheckpointStore(f.config.stateDir);
  const settings = { token: 'simulated', allowedUserIds: [people.op.id], channelIds: [channelId], root: f.cwd, startMode: 'ask' as const };
  const start = () => {
    const controller = new AbortController();
    const done = serveDiscord({ config: f.config, settings, log: world.log, signal: controller.signal, connect: world.connect, stateDir: join(f.cwd, 'discord'), teachat: false });
    return { stop: async () => { controller.abort(); await done; } };
  };
  let service = start(); cleanups.push(() => service.stop());
  await vi.waitFor(() => expect(world.connected).toBe(true));
  await world.slash('op', '/checkpoint list');
  const channel = world.channel('dm-op');
  const saved = store.save({ version: 1, requestId: 'old', checkpointId: 1, sequence: 1, reason: 'request_calls', durability: 'request-local', expiresAt: 0,
    summary: ['partial work'], snapshot: { amendments: [], artifacts: [], checks: [], results: [], workers: [], resources: { requestCallsRemaining: 0 }, pendingUncertain: ['inspect current files'] } },
  { root: await realpath(f.cwd), scope: `dm:${channel.id}`, channel: channel.id, owner: people.op.id, prompt: 'review remaining work', workload: 'ask' });
  await world.transport(channel).savedCheckpoint!('saved · resume authorizes a new execution', saved.id);
  const card = world.messages.at(-1)!;
  expect(card.components[0]!.components.map(item => item.label)).toEqual(['Resume', 'Change direction', 'Finish']);
  await service.stop(); service = start();
  await vi.waitFor(() => expect(world.connected).toBe(true));
  expect(await world.slash('op', '/checkpoint list')).toContain(saved.id);
  expect(calls).toBe(0);
  expect(await world.click('stranger', card.id, 'resume')).toContain('not authorised');
  if (action === 'redirect') {
    expect(await world.click('op', card.id, action)).toContain('what should change?');
    expect(await world.submit('op', { amendment: 'only review the parser' })).toContain('new execution authorized');
  } else expect(await world.click('op', card.id, action)).toContain(action === 'finish' ? 'no new execution' : 'new execution authorized');
  await vi.waitFor(() => expect(store.read(saved.id).status).toBe(action === 'finish' ? 'finished' : 'resumed'));
  if (action !== 'finish') {
    await vi.waitFor(() => expect(world.screen('dm-op')).toContain('remaining work reviewed'));
    expect(calls).toBe(1);
    expect(messages).toContain('inspect current files');
    if (action === 'redirect') expect(messages).toContain('only review the parser');
  } else expect(calls).toBe(0);
  expect(await world.click('op', card.id, 'resume')).toContain('already handled');
  expect(world.logs.filter(line => line.startsWith('⚠'))).toEqual([]);
}, 30_000);
