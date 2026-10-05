import { describe, expect, it, vi } from 'vitest';
import { route, type IncomingMessage } from '../src/discord/access.js';
import { quoteMessage, StatusCard, throttle } from '../src/discord/render.js';
import { readDiscordSettings } from '../src/discord/settings.js';

const alice = '111111111111111111', mallory = '222222222222222222', channel = '333333333333333333', guild = '444444444444444444';
const settings = { allowedUserIds: [alice], channelIds: ['888888888888888888', channel] };
const message = (fields: Partial<IncomingMessage>): IncomingMessage => ({ authorId: alice, authorIsBot: false, channelId: '555555555555555555', ownThread: false, mentionsBot: false, ...fields });

it('routes allowlisted DMs, owned threads and channel mentions, and ignores everything else', () => {
  expect(route(message({}), settings)).toEqual({ key: 'dm:555555555555555555', kind: 'dm' });
  expect(route(message({ authorId: mallory }), settings)).toBeUndefined();
  expect(route(message({ authorIsBot: true }), settings)).toBeUndefined();
  expect(route(message({ guildId: guild, channelId: channel }), settings)).toBeUndefined();
  expect(route(message({ guildId: guild, channelId: channel, mentionsBot: true }), settings)).toEqual({ key: '', kind: 'new-thread' });
  expect(route(message({ guildId: guild, channelId: '666666666666666666', mentionsBot: true }), settings)).toBeUndefined();
  expect(route(message({ guildId: guild, channelId: '777777777777777777', parentId: channel, ownThread: true }), settings)).toEqual({ key: 'thread:777777777777777777', kind: 'thread' });
  expect(route(message({ guildId: guild, channelId: '777777777777777777', parentId: channel, ownThread: false }), settings)).toBeUndefined();
  expect(route(message({ guildId: guild, channelId: channel, mentionsBot: true }), { allowedUserIds: [alice], channelIds: [] })).toBeUndefined();
});

it('fails closed without a token, root or allowlist and rejects malformed IDs', () => {
  const env = { DISCORD_BOT_TOKEN: 'token', DISCORD_ALLOWED_USER_IDS: alice, DISCORD_ROOT: '/repo' };
  expect(readDiscordSettings(env)).toMatchObject({ allowedUserIds: [alice], startMode: 'ask', channelIds: [] });
  expect(readDiscordSettings({ ...env, DISCORD_CHANNEL_IDS: `${channel},${guild}` }).channelIds).toEqual([channel, guild]);
  // Profiles saved before multiple channels keep working.
  expect(readDiscordSettings({ ...env, DISCORD_CHANNEL_ID: channel }).channelIds).toEqual([channel]);
  expect(() => readDiscordSettings({ ...env, DISCORD_CHANNEL_IDS: `${channel},general` })).toThrow(/channelIds/);
  expect(() => readDiscordSettings({ ...env, DISCORD_ALLOWED_USER_IDS: '' })).toThrow(/teapilot discord setup/);
  expect(() => readDiscordSettings({ ...env, DISCORD_ALLOWED_USER_IDS: 'alice' })).toThrow(/allowedUserIds/);
  expect(() => readDiscordSettings({ ...env, DISCORD_START_MODE: 'code' })).toThrow(/startMode/);
});

it('folds a turn into one redacted status card with its latest steps', () => {
  let now = 0;
  const card = new StatusCard(text => text.replace('secret', '[REDACTED]'), { now: () => now, maxSteps: 2 });
  expect(card.push({ type: 'attempt_start' })).toBe(false);
  expect(card.render()).toBe('🫖 thinking. · 0s');
  card.push({ type: 'tool_execution_start', tool: 'read', path: 'a.ts' });
  card.tick(); now = 65_000;
  expect(card.render()).toBe('⚙️ running read a.ts.. · 1m 05s');
  card.push({ type: 'tool_execution_end', tool: 'read', path: 'a.ts' });
  card.push({ type: 'tool_execution_end', tool: 'bash', command: 'echo secret' });
  card.push({ type: 'tool_execution_end', tool: 'write', path: 'b_c.ts', size: 10, isError: true });
  card.reason('a'.repeat(300) + ' the <think>last</think> **thought**');
  expect(card.render()).toBe(`🫖 thinking.. · 1m 05s\n-# … 1 earlier\n-# shell: echo \\[REDACTED\\]\n-# write b\\_c.ts (10 B) — failed\n-# 💭 …${'a'.repeat(139)} the last \\*\\*thought\\*\\*`);
  expect(card.summary({ status: 'completed', spentUsd: 0.25, requestId: 'r1' })).toBe('-# Result: completed · 3 steps · 1m 05s');
  // The turn's clock stops with it.
  now = 200_000;
  expect(card.details('completed').text).toMatch(/^\*\*Turn details\*\* · completed · 3 steps · 1m 05s\n/);
  expect(card.details('completed').text).toContain('accounted $0.250000\nrequest r1');
});

it('shows a quiet stop and keeps forensic details, including no-step requests', () => {
  const card = new StatusCard(text => text, { now: () => 0 });
  expect(card.summary({ status: 'cancelled', spentUsd: 0.000181, requestId: 'full-request-id', interruption: {
    reason: 'cancelled', edits: [{ path: 'file.md', size: 2048 }], shellRan: false,
  } })).toBe('-# stopped · 0 steps · 0s');
  expect(card.details('cancelled').text).toContain('accounted $0.000181\nrequest full-request-id\nedited `file.md` (2 KB)\nchecks: not run after latest recorded edit');
});

it('keeps cost, full request id and edit details when the log becomes an attachment', () => {
  const card = new StatusCard(text => text.replaceAll('secret', '[REDACTED]'), { now: () => 0 });
  card.reason('x'.repeat(3000));
  card.summary({ status: 'cancelled', spentUsd: 0.000181, requestId: 'full-request-id', interruption: {
    reason: 'cancelled', edits: [{ path: 'secret.md', size: 2048 }], shellRan: false,
  } });
  const details = card.details('cancelled');
  expect(details.file?.content).toContain('accounted $0.000181\nrequest full-request-id\nedited `[REDACTED].md` (2 KB)');
  expect(details.file?.content).not.toContain('secret');
});

it('escapes a preview that would start a list, and clears it when the message ends', () => {
  const card = new StatusCard(text => text);
  card.push({ type: 'text', text: '- first\n2. second' });
  expect(card.render()).toBe('✍️ writing. · 0s\n-# \\- first 2. second');
  card.push({ type: 'message_end' });
  expect(card.render()).toBe('🫖 thinking. · 0s');
});

it('attaches the whole log when Details would not fit in one message', () => {
  const card = new StatusCard(text => text);
  card.reason('x'.repeat(3000));
  card.push({ type: 'tool_execution_end', tool: 'read', path: 'a.ts' });
  const details = card.details('completed');
  expect(details.text).toBe('**Turn details** · completed · 1 step · 0s\nThe full log is attached.');
  expect(details.file?.name).toBe('turn-details.md');
  expect(details.file?.content).toBe(`completed · 1 step · 0s\n\n${'x'.repeat(3000)}\n\n- read a.ts\n`);});

it('shows a compaction while it runs, then lists it among the steps without counting it as one', () => {
  const card = new StatusCard(text => text);
  card.push({ type: 'tool_execution_end', tool: 'read', path: 'scene.py' });
  expect(card.push({ type: 'compaction_start', trigger: 'context' })).toBe(true);
  expect(card.render()).toBe('🗜️ compacting earlier context. · 0s\n-# read scene.py');
  card.push({ type: 'compaction', trigger: 'context', tokensBefore: 14948, ms: 36_200 });
  card.push({ type: 'compaction_failed', trigger: 'history', ms: 400 });
  expect(card.render()).toBe('🫖 thinking. · 0s\n-# read scene.py\n-# compacted earlier context (14.9k tokens) into a summary in 36s\n-# compacting earlier turns failed in 1s; carrying on without it');
  expect(card.details('completed').text).toBe('**Turn details** · completed · 1 step · 0s\n- read scene.py\n- compacted earlier context (14.9k tokens) into a summary in 36s\n- compacting earlier turns failed in 1s; carrying on without it');
});

it('coalesces frequent progress updates and delivers the latest on flush', async () => {
  const action = vi.fn(async () => undefined);
  const update = throttle(action, 10_000);
  update.request(); update.request(); update.request();
  await vi.waitFor(() => expect(action).toHaveBeenCalledTimes(1));
  update.request(); update.request();
  expect(action).toHaveBeenCalledTimes(1);
  await update.flush();
  expect(action).toHaveBeenCalledTimes(2);
});

it('quotes a selected message after the reply chain it answers, oldest first', () => {
  expect(quoteMessage({ author: 'bob', text: 'why?' })).toBe('Message from @bob:\nwhy?');
  expect(quoteMessage({ author: 'bob', text: 'why?' }, { messages: [{ author: 'alice', text: 'ship it' }, { author: 'carol', text: '' }], truncated: false }))
    .toBe('Reply chain, oldest first:\n@alice: ship it\n\n@carol: (no text)\n\nMessage from @bob:\nwhy?');
});

it('notes when the reply chain goes back further than could be fetched', () => {
  const partial = quoteMessage({ author: 'bob', text: 'why?' }, { messages: [{ author: 'alice', text: 'ship it' }], truncated: true });
  expect(partial).toMatch(/^Reply chain, oldest first:\nNote: .*could fetch.*\n\n@alice: ship it\n\nMessage from @bob:\nwhy\?$/);
  expect(quoteMessage({ author: 'bob', text: 'why?' }, { messages: [], truncated: true })).toMatch(/^Reply chain, oldest first:\nNote: .*\n\nMessage from @bob:\nwhy\?$/);
});

it('keeps a multi-line command on one small-text line', () => {
  const card = new StatusCard(text => text);
  card.push({ type: 'tool_execution_end', tool: 'bash', command: 'python -c "\nimport sys\nprint(1)\n"' });
  expect(card.render()).toBe('🫖 thinking. · 0s\n-# shell: python -c " import sys print(1) "');
});

it('lists a tip among the steps as a light bulb and its name', () => {
  const card = new StatusCard(text => text);
  card.push({ type: 'tool_execution_end', tool: 'write', path: 'bot.py' });
  expect(card.push({ type: 'tip', name: 'useJavascript' })).toBe(true);
  expect(card.render()).toBe('🫖 thinking. · 0s\n-# write bot.py\n-# 💡 useJavascript');
});

describe('status card tasks', () => {
  it('lists delegated tasks while they are in progress, and drops them once settled', () => {
    const card = new StatusCard(text => text, { now: () => 0 });
    expect(card.push({ type: 'task', id: 't1', label: 'level data', junior: 'junior-alfa', state: 'running' })).toBe(true);
    card.push({ type: 'task', id: 't2', label: 'controls', junior: 'junior-bravo', state: 'blocked' });
    expect(card.render()).toContain('-# ♟️ t1 level data · junior-alfa · running');
    expect(card.render()).toContain('-# ⛔ t2 controls · junior-bravo · blocked');
    card.push({ type: 'task', id: 't1', label: 'level data', junior: 'junior-alfa', state: 'awaiting_verification' });
    expect(card.render()).toContain('-# 🔎 t1 level data · junior-alfa · awaiting verification');
    card.push({ type: 'task', id: 't1', label: 'level data', junior: 'junior-alfa', state: 'verified' });
    card.push({ type: 'task', id: 't2', label: 'controls', junior: 'junior-bravo', state: 'cancelled' });
    expect(card.render()).not.toMatch(/t1|t2/);
  });
});
