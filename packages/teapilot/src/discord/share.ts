import type { Message } from 'pretty-send';
import { escapeMarkdown } from './render.js';

/** Starts the custom id of a pasted answer's expand button: `teapilot-paste:<id>:expand`, the id in the paste store. */
export const expandPrefix = 'teapilot-paste:';
export const emptyClipboard = 'nothing is on the clipboard, you can share games and messages through the `Apps -> teapilot -> Share` context menu!';
/** A pasted answer longer than this, in characters or lines, goes behind a button instead of flooding the channel. */
const floodChars = 1200;
const floodLines = 20;
const previewChars = 200;
/** Messages that can still be shared, and clipboards; the oldest are forgotten first. */
const keepLimit = 500;

/** One message of an answer as it reached Discord: plain text, or a pretty-send layout. */
export interface Posted { id: string; message: Message }
/** What /paste does: tell the paster `note` alone, move the app `playId` here, or post `messages`. */
export type Paste = { note: string } | { playId: string } | { messages: Message[] };
/** `stored` is the answer's id in the paste store, once it has been pasted compactly. */
type Clip = { playId: string } | { messages: Message[]; stored?: string };

const floods = (messages: Message[]) => {
  const text = messages.map(message => message.source).join('\n');
  return text.length > floodChars || text.split('\n').length > floodLines;
};
/** The start of an answer on one line, with its formatting dropped, since a cut could leave it unbalanced. */
const preview = (messages: Message[]) => {
  const text = messages.map(message => message.source).join(' ').replace(/[*_~`|>#\\]/g, '').replace(/\s+/g, ' ').trim();
  return escapeMarkdown(text.length > previewChars ? `${text.slice(0, previewChars).replace(/\s+\S*$/, '')}…` : text);
};

/**
 * Apps → Share copies an answer, with every message it was split into, or an app, to the sharer's clipboard, and /paste
 * posts it wherever they are. An answer that would flood the channel pastes as a button showing it to whoever presses.
 */
export class Clipboard {
  /** Each answer's messages, by the id of every one of them. */
  private readonly trails = new Map<string, Message[]>();
  private readonly clips = new Map<string, Clip>();
  constructor(private readonly store: { keep(messages: Message[]): string }) {}

  /** An answer as it was posted, so sharing any of its messages copies all of them. */
  keep(trail: Posted[]): void {
    const messages = trail.map(entry => entry.message);
    for (const { id } of trail) this.remember(this.trails, id, messages);
  }

  /** Returns the note the sharer sees. */
  copyAnswer(userId: string, messageId: string): string {
    const messages = this.trails.get(messageId);
    if (!messages) return 'this can\'t be shared: only teapilot\'s recent answers and games can.';
    this.remember(this.clips, userId, { messages });
    return 'copied! use `/paste` in another channel to share it.';
  }

  copyApp(userId: string, playId: string): string {
    this.remember(this.clips, userId, { playId });
    return 'copied! use `/paste` in another channel to move this game there.';
  }

  paste(userId: string): Paste {
    const clip = this.clips.get(userId);
    if (!clip) return { note: emptyClipboard };
    if ('playId' in clip) return { playId: clip.playId };
    if (!floods(clip.messages)) return { messages: clip.messages };
    clip.stored ??= this.store.keep(clip.messages);
    return { messages: [{
      content: preview(clip.messages),
      components: [{ type: 1, components: [{ type: 2, style: 2, label: 'click to expand', custom_id: `${expandPrefix}${clip.stored}:expand` }] }],
      source: clip.messages.map(message => message.source).join('\n'),
    }] };
  }

  private remember<T>(map: Map<string, T>, key: string, value: T): void {
    map.delete(key); map.set(key, value);
    if (map.size > keepLimit) map.delete(map.keys().next().value!);
  }
}
