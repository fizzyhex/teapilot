import { button, embed, field, modal, row, select } from '@teapilot/discord-play';
import { expect, it } from 'vitest';
import { browserLink, describe as preview, findControl, parseCustomId, renderModal, renderView } from '../src/discord/play/render.js';
import { checkMessage, checkModal } from '../scripts/discord-sim/validate.js';
import { firstJson, plain, unfence } from '../src/discord/play/consult.js';

it('warns below local browser links, but not public Funnel links', () => {
  const publicUrl = 'https://tea.example.ts.net:10000/play/abc123#ticket';
  const localUrl = 'http://localhost:2048/play/abc123#ticket';
  expect(browserLink(publicUrl)).toBe(`[open in browser](${publicUrl})`);
  expect(browserLink(localUrl)).toBe(`[open in browser](${localUrl})\n-# funnel is unavailable`);
  expect(browserLink(undefined)).toBe('this app cannot be opened here right now.');
});

it('renders a view as Discord API JSON with namespaced custom ids', () => {
  const payload = renderView('abc123', {
    content: 'hi',
    embeds: [embed({ title: 'Board', color: 'red', fields: [{ name: 'Turn', value: 'X', inline: true }], footer: 'round 1' })],
    rows: [row(button('go', 'Go', { style: 'success', emoji: '<:tea:123456789012345678>' }), button('docs', 'Docs', { url: 'https://example.com' })), row(select('pick', ['a', 'b'], { max: 2 }))],
  });
  expect(payload).toEqual({
    content: 'hi', allowedMentions: { parse: [] },
    embeds: [{ title: 'Board', color: 0xed4245, fields: [{ name: 'Turn', value: 'X', inline: true }], footer: { text: 'round 1' } }],
    components: [
      { type: 1, components: [
        { type: 2, style: 3, label: 'Go', emoji: { id: '123456789012345678', name: 'tea', animated: false }, custom_id: 'play:abc123:go' },
        { type: 2, style: 5, label: 'Docs', url: 'https://example.com' },
      ] },
      { type: 1, components: [{ type: 3, custom_id: 'play:abc123:pick', options: [{ value: 'a', label: 'a' }, { value: 'b', label: 'b' }], min_values: 1, max_values: 2 }] },
    ],
  });
  expect(() => checkMessage(payload)).not.toThrow();
  expect(parseCustomId('play:abc123:go')).toEqual({ playId: 'abc123', id: 'go' });
  expect(parseCustomId('teapilot:nonce:approve')).toBeUndefined();
});

it('accepts Discord\'s own { text } and { url } shapes for an embed footer and images', () => {
  const view = { embeds: [{ type: 'embed', title: 'Soup', footer: { text: 'Recipe 1 of 2' }, thumbnail: { url: 'https://example.com/a.png' } }] } as never;
  expect(renderView('a1', view).embeds[0]).toMatchObject({ footer: { text: 'Recipe 1 of 2' }, thumbnail: { url: 'https://example.com/a.png' } });
  expect(preview(view)).toContain('-- Recipe 1 of 2');
});

it('sends emoji-only buttons without a blank label', () => {
  const payload = renderView('a1', { rows: [row(button('c0', ' ', { emoji: '⬛' }), button('c1', ' ', { emoji: '1️⃣' }), button('c2', ' ', { emoji: '❤' }))] });
  expect(payload.components[0]!.components[0]).toEqual({ type: 2, style: 2, emoji: { name: '⬛' }, custom_id: 'play:a1:c0' });
  expect(() => checkMessage(payload)).not.toThrow();
});

it('names the SDK shapes a view is mistaken for', () => {
  // Keys nothing reads are named only when the view has nothing else to show.
  const lost = { text: 'board', controls: [button('left', 'Left')] };
  expect(() => renderView('a1', lost)).toThrow(/nothing to show\. It ignores `text`, `controls`: a view is \{ content\?, embeds\?, rows\? \}/);
  expect(renderView('a1', { content: 'board', title: 'snake' }).content).toBe('board');
  const objectButton = button({ id: 'left', label: 'Left' } as unknown as string, undefined as unknown as string);
  expect(() => renderView('a1', { rows: [row(objectButton)] })).toThrow(/button\(\) takes positional arguments/);
  expect(() => renderView('a1', { embeds: [embed('board' as never)] })).toThrow(/embed\(\) takes options, as in embed\(\{ description: text \}\)/);
});

it('refuses emoji Discord would refuse, such as a shortcode or a name', () => {
  for (const emoji of [':tea:', 'tea', '🍵🍵']) expect(() => renderView('a1', { rows: [row(button('c0', 'Go', { emoji }))] })).toThrow(/not one Unicode emoji/);
});

it('disables every control for a finished app, but keeps link buttons', () => {
  const payload = renderView('a1', { rows: [row(button('x', 'X'), button('site', 'Site', { url: 'https://example.com' }))] }, true);
  expect(payload.components[0]!.components).toEqual([
    { type: 2, style: 2, label: 'X', custom_id: 'play:a1:x', disabled: true },
    { type: 2, style: 5, label: 'Site', url: 'https://example.com' },
  ]);
});

it('leaves app controls intact with repost available only from the context menu', () => {
  const rows = [row(select('pick', ['a'])), ...Array.from({ length: 4 }, (_, i) => row(button(`b${i}`, 'B')))];
  const payload = renderView('a1', { rows }, true);
  expect(payload.components).toHaveLength(5);
  expect(payload.components[0]!.components).toHaveLength(1);
  expect(payload.components.flatMap(row => row.components).some(control => control.label === 'repost this!')).toBe(false);
  expect(() => checkMessage(payload)).not.toThrow();
  const full = renderView('a1', { rows: Array.from({ length: 5 }, (_, i) => row(...Array.from({ length: 5 }, (_, j) => button(`b${i}_${j}`, 'B')))) });
  expect(full.components.flatMap(row => row.components)).toHaveLength(25);
  expect(() => checkMessage(full)).not.toThrow();
});

it.each([
  ['too many rows', { rows: Array.from({ length: 6 }, (_, i) => row(button(`b${i}`, 'B'))) }, /rows has 6 entries/],
  ['too many buttons', { rows: [row(...Array.from({ length: 6 }, (_, i) => button(`b${i}`, 'B')))] }, /Row 1 has 6 entries/],
  ['a select sharing a row', { rows: [row(select('s', ['a']), button('b', 'B'))] }, /must be alone/],
  ['a duplicate select id', { rows: [row(select('b', ['x'])), row(button('b', 'C'))] }, /used twice/],
  ['a bad id', { rows: [row(button('has space', 'B'))] }, /letters, digits/],
  ['long content', { content: 'x'.repeat(2001) }, /Discord allows 2000/],
  ['a long label', { rows: [row(button('b', 'x'.repeat(81)))] }, /Discord allows 80/],
  ['an unlabeled button', { rows: [row(button('b', ' '))] }, /label or an emoji/],
  ['an empty view', {}, /nothing to show/],
  ['too much embed text', { embeds: [embed({ description: 'x'.repeat(4000) }), embed({ description: 'x'.repeat(2500) })] }, /6000/],
  ['a bad colour', { embeds: [embed({ title: 't', color: 'mauve' })] }, /Embed color/],
  ['a raw object', { rows: [{ controls: [] }] }, /built with row/],
])('refuses %s', (_name, view, error) => {
  expect(() => renderView('p1', view)).toThrow(error);
});

it('renders modals and checks their fields', () => {
  expect(() => checkModal(renderModal('p1', modal('guess', 'Your guess', [field('word', 'Word', { max: 5, required: false })])))).not.toThrow();
  expect(renderModal('p1', modal('guess', 'Your guess', [field('word', 'Word', { max: 5, required: false }), field('why', 'Why', { style: 'paragraph' })]))).toEqual({
    custom_id: 'play:p1:guess', title: 'Your guess',
    components: [
      { type: 1, components: [{ type: 4, custom_id: 'word', label: 'Word', style: 1, required: false, max_length: 5 }] },
      { type: 1, components: [{ type: 4, custom_id: 'why', label: 'Why', style: 2 }] },
    ],
  });
  expect(() => renderModal('p1', modal('m', 'x'.repeat(46), [field('a', 'A')]))).toThrow(/Discord allows 45/);
  expect(() => renderModal('p1', modal('m', 'M', []))).toThrow(/at least one field/);
  // A modal behind a button is checked when the view renders, not only when someone clicks.
  expect(() => renderView('p1', { rows: [row(button('open', 'Open', { opens: modal('m', 'M', []) }))] })).toThrow(/at least one field/);
});

it('finds controls and previews a view as text', () => {
  const view = { content: 'Pick', rows: [row(button('a', 'A', { opens: modal('m', 'M', [field('f', 'F')]) }), button('site', 'Site', { url: 'https://example.com' })), row(select('s', ['x', 'y']))] };
  expect(findControl(view, 'a')?.type).toBe('button');
  expect(findControl(view, 's')?.type).toBe('select');
  expect(findControl(view, 'missing')).toBeUndefined();
  expect(preview(view)).toBe('Pick\n[A](a → modal m) [Site](https://example.com)\n<select s: x|y>');
});

it('hands a consult reply that is one fenced block to the app as its contents', () => {
  expect(unfence('```json\n{"a":1}\n```')).toBe('{"a":1}');
  expect(unfence('  ```\nplain\n```\n')).toBe('plain');
  expect(unfence('Here you go:\n```json\n{}\n```')).toBe('Here you go:\n```json\n{}\n```');
});

it('finds the first whole JSON value in a consult reply that repeats or wraps it', () => {
  expect(firstJson('{"a":"}{"}\n\n{"a":"}{"}')).toBe('{"a":"}{"}');
  expect(firstJson('Sure! [1, {"b": "\\"x\\""}] hope that helps')).toBe('[1, {"b": "\\"x\\""}]');
  expect(firstJson(' {"a":1} ')).toBe(' {"a":1} ');
  expect(firstJson('no json here')).toBeUndefined();
  expect(firstJson('{"a": 1')).toBeUndefined();
});

it('gives a button repeated under one id its own custom_id, which still reads back as that id', () => {
  const payload = renderView('abc123', { rows: [row(button('pick', 'Mine')), row(button('pick', 'Yours'))] });
  const ids = payload.components.flatMap(entry => entry.components.map(control => String(control.custom_id)));
  expect(ids).toEqual(['play:abc123:pick', 'play:abc123:pick~2']);
  expect(ids.map(value => parseCustomId(value)?.id)).toEqual(['pick', 'pick']);
  // Colons are a common way to name controls, such as draw:sand.
  expect(parseCustomId(String(renderView('abc123', { rows: [row(button('draw:sand', 'Draw'))] }).components[0]!.components[0]!.custom_id))?.id).toBe('draw:sand');
  expect(() => checkMessage(payload)).not.toThrow();
});

it('unwraps plain text a model sent as a single JSON field', () => {
  expect(plain('{"text": "Frost this morning."}')).toBe('Frost this morning.');
  expect(plain('Frost this morning.')).toBe('Frost this morning.');
  expect(plain('{"a": "x", "b": "y"}')).toBe('{"a": "x", "b": "y"}');
  expect(plain('{"n": 3}')).toBe('{"n": 3}');
});
