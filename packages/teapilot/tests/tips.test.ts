import { expect, it } from 'vitest';
import type { Message } from '@earendil-works/pi-ai';
import { pickTip, shownTips, tipText, TIPS, type TipCall } from '../src/agents/tips.js';

const call = (fields: Partial<TipCall>): TipCall => ({ tool: 'write', succeeded: true, scratch: false, tools: new Set(['write', 'edit', 'request_capabilities', 'delegate_task']), pressure: false, ...fields });
const pick = (fields: Partial<TipCall>, shown: string[] = []) => pickTip(call(fields), text => TIPS.filter(tip => shown.includes(tip.name)).map(tipText).includes(text))?.name;
const code = (lines: number) => Array.from({ length: lines }, (_, index) => `const a${index} = ${index};`).join('\n');

it('answers each call with the first tip that fits', () => {
  expect(pick({ path: 'bot.py', content: 'import discord\n' })).toBe('useJavascript');
  expect(pick({ tool: 'edit', path: 'bot.py', content: 'from discord.ext import commands' })).toBe('useJavascript');
  expect(pick({ path: 'bot.py', content: 'import discord\n', tools: new Set(['write']) })).toBeUndefined();
  expect(pick({ path: 'main.py', content: 'print(1)' })).toBeUndefined();
  expect(pick({ path: 'plan.md', content: '# plan' })).toBeUndefined();
  expect(pick({ path: 'app.ts', content: code(21) })).toBeUndefined();
  expect(pick({ tool: 'read', path: 'app.ts', pressure: true })).toBe('takeNotes');
});

it('leaves workspace and delegation workflow advice to skills and project instructions', () => {
  expect(pick({ path: 'plan.md', content: '# plan', tools: new Set(['write']), repository: true })).toBeUndefined();
  expect(pick({ path: 'notes.md', scratch: true, tools: new Set(['write']), repository: true })).toBeUndefined();
  expect(pick({ tool: 'bash', succeeded: false, repository: true })).toBeUndefined();
  expect(pick({ tool: 'bash', succeeded: false })).toBeUndefined();
  expect(pick({ tool: 'delegate_task', repository: true })).toBeUndefined();
});

it('uses bounded task state for pressure and never asks a read-only model to write notes', () => {
  const state = pickTip(call({ tool: 'read', pressure: true, tools: new Set(['read', 'task_state']) }), () => false);
  expect(state?.content).toContain('task_state');
  expect(state?.content).not.toContain('markdown');
  expect(pickTip(call({ tool: 'read', pressure: true, tools: new Set(['read']) }), () => false)).toBeUndefined();
});

it('gives nothing for failed calls, reads, or scratchpad notes', () => {
  expect(pick({ path: 'main.py', succeeded: false })).toBeUndefined();
  expect(pick({ tool: 'read', path: 'main.py' })).toBeUndefined();
  expect(pick({ path: 'notes.txt', scratch: true, tools: new Set(['write']) })).toBeUndefined();
  expect(pick({ tool: 'edit', path: 'app.ts', content: code(40) })).toBeUndefined();
});

it('skips tips already given, falling to the next that fits', () => {
  expect(pick({ path: 'bot.py', content: 'import discord', pressure: true }, ['useJavascript'])).toBe('takeNotes');
  expect(pick({ path: 'bot.py', content: 'import discord', pressure: true }, ['useJavascript', 'takeNotes'])).toBeUndefined();
});

it('finds tips in what the model was sent, so one summarised away is given again', () => {
  const given = tipText(TIPS.find(tip => tip.name === 'useJavascript')!);
  const result = (texts: string[]): Message => ({ role: 'toolResult', toolCallId: 'c1', toolName: 'write', content: texts.map(text => ({ type: 'text', text })), isError: false, timestamp: 0 });
  expect(shownTips([{ role: 'user', content: given, timestamp: 0 }, result(['Wrote a.ts', given])])).toEqual(new Set([given]));
  // After a compaction the result is gone; only its summary remains.
  expect(shownTips([{ role: 'user', content: 'summary of earlier work', timestamp: 0 }])).toEqual(new Set());
  expect(shownTips([result([`Wrote a.ts\n${given}`])])).toEqual(new Set());
});
