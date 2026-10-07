// An in-memory Discord for testing teapilot's Discord features without Discord. It stands in for
// src/discord/gateway.ts only: routing, conversations, models and discord.play all run for real.
// Everything the bot sends is checked the way discord.js and Discord would check it.
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browseGone, browseModal, browseModalPrefix, browsePrefix, browseRows, browseSubmit, type BrowseAction, type BrowseSession, type WorkspaceBrowser } from '../../src/discord/browse.js';
import type { CardButton, CardControls, DiscordTransport } from '../../src/discord/bridge.js';
import type { connect, GatewayHandlers } from '../../src/discord/gateway.js';
import { grantPrefix, grantsGone, grantView, type GrantPanel } from '../../src/discord/grants-panel.js';
import type { Permission } from '../../src/execution/grants.js';
import { planButtons, planModal, type PlanAction, type PlanControls } from '../../src/discord/plan.js';
import { parseCustomId, type ModalPayload } from '../../src/discord/play/render.js';
import type { PlayInteraction } from '../../src/discord/play/runtime.js';
import type { DiscordSettings } from '../../src/discord/settings.js';
import { viewSource } from 'pretty-send';
import { MESSAGE_LIMIT, viewSourcePrefix } from '../../src/discord/render.js';
import { checkFiles, checkMessage, checkModal, componentsV2, DiscordRejected } from './validate.js';
import type { CheckpointDecision } from '../../src/agents/checkpoint.js';
import { checkpointDetailsText, checkpointModal, checkpointWaitMs, checkpointModalPrefix, checkpointPrefix, checkpointRow, checkpointVerdict, checkpointWaiting, steerHoldMs, type CheckpointButton } from '../../src/discord/checkpoint.js';

type Json = Record<string, unknown>;
type Row = { type: number; components: Json[] };
interface Upload { name: string; data: Buffer }
interface Payload { content?: string; embeds?: Json[]; components?: Row[]; files?: Upload[]; flags?: number }
/** An attachment as the simulator keeps it: on disk, so whoever drives it can open the file. */
export interface Attachment { name: string; size: number; path: string }

/** One control as `click`/`select` address it, and as Discord received it. */
export interface SnapshotControl {
  id: string; type: number; label?: string; emoji?: { id?: string; name?: string }; url?: string;
  style?: number; disabled: boolean; customId?: string;
  options?: Array<{ label: string; value: string; description?: string }>;
}

/** A message with the payload Discord received, rather than the lines `screen` draws it as. */
export interface SnapshotMessage {
  id: string; channel: string; author: string; content: string; embeds: Json[]; components: Row[];
  flags?: number; files: Attachment[]; only?: string; replyTo?: string; edits: number; reactions: string[];
  controls: SnapshotControl[];
}

/** `World.snapshot()`: the whole simulated Discord, as data. */
export interface WorldSnapshot {
  messages: SnapshotMessage[];
  warnings: Warning[];
  forms: Array<{ person: string; from: string; payload: ModalPayload }>;
  channels: Channel[];
}
const kilobytes = (bytes: number) => bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export interface Person { name: string; id: string }
/** An operator, a whitelisted user, and someone teapilot does not know. */
export const people = {
  op: { name: 'op', id: '100000000000000001' },
  user: { name: 'user', id: '100000000000000002' },
  stranger: { name: 'stranger', id: '100000000000000003' },
} satisfies Record<string, Person>;
export type PersonName = keyof typeof people;
export const bot: Person = { name: 'teapilot', id: '100000000000000000' };
export const guildId = '300000000000000001';
export const channelId = '200000000000000001';

export interface Channel { id: string; name: string; kind: 'dm' | 'channel' | 'thread'; parent?: string }
export interface Message {
  id: string; channel: Channel; author: string; content: string; embeds: Json[]; components: Row[]; files: Attachment[]; flags?: number;
  /** Ephemeral: only this person sees it. */
  only?: string;
  /** The message this one replies to; teapilot's replies never ping. */
  replyTo?: string;
  edits: number;
  /** Emoji teapilot reacted with. */
  reactions: string[];
  /** Set while approve/deny buttons on this message are waiting. */
  approval?: (approved: boolean) => void;
  /** Whitelisted users may answer the approval too, not only operators. */
  approvalUsers?: boolean;
  /** Set while a checkpoint card waits for continue, steer or stop. */
  checkpoint?: { nonce: string; details: string; resolve(decision: CheckpointDecision, actor?: string): void; steering(): boolean };
}

/** A mistake in how the simulator was asked to act, such as clicking a control that does not exist. */
export class SimError extends Error {}

/** A `⚠` line, kept as data so tooling can read it without parsing rendered text. */
export interface Warning {
  /** The line as `screen` and `log` show it, without the leading `⚠ `. */
  text: string;
  /** `rejection` when Discord would have refused the message, edit or form. */
  kind: 'rejection' | 'other';
  /** What was refused, for a rejection: `a message in #dm-op`, `an edit to m4`, `the form on m4`. */
  what?: string;
  /** Discord's or discord.js's own reason, for a rejection. */
  message?: string;
}

const styles: Record<number, string> = { 1: 'primary', 3: 'success', 4: 'danger' };
const settle = (text: string, verdict: string) => `${text.slice(0, 2000 - verdict.length - 2)}\n\n${verdict}`;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class World {
  readonly messages: Message[] = [];
  /** The operator log from teapilot, oldest first. */
  readonly logs: string[] = [];
  private readonly channels = new Map<string, Channel>([['channel', { id: channelId, name: 'channel', kind: 'channel' }]]);
  /** The form each person has open, by name; Discord shows one at a time. */
  private readonly forms = new Map<string, { message: Message; payload: ModalPayload }>();
  private readonly listeners = new Set<(text: string) => void>();
  private handlers?: GatewayHandlers;
  private operators: readonly string[] = [];
  private counters = { message: 0, thread: 0, approval: 0, browse: 0 };
  /** Status cards by message id, as the gateway keeps them; a restart forgets them. */
  private cards = new Map<string, CardControls['press']>();
  private cardResenders = new Map<string, () => Message>();
  /** Plans by the id of their last message, as the gateway keeps them; a restart forgets them. */
  private plans = new Map<string, PlanControls>();
  /** Folder views under /workspace tree, by nonce, as the gateway keeps them; a restart forgets them. */
  private browsing = new Map<string, BrowseSession>();
  /** Panels under /convo grants, by message id, as the gateway keeps them; a restart forgets them. */
  private panels = new Map<string, GrantPanel>();
  private recent?: Channel;
  /** The bot's custom status, as `teapilot discord start` last set it. */
  status?: string;
  private lastEvent = Date.now();

  /** `files` is where attachments are written, one file per upload. */
  constructor(private readonly files = join(tmpdir(), 'teapilot-discord-files')) {}
  private store(message: string, uploads: Upload[]): Attachment[] {
    if (!uploads.length) return [];
    mkdirSync(this.files, { recursive: true });
    return uploads.map((upload, index) => {
      const path = join(this.files, `${message}-${Date.now().toString(36)}-${index}-${upload.name.replace(/[^\w.-]+/g, '_')}`);
      writeFileSync(path, upload.data);
      return { name: upload.name, size: upload.data.length, path };
    });
  }

  /** Every message, edit, warning and log line, as the text `screen` shows. */
  onEvent(listener: (text: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(text: string): void {
    this.lastEvent = Date.now();
    for (const listener of this.listeners) listener(text);
  }
  /**
   * Every warning, structured as well as rendered: challenge tooling asserts on these instead of
   * scraping `⚠` lines out of `screen` text. `kind` is `rejection` when Discord would have refused it.
   */
  readonly warnings: Warning[] = [];
  warn(text: string, detail?: Partial<Warning>): void {
    this.warnings.push({ text, kind: detail?.kind ?? 'other', ...detail });
    this.logs.push(`⚠ ${text}`);
    this.emit(`⚠ ${text}`);
  }
  log = (text: string): void => { this.logs.push(text); this.emit(`[log] ${text}`); };

  get connected(): boolean { return Boolean(this.handlers); }
  /** When the last message, edit, warning or log line happened. */
  get lastActivity(): number { return this.lastEvent; }

  /** Drop-in for gateway.ts's connect(). */
  connect: typeof connect = async (settings: DiscordSettings, handlers: GatewayHandlers) => {
    this.handlers = handlers;
    this.operators = settings.allowedUserIds;
    return {
      botName: `${bot.name} (simulated)`,
      username: async id => Object.values(people).find(person => person.id === id)?.name,
      play: {
        post: async (channel, payload) => this.post(this.channel(channel), bot.name, payload as Payload).id,
        edit: async (channel, id, payload) => {
          const message = this.find(id);
          if (message.channel.id !== channel) throw new Error('Unknown Message');
          // Like the gateway, an app's edit replaces the attachments the message had.
          this.update(message, { ...payload as Payload, files: (payload as Payload).files ?? [] });
        },
        request: async (method, route) => {
          this.warn(`A trusted app called Discord REST ${method} ${route}; the simulator does not emulate REST routes.`);
          throw new Error('The Discord simulator does not emulate REST routes.');
        },
      },
      setStatus: async text => {
        this.status = text;
        this.log(`status: ${text ?? '(cleared)'}`);
      },
      close: async () => {
        this.handlers = undefined;
        this.cards.clear();
        this.cardResenders.clear();
        this.plans.clear();
        this.browsing.clear();
        this.panels.clear();
        // Like the real gateway: pending approvals resolve as denied, and their buttons stay behind.
        for (const message of this.messages) { const resolve = message.approval; message.approval = undefined; resolve?.(false); }
      },
    };
  };

  person(name: string): Person {
    const person = people[name as PersonName];
    if (!person) throw new SimError(`Unknown person ${name}. Use ${Object.keys(people).join(', ')}.`);
    return person;
  }
  private nameOf(id: string): string { return [bot, ...Object.values(people)].find(person => person.id === id)?.name ?? id; }

  channel(ref: string): Channel {
    const channel = this.channels.get(ref) ?? [...this.channels.values()].find(entry => entry.id === ref);
    if (!channel) throw new SimError(`No channel ${ref}. Channels: ${[...this.channels.keys()].join(', ')}.`);
    return channel;
  }
  private dm(person: Person): Channel {
    const name = `dm-${person.name}`;
    if (!this.channels.has(name)) this.channels.set(name, { id: name, name, kind: 'dm' });
    return this.channels.get(name)!;
  }

  find(ref: string): Message {
    const id = /^\d+$/.test(ref) ? `m${ref}` : ref;
    const message = this.messages.find(entry => entry.id === id);
    if (!message) throw new SimError(`No message ${ref}.`);
    return message;
  }

  /** Mentions typed as @op, @user, @stranger or @teapilot become Discord mentions. */
  private mention(text: string): string {
    return text.replace(/@(\w+)\b/g, (match, name: string) => name === bot.name ? `<@${bot.id}>` : name in people ? `<@${people[name as PersonName].id}>` : match);
  }
  private display(text: string): string { return text.replace(/<@!?(\d+)>/g, (_match, id: string) => `@${this.nameOf(id)}`); }

  private check(what: string, run: () => void): void {
    try { run(); } catch (error) {
      if (error instanceof DiscordRejected) this.warn(`Discord would reject ${what}: ${error.message}`, { kind: 'rejection', what, message: error.message });
      throw error;
    }
  }

  private post(channel: Channel, author: string, payload: Payload, only?: string, replyTo?: Message): Message {
    if (author === bot.name) this.check(`a message in #${channel.name}`, () => { checkMessage(payload); checkFiles(payload); });
    const id = `m${++this.counters.message}`;
    const message: Message = { id, channel, author, content: payload.content ?? '', embeds: payload.embeds ?? [], components: payload.components ?? [], files: this.store(id, payload.files ?? []), flags: payload.flags, only, replyTo: replyTo?.id, edits: 0, reactions: [] };
    this.messages.push(message);
    this.recent = channel;
    this.emit(this.render(message));
    return message;
  }

  private update(message: Message, payload: Payload): void {
    // Discord keeps the Components V2 flag once a message has it.
    const next = { content: payload.content ?? message.content, embeds: payload.embeds ?? message.embeds, components: payload.components ?? message.components, flags: (payload.flags ?? 0) | (message.flags ?? 0) || undefined };
    const uploads = payload.files;
    // Attachments the edit leaves in place still count for attachment:// references.
    const kept = uploads ?? message.files.map(file => ({ name: file.name, data: Buffer.alloc(file.size) }));
    this.check(`an edit to ${message.id}`, () => { checkMessage({ ...next, files: kept }); checkFiles({ ...next, files: kept }); });
    Object.assign(message, next);
    if (uploads) message.files = this.store(message.id, uploads);
    message.edits++;
    this.emit(this.render(message));
  }

  /** With `replyTo`, the first message replies to it, as the gateway's reply transport does. */
  transport(channel: Channel, replyTo?: Message): DiscordTransport {
    const cardIds = new Map<string, string>();
    const reply = () => { const to = replyTo; replyTo = undefined; return to; };
    return {
      send: async (text, options) => this.post(channel, bot.name, { content: text, ...(options?.silent ? { flags: 1 << 12 } : {}) }, undefined, reply()).id,
      sendFiles: async (text, files) => this.post(channel, bot.name, { content: text, files }, undefined, reply()).id,
      answer: async ({ embeds, components, flags, files }) => this.post(channel, bot.name, { embeds: embeds as unknown as Json[], components: components as Row[], flags, files }, undefined, reply()).id,
      edit: async (id, text) => this.update(this.find(id), { content: text }),
      card: async (text, controls, id) => {
        const payload = { content: text, components: [{ type: 1, components: [
          ...(controls.stop ? [{ type: 2, style: 2, label: 'Stop', custom_id: 'teapilot-card:stop' }] : []),
          { type: 2, style: 2, label: 'Details', custom_id: 'teapilot-card:details' },
        ] }] };
        const message = id ? this.find(cardIds.get(id) ?? id) : this.post(channel, bot.name, payload);
        if (id) this.update(message, payload);
        this.cards.set(message.id, controls.press);
        const register = (current: Message) => this.cardResenders.set(current.id, () => {
          const fresh = this.post(channel, bot.name, { content: current.content, components: current.components });
          for (const [alias, latest] of cardIds) if (latest === current.id) cardIds.set(alias, fresh.id);
          cardIds.set(current.id, fresh.id);
          this.cards.set(fresh.id, this.cards.get(current.id)!);
          this.cards.delete(current.id); this.cardResenders.delete(current.id);
          register(fresh);
          this.update(current, { content: '-# this card moved to a newer message below.', components: [] });
          return fresh;
        });
        register(message);
        return message.id;
      },
      plan: async (messages, controls, ids = []) => {
        const posted: string[] = [];
        messages.forEach((embeds, index) => {
          const last = index === messages.length - 1;
          const components = last && controls.actions.length ? [{ type: 1, components: controls.actions.map(action => ({
            type: 2, style: planButtons[action].style === 'success' ? 3 : 2, label: planButtons[action].label,
            ...(planButtons[action].emoji ? { emoji: { name: planButtons[action].emoji } } : {}), custom_id: `teapilot-plan:${action}` })) }] : [];
          const known = ids[index];
          if (known) { this.update(this.find(known), { embeds: embeds as unknown as Json[], components }); posted.push(known); }
          else posted.push(this.post(channel, bot.name, { embeds: embeds as unknown as Json[], components }, undefined, reply()).id);
        });
        for (const id of ids.slice(messages.length)) {
          const at = this.messages.findIndex(message => message.id === id);
          if (at >= 0) { this.messages.splice(at, 1); this.emit(`${bot.name} deleted ${id}`); }
        }
        if (ids.length) this.plans.delete(ids.at(-1)!);
        this.plans.set(posted.at(-1)!, controls);
        return posted;
      },
      typing: () => this.emit(`… ${bot.name} is typing in ${channel.name}`),
      // Like the real gateway (src/discord/checkpoint.ts): it continues by itself unless someone steers or stops.
      askCheckpoint: (text, details, signal, timeoutMs = checkpointWaitMs) => {
        if (signal.aborted) return Promise.resolve({ action: 'continue' as const });
        const nonce = String(++this.counters.approval);
        const message = this.post(channel, bot.name, { content: checkpointWaiting(text, timeoutMs), components: [checkpointRow(nonce) as Row] });
        return new Promise<CheckpointDecision>(resolve => {
          let timer = setTimeout(() => finish({ action: 'continue' }), timeoutMs);
          const finish = (decision: CheckpointDecision, actor?: string) => {
            if (!message.checkpoint) return;
            message.checkpoint = undefined;
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            this.update(message, { content: settle(text, checkpointVerdict(decision, actor)), components: [] });
            resolve(decision);
          };
          const abort = () => finish({ action: 'continue' });
          message.checkpoint = { nonce, details, resolve: finish,
            steering: () => { if (!message.checkpoint) return false; clearTimeout(timer); timer = setTimeout(() => finish({ action: 'continue' }), steerHoldMs); return true; } };
          signal.addEventListener('abort', abort, { once: true });
        });
      },
      askApproval: (text, signal, users = false) => {
        if (signal.aborted) return Promise.resolve(false);
        const nonce = ++this.counters.approval;
        const message = this.post(channel, bot.name, { content: text, components: [{ type: 1, components: [
          { type: 2, style: 3, label: 'Approve', custom_id: `teapilot:${nonce}:approve` },
          { type: 2, style: 4, label: 'Deny', custom_id: `teapilot:${nonce}:deny` },
        ] }] });
        return new Promise<boolean>(resolve => {
          const expire = () => {
            if (!message.approval) return;
            message.approval = undefined;
            this.update(message, { content: settle(text, '**Denied** (expired or cancelled)'), components: [] });
            resolve(false);
          };
          message.approvalUsers = users;
          message.approval = approved => { signal.removeEventListener('abort', expire); resolve(approved); };
          signal.addEventListener('abort', expire, { once: true });
        });
      },
    };
  }

  /** A person sends a message: in their DM by default, in `channel` (mentioning teapilot), or in a thread. */
  say(name: string, text: string, where?: string, uploads: Array<Upload & { contentType?: string }> = []): Message {
    const person = this.person(name);
    const handlers = this.handlers;
    if (!handlers) throw new SimError('teapilot is not connected.');
    const channel = where ? this.channel(where) : this.dm(person);
    if (channel.kind === 'dm' && channel.name !== `dm-${person.name}`) throw new SimError(`${channel.name} is someone else's DM.`);
    let content = this.mention(text);
    if (channel.kind === 'channel' && !content.includes(`<@${bot.id}>`)) content = `<@${bot.id}> ${content}`;
    const message = this.post(channel, person.name, { content, files: uploads });
    const thread = channel.kind === 'thread' ? channel : undefined;
    handlers.message({
      authorId: person.id, authorIsBot: false, authorName: person.name,
      guildId: channel.kind === 'dm' ? undefined : guildId, channelId: channel.id, parentId: thread?.parent,
      ownThread: Boolean(thread), mentionsBot: content.includes(`<@${bot.id}>`),
      // The gateway strips mentions of the bot.
      content: content.replaceAll(`<@${bot.id}>`, '').trim(),
      attachments: uploads.map(upload => ({ name: upload.name, size: upload.data.length, contentType: upload.contentType, download: async () => upload.data })),
      replyChain: async () => ({ messages: [], truncated: false }),
      transport: () => this.transport(channel),
      replyTransport: () => this.transport(channel, message),
      react: async emoji => {
        if (!message.reactions.includes(emoji)) message.reactions.push(emoji);
        this.emit(`${bot.name} reacted ${emoji} to ${message.id}`);
      },
      startThread: async title => {
        const name = `thread-${++this.counters.thread}`;
        const created: Channel = { id: name, name, kind: 'thread', parent: channel.id };
        this.channels.set(name, created);
        this.emit(`# ${name} started from ${message.id}: ${title.slice(0, 90)}`);
        return { id: created.id, transport: this.transport(created) };
      },
    });
    return message;
  }

  private visible(ref: string, person: Person): Message {
    const message = this.find(ref);
    if (message.only && message.only !== person.name) throw new SimError(`${person.name} cannot see ${message.id}; only ${message.only} can.`);
    return message;
  }
  private controls(message: Message): Json[] { return message.components.flatMap(row => row.type === 1 ? row.components : []); }
  private controlId(control: Json): string | undefined {
    if (typeof control.custom_id !== 'string') return undefined;
    return parseCustomId(control.custom_id)?.id ?? control.custom_id.split(':').at(-1);
  }
  private control(message: Message, id: string): Json {
    const control = this.controls(message).find(entry => this.controlId(entry) === id || (entry.url && entry.label === id));
    if (!control) {
      const ids = this.controls(message).map(entry => this.controlId(entry) ?? String(entry.label)).join(', ');
      throw new SimError(`${message.id} has no control ${id}.${ids ? ` Controls: ${ids}.` : ''}`);
    }
    if (control.disabled) throw new SimError(`${id} on ${message.id} is disabled; Discord does not let anyone use it.`);
    return control;
  }

  async click(name: string, ref: string, id: string): Promise<string> {
    const person = this.person(name);
    const message = this.visible(ref, person);
    const control = this.control(message, id);
    if (control.type !== 2) throw new SimError(`${id} is a select; use select.`);
    if (typeof control.url === 'string') return `${person.name} opened ${control.url}; links never reach teapilot.`;
    const custom = String(control.custom_id);
    if (custom.startsWith('teapilot:')) return this.answerApproval(person, message, custom.endsWith(':approve'));
    if (custom.startsWith(checkpointPrefix)) return this.pressCheckpoint(person, message, custom.split(':').at(-1) as CheckpointButton);
    if (custom.startsWith('teapilot-plan:')) return this.pressPlan(person, message, custom.slice('teapilot-plan:'.length) as PlanAction);
    if (custom.startsWith(browsePrefix)) return this.pressBrowse(person, message, custom.slice(browsePrefix.length));
    if (custom.startsWith(grantPrefix)) return this.pressGrant(person, message, custom.slice(grantPrefix.length) as Permission);
    if (custom.startsWith('teapilot-card:')) return this.pressCard(person, message, custom.slice('teapilot-card:'.length) as CardButton);
    if (custom.startsWith(viewSourcePrefix)) return this.pressViewSource(person, message, custom);
    return this.interact(person, message, 'button', custom, `clicked [${this.label(control)}]`);
  }

  /** The Apps → repost this! message context menu, independent of the message's controls. */
  async repost(name: string, ref: string): Promise<string> {
    const person = this.person(name);
    const message = this.visible(ref, person);
    const resend = this.cardResenders.get(message.id);
    if (resend) return `${person.name} used Apps → repost this! on ${message.id}.\n${this.render(resend())}`;
    const playId = this.handlers?.resendTarget?.(message.channel.id, message.id);
    if (!playId) return this.render(this.post(message.channel, bot.name, { content: 'this message is not an available card or app.' }, person.name));
    return this.interact(person, message, 'resend', `play:${playId}:resend`, 'used Apps → repost this!');
  }

  /** Like the real gateway: operators may answer approvals, and whitelisted users the ones that allow them. */
  private answerApproval(person: Person, message: Message, approved: boolean): string {
    const note = (content: string) => this.render(this.post(message.channel, bot.name, { content }, person.name));
    if (!this.operators.includes(person.id) && !(message.approval && message.approvalUsers && this.handlers?.allowed?.(person.id))) return note('You are not allowed to approve teapilot actions.');
    const resolve = message.approval;
    if (!resolve) return note('This approval is no longer pending.');
    message.approval = undefined;
    this.update(message, { content: settle(message.content, `**${approved ? 'Approved' : 'Denied'}** by <@${person.id}>`), components: [] });
    resolve(approved);
    return `${person.name} ${approved ? 'approved' : 'denied'} ${message.id}.`;
  }

  /** Like the real gateway: details are private, steer opens a form, and anyone who may use teapilot can answer. */
  private pressCheckpoint(person: Person, message: Message, action: CheckpointButton): string {
    const label = `${person.name} clicked [${action}] on ${message.id}.`;
    const note = (content: string) => `${label}\n${this.render(this.post(message.channel, bot.name, { content }, person.name))}`;
    const checkpoint = message.checkpoint;
    if (!checkpoint) return note('this checkpoint has already moved on.');
    if (action === 'details') return note(checkpointDetailsText(checkpoint.details, MESSAGE_LIMIT));
    if (!this.operators.includes(person.id) && this.handlers?.allowed?.(person.id) !== true) return note('You are not allowed to use teapilot.');
    if (action === 'steer') {
      checkpoint.steering();
      const payload = checkpointModal(checkpoint.nonce) as ModalPayload;
      this.check(`the form on ${message.id}`, () => checkModal(payload));
      this.forms.set(person.name, { message, payload });
      this.emit(`${person.name} opened form "${payload.title}" from ${message.id}`);
      return `${label}\n${person.name} sees a form:\n${this.renderForm(payload)}`;
    }
    checkpoint.resolve({ action: action === 'stop' ? 'stop' : 'continue' }, person.id);
    return label;
  }

  /** Like the real gateway: the buttons edit the plan in place, and only a refusal is said, privately. Request change opens a form. */
  private pressPlan(person: Person, message: Message, action: PlanAction): string {
    const controls = this.plans.get(message.id);
    const refusal = controls ? controls.refusal(person.id) : 'This plan is no longer available: teapilot restarted since, or it was replaced.';
    const label = `${person.name} clicked [${planButtons[action].label}] on ${message.id}.`;
    if (!controls || refusal) return `${label}
${this.render(this.post(message.channel, bot.name, { content: refusal }, person.name))}`;
    if (action === 'change') {
      const payload: ModalPayload = { custom_id: `teapilot-plan-modal:${message.id}`, title: planModal.title, components: [{ type: 1, components: [
        { type: 4, custom_id: planModal.field, label: planModal.label, style: 2, required: true, max_length: planModal.maxLength }] }] } as ModalPayload;
      this.check(`the form on ${message.id}`, () => checkModal(payload));
      this.forms.set(person.name, { message, payload });
      this.emit(`${person.name} opened form "${payload.title}" from ${message.id}`);
      return `${label}
${person.name} sees a form:
${this.renderForm(payload)}`;
    }
    const note = controls.press(action, { id: person.id, name: person.name });
    return note ? `${label}
${this.render(this.post(message.channel, bot.name, { content: note }, person.name))}` : label;
  }

  /** Like the real gateway: each button opens a form, and the folder form starts from the folder on show. */
  private pressBrowse(person: Person, message: Message, rest: string): string {
    const [nonce, action] = rest.split(':') as [string, BrowseAction];
    const session = this.browsing.get(nonce);
    const label = `${person.name} clicked [${action === 'folder' ? 'open folder' : 'open file'}] on ${message.id}.`;
    if (!session) return `${label}\n${this.render(this.post(message.channel, bot.name, { content: browseGone }, person.name))}`;
    const payload = browseModal(action, nonce, session.dir) as ModalPayload;
    this.check(`the form on ${message.id}`, () => checkModal(payload));
    this.forms.set(person.name, { message, payload });
    this.emit(`${person.name} opened form "${payload.title}" from ${message.id}`);
    return `${label}\n${person.name} sees a form:\n${this.renderForm(payload)}`;
  }

  /**
   * Like the real gateway: the press is acknowledged at once, and the panel is repainted once it settles, which can
   * wait on an operator's approval. Only a refusal is said, privately.
   */
  private async pressGrant(person: Person, message: Message, permission: Permission): Promise<string> {
    const panel = this.panels.get(message.id);
    const say = (content: string) => this.render(this.post(message.channel, bot.name, { content }, person.name));
    const seen = [`${person.name} clicked [${permission}] on ${message.id}.`];
    if (!panel) return `${seen[0]}\n${say(grantsGone)}`;
    let settled = false;
    void panel.press(permission, person.id).catch(error => `that didn't work: ${error instanceof Error ? error.message : String(error)}`).then(note => {
      settled = true;
      this.update(message, grantView(panel) as Payload);
      seen.push(this.render(message));
      if (note) seen.push(say(note));
    });
    for (const deadline = Date.now() + 1000; !settled && Date.now() < deadline;) await pause(20);
    await this.quiet(150, 1000);
    if (!settled) seen.push('(waiting on an approval; check screen later)');
    return seen.join('\n');
  }

  /** Like the real gateway: anyone may press, and the table is read back from the embed, privately. */
  private pressViewSource(person: Person, message: Message, custom: string): string {
    const source = viewSource(custom, message.embeds[0] as never, viewSourcePrefix);
    const block = source && `\`\`\`md\n${source}\n\`\`\``;
    const content = !block ? 'this table can no longer be read back.' : block.length <= MESSAGE_LIMIT ? block : 'the table is attached.';
    const files = block && block.length > MESSAGE_LIMIT ? [{ name: 'table.md', data: Buffer.from(`${source}\n`) }] : [];
    const note = this.post(message.channel, bot.name, { content, files }, person.name);
    return `${person.name} clicked [view source] on ${message.id}.\n${this.render(note)}`;
  }

  /** Like the real gateway: anyone may press, the conversation decides, and only the presser sees the answer. */
  private pressCard(person: Person, message: Message, button: CardButton): string {
    const press = this.cards.get(message.id);
    const reply = press ? press(button, person.id) : { text: 'This turn is no longer available: teapilot restarted since, or the turn is too old.' };
    const note = this.post(message.channel, bot.name, { content: reply.text }, person.name);
    const file = reply.file ? `\n  📎 ${reply.file.name}:\n${reply.file.content.split('\n').map(line => `    ${line}`).join('\n')}` : '';
    return `${person.name} clicked [${button === 'stop' ? 'Stop' : 'Details'}] on ${message.id}.\n${this.render(note)}${file}`;
  }

  /** The newest approval still waiting, if any. */
  pendingApproval(): Message | undefined { return this.messages.findLast(message => message.approval); }

  async select(name: string, ref: string, id: string, choices: string[]): Promise<string> {
    const person = this.person(name);
    const message = this.visible(ref, person);
    const control = this.control(message, id);
    if (control.type !== 3) throw new SimError(`${id} is a button; use click.`);
    const options = control.options as Array<{ label: string; value: string }>;
    // Discord's client enforces the options and counts; accept a label or a value.
    const values = choices.map(choice => {
      const option = options.find(entry => entry.value === choice) ?? options.find(entry => entry.label === choice);
      if (!option) throw new SimError(`${id} has no option ${choice}. Options: ${options.map(entry => entry.value).join(', ')}.`);
      return option.value;
    });
    const min = (control.min_values as number | undefined) ?? 1, max = (control.max_values as number | undefined) ?? 1;
    if (values.length < min || values.length > max) throw new SimError(`${id} takes ${min === max ? min : `${min}–${max}`} choice(s), not ${values.length}.`);
    return this.interact(person, message, 'select', String(control.custom_id), `chose ${values.join(', ')} in <${id}>`, values);
  }

  /** Submits the form this person has open, as Discord's client would after checking it. */
  async submit(name: string, fields: Record<string, string>): Promise<string> {
    const person = this.person(name);
    const form = this.forms.get(person.name);
    if (!form) throw new SimError(`${person.name} has no form open. Click the button that opens it first.`);
    const inputs = form.payload.components.map(row => row.components[0]!);
    const ids = inputs.map(input => String(input.custom_id));
    const unknown = Object.keys(fields).filter(key => !ids.includes(key));
    if (unknown.length) throw new SimError(`The form has no field ${unknown.join(', ')}. Fields: ${ids.join(', ')}.`);
    for (const input of inputs) {
      const value = fields[String(input.custom_id)] ?? '';
      if (input.required !== false && !value) throw new SimError(`${String(input.custom_id)} is required.`);
      if (typeof input.max_length === 'number' && value.length > input.max_length) throw new SimError(`${String(input.custom_id)} takes at most ${input.max_length} characters.`);
      if (typeof input.min_length === 'number' && value && value.length < input.min_length) throw new SimError(`${String(input.custom_id)} needs at least ${input.min_length} characters.`);
    }
    this.forms.delete(person.name);
    if (form.payload.custom_id.startsWith(browseModalPrefix)) return this.submitBrowse(person, form, fields[String(inputs[0]!.custom_id)] ?? '');
    if (form.payload.custom_id.startsWith(checkpointModalPrefix)) {
      const text = (fields.steer ?? '').trim();
      const checkpoint = form.message.checkpoint;
      if (!checkpoint) return `${person.name} submitted "${form.payload.title}", but the checkpoint had already moved on.`;
      checkpoint.resolve(text ? { action: 'steer', text } : { action: 'continue' }, person.id);
      return `${person.name} submitted "${form.payload.title}" on ${form.message.id}.`;
    }
    if (form.payload.custom_id.startsWith('teapilot-plan-modal:')) {
      const controls = this.plans.get(form.message.id);
      const note = controls ? controls.press('change', { id: person.id, name: person.name }, fields[planModal.field] ?? '') : 'This plan is no longer available: teapilot restarted since, or it was replaced.';
      return `${person.name} submitted "${form.payload.title}" on ${form.message.id}.${note ? `
${this.render(this.post(form.message.channel, bot.name, { content: note }, person.name))}` : ''}`;
    }
    return this.interact(person, form.message, 'modal', form.payload.custom_id, `submitted "${form.payload.title}"`, undefined, Object.fromEntries(ids.map(key => [key, fields[key] ?? ''])));
  }

  /** Like the real gateway: a folder edits the view in place; a file or a refusal is said privately. */
  private async submitBrowse(person: Person, form: { message: Message; payload: ModalPayload }, input: string): Promise<string> {
    const [nonce, action] = form.payload.custom_id.slice(browseModalPrefix.length).split(':') as [string, BrowseAction];
    const label = `${person.name} submitted "${form.payload.title}" on ${form.message.id}.`;
    const session = this.browsing.get(nonce);
    const say = (payload: Payload) => this.render(this.post(form.message.channel, bot.name, payload, person.name));
    if (!session) return `${label}\n${say({ content: browseGone })}`;
    const outcome = await browseSubmit(session, action, input);
    if ('show' in outcome) {
      this.update(form.message, { content: outcome.show });
      return `${label}\n${this.render(form.message)}`;
    }
    return `${label}\n${say({ content: outcome.note, files: outcome.file ? [outcome.file] : [] })}`;
  }

  /**
   * A slash command as the session text the gateway makes of it, such as "/convo clear" or "/collab join". Its notes
   * show to that person alone; a note with buttons is answered with button `choice`, or left to expire without one.
   * `oneShot` acts as a channel teapilot cannot post in, where /collab applies.
   */
  async slash(name: string, text: string, where?: string, choice?: number, oneShot = false): Promise<string> {
    const person = this.person(name);
    const handlers = this.handlers;
    if (!handlers) throw new SimError('teapilot is not connected.');
    const channel = where ? this.channel(where) : this.dm(person);
    const thread = channel.kind === 'thread' ? channel : undefined;
    const seen: string[] = [`${person.name} ran ${text} in #${channel.name}.`];
    const note = (content: string, components: Row[] = []) => seen.push(this.render(this.post(channel, bot.name, { content, components }, person.name)));
    let answered = false;
    const first = () => { if (answered) throw new Error('This interaction was already answered.'); answered = true; };
    await new Promise<void>(done => {
      const timer = setTimeout(() => { seen.push('(no response after 15 s)'); done(); }, 15_000);
      const finish = () => { clearTimeout(timer); done(); };
      handlers.command({
        authorId: person.id, authorIsBot: false, guildId: channel.kind === 'dm' ? undefined : guildId, channelId: channel.id, parentId: thread?.parent,
        ownThread: Boolean(thread), mentionsBot: false, text, oneShot,
        respond: async content => { if (answered) { if (content) note(content); return; } first(); if (content) note(content); finish(); },
        browse: async (content, browser: WorkspaceBrowser, dir) => {
          first();
          const nonce = `sim${++this.counters.browse}`;
          this.browsing.set(nonce, { browser, dir });
          note(content, browseRows(nonce));
          finish();
        },
        grants: async panel => {
          first();
          // Posted for everyone, without notifying anyone.
          const message = this.post(channel, bot.name, grantView(panel) as Payload);
          this.panels.set(message.id, panel);
          seen.push(this.render(message));
          finish();
        },
        choose: async (content, labels) => {
          first();
          note(content, [{ type: 1, components: labels.map((label, index) => ({ type: 2, style: index ? 2 : 1, label, custom_id: `teapilot-choice:sim:${index}` })) }]);
          if (choice === undefined || !labels[choice]) { seen.push(`(no button pressed; run again with --choose 0-${labels.length - 1})`); finish(); return undefined; }
          seen.push(`${person.name} pressed "${labels[choice]}".`);
          return { choice, settle: async settled => { note(settled); finish(); }, transport: () => this.transport(channel) };
        },
      });
    });
    await this.quiet(150, 1000);
    return seen.join('\n');
  }

  /** What Discord would offer while `name` types `typed` into the option of `text`'s command, such as "/workspace tree". */
  async complete(name: string, text: string, typed: string, where?: string): Promise<string> {
    const person = this.person(name);
    const handlers = this.handlers;
    if (!handlers?.complete) throw new SimError('teapilot does not complete options.');
    const channel = where ? this.channel(where) : this.dm(person);
    const thread = channel.kind === 'thread' ? channel : undefined;
    const choices = await new Promise<string[]>(resolve => handlers.complete!({
      authorId: person.id, authorIsBot: false, guildId: channel.kind === 'dm' ? undefined : guildId, channelId: channel.id, parentId: thread?.parent,
      ownThread: Boolean(thread), mentionsBot: false, text, typed, respond: async offered => resolve(offered),
    }));
    if (choices.length > 25) this.warn(`teapilot offered ${choices.length} completions; Discord takes at most 25.`);
    return choices.length ? choices.map(choice => `  ${choice}`).join('\n') : '(no suggestions)';
  }

  /** One component interaction, held to Discord's rules: one first response within 3 s, and edits only after it. */
  private async interact(person: Person, message: Message, kind: PlayInteraction['kind'], custom: string, action: string, values?: string[], fields?: Record<string, string>): Promise<string> {
    const handlers = this.handlers;
    if (!handlers) throw new SimError('teapilot is not connected.');
    const resend = kind === 'resend';
    const target = parseCustomId(custom);
    if (!target) throw new SimError(`${custom} is not a discord.play control.`);
    const seen: string[] = [`${person.name} ${action} on ${message.id}.`];
    const started = Date.now();
    let state: 'new' | 'deferred' | 'replied' | 'form' = 'new';
    let updated = false, notes = 0;
    const first = (what: string) => {
      if (state !== 'new') throw new Error(`Interaction has already been acknowledged (${what}).`);
      const late = Date.now() - started;
      if (late > 3000) { this.warn(`${what} came ${late} ms after ${person.name}'s ${kind} on ${message.id}; Discord allows 3000 ms, so it shows "This interaction failed".`); throw new Error('Unknown interaction'); }
    };
    const note = (content: string, embeds?: Json[]) => {
      notes++;
      seen.push(this.render(this.post(message.channel, bot.name, { content, embeds }, person.name)));
    };
    const interaction: PlayInteraction = {
      playId: target.playId, controlId: target.id, messageId: message.id, kind: resend ? 'resend' : kind, user: { id: person.id, name: person.name }, values, fields,
      post: resend ? async payload => {
        if (state !== 'deferred') throw new Error('repost needs deferUpdate first.');
        const fresh = this.post(message.channel, bot.name, payload);
        seen.push(this.render(fresh));
        notes++;
        return { id: fresh.id, edit: async next => this.update(fresh, next) };
      } : undefined,
      openModal: async payload => {
        if (kind === 'modal') throw new Error('A form cannot open another form.');
        first('showModal');
        this.check(`the form on ${message.id}`, () => checkModal(payload));
        state = 'form';
        this.forms.set(person.name, { message, payload });
        seen.push(`${person.name} sees a form:\n${this.renderForm(payload)}`);
        this.emit(`${person.name} opened form "${payload.title}" from ${message.id}`);
      },
      reply: async content => { first('reply'); state = 'replied'; note(content); },
      defer: async () => { first('deferUpdate'); state = 'deferred'; },
      update: async payload => {
        if (state !== 'deferred') throw new Error('editReply before deferUpdate.');
        this.update(message, { ...payload as Payload, files: (payload as Payload).files ?? [] });
        updated = true;
      },
      followUp: async (content, embeds) => {
        if (state === 'new') throw new Error('followUp before the interaction was acknowledged.');
        note(content, embeds);
      },
    };
    const unanswered = setTimeout(() => { if (state === 'new') this.warn(`Nothing answered ${person.name}'s ${kind} on ${message.id} within 3 s; Discord shows "This interaction failed".`); }, 3000);
    handlers.component(interaction);
    const done = () => state === 'form' || state === 'replied' || (state === 'deferred' && (updated || notes > 0));
    for (const deadline = Date.now() + 15_000; !done() && Date.now() < deadline;) await pause(20);
    clearTimeout(unanswered);
    // Notes can follow an update; give them a moment.
    await this.quiet(150, 1000);
    if (updated) seen.push(this.render(message));
    if (!done()) seen.push('(no response after 15 s; check screen later)');
    return seen.join('\n');
  }

  /** Resolves once nothing has happened for `ms`, or after `max`. */
  async quiet(ms: number, max: number): Promise<void> {
    for (const deadline = Date.now() + max; Date.now() - this.lastEvent < ms && Date.now() < deadline;) await pause(Math.min(ms, 20));
  }

  private label(control: Json): string {
    const emoji = control.emoji as { id?: string; name?: string } | undefined;
    const icon = emoji ? emoji.id ? `:${emoji.name}:` : emoji.name : undefined;
    return [icon, control.label].filter(Boolean).join(' ');
  }

  private renderControl(control: Json): string {
    if (control.type === 2) {
      if (typeof control.url === 'string') return `[${this.label(control)}](${control.url})`;
      const notes = [this.controlId(control), styles[control.style as number], control.disabled ? 'disabled' : undefined].filter(Boolean);
      return `[${this.label(control)}](${notes.join(', ')})`;
    }
    // Shown as an option looks in Discord: its emoji and label, then its description underneath.
    const options = (control.options as Array<Json & { label: string; value: string; description?: string; default?: boolean }>).map(option =>
      `${this.label(option)}${option.label === option.value ? '' : `=${option.value}`}${option.description ? ` "${option.description}"` : ''}${option.default ? '*' : ''}`);
    const min = (control.min_values as number | undefined) ?? 1, max = (control.max_values as number | undefined) ?? 1;
    return `<select ${this.controlId(control)}${min === 1 && max === 1 ? '' : ` ${min}–${max}`}${control.disabled ? ', disabled' : ''}${control.placeholder ? ` "${String(control.placeholder)}"` : ''}: ${options.join(' | ')}>`;
  }

  /** A Components V2 component as lines: text as it reads, a divider as a rule, and media by url. */
  private renderComponent(component: Json): string[] {
    const children = (component.components as Json[] | undefined) ?? [];
    const media = (item: Json) => String((item.media as { url?: string } | undefined)?.url ?? '');
    switch (component.type) {
      case 1: return [children.map(control => this.renderControl(control)).join(' ')];
      case 9: return [...children.flatMap(child => this.renderComponent(child)), ...this.renderComponent(component.accessory as Json)];
      case 10: return this.display(String(component.content)).split('\n');
      case 11: return [`🖼 thumbnail: ${media(component)}`];
      case 12: return [`🖼 gallery: ${(component.items as Json[]).map(media).join(', ')}`];
      case 13: return [`📄 file: ${String((component.file as { url?: string }).url)}`];
      case 14: return [component.divider === false ? '' : '───'];
      case 17: return children.flatMap(child => this.renderComponent(child)).map(line => `│ ${line}`);
      default: return [`(component type ${String(component.type)})`];
    }
  }

  private renderEmbed(embed: Json): string[] {
    const lines: string[] = [];
    const color = typeof embed.color === 'number' ? ` (#${embed.color.toString(16).padStart(6, '0')})` : '';
    if (embed.title) lines.push(`**${String(embed.title)}**${color}`); else if (color) lines.push(color.trim());
    if (embed.description) lines.push(...this.display(String(embed.description)).split('\n'));
    for (const field of (embed.fields as Array<{ name: string; value: string; inline?: boolean }> | undefined) ?? []) lines.push(`${field.name}: ${this.display(field.value).replaceAll('\n', ' / ')}${field.inline ? ' (inline)' : ''}`);
    const footer = embed.footer as { text?: string } | undefined;
    if (footer?.text) lines.push(`-# ${footer.text}`);
    for (const key of ['image', 'thumbnail'] as const) { const media = embed[key] as { url?: string } | undefined; if (media?.url) lines.push(`${key}: ${media.url}`); }
    return lines.map(line => `┃ ${line}`);
  }

  private renderForm(payload: ModalPayload): string {
    const fields = payload.components.map(row => {
      const input = row.components[0]!;
      const rules = [input.style === 2 ? 'paragraph' : 'short', input.required === false ? 'optional' : 'required', typeof input.max_length === 'number' ? `max ${input.max_length}` : undefined].filter(Boolean).join(', ');
      return `  ${String(input.custom_id)}: ${String(input.label)} (${rules})`;
    });
    return [`  "${payload.title}"`, ...fields].join('\n');
  }

  render(message: Message): string {
    const header = `${message.id} ${message.author}${message.replyTo ? ` (replying to ${message.replyTo}, no ping)` : ''}${message.only ? ` (only ${message.only} sees this)` : ''}${message.edits ? ' (edited)' : ''} in #${message.channel.name}:`;
    const lines = [
      ...(message.content ? this.display(message.content).split('\n') : []),
      ...message.embeds.flatMap(embed => this.renderEmbed(embed)),
      ...(message.flags && message.flags & componentsV2 ? message.components.flatMap(component => this.renderComponent(component)) : message.components.map(row => row.components.map(control => this.renderControl(control)).join(' '))),
      ...message.files.map(file => `📎 ${file.name} (${kilobytes(file.size)}) → ${file.path}`),
      ...(message.reactions.length ? [`reactions: ${message.reactions.join(' ')}`] : []),
    ];
    return [header, ...lines.map(line => `  ${line}`)].join('\n');
  }

  /**
   * Everything in the world as plain data: each message with the payload Discord received, the
   * controls it carries with the ids `click` accepts, and every warning. Challenge tooling asserts
   * on this rather than on `screen`'s rendered text, and can re-run validate.ts over it offline.
   */
  snapshot(): WorldSnapshot {
    return {
      messages: this.messages.map((message): SnapshotMessage => ({
        id: message.id, channel: message.channel.name, author: message.author, content: message.content,
        embeds: message.embeds, components: message.components, flags: message.flags, files: message.files,
        only: message.only, replyTo: message.replyTo, edits: message.edits, reactions: message.reactions,
        controls: this.controls(message).map((control): SnapshotControl => ({
          id: this.controlId(control) ?? String(control.label),
          type: control.type as number,
          label: control.label as string | undefined,
          emoji: control.emoji as SnapshotControl['emoji'],
          url: control.url as string | undefined,
          style: control.style as number | undefined,
          disabled: Boolean(control.disabled),
          customId: control.custom_id as string | undefined,
          options: control.options as SnapshotControl['options'],
        })),
      })),
      warnings: this.warnings,
      forms: [...this.forms].map(([name, form]) => ({ person: name, from: form.message.id, payload: form.payload })),
      channels: [...this.channels.values()],
    };
  }

  /** A channel's latest messages: the one most recently active unless `where` names one. */
  screen(where?: string, last = 15): string {
    const channel = where ? this.channel(where) : this.recent;
    if (!channel) return 'Nothing has happened yet.';
    const messages = this.messages.filter(message => message.channel === channel);
    const shown = messages.slice(-last);
    const forms = [...this.forms].map(([name, form]) => `${name} has form "${form.payload.title}" open (from ${form.message.id}).`);
    return [
      `#${channel.name} (${channel.kind}${channel.parent ? ` in #${this.channel(channel.parent).name}` : ''})${messages.length > shown.length ? `, last ${shown.length} of ${messages.length} messages` : ''}`,
      ...shown.map(message => this.render(message)),
      ...forms,
      `Channels: ${[...this.channels.keys()].join(', ')}.`,
    ].join('\n');
  }
}
