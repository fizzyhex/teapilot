import { afterEach, expect, it, vi } from 'vitest';
import { InteractionFeed, type FeedLink } from '../src/discord/feed.js';

afterEach(() => { vi.useRealTimers(); });

it('reposts the latest paused card repeatedly and sends later updates to the new copy', async () => {
  vi.useFakeTimers();
  const messages = new Map<string, string>();
  const sent: string[] = [];
  const cards: string[] = [];
  const feed = new InteractionFeed(webhook('first', 1000, messages, sent), { log: () => undefined, onCard: id => cards.push(id) });
  const original = await feed.showCard('working', 'paused');
  await vi.advanceTimersByTimeAsync(1000);
  await feed.showCard('latest work', 'latest paused', original);
  await feed.resend(webhook('click', 1000, messages, sent), 'moved');
  const fresh = cards.at(-1)!;
  expect(messages.get(original)).toBe('moved');
  expect(messages.get(fresh)).toBe('latest work');
  await feed.showCard('done', undefined, original);
  expect(messages.get(fresh)).toBe('done');
  await feed.resend(webhook('again', 1000, messages, sent), 'moved');
  const newest = cards.at(-1)!;
  await feed.showCard('final', undefined, original);
  expect(messages.get(fresh)).toBe('moved');
  expect(messages.get(newest)).toBe('final');
  expect(messages.get(original)).toBe('moved');
});

/** A webhook that records what reached Discord, and refuses everything once it has expired. */
function webhook(name: string, lifetimeMs: number, messages: Map<string, string>, sent: string[]): FeedLink<string> {
  const expires = Date.now() + lifetimeMs;
  let next = 0;
  const live = () => { if (Date.now() > expires) throw new Error('expired'); };
  return {
    expires,
    async post(text) { live(); const id = `${name}-${++next}`; messages.set(id, text); sent.push(text); return id; },
    async revise(id, text) { live(); messages.set(id, text); },
  };
}

it('pauses a running card before its interaction expires, holds what the turn sends, and delivers it on resume', async () => {
  vi.useFakeTimers();
  const messages = new Map<string, string>();
  const sent: string[] = [];
  const logs: string[] = [];
  const cards: string[] = [];
  const feed = new InteractionFeed(webhook('first', 60_000, messages, sent), { log: text => logs.push(text), onCard: id => cards.push(id) });

  const card = await feed.showCard('working', 'working (paused)');
  expect(messages.get(card)).toBe('working');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(messages.get(card)).toBe('working (paused)');
  expect(feed.live).toBe(false);
  expect(logs.join('\n')).toMatch(/paused the status card/);

  // The turn carries on: its card changes and its answer arrive while nothing can reach Discord.
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  await feed.showCard('still working', 'still working (paused)', card);
  const answer = await feed.post('the answer');
  await feed.revise(answer, 'the final answer');
  await feed.showCard('done', undefined, card);
  expect(messages.get(card)).toBe('working (paused)');
  expect(sent).toEqual(['working']);

  await feed.resume(webhook('click', 60_000, messages, sent));
  expect(sent).toEqual(['working', 'the final answer']);
  expect(messages.get(card)).toBe('done');
  expect(feed.live).toBe(true);
  expect(new Set(cards)).toEqual(new Set([card]));
  // A finished turn's card is left alone when the new interaction runs out too.
  await vi.advanceTimersByTimeAsync(60_000);
  expect(messages.get(card)).toBe('done');
});

it('restores the card on resume and pauses again when the new interaction runs out', async () => {
  vi.useFakeTimers();
  const messages = new Map<string, string>();
  const feed = new InteractionFeed(webhook('first', 1000, messages, []), { log: () => undefined });
  const card = await feed.showCard('working', 'paused');
  await vi.advanceTimersByTimeAsync(1000);
  await feed.resume(webhook('click', 1000, messages, []));
  expect(messages.get(card)).toBe('working');
  await vi.advanceTimersByTimeAsync(1000);
  expect(messages.get(card)).toBe('paused');
});

it('says so when a turn without a status card sends after its interaction expired', async () => {
  vi.useFakeTimers();
  const logs: string[] = [];
  const feed = new InteractionFeed(webhook('first', 1000, new Map(), []), { log: text => logs.push(text) });
  await vi.advanceTimersByTimeAsync(1000);
  await feed.post('late');
  await feed.post('later');
  expect(logs).toHaveLength(1);
  expect(logs[0]).toMatch(/will not be shown/);
});
