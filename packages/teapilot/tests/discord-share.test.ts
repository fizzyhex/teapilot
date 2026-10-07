import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message } from 'pretty-send';
import { afterEach, expect, it } from 'vitest';
import { PasteStore } from '../src/discord/paste-store.js';
import { Clipboard, emptyClipboard, expandPrefix } from '../src/discord/share.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function store() {
  const directory = await mkdtemp(join(tmpdir(), 'teapilot-pastes-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return new PasteStore(directory);
}
const text = (content: string): Message => ({ content, source: content });
const table: Message = { embeds: [{ fields: [{ name: 'a', value: '1' }] }], components: [{ type: 1, components: [] }], source: '| a |\n|---|\n| 1 |' };

it('copies every message of an answer from any one of them, and pastes them as they were', async () => {
  const clipboard = new Clipboard(await store());
  const messages = [text('**here** it is'), table, text('bye')];
  clipboard.keep(messages.map((message, index) => ({ id: `m${index}`, message })));
  expect(clipboard.paste('op')).toEqual({ note: emptyClipboard });
  expect(clipboard.copyAnswer('op', 'm2')).toContain('/paste');
  expect(clipboard.paste('op')).toEqual({ messages });
  expect(clipboard.paste('someone else')).toEqual({ note: emptyClipboard });
  expect(clipboard.copyAnswer('op', 'not teapilot\'s')).toContain('can\'t be shared');
  expect(clipboard.paste('op')).toEqual({ messages });
  clipboard.copyApp('op', 'app-1');
  expect(clipboard.paste('op')).toEqual({ playId: 'app-1' });
});

it('pastes a long answer as a preview with a button, stored once however often it is pasted', async () => {
  const pastes = await store();
  const clipboard = new Clipboard(pastes);
  const picture = { name: 'chart.png', data: Buffer.from([1, 2, 3]) };
  const messages = [text(`# **Big** answer\n${'a line of the answer\n'.repeat(30)}`), { ...table, files: [picture] }];
  clipboard.keep(messages.map((message, index) => ({ id: `m${index}`, message })));
  clipboard.copyAnswer('op', 'm0');
  const pasted = clipboard.paste('op');
  if (!('messages' in pasted)) throw new Error('expected messages');
  expect(pasted.messages).toHaveLength(1);
  const [compact] = pasted.messages;
  expect(compact!.content).toMatch(/^Big answer a line of the answer .{100,}…$/);
  const button = (compact!.components![0]!.components as Array<{ label: string; custom_id: string }>)[0]!;
  expect(button.label).toBe('click to expand');
  expect(clipboard.paste('op')).toEqual(pasted);
  expect(pastes.find(button.custom_id.slice(expandPrefix.length).split(':')[0]!)).toEqual(messages);
  expect(pastes.find('../escape')).toBeUndefined();
});

it('counts lines as well as characters before compacting', async () => {
  const clipboard = new Clipboard(await store());
  clipboard.keep([{ id: 'short', message: text('a\n'.repeat(25)) }]);
  clipboard.copyAnswer('op', 'short');
  const pasted = clipboard.paste('op');
  expect('messages' in pasted && pasted.messages[0]!.components).toBeTruthy();
});
