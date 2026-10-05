import { expect, it } from 'vitest';
import type { ContextData } from '../src/discord/play/engine.js';
import { sandbox } from '../src/discord/play/sandbox.js';

const ctx: ContextData = { now: 1, invoker: { id: '1' }, participants: 'everyone', emojis: { tea: '<:tea:123456789012345678>' }, seed: 42 };
const counter = `
import { app, button, row, step, after } from '@teapilot/discord-play';
interface State { count: number }
export default app<State>({
  participants: 'invoker',
  init: (): State => ({ count: 0 }),
  update: (state: State, action) => action.kind === 'button' ? step({ count: state.count + 1 }, after(1000, 'tick')) : state,
  view: (state: State, ctx) => ({ content: ctx.emoji('tea') + ' ' + state.count + ' ' + ctx.emoji('missing') + ' ' + ctx.emoji(':tea:'), rows: [row(button('add', 'Add'))] }),
});`;

it('runs a TypeScript app against the SDK with JSON in and out', async () => {
  const engine = await sandbox(counter);
  try {
    expect((await engine.call('meta', { ctx })).value).toEqual({ participants: 'invoker', keys: ['participants', 'init', 'update', 'view'] });
    const start = await engine.call('init', { ctx });
    expect(start.value).toEqual({ count: 0 });
    const next = await engine.call('update', { state: { count: 2 }, action: { kind: 'button', id: 'add', user: { id: '1' } }, ctx });
    expect(next.value).toEqual({ type: 'step', state: { count: 3 }, effects: [{ type: 'after', id: 'tick', ms: 1000 }] });
    const view = await engine.call('view', { state: { count: 3 }, ctx });
    expect(view.value).toMatchObject({ content: '<:tea:123456789012345678> 3 :missing: <:tea:123456789012345678>' });
  } finally { engine.dispose(); }
});

it('continues a seeded random sequence across calls', async () => {
  const engine = await sandbox(`import { app } from '@teapilot/discord-play';
export default app({ init: ctx => [ctx.random(), ctx.random()], update: s => s, view: () => ({ content: 'x' }) });`);
  try {
    const first = await engine.call('init', { ctx });
    const again = await engine.call('init', { ctx });
    const later = await engine.call('init', { ctx: { ...ctx, seed: first.seed } });
    expect(again.value).toEqual(first.value);
    expect(later.value).not.toEqual(first.value);
    expect((first.value as number[]).every(value => value >= 0 && value < 1)).toBe(true);
  } finally { engine.dispose(); }
});

it('runs Math.random from the same seed, and forgives forgotten SDK imports', async () => {
  const engine = await sandbox(`export default app({ init: ctx => [Math.random(), ctx.random()], update: s => s, view: () => ({ rows: [row(button('go', 'Go'))] }) });`);
  try {
    const first = await engine.call('init', { ctx });
    expect((await engine.call('init', { ctx })).value).toEqual(first.value);
    expect((await engine.call('view', { state: null, ctx })).value).toEqual({ rows: [{ type: 'row', controls: [{ type: 'button', id: 'go', label: 'Go' }] }] });
  } finally { engine.dispose(); }
  await expect(sandbox(`import { app, short } from '@teapilot/discord-play'; export default app({});`)).rejects.toThrow(/"short" is not part of @teapilot\/discord-play\. It exports app, step, .*button/);
});

it('has no process, require, fetch or timers', async () => {
  const engine = await sandbox(`import { app } from '@teapilot/discord-play';
export default app({ init: () => [typeof process, typeof require, typeof fetch, typeof setTimeout, typeof globalThis.Deno], update: s => s, view: () => ({ content: 'x' }) });`);
  try { expect((await engine.call('init', { ctx })).value).toEqual(['undefined', 'undefined', 'undefined', 'undefined', 'undefined']); }
  finally { engine.dispose(); }
});

it('refuses imports other than the SDK', async () => {
  await expect(sandbox(`import { readFileSync } from 'node:fs'; export default {};`)).rejects.toThrow(/can import only "@teapilot\/discord-play"/);
});

it('reports a missing default export and syntax errors', async () => {
  await expect(sandbox(`export const nothing = 1;`)).rejects.toThrow(/must "export default app/);
  const engine = await sandbox(`export default 5;`);
  await expect(engine.call('init', { ctx })).rejects.toThrow(/must "export default app/);
  await expect(sandbox(`export default app({ init: () => { `)).rejects.toThrow();
});

it('stops a runaway loop and recovers for the next call', async () => {
  const engine = await sandbox(`import { app } from '@teapilot/discord-play';
export default app({ init: () => 1, update: (s, action) => { if (action.id === 'loop') for (;;) {} return s + 1; }, view: () => ({ content: 'x' }) });`);
  try {
    const started = Date.now();
    await expect(engine.call('update', { state: 1, action: { kind: 'button', id: 'loop', user: { id: '1' } }, ctx })).rejects.toThrow(/ran too long/);
    expect(Date.now() - started).toBeLessThan(5000);
    expect((await engine.call('update', { state: 1, action: { kind: 'button', id: 'ok', user: { id: '1' } }, ctx })).value).toBe(2);
  } finally { engine.dispose(); }
});

it('caps memory', async () => {
  const engine = await sandbox(`import { app } from '@teapilot/discord-play';
export default app({ init: () => { const hog = []; for (let i = 0; i < 1e7; i++) hog.push('x'.repeat(1000) + i); return hog.length; }, update: s => s, view: () => ({ content: 'x' }) });`);
  try { await expect(engine.call('init', { ctx })).rejects.toThrow(/memory|too long/); }
  finally { engine.dispose(); }
});

it('rejects async apps and oversized source', async () => {
  const engine = await sandbox(`import { app } from '@teapilot/discord-play';
export default app({ init: async () => 1, update: s => s, view: () => ({ content: 'x' }) });`);
  try { await expect(engine.call('init', { ctx })).rejects.toThrow(/must be synchronous/); }
  finally { engine.dispose(); }
  await expect(sandbox('x'.repeat(64_001))).rejects.toThrow(/limit is 64000/);
});
