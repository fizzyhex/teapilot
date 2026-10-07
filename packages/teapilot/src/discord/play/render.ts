import { createHash } from 'node:crypto';
import { colors, type Control, type Embed, type Modal, type Picture, type View } from '@teapilot/discord-play';
import type { PictureSpec } from '../images.js';

/** A mistake in an app's output. The message is written for the model that wrote the app. */
export class PlayError extends Error {}

export function browserLink(url: string | undefined): string {
  if (!url) return 'this app cannot be opened here right now.';
  return `[open in browser](${url})${url.startsWith('https://') ? '' : '\n-# funnel is unavailable'}`;
}

/** Discord API JSON for one message; discord.js accepts these objects as they are. */
export interface MessagePayload {
  content: string;
  embeds: Array<Record<string, unknown>>;
  components: Array<{ type: 1; components: Array<Record<string, unknown>> }>;
  allowedMentions: { parse: [] };
  /** Conversation images the embeds show as attachment://name; the runtime renders them into `files` before sending. */
  pictures?: PictureSpec[];
  files?: Array<{ name: string; data: Buffer }>;
}
export interface ModalPayload { custom_id: string; title: string; components: Array<{ type: 1; components: Array<Record<string, unknown>> }> }

const limits = { content: 2000, embeds: 10, embedTotal: 6000, title: 256, description: 4096, fields: 25, fieldName: 256, fieldValue: 1024, footer: 2048, rows: 5, buttons: 5, label: 80, options: 25, option: 100, placeholder: 150, modalTitle: 45, modalFields: 5, modalLabel: 45, modalValue: 4000 };
const styles = { primary: 1, secondary: 2, success: 3, danger: 4 } as const;
const idPattern = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Every Discord custom_id teapilot gives a play control starts with this. */
export const playPrefix = 'play:';
export const customId = (playId: string, id: string) => `${playPrefix}${playId}:${id}`;
/** A button repeated under one id (one per player, say) gets a "~n" suffix on Discord; it reaches the app as that id. */
export function parseCustomId(value: string): { playId: string; id: string } | undefined {
  const match = /^play:([a-z0-9]{1,16}):([A-Za-z0-9_.:-]{1,64})(?:~\d{1,2})?$/.exec(value);
  return match ? { playId: match[1]!, id: match[2]! } : undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
/** A short sample of a wrong value, for error messages. */
const shown = (value: unknown) => { const text = JSON.stringify(value) ?? String(value); return text.length > 80 ? `${text.slice(0, 79)}…` : text; };
function string(value: unknown, what: string, max: number, required = false): string | undefined {
  if (value === undefined || value === null || value === '') { if (required) throw new PlayError(`${what} is required.`); return undefined; }
  if (typeof value !== 'string') throw new PlayError(`${what} must be a string.`);
  if (value.length > max) throw new PlayError(`${what} is ${value.length} characters; Discord allows ${max}.`);
  return value;
}
function list(value: unknown, what: string, max: number): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new PlayError(`${what} must be an array.`);
  if (value.length > max) throw new PlayError(`${what} has ${value.length} entries; Discord allows ${max}.`);
  return value;
}
function id(value: unknown, what: string): string {
  if (typeof value !== 'string' || !idPattern.test(value)) throw new PlayError(`${what} id ${JSON.stringify(value)} must be 1–64 letters, digits, "_", ".", ":" or "-".`);
  return value;
}
function color(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffff) return value;
  if (typeof value === 'string' && /^#?[0-9a-f]{6}$/i.test(value)) return Number.parseInt(value.replace('#', ''), 16);
  if (typeof value === 'string' && value in colors) return colors[value as keyof typeof colors];
  throw new PlayError(`Embed color ${JSON.stringify(value)} must be 0–0xffffff, "#rrggbb" or one of ${Object.keys(colors).join(', ')}.`);
}
// One emoji, including a bare pictograph such as ❤. The v flag is newer than the compile target, not than Node 22.
const unicodeEmoji = new RegExp('^(?:\\p{RGI_Emoji}|\\p{Extended_Pictographic}\\uFE0F?)$', 'v');
const boardEmoji = new RegExp('<a?:\\w{2,32}:\\d{17,20}>|\\p{RGI_Emoji}|\\p{Extended_Pictographic}\\uFE0F?', 'gv');
/** Embed markdown stops rendering after roughly 100 elements; message content can show larger emoji boards. */
function largeEmojiBoard(value: unknown): value is string {
  if (typeof value !== 'string' || !value.includes('\n')) return false;
  return [...value.matchAll(boardEmoji)].length > 100 && !value.replace(boardEmoji, '').trim();
}
/** Custom emoji arrive as <:name:id> or <a:name:id>; anything else must be one Unicode emoji, the only other kind Discord accepts. */
function emoji(value: unknown): Record<string, unknown> | undefined {
  const text = string(value, 'Emoji', 100);
  if (!text) return undefined;
  const custom = /^<(a?):(\w{2,32}):(\d{17,20})>$/.exec(text);
  if (custom) return { id: custom[3], name: custom[2], animated: custom[1] === 'a' };
  if (!unicodeEmoji.test(text)) throw new PlayError(`Emoji ${JSON.stringify(text)} is not one Unicode emoji. Use a character such as "🍵", or a server emoji as <:name:id>; ctx.emoji(name) gives only those the user shared.`);
  return { name: text };
}
function url(value: unknown, what: string): string | undefined {
  const text = string(value, what, 2000);
  if (text && !/^https?:\/\//i.test(text)) throw new PlayError(`${what} must be an http(s) URL.`);
  return text;
}
/** Discord's own { text } / { url } shapes, which models often write for footer, image and thumbnail. */
const unwrap = (value: unknown, key: 'text' | 'url') => isRecord(value) && typeof value[key] === 'string' ? value[key] : value;
const compact = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));

const filters = new Set(['blur', 'brightness', 'contrast', 'grayscale', 'hue-rotate', 'invert', 'opacity', 'saturate', 'sepia', 'drop-shadow']);
/** CSS filter functions, with the spelling "greyscale" accepted. */
function filterText(value: unknown): string | undefined {
  const text = string(value, 'picture() filter', 300)?.trim().replace(/\bgreyscale\(/gi, 'grayscale(');
  if (!text || text === 'none') return undefined;
  const parts = [...text.matchAll(/([a-z-]+)\(([^()]*(?:\([^()]*\)[^()]*)*)\)/gi)];
  if (text.replace(/([a-z-]+)\(([^()]*(?:\([^()]*\)[^()]*)*)\)/gi, '').trim() || parts.some(part => !filters.has(part[1]!.toLowerCase()))) {
    throw new PlayError(`picture() filter ${JSON.stringify(text)} must be CSS filter functions separated by spaces, from ${[...filters].join(', ')}, as in "grayscale(1) sepia(0.8)".`);
  }
  return text;
}
/** A picture() checked, with the shorthands models reach for (grayscale: true, sepia: 1) folded into its filter. */
export function checkPicture(value: Record<string, unknown>): PictureSpec {
  const file = string(value.file, 'picture() file', 100, true)!;
  const rotate = value.rotate ?? 0;
  if (typeof rotate !== 'number' || !Number.isFinite(rotate)) throw new PlayError('picture() rotate must be a number of degrees.');
  const flip = value.flip === false || value.flip === undefined || value.flip === null ? undefined : value.flip;
  if (flip !== undefined && flip !== 'horizontal' && flip !== 'vertical' && flip !== 'both') throw new PlayError('picture() flip must be "horizontal", "vertical" or "both".');
  const shorthand = Object.entries(value).flatMap(([key, amount]) => {
    const name = key === 'greyscale' ? 'grayscale' : key === 'hueRotate' ? 'hue-rotate' : key;
    if (!filters.has(name) || name === 'drop-shadow' || amount === false || amount === undefined || amount === null) return [];
    const level = amount === true ? 1 : amount;
    if (typeof level !== 'number' || !Number.isFinite(level)) throw new PlayError(`picture() ${key} must be true or a number.`);
    return [`${name}(${level}${name === 'blur' ? 'px' : name === 'hue-rotate' ? 'deg' : ''})`];
  });
  const filter = [filterText(value.filter), ...shorthand].filter(Boolean).join(' ') || undefined;
  const width = value.width;
  if (width !== undefined && (typeof width !== 'number' || !Number.isInteger(width) || width < 16 || width > 2048)) throw new PlayError('picture() width must be a whole number of pixels from 16 to 2048.');
  const spec = { file, rotate: ((rotate % 360) + 360) % 360, ...(flip ? { flip } : {}), ...(filter ? { filter } : {}), ...(width ? { width } : {}) } as Omit<PictureSpec, 'name'>;
  // Each look gets its own attachment name, so Discord never shows a stale copy of an earlier one.
  const stem = file.replace(/\.[^.]*$/, '').replace(/[^\w-]+/g, '_').slice(0, 40) || 'picture';
  const extension = /\.jpe?g$/i.test(file) ? 'jpg' : 'png';
  return { ...spec, name: `${stem}-${createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 8)}.${extension}` };
}
/** An embed image: an http(s) URL, or a picture() collected for the runtime to render and attach. */
function media(value: unknown, what: string, pictures?: PictureSpec[]): string | undefined {
  if (isRecord(value) && value.type === 'picture') {
    if (!pictures) throw new PlayError(`picture() shows only in the app's own view, not in ${what.toLowerCase()}s of private notes.`);
    const spec = checkPicture(value);
    if (!pictures.some(entry => entry.name === spec.name)) pictures.push(spec);
    return `attachment://${spec.name}`;
  }
  return url(unwrap(value, 'url'), what);
}

function renderEmbed(value: unknown, index: number, pictures?: PictureSpec[]): { json: Record<string, unknown>; size: number } {
  if (!isRecord(value)) throw new PlayError(`Embed ${index + 1} must be built with embed().`);
  // embed("text") spreads the string into numbered keys.
  if ('0' in value) throw new PlayError(`Embed ${index + 1}: embed() takes options, as in embed({ description: text }), not a string.`);
  const title = string(value.title, 'Embed title', limits.title);
  const description = string(value.description, 'Embed description', limits.description);
  const footer = string(unwrap(value.footer, 'text'), 'Embed footer', limits.footer);
  const fields = list(value.fields, 'Embed fields', limits.fields).map((field, number) => {
    if (!isRecord(field)) throw new PlayError(`Embed field ${number + 1} must be { name, value, inline? }.`);
    return compact({ name: string(field.name, 'Embed field name', limits.fieldName, true), value: string(field.value, 'Embed field value', limits.fieldValue, true), inline: field.inline === true ? true : undefined });
  });
  const size = (title?.length ?? 0) + (description?.length ?? 0) + (footer?.length ?? 0) + fields.reduce((sum, field) => sum + String(field.name).length + String(field.value).length, 0);
  if (!size && !value.image && !value.thumbnail) throw new PlayError(`Embed ${index + 1} is empty.`);
  const image = media(value.image, 'Embed image', pictures), thumbnail = media(value.thumbnail, 'Embed thumbnail', pictures);
  return { size, json: compact({ title, description, url: url(value.url, 'Embed url'), color: color(value.color), fields: fields.length ? fields : undefined, footer: footer ? { text: footer } : undefined, image: image ? { url: image } : undefined, thumbnail: thumbnail ? { url: thumbnail } : undefined }) };
}

export function renderEmbeds(value: unknown, pictures?: PictureSpec[]): Array<Record<string, unknown>> {
  const rendered = list(value, 'embeds', limits.embeds).map((embed, index) => renderEmbed(embed, index, pictures));
  const total = rendered.reduce((sum, embed) => sum + embed.size, 0);
  if (total > limits.embedTotal) throw new PlayError(`Embeds hold ${total} characters in total; Discord allows ${limits.embedTotal}.`);
  return rendered.map(embed => embed.json);
}

function renderControl(playId: string, control: unknown, disabled: boolean, seen: Set<string>): Record<string, unknown> {
  if (!isRecord(control)) throw new PlayError(`Rows hold controls built with button() or select(), not ${shown(control)}.`);
  if (control.type === 'button') {
    if (isRecord(control.id)) throw new PlayError('button() takes positional arguments, as in button("left", "◀", { style: "primary" }), not one object.');
    // Discord rejects blank labels; an emoji-only button often arrives with a space as its label.
    const label = string(control.label, 'Button label', limits.label)?.trim() ? control.label as string : undefined;
    const icon = emoji(control.emoji);
    if (!label && !icon) throw new PlayError('A button needs a label or an emoji.');
    if (control.url !== undefined) return compact({ type: 2, style: 5, label, emoji: icon, url: url(control.url, 'Button url') });
    const key = id(control.id, 'Button');
    if (seen.has(`select:${key}`)) throw new PlayError(`Control id "${key}" is used twice in one view.`);
    // Discord needs unique custom_ids, but apps often repeat a button per player and tell presses apart by who pressed.
    let copy = 1;
    while (seen.has(copy === 1 ? key : `${key}~${copy}`)) copy++;
    const unique = copy === 1 ? key : `${key}~${copy}`;
    seen.add(unique);
    if (control.opens !== undefined) renderModal(playId, control.opens);
    const style = control.style ?? 'secondary';
    if (typeof style !== 'string' || !(style in styles)) throw new PlayError(`Button style must be one of ${Object.keys(styles).join(', ')}.`);
    return compact({ type: 2, style: styles[style as keyof typeof styles], label, emoji: icon, custom_id: customId(playId, unique), disabled: disabled || control.disabled === true || undefined });
  }
  if (control.type === 'select') {
    const key = id(control.id, 'Select');
    if (seen.has(key) || seen.has(`select:${key}`)) throw new PlayError(`Control id "${key}" is used twice in one view.`);
    seen.add(key); seen.add(`select:${key}`);
    const options = list(control.options, 'Select options', limits.options).map(option => {
      if (!isRecord(option)) throw new PlayError('Select options must be strings or { value, label }.');
      return compact({ value: string(option.value, 'Option value', limits.option, true), label: string(option.label, 'Option label', limits.option, true), description: string(option.description, 'Option description', limits.option), emoji: emoji(option.emoji), default: option.default === true || undefined });
    });
    if (!options.length) throw new PlayError(`Select "${key}" needs at least one option.`);
    const count = (value: unknown, what: string, fallback: number) => {
      if (value === undefined) return fallback;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > options.length) throw new PlayError(`Select ${what} must be a whole number from 0 to the number of options.`);
      return value;
    };
    const min = count(control.min, 'min', 1), max = count(control.max, 'max', 1);
    if (max < Math.max(min, 1)) throw new PlayError('Select max must be at least min and at least 1.');
    return compact({ type: 3, custom_id: customId(playId, key), options, placeholder: string(control.placeholder, 'Select placeholder', limits.placeholder), min_values: min, max_values: max, disabled: disabled || control.disabled === true || undefined });
  }
  throw new PlayError(`Rows hold controls built with button() or select(), not ${shown(control)}.`);
}

/**
 * Accepts the shapes a view is easily mistaken for when what they mean is clear: a bare string,
 * embed or row, a list of those, a lone embed as embeds, and a row given as a list of controls or one control.
 */
export function normalizeView(value: unknown): unknown {
  const asRow = (part: unknown) => Array.isArray(part) ? { type: 'row', controls: part }
    : isRecord(part) && (part.type === 'button' || part.type === 'select') ? { type: 'row', controls: [part] } : part;
  let view = value;
  if (typeof view === 'string' || Array.isArray(view) || isRecord(view) && typeof view.type === 'string') {
    const parts: unknown[] = Array.isArray(view) ? view : [view];
    const isEmbed = (part: unknown) => isRecord(part) && part.type === 'embed';
    const content = parts.filter((part): part is string => typeof part === 'string');
    const embeds = parts.filter(isEmbed);
    const rows = parts.filter(part => typeof part !== 'string' && !isEmbed(part)).map(asRow);
    view = { ...(content.length ? { content: content.join('\n') } : {}), ...(embeds.length ? { embeds } : {}), ...(rows.length ? { rows } : {}) };
  }
  if (isRecord(view) && isRecord(view.embeds)) view = { ...view, embeds: [view.embeds] };
  // A row inside a row, or a list of controls inside one, still means those controls side by side.
  const flat = (part: unknown) => isRecord(part) && part.type === 'row' && Array.isArray(part.controls)
    ? { ...part, controls: part.controls.flatMap(control => Array.isArray(control) ? control : isRecord(control) && control.type === 'row' && Array.isArray(control.controls) ? control.controls : [control]) } : part;
  if (isRecord(view) && Array.isArray(view.rows)) view = { ...view, rows: view.rows.map(part => flat(asRow(part))) };
  return view;
}

const viewKeys = new Set(['content', 'embeds', 'rows']);
/** Names keys a view was given that nothing reads, such as `controls` or `text`, for errors about what it lacks. */
export function ignoredKeys(view: unknown): string {
  const keys = isRecord(view) ? Object.keys(view).filter(key => !viewKeys.has(key)) : [];
  return keys.length ? ` It ignores ${keys.map(key => `\`${key}\``).join(', ')}: a view is { content?, embeds?, rows? }, with controls as rows: [row(button(id, label))].` : '';
}

/** Checks a view against Discord's limits and renders it; `disabled` greys out every control, for a finished app. */
export function renderView(playId: string, view: unknown, disabled = false): MessagePayload {
  if (!isRecord(view) || view.type !== undefined) throw new PlayError(`view() must return a message object { content?, embeds?, rows? }${isRecord(view) && typeof view.type === 'string' ? `, not a bare ${view.type}; wrap it, as in { ${view.type === 'embed' ? 'embeds' : 'rows'}: [...] }` : Array.isArray(view) ? ', not an array' : ''}.`);
  let content = string(view.content, 'Message content', limits.content) ?? '';
  const pictures: PictureSpec[] = [];
  const embeds = renderEmbeds(view.embeds, pictures).flatMap(embed => {
    if (!largeEmojiBoard(embed.description)) return [embed];
    const combined = [content, embed.description].filter(Boolean).join('\n');
    if (combined.length > limits.content) throw new PlayError(`emoji boards too large for embed rendering are shown as message content; this view needs ${combined.length} characters, but Discord allows ${limits.content}.`);
    content = combined;
    const { description: _, ...rest } = embed;
    // A colour or URL alone is not an embed; retain titles, fields, footers and media.
    return rest.title || rest.footer || rest.image || rest.thumbnail || Array.isArray(rest.fields) && rest.fields.length ? [rest] : [];
  });
  const seen = new Set<string>();
  // An empty row() is usually a conditional control that is hidden right now, so it is dropped.
  const rows = list(view.rows, 'rows', Infinity).filter(value => !(isRecord(value) && value.type === 'row' && Array.isArray(value.controls) && !value.controls.length));
  if (rows.length > limits.rows) throw new PlayError(`rows has ${rows.length} entries; Discord allows ${limits.rows}.`);
  const components = rows.map((value, index) => {
    if (!isRecord(value) || value.type !== 'row') throw new PlayError(`Row ${index + 1} must be built with row().`);
    const controls = list(value.controls, `Row ${index + 1}`, limits.buttons);
    if (controls.some(control => isRecord(control) && control.type === 'select') && controls.length > 1) throw new PlayError(`Row ${index + 1}: a select must be alone in its row.`);
    return { type: 1 as const, components: controls.map(control => renderControl(playId, control, disabled, seen)) };
  });
  if (!content && !embeds.length && !components.length) throw new PlayError(`view() returned nothing to show.${ignoredKeys(view)}`);
  return { content, embeds, components, allowedMentions: { parse: [] }, ...(pictures.length ? { pictures } : {}) };
}

export function renderModal(playId: string, value: unknown): ModalPayload {
  if (!isRecord(value) || value.type !== 'modal') throw new PlayError('Button opens must be built with modal().');
  const key = id(value.id, 'Modal');
  const fields = list(value.fields, 'Modal fields', limits.modalFields);
  if (!fields.length) throw new PlayError(`Modal "${key}" needs at least one field.`);
  const seen = new Set<string>();
  return {
    custom_id: customId(playId, key),
    title: string(value.title, 'Modal title', limits.modalTitle, true)!,
    components: fields.map(field => {
      if (!isRecord(field)) throw new PlayError('Modal fields must be built with field().');
      const name = id(field.id, 'Modal field');
      if (seen.has(name)) throw new PlayError(`Modal field id "${name}" is used twice.`);
      seen.add(name);
      const length = (entry: unknown, what: string) => {
        if (entry === undefined) return undefined;
        if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 0 || entry > limits.modalValue) throw new PlayError(`Modal field ${what} must be a whole number from 0 to ${limits.modalValue}.`);
        return entry;
      };
      return { type: 1 as const, components: [compact({
        type: 4, custom_id: name, label: string(field.label, 'Modal field label', limits.modalLabel, true), style: field.style === 'paragraph' ? 2 : 1,
        placeholder: string(field.placeholder, 'Modal field placeholder', 100), required: field.required === false ? false : undefined,
        min_length: length(field.min, 'min'), max_length: length(field.max, 'max'), value: string(field.value, 'Modal field value', limits.modalValue),
      })] };
    }),
  };
}

/** The control a view shows under this id, if any; link buttons have no id. */
export function findControl(view: View | undefined, key: string): Control | undefined {
  for (const row of view?.rows ?? []) for (const control of row.controls) if (control.type === 'select' ? control.id === key : control.id === key && control.url === undefined) return control;
  return undefined;
}

/** A plain-text rendering of a view, so the model can check what it built. */
export function describe(view: View): string {
  const lines: string[] = [];
  if (view.content) lines.push(view.content);
  for (const embed of view.embeds ?? [] as Embed[]) {
    lines.push(`[embed${embed.color !== undefined ? ` ${String(embed.color)}` : ''}]${embed.title ? ` ${embed.title}` : ''}`);
    if (embed.description) lines.push(embed.description);
    for (const field of embed.fields ?? []) lines.push(`${field.name}: ${field.value}`);
    if (embed.footer) lines.push(`-- ${String(unwrap(embed.footer, 'text'))}`);
    for (const key of ['image', 'thumbnail'] as const) {
      const value = embed[key] as unknown;
      if (isRecord(value) && value.type === 'picture') {
        const { file, type: _, ...options } = value as unknown as Picture;
        lines.push(`${key}: ${String(file)}${Object.keys(options).length ? ` ${JSON.stringify(options)}` : ''}`);
      } else if (value) lines.push(`${key}: ${String(unwrap(value, 'url'))}`);
    }
  }
  for (const row of view.rows ?? []) lines.push(row.controls.map(control => control.type === 'select'
    ? `<select ${control.id}: ${control.options.map(option => option.value).join('|')}>`
    : `[${[control.emoji, control.label].filter(Boolean).join(' ')}](${control.url ?? control.id}${control.opens ? ` → modal ${(control.opens as Modal).id}` : ''}${control.disabled ? ', disabled' : ''})`).join(' '));
  return lines.join('\n');
}
