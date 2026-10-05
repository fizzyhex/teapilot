import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { ActionRowBuilder, APIModalInteractionResponseCallbackData, Attachment, BaseMessageOptions, ButtonBuilder, ButtonInteraction, ChatInputCommandInteraction, ClientOptions, Message, MessageActionRowComponentBuilder, MessageContextMenuCommandInteraction, ModalSubmitInteraction, RequestMethod, RouteLike, SendableChannels, StringSelectMenuInteraction } from 'discord.js';
import type { IncomingMessage } from './access.js';
import type { SideAnswer } from './aside-store.js';
import type { CardButton, CardControls, DiscordTransport } from './bridge.js';
import type { Checkpoint, CheckpointDecision } from '../agents/checkpoint.js';
import { browseGone, browseModal, browseModalPrefix, browsePrefix, browseRows, browseSubmit, type BrowseAction, type BrowseSession, type WorkspaceBrowser } from './browse.js';
import { attachmentOption, commandDefinitions, commandText, interactionLifetimeMs, promptAttachments, promptCommand, promptSetup, replyCommand, replyMenu, treeOption, withoutUserInstall, type PromptSetup } from './commands.js';
import { isAside } from '../chat.js';
import type { Permission } from '../execution/grants.js';
import { grantPrefix, grantsGone, grantView, type GrantPanel } from './grants-panel.js';
import { InteractionFeed, type FeedLink } from './feed.js';
import { planButtons, planModal, type PlanAction, type PlanControls } from './plan.js';
import { viewSource, type Message as AnswerMessage } from 'pretty-send';
import { chunk, MESSAGE_LIMIT, quoteMessage, viewSourcePrefix, type QuotedMessage, type ReplyChain } from './render.js';
import { browserLink, parseCustomId, playPrefix, type MessagePayload } from './play/render.js';
import type { PlayInteraction, PlaySurface } from './play/runtime.js';
import type { DiscordSettings } from './settings.js';
import { browserMenu } from './commands.js';

/** How far the Reply menu follows a message's replies back, and how long it may spend fetching them. */
const replyChainDepth = 10;
const replyChainBudgetMs = 1500;
const replyChainMessageChars = 2000;
const editFilePrefix = 'teapilot:edit-file:';
/** The fields teapilot reads from a message in a raw Gateway payload. */
interface RawMessage { author?: { username?: string }; content?: string; message_reference?: { type?: number; message_id?: string } }

/** A file attached to a message; downloaded only for messages teapilot answers. */
export interface IncomingFile { name: string; size: number; contentType?: string; download(): Promise<Buffer> }
export interface GatewayMessage extends IncomingMessage {
  /** Message text with the bot mention removed. */
  content: string;
  attachments: IncomingFile[];
  authorName: string;
  transport(): DiscordTransport;
  /** Like `transport()`, but the first message replies to this one, without pinging its author. */
  replyTransport(): DiscordTransport;
  startThread(name: string): Promise<{ id: string; transport: DiscordTransport }>;
  /** The messages this one replies to; fetched on demand, so only routed messages pay for it. */
  replyChain(): Promise<ReplyChain>;
  /** Adds an emoji reaction to this message, as quiet feedback that it was understood. */
  react(emoji: string): Promise<void>;
}
/** A slash command from an allowlisted-or-not user; `text` is the equivalent session command. */
export interface GatewayCommand extends IncomingMessage {
  transport?(): DiscordTransport;
  text: string;
  /** Answer only the invoker: with text it shows a private note, without it the invocation is dismissed quietly. */
  respond(text?: string): Promise<void>;
  /** Instead of `respond()`: a private note with buttons, as for a reply. */
  choose(note: string, labels: string[]): Promise<GatewayChoice | undefined>;
  /** Instead of `respond()`: a private view of a folder, `text`, with buttons that open another folder or send a file. */
  browse(text: string, browser: WorkspaceBrowser, dir: string, conversation: string): Promise<void>;
  /** Instead of `respond()`: posts `panel` for everyone here without notifying anyone; each press repaints it. */
  grants(panel: GrantPanel): Promise<void>;
  /** teapilot cannot post here, so /reply and /prompt answer through their interactions, one person or collab at a time. */
  oneShot: boolean;
}
/** Discord asking for completions of an option being typed; `text` is the command it belongs to, without the option. */
export interface GatewayCompletion extends IncomingMessage {
  text: string;
  typed: string;
  /** Up to 25 suggestions; the first ones win. */
  respond(choices: string[]): Promise<void>;
}
/** /reply or the Reply context menu: `content` is what teapilot receives, `title` names a new thread. */
export interface GatewayReply extends Omit<GatewayMessage, 'replyChain' | 'replyTransport' | 'react'> {
  title: string;
  /** Interaction id, unique per invocation. */
  id: string;
  /**
   * The bot cannot post in this channel, so it answers through the interaction itself: one
   * conversation per invocation, no threads, and it ends when Discord expires the interaction.
   * With this set, `respond()` with no text keeps the reply visible instead of dismissing it.
   */
  oneShot: boolean;
  /** From the Reply menu: only teapilot's answer (and approval buttons) go to Discord; the rest is logged in the terminal. */
  answerOnly: boolean;
  /** The mode and tier chosen with /prompt, applied before `content`. */
  setup: PromptSetup;
  /** From /prompt: every approval this prompt asks for passes without asking, if an operator sent it. */
  yolo: boolean;
  /** A side question (/btw): `respond()` keeps a private reply open, and `transport()` answers there, for the asker alone. */
  side: boolean;
  respond(text?: string): Promise<void>;
  /**
   * Instead of `respond()`: a private note with a button per label, the first one primary. Resolves with the
   * invoker's click, or undefined once the interaction expires.
   */
  choose(note: string, labels: string[]): Promise<GatewayChoice | undefined>;
}
/** A button pressed on a `choose()` note; its interaction carries whatever follows. */
export interface GatewayChoice {
  /** Index of the pressed label. */
  choice: number;
  /** Replaces the note, and removes its buttons. */
  settle(note: string): Promise<void>;
  /** Posts publicly as follow-ups to the click, for 15 minutes. */
  transport(): DiscordTransport;
}
export interface GatewayHandlers {
  savedCheckpoint?(input: { id: string; action: 'resume' | 'redirect' | 'finish'; amendment?: string; user: { id: string; name: string }; channelId: string; transport: DiscordTransport }): Promise<string>;
  openBrowser?(channelId: string, messageId: string, user: { id: string; name: string }): string | undefined;
  openEditorForMessage?(messageId: string, user: { id: string; name: string }): string | null | undefined;
  bindFileReply?(messageId: string, conversation: string, path: string, user: { id: string; name: string }): void;
  message(message: GatewayMessage): void;
  command(command: GatewayCommand): void;
  complete?(completion: GatewayCompletion): void;
  reply(reply: GatewayReply): void;
  /** A click, selection or form on a discord.play app, from anyone; the runtime decides who may act. */
  component(interaction: PlayInteraction): void;
  /** Whether a person may use teapilot at all: an operator, or a whitelisted user. Defaults to the operators. */
  allowed?(userId: string): boolean;
  /** Side answers (/btw) posted compactly or summarised. */
  asides: {
    /** Saves an answer posted compactly, and returns the id its button carries. */
    keep(answer: SideAnswer): string;
    find(id: string): SideAnswer | undefined;
    /** A shorter answer with its sources inline, for everyone in the channel. */
    summarise(answer: SideAnswer): Promise<string>;
  };
}
export interface Gateway {
  botName: string;
  /** A user's Discord username, or undefined when it cannot be fetched. */
  username(id: string): Promise<string | undefined>;
  /** Posts and edits discord.play messages by channel, so apps keep working after a restart. */
  play: PlaySurface;
  /** Shows `text` as the bot's custom status, or clears it when there is nothing to say. */
  setStatus(text: string | undefined): Promise<void>;
  close(): Promise<void>;
}

const noop = () => undefined;
/** Custom id prefix of `choose()` buttons: `teapilot-choice:<nonce>:<index>`. */
const choicePrefix = 'teapilot-choice:';
/** Custom id prefix of status card buttons: `teapilot-card:<button>`; the card's message id finds its turn. */
const cardPrefix = 'teapilot-card:';
/** Added to a status card once Discord stops its interaction's updates. */
const pauseNote = '-# live updates frozen... discord stops them after 15 minutes. press **resume** to catch up!';
/** Custom id prefix of a plan's buttons: `teapilot-plan:<action>`; the plan's last message id finds its controls. */
const planPrefix = 'teapilot-plan:';
/** Custom id prefix of the change request form: `teapilot-plan-modal:<message id>`. */
const planModalPrefix = 'teapilot-plan-modal:';
const checkpointPrefix = 'teapilot-checkpoint:';
const savedCheckpointPrefix = 'teapilot-saved-checkpoint:';
const savedCheckpointModalPrefix = 'teapilot-saved-checkpoint-modal:';
const checkpointModalPrefix = 'teapilot-checkpoint-modal:';
/** Custom id prefix of a side answer's share menu: `teapilot-btw:<nonce>`. */
const sidePrefix = 'teapilot-btw:';
/** Custom id prefix of a compactly posted side answer's button: `teapilot-btw-show:<id>`, the id in the aside store. */
const showPrefix = 'teapilot-btw-show:';
/** Custom id prefix of a side answer's summary preview buttons: `teapilot-btw-summary:<nonce>:post|cancel`. */
const summaryPrefix = 'teapilot-btw-summary:';
/** A private side answer (/btw), kept so its asker can post it for everyone; `summary` is the preview waiting to be posted. */
interface PendingAside extends SideAnswer { summary?: string; summarising?: boolean }
/** How a side answer can be shared, in its menu. */
const shareOptions = [
  { value: 'full', label: 'Post as is', description: 'Just send the full message.' },
  { value: 'compact', label: 'Post compactly', description: 'Post a button that expands to show the full message.' },
  { value: 'summary', label: 'Summarise further', description: 'Cut down the message before sending it.' },
];
/** The line above a side answer posted for everyone: who asked, and what. */
const askedBy = (answer: SideAnswer) => `-# <@${answer.userId}> asked: ${answer.question.replace(/^\/btw\s*/i, '').replace(/\s+/g, ' ').slice(0, 300)}`;
/** Status cards whose buttons still answer; the oldest are forgotten first. */
const cardLimit = 500;
/** Discord's limit on a custom status. */
const statusLimitChars = 128;
const quiet = { allowedMentions: { parse: [] as [] } };
/**
 * discord.play renders Discord API JSON, which discord.js accepts in place of its builders. Its pictures travel as
 * files; an edit replaces the attachments it had, so an earlier picture never lingers under the new one.
 */
const raw = (payload: MessagePayload, edit = false) => {
  const { files, pictures: _, ...rest } = payload;
  return { ...rest, files: (files ?? []).map(file => ({ attachment: file.data, name: file.name })), ...(edit ? { attachments: [] } : {}) } as unknown as BaseMessageOptions & { content: string };
};
/** A Discord attachment, downloaded only when teapilot keeps it. */
const incoming = (file: Attachment): IncomingFile => ({ name: file.name, size: file.size, contentType: file.contentType ?? undefined,
  async download() {
    const response = await fetch(file.url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Discord returned ${response.status} for ${file.name}.`);
    return Buffer.from(await response.arrayBuffer());
  } });
const attachments = (files: Array<{ name: string; data: Buffer }>) => files.map(file => ({ attachment: file.data, name: file.name }));
/** A pretty-send message as discord.js takes it: raw embeds and components, which it accepts in place of builders. */
const answerPayload = ({ embeds, components, flags, files }: AnswerMessage) =>
  ({ ...(embeds ? { embeds } : {}), components, ...(flags ? { flags } : {}), files: attachments(files ?? []), ...quiet }) as unknown as BaseMessageOptions & { flags?: number };

/**
 * A dispatcher from the undici discord.js itself loads. Its REST client otherwise uses undici's process-wide
 * dispatcher, which pi-coding-agent replaces with its newer undici on import; that one cannot send the
 * older undici's FormData, so every upload hung until discord.js timed out ("This operation was aborted").
 */
function restAgent(): NonNullable<NonNullable<ClientOptions['rest']>['agent']> {
  const discord = createRequire(createRequire(import.meta.url).resolve('discord.js'));
  const { Agent } = createRequire(discord.resolve('@discordjs/rest'))('undici') as { Agent: new () => NonNullable<NonNullable<ClientOptions['rest']>['agent']> };
  return new Agent();
}

/**
 * The only module that loads discord.js. It connects outbound over the Gateway:
 * no public URL, webhook or local server. Approval clicks are accepted from allowlisted users only.
 */
export async function connect(settings: DiscordSettings, handlers: GatewayHandlers, log: (text: string) => void): Promise<Gateway> {
  const { ActionRowBuilder, ActivityType, ApplicationIntegrationType, ButtonBuilder, ButtonStyle, Client, Events, GatewayIntentBits, InteractionContextType, MessageFlags, MessageReferenceType, Partials, PermissionFlagsBits, StringSelectMenuBuilder, ThreadAutoArchiveDuration } = await import('discord.js');
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel],
    allowedMentions: { parse: [] },
    rest: { agent: restAgent() },
  });
  type CardMessage = BaseMessageOptions & { flags?: typeof MessageFlags.SuppressEmbeds };
  type FeedMessage = BaseMessageOptions & { flags?: typeof MessageFlags.SuppressEmbeds | typeof MessageFlags.SuppressNotifications };
  // SuppressNotifications is a creation flag, not an editable message flag.
  const editable = (payload: FeedMessage): CardMessage => ({ ...payload, flags: payload.flags === MessageFlags.SuppressNotifications ? undefined : payload.flags });
  const pending = new Map<string, { text: string; users: boolean; resolve(approved: boolean): void }>();
  const pendingContinuations = new Map<string, { text: string; claim(): boolean; resolve(outcome: 'approved' | 'denied' | 'auto-approved', actor?: string): void }>();
  const cards = new Map<string, CardControls['press']>();
  const checkpoints = new Map<string, { checkpoint: Checkpoint; decide: (action: 'continue' | 'redirect' | 'finish_partial', userId: string, amendment?: string) => CheckpointDecision | undefined; stop(userId: string): { text: string }; resolve(value: CheckpointDecision | undefined): void; finish(value: CheckpointDecision | undefined, verdict: string, reviseMessage?: boolean): void; text: string; messageId: string; finalContent?: string; settled: boolean }>();
  const remember = (id: string, controls: CardControls) => {
    cards.delete(id); cards.set(id, controls.press);
    if (cards.size > cardLimit) cards.delete(cards.keys().next().value!);
  };
  /** Status cards posted through interactions, whose Resume button carries their turn's updates on through a new one. */
  const resumers = new Map<string, (click: ButtonInteraction) => Promise<void>>();
  /** A status card: links in its previews stay text rather than growing embeds. `paused` adds the note and button to resume its updates. */
  const cardPayload = (text: string, controls: CardControls, paused = false): CardMessage => ({
    content: paused ? `${text.slice(0, MESSAGE_LIMIT - pauseNote.length - 2)}\n\n${pauseNote}` : text, flags: MessageFlags.SuppressEmbeds, ...quiet,
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...(paused ? [new ButtonBuilder().setCustomId(`${cardPrefix}resume`).setLabel('Resume').setStyle(ButtonStyle.Primary)] : []),
      ...(controls.stop ? [new ButtonBuilder().setCustomId(`${cardPrefix}stop`).setLabel('Stop').setStyle(ButtonStyle.Secondary)] : []),
      new ButtonBuilder().setCustomId(`${cardPrefix}details`).setLabel('Details').setStyle(ButtonStyle.Secondary))],
  });
  /** Plans whose buttons still answer, by the id of their last message; the oldest are forgotten first. */
  const plans = new Map<string, PlanControls>();
  const planRow = (controls: PlanControls) => controls.actions.length ? [new ActionRowBuilder<ButtonBuilder>().addComponents(controls.actions.map(action => {
    const { label, emoji, style } = planButtons[action];
    const button = new ButtonBuilder().setCustomId(`${planPrefix}${action}`).setLabel(label).setStyle(style === 'success' ? ButtonStyle.Success : ButtonStyle.Secondary);
    return emoji ? button.setEmoji(emoji) : button;
  }))] : [];
  const settle = (text: string, verdict: string) => `${text.slice(0, MESSAGE_LIMIT - verdict.length - 2)}\n\n${verdict}`;
  const savedCheckpointPayload = (text: string, id: string): Payload => ({ content: text, allowedMentions: { parse: [] }, components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${savedCheckpointPrefix}${id}:resume`).setLabel('Resume').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${savedCheckpointPrefix}${id}:redirect`).setLabel('Change direction').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${savedCheckpointPrefix}${id}:finish`).setLabel('Finish').setStyle(ButtonStyle.Secondary))] });
  const checkpointOffer = (text: string, checkpoint: Checkpoint, signal: AbortSignal,
    decide: (action: 'continue' | 'redirect' | 'finish_partial', userId: string, amendment?: string) => CheckpointDecision | undefined,
    stop: (userId: string) => { text: string },
    post: (payload: Payload) => Promise<{ id: string }>,
    revise: (id: string, payload: Payload) => Promise<unknown>): Promise<CheckpointDecision | undefined> => {
    if (signal.aborted || Date.now() >= checkpoint.expiresAt) return Promise.resolve(undefined);
    const nonce = randomUUID();
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${checkpointPrefix}${nonce}:continue`).setLabel('Continue').setStyle(ButtonStyle.Success).setDisabled(!checkpoint.continuation),
      new ButtonBuilder().setCustomId(`${checkpointPrefix}${nonce}:redirect`).setLabel('Change direction').setStyle(ButtonStyle.Primary).setDisabled(!checkpoint.continuation),
      new ButtonBuilder().setCustomId(`${checkpointPrefix}${nonce}:finish`).setLabel('Finish partial').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`${checkpointPrefix}${nonce}:stop`).setLabel('Stop now').setStyle(ButtonStyle.Danger));
    const footer = '\n\n-# checkpoint expired or cancelled';
    const clippedText = text.length + footer.length <= MESSAGE_LIMIT ? text : `${text.slice(0, MESSAGE_LIMIT - footer.length - 2).trimEnd()}…`;
    return new Promise<CheckpointDecision | undefined>(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const entry = { checkpoint, decide, stop, text: clippedText, messageId: '', finalContent: undefined as string | undefined, settled: false, resolve,
        finish(value: CheckpointDecision | undefined, verdict: string, reviseMessage = true) {
          if (entry.settled) return;
          entry.settled = true;
          checkpoints.delete(nonce);
          if (timer) clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          const id = entry.messageId;
          entry.finalContent = settle(clippedText, verdict);
          if (id && reviseMessage) void revise(id, { content: entry.finalContent, components: [], allowedMentions: { parse: [] } }).catch(noop);
          resolve(value);
        } };
      const abort = () => entry.finish(undefined, '**checkpoint cancelled**');
      checkpoints.set(nonce, entry);
      if (checkpoints.size > cardLimit) { const oldest = checkpoints.keys().next().value!; checkpoints.get(oldest)?.finish(undefined, '**checkpoint no longer available**'); }
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => entry.finish(undefined, footer.trim()), Math.max(0, checkpoint.expiresAt - Date.now()));
      if (signal.aborted || Date.now() >= checkpoint.expiresAt) { entry.finish(undefined, footer.trim()); return; }
      // Don't hold the host decision hostage to a slow Discord REST call. If cancellation wins during send,
      // the promise settles immediately and the eventual post is stripped of controls.
      void post({ content: clippedText, components: [row], allowedMentions: { parse: [] } }).then(({ id }) => {
        entry.messageId = id;
        if (entry.settled) void revise(id, { content: entry.finalContent ?? settle(clippedText, '**checkpoint cancelled**'), components: [], allowedMentions: { parse: [] } }).catch(noop);
      }, () => entry.finish(undefined, '**checkpoint could not be shown**'));
    });
  };

  type Payload = { content: string; components: Array<ActionRowBuilder<ButtonBuilder>>; allowedMentions: { parse: [] } };
  /** Approve/deny buttons under `text`; `post` and `revise` decide whether a channel or an interaction carries them. Operators answer; with `users`, so may whitelisted users. */
  const askApproval = (text: string, signal: AbortSignal, users: boolean, post: (payload: Payload) => Promise<{ id: string }>, revise: (id: string, payload: Payload) => Promise<unknown>): Promise<boolean> => {
    if (signal.aborted) return Promise.resolve(false);
    const nonce = randomUUID();
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`teapilot:${nonce}:approve`).setLabel('Approve').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`teapilot:${nonce}:deny`).setLabel('Deny').setStyle(ButtonStyle.Danger));
    return post({ content: text, components: [row], ...quiet }).then(message => new Promise<boolean>(resolve => {
      const expire = () => {
        if (!pending.delete(nonce)) return;
        void revise(message.id, { content: settle(text, '**Denied** (expired or cancelled)'), components: [], ...quiet }).catch(noop);
        resolve(false);
      };
      pending.set(nonce, { text, users, resolve: approved => { signal.removeEventListener('abort', expire); resolve(approved); } });
      signal.addEventListener('abort', expire, { once: true });
    }));
  };
  const askContinuationBudget = (text: string, signal: AbortSignal, timeoutMs: number, post: (payload: Payload) => Promise<{ id: string }>, revise: (id: string, payload: Payload) => Promise<unknown>): Promise<'approved' | 'denied' | 'auto-approved'> => {
    if (signal.aborted) return Promise.resolve('denied');
    const nonce = randomUUID();
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`teapilot:${nonce}:approve`).setLabel('Approve batch').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`teapilot:${nonce}:deny`).setLabel('Stop run').setStyle(ButtonStyle.Danger));
    return post({ content: text, components: [row], ...quiet }).then(message => new Promise(resolve => {
      let settled = false;
      let claimed = false;
      let timer: ReturnType<typeof setTimeout>;
      const settle = (outcome: 'approved' | 'denied' | 'auto-approved', verdict: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        pendingContinuations.delete(nonce);
        void revise(message.id, { content: settleContinuationText(text, verdict), components: [], ...quiet }).catch(noop);
        resolve(outcome);
      };
      const abort = () => settle('denied', '**run stopped** (cancelled)');
      pendingContinuations.set(nonce, { text,
        claim: () => { if (settled || claimed) return false; claimed = true; clearTimeout(timer); pendingContinuations.delete(nonce); return true; },
        resolve: (outcome, actor) => settle(outcome, outcome === 'approved' ? `**batch approved**${actor ? ` by <@${actor}>` : ''}` : outcome === 'auto-approved' ? '**auto-approved after 45 seconds**' : `**run stopped**${actor ? ` by <@${actor}>` : ''}`) });
      timer = setTimeout(() => settle('denied', '**no response — run paused**'), timeoutMs);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    }));
  };
  const settleContinuationText = (text: string, verdict: string) => `${text.slice(0, MESSAGE_LIMIT - verdict.length - 2)}\n\n${verdict}`;

  /** Posts in `channel`; with `replyTo`, the first message replies to it, without pinging its author. */
  const transport = (channel: SendableChannels, replyTo?: Message): DiscordTransport => {
    const sent = new Map<string, Message>();
    const reply = () => {
      const to = replyTo; replyTo = undefined;
      return to ? { reply: { messageReference: to, failIfNotExists: false }, allowedMentions: { parse: [] as [], repliedUser: false } } : quiet;
    };
    return {
      async send(text, options) { const message = await channel.send({ content: text, ...(options?.silent ? { flags: MessageFlags.SuppressNotifications } : {}), ...reply() }); sent.set(message.id, message); return message.id; },
      async sendFiles(text, files) { return (await channel.send({ content: text, files: attachments(files), ...reply() })).id; },
      async answer(message) { const posted = await channel.send({ ...answerPayload(message), ...reply() }); sent.set(posted.id, posted); return posted.id; },
      async edit(id, text) { const message = sent.get(id) ?? await channel.messages.fetch(id); await message.edit({ content: text, ...quiet }); },
      async card(text, controls, id) {
        const payload = cardPayload(text, controls);
        const message = id ? await (sent.get(id) ?? await channel.messages.fetch(id)).edit(payload) : await channel.send(payload);
        sent.set(message.id, message); remember(message.id, controls);
        return message.id;
      },
      async checkpoint(text, checkpoint, signal, decide, stop) {
        return checkpointOffer(text, checkpoint, signal, decide, stop,
          async payload => { const message = await channel.send(payload as BaseMessageOptions); sent.set(message.id, message); return { id: message.id }; },
          async (id, payload) => { const message = sent.get(id) ?? await channel.messages.fetch(id); return message.edit(payload as BaseMessageOptions); });
      },
      async savedCheckpoint(text, id) { await channel.send(savedCheckpointPayload(text, id) as BaseMessageOptions); },
      async plan(messages, controls, ids = []) {
        const posted: string[] = [];
        for (const [index, embeds] of messages.entries()) {
          const payload = { embeds, components: index === messages.length - 1 ? planRow(controls) : [], ...quiet };
          const known = ids[index];
          const message = known ? await (sent.get(known) ?? await channel.messages.fetch(known)).edit(payload) : await channel.send({ ...payload, ...reply() });
          sent.set(message.id, message); posted.push(message.id);
        }
        for (const id of ids.slice(messages.length)) await (sent.get(id) ?? await channel.messages.fetch(id)).delete().catch(noop);
        if (ids.length) plans.delete(ids.at(-1)!);
        plans.set(posted.at(-1)!, controls);
        if (plans.size > cardLimit) plans.delete(plans.keys().next().value!);
        return posted;
      },
      typing() { void channel.sendTyping().catch(noop); },
      askApproval: (text, signal, users = false) => askApproval(text, signal, users, payload => channel.send(payload), async (id, payload) => (sent.get(id) ?? await channel.messages.fetch(id)).edit(payload)),
      askContinuationBudget: (text, signal, timeoutMs = 45_000) => askContinuationBudget(text, signal, timeoutMs, payload => channel.send(payload), async (id, payload) => (sent.get(id) ?? await channel.messages.fetch(id)).edit(payload)),
    };
  };

  /** Posts and edits through `interaction`'s webhook; a click's own message is edited through its reply. */
  const webhookLink = (interaction: ChatInputCommandInteraction | MessageContextMenuCommandInteraction | ButtonInteraction | ModalSubmitInteraction, hidden: boolean): FeedLink<FeedMessage> => {
    const expires = interaction.createdTimestamp + interactionLifetimeMs;
    // A click has no deferred message of its own: its reply is the message it was pressed on, so everything is a follow-up.
    let first = !interaction.isButton();
    const live = () => { if (Date.now() > expires) throw new Error('This Discord interaction expired after 15 minutes. Run /reply again.'); };
    return {
      expires,
      async post(payload) {
        live();
        // The deferred "thinking" message becomes the first message, private if it was deferred so; later ones are follow-ups.
        if (first) { first = false; return (await interaction.editReply(editable(payload))).id; }
        return (await interaction.followUp(hidden ? { ...payload, flags: (payload.flags ?? 0) | MessageFlags.Ephemeral } : payload)).id;
      },
      async revise(id, payload) {
        live();
        if (interaction.isButton() && id === interaction.message.id) await interaction.editReply(editable(payload));
        else await interaction.webhook.editMessage(id, editable(payload));
      },
    };
  };

  /**
   * Where the bot cannot post, answer through the interaction webhook, which needs no channel permission.
   * Discord keeps that webhook valid for 15 minutes, and there is no typing indicator or thread.
   */
  const interactionTransport = (interaction: ChatInputCommandInteraction | MessageContextMenuCommandInteraction | ButtonInteraction | ModalSubmitInteraction,
    { hidden = false, buttons = () => [] }: { hidden?: boolean; buttons?: () => Array<ActionRowBuilder<MessageActionRowComponentBuilder>> } = {}): DiscordTransport => {
    let controls: CardControls | undefined;
    const feed: InteractionFeed<FeedMessage> = new InteractionFeed(webhookLink(interaction, hidden), {
      log: text => log(`Discord: ${text}`),
      onCard: id => {
        if (controls) remember(id, controls);
        resumers.delete(id); resumers.set(id, click => feed.resume(webhookLink(click, hidden)));
        if (resumers.size > cardLimit) resumers.delete(resumers.keys().next().value!);
      },
    });
    return {
      send: (text, options) => feed.post({ content: text, components: buttons(), ...(options?.silent ? { flags: MessageFlags.SuppressNotifications } : {}), ...quiet }),
      sendFiles: (text, files) => feed.post({ content: text, files: attachments(files), components: buttons(), ...quiet }),
      answer: message => feed.post(answerPayload(message) as CardMessage),
      edit: (id, text) => feed.revise(id, { content: text, ...quiet }),
      card(text, given, id) {
        controls = given;
        return feed.showCard(cardPayload(text, given), given.stop ? cardPayload(text, given, true) : undefined, id);
      },
      typing: noop,
      askApproval: (text, signal, users = false) => askApproval(text, signal, users, async payload => ({ id: await feed.post(payload) }), (id, payload) => feed.revise(id, payload)),
      askContinuationBudget: (text, signal, timeoutMs = 45_000) => askContinuationBudget(text, signal, timeoutMs, async payload => ({ id: await feed.post(payload) }), (id, payload) => feed.revise(id, payload)),
      async checkpoint(text, checkpoint, signal, decide, stop) {
        return checkpointOffer(text, checkpoint, signal, decide, stop,
          async payload => ({ id: await feed.post(payload as FeedMessage) }),
          (id, payload) => feed.revise(id, payload as FeedMessage));
      },
      async savedCheckpoint(text, id) { await feed.post(savedCheckpointPayload(text, id) as FeedMessage); },
      // The runtime stops editing through this interaction once it expires, and uses the app's clicks after that.
      async postApp(payload) {
        if (!feed.live) throw new Error('Discord has stopped the updates of this reply; press Resume on its status card first.');
        const id = await feed.post(raw(payload));
        return { id, edit: next => feed.revise(id, raw(next, true)) };
      },
    };
  };

  /**
   * A side answer (/btw) through an interaction: only the asker sees it, and each message carries a menu that shares
   * everything answered so far, with the question, with the whole channel: as it is, behind a button, or summarised.
   */
  const sideTransport = (interaction: ChatInputCommandInteraction | MessageContextMenuCommandInteraction, question: string): DiscordTransport => {
    const nonce = randomUUID();
    const answer: PendingAside = { userId: interaction.user.id, question, parts: [] };
    sideAnswers.set(nonce, answer);
    setTimeout(() => sideAnswers.delete(nonce), interactionLifetimeMs).unref?.();
    const menu = () => [new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId(`${sidePrefix}${nonce}`).setPlaceholder('Post to channel?').addOptions(shareOptions))];
    const base = interactionTransport(interaction, { hidden: true, buttons: menu });
    return {
      ...base,
      async send(text) { answer.parts.push({ text, files: [] }); return await base.send(text); },
      async sendFiles(text, files) { answer.parts.push({ text, files }); return await base.sendFiles!(text, files); },
      postApp: undefined,
    };
  };

  const sendable = async (interaction: ChatInputCommandInteraction | MessageContextMenuCommandInteraction) => {
    const channel = interaction.channel ?? await client.channels.fetch(interaction.channelId).catch(() => null);
    return channel?.isSendable() ? channel : undefined;
  };
  /** Where teapilot cannot post, so it answers through each interaction instead. */
  const placement = async (interaction: ChatInputCommandInteraction | MessageContextMenuCommandInteraction) => {
    const channel = await sendable(interaction);
    const thread = channel?.isThread() ? channel : undefined;
    // Servers where teapilot is only user-installed, or where it lacks Send Messages, still allow interaction replies.
    // A user install reports the user's default permissions, which can look like the right to post, so the install type decides first.
    const guildInstalled = interaction.authorizingIntegrationOwners[ApplicationIntegrationType.GuildInstall] !== undefined;
    const cannotPost = interaction.inGuild()
      ? !guildInstalled || !interaction.appPermissions?.has([PermissionFlagsBits.ViewChannel, thread ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages])
      : interaction.context === InteractionContextType.PrivateChannel;
    return { channel, thread, oneShot: !channel || cannotPost };
  };
  const strip = (text: string, id: string) => text.replace(new RegExp(`<@!?${id}>`, 'g'), '').trim();
  /**
   * The message each Reply-menu target replies to, by interaction id, from the raw payload. discord.js
   * keeps it only in the channel's cache, which does not exist where teapilot cannot view the channel.
   */
  const interactionReplies = new Map<string, RawMessage>();
  /** Side answers that can still be posted to their channel, by nonce. */
  const sideAnswers = new Map<string, PendingAside>();
  /** Folder views under /workspace tree, by nonce, with who opened them; the oldest are forgotten first. */
  const browsing = new Map<string, { userId: string; conversation: string; session: BrowseSession }>();
  /** Panels under /convo grants, by message id; the oldest are forgotten first. */
  const panels = new Map<string, GrantPanel>();
  /** Open `choose()` notes by nonce: who may press them, and what the press resolves. */
  const choices = new Map<string, { userId: string; resolve(click: GatewayChoice | undefined): void }>();
  /** A private note with a button per label, the first one primary; resolves with the invoker's click, or undefined once it expires. */
  const offer = async (interaction: ChatInputCommandInteraction | MessageContextMenuCommandInteraction, note: string, labels: string[]): Promise<GatewayChoice | undefined> => {
    const nonce = randomUUID();
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(labels.map((label, index) =>
      new ButtonBuilder().setCustomId(`${choicePrefix}${nonce}:${index}`).setLabel(label).setStyle(index ? ButtonStyle.Secondary : ButtonStyle.Primary)));
    await interaction.reply({ content: note, components: [row], flags: MessageFlags.Ephemeral, ...quiet });
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        if (!choices.delete(nonce)) return;
        void interaction.editReply({ content: `${note}\n\n-# Expired.`.slice(0, MESSAGE_LIMIT), components: [] }).catch(noop);
        resolve(undefined);
      }, interactionLifetimeMs);
      choices.set(nonce, { userId: interaction.user.id, resolve: click => { clearTimeout(timer); resolve(click); } });
    });
  };

  /** The side answer behind a menu or preview, if it is still the clicker's to post; otherwise a private note says why not. */
  const pendingAside = async (interaction: ButtonInteraction | StringSelectMenuInteraction, nonce: string): Promise<PendingAside | undefined> => {
    const answer = sideAnswers.get(nonce);
    if (!answer) { await interaction.reply({ content: 'This answer can no longer be posted: it was posted already, is too old, or teapilot restarted since.', flags: MessageFlags.Ephemeral }).catch(noop); return undefined; }
    if (answer.userId !== interaction.user.id) { await interaction.reply({ content: 'Only the person who asked can post this answer.', flags: MessageFlags.Ephemeral }).catch(noop); return undefined; }
    return answer;
  };
  /** A side answer's messages, `askedBy` above the first, each part's files after its last piece. */
  const sendAside = async (answer: SideAnswer, send: (content: string, files: ReturnType<typeof attachments>) => Promise<unknown>) => {
    for (const [index, part] of answer.parts.entries()) {
      const pieces = chunk(index ? part.text : `${askedBy(answer)}\n${part.text}`);
      for (const [at, piece] of pieces.entries()) await send(piece, at === pieces.length - 1 ? attachments(part.files) : []);
    }
  };
  const failure = (error: unknown) => error instanceof Error ? error.message : String(error);

  /** The asker picked how to share a side answer from its menu. */
  const share = async (interaction: StringSelectMenuInteraction, nonce: string) => {
    const answer = await pendingAside(interaction, nonce);
    if (!answer) return;
    const choice = interaction.values[0];
    if (choice === 'summary') {
      if (answer.summarising) { await interaction.reply({ content: 'This answer is already being summarised.', flags: MessageFlags.Ephemeral }).catch(noop); return; }
      answer.summarising = true;
      // The menu stays, so the asker can still post it another way; the preview is a note of its own.
      await interaction.deferUpdate().catch(noop);
      try {
        // Without embeds the preview looks as the post will: sources stay links rather than previews.
        const note = await interaction.followUp({ content: '-# Summarising…', flags: MessageFlags.Ephemeral | MessageFlags.SuppressEmbeds, ...quiet });
        try {
          const summary = await handlers.asides.summarise(answer);
          if (!summary) throw new Error('The model sent back nothing.');
          answer.summary = summary;
          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`${summaryPrefix}${nonce}:post`).setLabel('Post').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`${summaryPrefix}${nonce}:cancel`).setLabel('Cancel').setStyle(ButtonStyle.Secondary));
          await interaction.webhook.editMessage(note.id, { content: chunk(`${askedBy(answer)}\n${summary}`)[0]!, components: [row], ...quiet });
        } catch (error) {
          log(`Discord: side answer not summarised: ${failure(error)}`);
          await interaction.webhook.editMessage(note.id, { content: `Could not summarise it: ${failure(error)}`.slice(0, MESSAGE_LIMIT), ...quiet }).catch(noop);
        }
      } finally { answer.summarising = false; }
      return;
    }
    sideAnswers.delete(nonce);
    // Take the menu off the private answer, then post publicly as follow-ups to the pick.
    await interaction.update({ components: [] }).catch(noop);
    try {
      if (choice === 'compact') {
        const id = handlers.asides.keep(answer);
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`${showPrefix}${id}`).setLabel('Show answer').setStyle(ButtonStyle.Secondary));
        await interaction.followUp({ content: askedBy(answer), components: [row], ...quiet });
      } else await sendAside(answer, (content, files) => interaction.followUp({ content, files, ...quiet }));
    } catch (error) {
      log(`Discord: side answer not posted: ${failure(error)}`);
      await interaction.followUp({ content: 'That answer could not be posted here.', flags: MessageFlags.Ephemeral }).catch(noop);
    }
  };

  /**
   * The messages `message` replies to, oldest first, for mentions and the Reply menu. Discord drops an
   * interaction unless it is answered within 3 seconds, so the walk stops at a depth and time budget,
   * and at anything it cannot fetch.
   */
  const replyChain = async (message: Message, selfId: string, repliedTo?: RawMessage): Promise<ReplyChain> => {
    const messages: QuotedMessage[] = [];
    const quote = (author: string | undefined, content: string | undefined) => messages.unshift({ author: author ?? 'unknown', text: strip(content ?? '', selfId).slice(0, replyChainMessageChars) });
    const replies = (reference: { type?: number; messageId?: string } | null | undefined) => reference?.type === MessageReferenceType.Default && !!reference.messageId;
    const deadline = Date.now() + replyChainBudgetMs;
    let current = message;
    while (replies(current.reference)) {
      const left = deadline - Date.now();
      if (messages.length >= replyChainDepth || left <= 0) return { messages, truncated: true };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const parent = await Promise.race([
        current.fetchReference(),
        new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), left); }),
      ]).catch(() => undefined).finally(() => clearTimeout(timer));
      if (!parent) {
        // Without channel access nothing can be fetched, but Discord sent the first reply with the interaction.
        if (current !== message || !repliedTo) return { messages, truncated: true };
        quote(repliedTo.author?.username, repliedTo.content);
        const reference = repliedTo.message_reference;
        return { messages, truncated: replies(reference && { type: reference.type ?? MessageReferenceType.Default, messageId: reference.message_id }) };
      }
      quote(parent.author.username, parent.content);
      current = parent;
    }
    return { messages, truncated: false };
  };

  /** /reply and the Reply context menu: both start or continue a conversation wherever the bot may post. */
  const reply = async (interaction: ChatInputCommandInteraction | MessageContextMenuCommandInteraction, self: NonNullable<typeof client.user>) => {
    let answered = false;
    const { channel, thread, oneShot } = await placement(interaction);
    const target = interaction.isMessageContextMenuCommand() ? interaction.targetMessage : undefined;
    const isPrompt = interaction.isChatInputCommand() && interaction.commandName === promptCommand;
    const text = interaction.isChatInputCommand() ? interaction.options.getString(isPrompt ? 'prompt' : 'message', true).trim() : strip(target?.content ?? '', self.id);
    // The Reply menu quotes someone's message; only a person's own /btw is a side question.
    const side = !target && isAside(text);
    const respond = async (note?: string) => {
      if (answered) { if (note) await interaction.followUp({ content: note, flags: MessageFlags.Ephemeral }); return; }
      answered = true;
      if (note) await interaction.reply({ content: note, flags: MessageFlags.Ephemeral });
      else if (side) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      else if (oneShot) await interaction.deferReply();
      else { await interaction.deferReply({ flags: MessageFlags.Ephemeral }); await interaction.deleteReply(); }
    };
    const spawn = async (start: () => Promise<{ id: string } & Parameters<typeof transport>[0]>) => {
      if (!channel || oneShot) throw new Error('teapilot cannot post in this channel.');
      if (thread) throw new Error('Threads cannot be started inside other threads.');
      const created = await start();
      return { id: created.id, transport: transport(created) };
    };
    const choose = async (note: string, labels: string[]): Promise<GatewayChoice | undefined> => {
      if (answered) throw new Error('This interaction was already answered.');
      answered = true;
      return offer(interaction, note, labels);
    };
    const setup = interaction.isChatInputCommand() && isPrompt ? promptSetup(interaction.options.getString('mode'), interaction.options.getString('reasoning')) : {};
    const yolo = interaction.isChatInputCommand() && isPrompt && interaction.options.getBoolean('yolo') === true;
    const files = interaction.isChatInputCommand() && isPrompt
      ? Array.from({ length: promptAttachments }, (_, index) => interaction.options.getAttachment(attachmentOption(index))).filter((file): file is Attachment => !!file).map(incoming)
      : [];
    const repliedTo = interactionReplies.get(interaction.id);
    interactionReplies.delete(interaction.id);
    const chain = target && text ? await replyChain(target, self.id, repliedTo) : undefined;
    handlers.reply({
      authorId: interaction.user.id,
      authorIsBot: interaction.user.bot,
      authorName: interaction.user.username,
      guildId: interaction.guildId ?? undefined,
      channelId: interaction.channelId,
      parentId: thread?.parentId ?? undefined,
      ownThread: thread?.ownerId === self.id,
      mentionsBot: false,
      content: target && text ? quoteMessage({ author: target.author.username, text }, chain) : text,
      title: text,
      id: interaction.id,
      oneShot,
      answerOnly: !!target,
      setup,
      yolo,
      attachments: files,
      side,
      transport: () => side ? sideTransport(interaction, text) : channel && !oneShot ? transport(channel) : interactionTransport(interaction),
      startThread: name => spawn(async () => {
        const options = { name: name.slice(0, 90) || 'teapilot', autoArchiveDuration: ThreadAutoArchiveDuration.OneDay };
        if (target) return await target.startThread(options);
        // A slash command has no message to anchor a thread, so echo the prompt and open the thread on it.
        const response = await interaction.reply({ content: `<@${interaction.user.id}>: ${text}`.slice(0, MESSAGE_LIMIT), ...quiet, withResponse: true });
        answered = true;
        const message = response.resource?.message;
        if (!message) throw new Error('Discord did not return the message to start a thread on.');
        return await message.startThread(options);
      }),
      respond: note => respond(note).catch(error => log(`Discord: ${error instanceof Error ? error.message : String(error)}`)),
      choose,
    });
  };

  // Raw packets arrive before discord.js builds the interaction, so the entry is ready when reply() runs.
  client.on(Events.Raw, (packet: { t?: string; d?: { id?: string; data?: { target_id?: string; resolved?: { messages?: Record<string, { referenced_message?: RawMessage | null }> } } } }) => {
    const data = packet.t === 'INTERACTION_CREATE' ? packet.d?.data : undefined;
    const repliedTo = data?.target_id ? data.resolved?.messages?.[data.target_id]?.referenced_message : undefined;
    if (packet.d?.id && repliedTo) interactionReplies.set(packet.d.id, repliedTo);
  });

  client.on(Events.InteractionCreate, async interaction => {
    if (interaction.isButton() && interaction.customId.startsWith(savedCheckpointPrefix) || interaction.isModalSubmit() && interaction.customId.startsWith(savedCheckpointModalPrefix)) {
      const modal = interaction.isModalSubmit();
      const tail = interaction.customId.slice(modal ? savedCheckpointModalPrefix.length : savedCheckpointPrefix.length);
      const [id, button] = tail.split(':');
      const action = modal ? 'redirect' : button;
      if (!handlers.savedCheckpoint || !handlers.allowed?.(interaction.user.id) || !interaction.channelId || !id || !['resume', 'redirect', 'finish'].includes(action ?? '')) {
        await interaction.reply({ content: 'this checkpoint is unavailable or you are not authorised.', flags: MessageFlags.Ephemeral, ...quiet }).catch(noop); return;
      }
      if (!modal && action === 'redirect' && interaction.isButton()) {
        await interaction.showModal({ custom_id: `${savedCheckpointModalPrefix}${id}`, title: 'change direction · new execution', components: [{ type: 1, components: [{ type: 4, custom_id: 'amendment', label: 'what should change?', style: 2, required: true, max_length: 1000 }] }] } as unknown as APIModalInteractionResponseCallbackData).catch(noop); return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(noop);
      const channel = interaction.channel;
      const hidden = interaction.message?.flags.has(MessageFlags.Ephemeral) === true;
      const note = await handlers.savedCheckpoint({ id, action: action as 'resume' | 'redirect' | 'finish', amendment: interaction.isModalSubmit() ? interaction.fields.getTextInputValue('amendment') : undefined,
        user: { id: interaction.user.id, name: interaction.user.username }, channelId: interaction.channelId,
        transport: !hidden && channel?.isSendable() ? transport(channel) : interactionTransport(interaction, { hidden: true }) }).catch(error => `couldn’t reopen checkpoint: ${failure(error)}`);
      await interaction.editReply({ content: note, ...quiet }).catch(noop);
      return;
    }
    if (interaction.isMessageContextMenuCommand() && interaction.commandName === browserMenu) {
      const user = { id: interaction.user.id, name: interaction.user.username };
      const editorUrl = handlers.openEditorForMessage?.(interaction.targetMessage.id, user);
      const url = editorUrl === null ? undefined : editorUrl
        ?? (interaction.targetMessage.author.id === client.user?.id ? handlers.openBrowser?.(interaction.channelId, interaction.targetMessage.id, user) : undefined);
      await interaction.reply({ content: browserLink(url), flags: MessageFlags.Ephemeral, ...quiet }).catch(noop);
      return;
    }
    if (interaction.isButton() && interaction.customId.startsWith(editFilePrefix)) {
      const messageId = interaction.message?.id;
      const url = handlers.openEditorForMessage?.(messageId, { id: interaction.user.id, name: interaction.user.username });
      await interaction.reply({ content: url ? browserLink(url) : 'this file reply is no longer available to you.', flags: MessageFlags.Ephemeral, ...quiet }).catch(noop);
      return;
    }
    // Only the Reply menu reads this; drop it for every other interaction so the map stays empty.
    if (!(interaction.isMessageContextMenuCommand() && interaction.commandName === replyMenu)) interactionReplies.delete(interaction.id);
    if (interaction.isMessageContextMenuCommand() && interaction.commandName === replyMenu || interaction.isChatInputCommand() && [replyCommand, promptCommand].includes(interaction.commandName)) {
      const self = client.user;
      if (self && (interaction.isMessageContextMenuCommand() || interaction.isChatInputCommand())) await reply(interaction, self).catch(error => log(`Discord: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    if (interaction.isChatInputCommand()) {
      const self = client.user;
      const channel = interaction.channel;
      const argument = interaction.options.getString('value') ?? interaction.options.getString('name') ?? interaction.options.getString(treeOption) ?? interaction.options.getString('target');
      const text = commandText(interaction.commandName, interaction.options.getSubcommand(false), argument, interaction.options.getString('scope'));
      const deferredSkills = ['skills', 'checkpoint'].includes(interaction.commandName);
      if (deferredSkills) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      let answered = false;
      const respond = async (note?: string) => {
        if (answered) { if (note) await interaction.followUp({ content: note, flags: MessageFlags.Ephemeral }); return; }
        answered = true;
        if (deferredSkills) { if (note) await interaction.editReply({ content: note }); else await interaction.deleteReply(); }
        else if (note) await interaction.reply({ content: note, flags: MessageFlags.Ephemeral });
        else { await interaction.deferReply({ flags: MessageFlags.Ephemeral }); await interaction.deleteReply(); }
      };
      if (!self || !text) { await respond('Unknown teapilot command.').catch(noop); return; }
      const thread = channel?.isThread() ? channel : undefined;
      const { oneShot } = await placement(interaction);
      handlers.command({
        transport: () => channel?.isSendable() ? transport(channel) : interactionTransport(interaction, { hidden: true }),
        authorId: interaction.user.id,
        authorIsBot: interaction.user.bot,
        guildId: interaction.guildId ?? undefined,
        channelId: interaction.channelId,
        parentId: thread?.parentId ?? undefined,
        ownThread: thread?.ownerId === self.id,
        mentionsBot: false,
        text,
        oneShot,
        respond: note => respond(note).catch(error => log(`Discord: ${error instanceof Error ? error.message : String(error)}`)),
        choose: async (note, labels) => {
          if (answered) throw new Error('This interaction was already answered.');
          answered = true;
          return offer(interaction, note, labels);
        },
        browse: async (text, browser, dir, conversation) => {
          if (answered) throw new Error('This interaction was already answered.');
          answered = true;
          const nonce = randomUUID();
          browsing.set(nonce, { userId: interaction.user.id, conversation, session: { browser, dir } });
          if (browsing.size > cardLimit) browsing.delete(browsing.keys().next().value!);
          await interaction.reply({ content: text, components: browseRows(nonce) as unknown as BaseMessageOptions['components'], flags: MessageFlags.Ephemeral, ...quiet })
            .catch(error => log(`Discord: ${error instanceof Error ? error.message : String(error)}`));
        },
        grants: async panel => {
          if (answered) throw new Error('This interaction was already answered.');
          answered = true;
          const response = await interaction.reply({ ...grantView(panel) as unknown as BaseMessageOptions, flags: MessageFlags.SuppressNotifications, ...quiet, withResponse: true })
            .catch(error => { log(`Discord: ${error instanceof Error ? error.message : String(error)}`); return undefined; });
          const id = response?.resource?.message?.id;
          if (!id) return;
          panels.set(id, panel);
          if (panels.size > cardLimit) panels.delete(panels.keys().next().value!);
        },
      });
      return;
    }
    if (interaction.isAutocomplete()) {
      const self = client.user;
      const thread = interaction.channel?.isThread() ? interaction.channel : undefined;
      const text = commandText(interaction.commandName, interaction.options.getSubcommand(false));
      const respond = async (choices: string[]) => {
        await interaction.respond(choices.slice(0, 25).map(choice => ({ name: choice.slice(0, 100), value: choice.slice(0, 100) })));
      };
      if (!self || !text || !handlers.complete) { await respond([]).catch(noop); return; }
      handlers.complete({
        authorId: interaction.user.id,
        authorIsBot: interaction.user.bot,
        guildId: interaction.guildId ?? undefined,
        channelId: interaction.channelId,
        parentId: thread?.parentId ?? undefined,
        ownThread: thread?.ownerId === self.id,
        mentionsBot: false,
        text,
        typed: String(interaction.options.getFocused()),
        respond: choices => respond(choices).catch(error => log(`Discord: ${error instanceof Error ? error.message : String(error)}`)),
      });
      return;
    }
    if ((interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) && interaction.customId.startsWith(playPrefix)) {
      const target = parseCustomId(interaction.customId);
      if (!target) { await interaction.reply({ content: 'This app is not available.', flags: MessageFlags.Ephemeral, ...quiet }).catch(noop); return; }
      handlers.component({
        playId: target.playId, controlId: target.id, messageId: interaction.message?.id,
        kind: interaction.isButton() ? 'button' : interaction.isStringSelectMenu() ? 'select' : 'modal',
        user: { id: interaction.user.id, name: interaction.user.username },
        values: interaction.isStringSelectMenu() ? [...interaction.values] : undefined,
        fields: interaction.isModalSubmit() ? Object.fromEntries([...interaction.fields.fields.values()].flatMap(field => 'value' in field && typeof field.value === 'string' ? [[field.customId, field.value]] : [])) : undefined,
        openModal: async payload => { if (interaction.isModalSubmit()) throw new Error('A form cannot open another form.'); await interaction.showModal(payload as unknown as APIModalInteractionResponseCallbackData); },
        reply: async content => { await interaction.reply({ content, flags: MessageFlags.Ephemeral, ...quiet }); },
        defer: async () => { await interaction.deferUpdate(); },
        update: async payload => { await interaction.editReply(raw(payload, true)); },
        followUp: async (content, embeds) => { await interaction.followUp({ content, embeds: embeds as BaseMessageOptions['embeds'], flags: MessageFlags.Ephemeral, ...quiet }); },
      });
      return;
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith(checkpointModalPrefix)) {
      const nonce = interaction.customId.slice(checkpointModalPrefix.length);
      const entry = checkpoints.get(nonce);
      if (!entry || entry.settled || Date.now() >= entry.checkpoint.expiresAt) { await interaction.reply({ content: 'this checkpoint is no longer open.', flags: MessageFlags.Ephemeral, ...quiet }).catch(noop); return; }
      const decision = entry.decide('redirect', interaction.user.id, interaction.fields.getTextInputValue('amendment'));
      if (!decision) { await interaction.reply({ content: 'only the requester or an operator can change this direction.', flags: MessageFlags.Ephemeral, ...quiet }).catch(noop); return; }
      entry.finish(decision, `**direction changed by <@${interaction.user.id}>**`, false);
      // Settle the paused host synchronously; a slow interaction webhook must not hold execution in a limbo state.
      void interaction.deferUpdate().then(() => interaction.editReply({ content: settle(entry.text, `**direction changed by <@${interaction.user.id}>**`), components: [], ...quiet })).catch(noop);
      return;
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith(planModalPrefix)) {
      const controls = plans.get(interaction.customId.slice(planModalPrefix.length));
      const request = interaction.fields.getTextInputValue(planModal.field);
      const note = controls ? controls.press('change', { id: interaction.user.id, name: interaction.user.username }, request) : 'This plan is no longer available: teapilot restarted since, or it was replaced.';
      // The plan's own message shows the outcome; only a refusal needs saying.
      if (interaction.isFromMessage()) await interaction.deferUpdate().catch(noop);
      if (note) await (interaction.isFromMessage() ? interaction.followUp({ content: note, flags: MessageFlags.Ephemeral, ...quiet }) : interaction.reply({ content: note, flags: MessageFlags.Ephemeral, ...quiet })).catch(noop);
      return;
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith(browseModalPrefix)) {
      const [nonce, action] = interaction.customId.slice(browseModalPrefix.length).split(':') as [string, BrowseAction];
      const entry = browsing.get(nonce);
      if (!entry) { await interaction.reply({ content: browseGone, flags: MessageFlags.Ephemeral, ...quiet }).catch(noop); return; }
      if (entry.userId !== interaction.user.id) { await interaction.reply({ content: 'this view is not yours.', flags: MessageFlags.Ephemeral, ...quiet }).catch(noop); return; }
      // Reading and zipping a file can outlast Discord's 3 seconds; a folder is quick.
      if (action === 'file') await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(noop);
      try {
        const outcome = await browseSubmit(entry.session, action, interaction.fields.getTextInputValue('path'));
        if ('show' in outcome) {
          // The view is the message the button was pressed on, so it is edited in place.
          await (interaction.isFromMessage() ? interaction.update({ content: outcome.show, ...quiet }) : interaction.reply({ content: outcome.show, flags: MessageFlags.Ephemeral, ...quiet }));
        } else if (action === 'file') {
          const message = await interaction.editReply({ content: outcome.note, files: outcome.file ? attachments([outcome.file]) : [],
            components: outcome.file ? [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`${editFilePrefix}open`).setLabel('edit file').setStyle(ButtonStyle.Primary))] : [], ...quiet });
          const path = entry.session.browser.filePath?.(interaction.fields.getTextInputValue('path'));
          if (message && path) {
            handlers.bindFileReply?.(message.id, entry.conversation, path, { id: interaction.user.id, name: interaction.user.username });
          }
        } else await interaction.reply({ content: outcome.note, flags: MessageFlags.Ephemeral, ...quiet });
      } catch (error) {
        log(`Discord: could not open from /workspace tree: ${failure(error)}`);
        const note = 'that didn\'t work - try again?';
        await (interaction.deferred ? interaction.editReply({ content: note }) : interaction.reply({ content: note, flags: MessageFlags.Ephemeral })).catch(noop);
      }
      return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith(sidePrefix)) {
      await share(interaction, interaction.customId.slice(sidePrefix.length));
      return;
    }
    if (!interaction.isButton()) return;
    if (interaction.customId.startsWith(checkpointPrefix)) {
      const [nonce, action] = interaction.customId.slice(checkpointPrefix.length).split(':');
      const entry = checkpoints.get(nonce ?? '');
      if (!entry || entry.settled || Date.now() >= entry.checkpoint.expiresAt) { await interaction.reply({ content: 'this checkpoint is no longer open.', flags: MessageFlags.Ephemeral, ...quiet }).catch(noop); return; }
      if (action === 'redirect') {
        await interaction.showModal({ custom_id: `${checkpointModalPrefix}${nonce}`, title: 'change direction', components: [{ type: 1, components: [{ type: 4, custom_id: 'amendment', label: 'what should change?', style: 2, required: true, max_length: 1000 }] }] } as unknown as APIModalInteractionResponseCallbackData).catch(noop); return;
      }
      if (action === 'stop') {
        const reply = entry.stop(interaction.user.id);
        if (reply?.text !== 'stopping…') { await interaction.reply({ content: reply?.text ?? 'this turn cannot be stopped here.', flags: MessageFlags.Ephemeral, ...quiet }).catch(noop); return; }
        await interaction.deferUpdate().catch(noop); return;
      }
      const decision = entry.decide(action === 'finish' ? 'finish_partial' : 'continue', interaction.user.id);
      if (!decision) { await interaction.reply({ content: 'this choice is unavailable or you are not authorised.', flags: MessageFlags.Ephemeral, ...quiet }).catch(noop); return; }
      const verdict = action === 'finish' ? '**finishing partial result**' : '**continuing within the approved window**';
      entry.finish(decision, verdict, false);
      void interaction.update({ content: settle(entry.text, verdict), components: [], ...quiet }).catch(noop);
      return;
    }
    if (interaction.customId.startsWith(choicePrefix)) {
      const [nonce, index] = interaction.customId.slice(choicePrefix.length).split(':');
      const entry = choices.get(nonce ?? '');
      if (!entry) { await interaction.reply({ content: 'This choice is no longer open.', flags: MessageFlags.Ephemeral }).catch(noop); return; }
      if (entry.userId !== interaction.user.id) { await interaction.reply({ content: 'This choice is not yours.', flags: MessageFlags.Ephemeral }).catch(noop); return; }
      choices.delete(nonce!);
      // Acknowledge at once: whatever the choice leads to may take longer than Discord's 3 seconds.
      await interaction.deferUpdate().catch(noop);
      entry.resolve({
        choice: Number(index),
        settle: async note => { await interaction.editReply({ content: note, components: [] }); },
        transport: () => interactionTransport(interaction),
      });
      return;
    }
    if (interaction.customId.startsWith(browsePrefix)) {
      const [nonce, action] = interaction.customId.slice(browsePrefix.length).split(':') as [string, BrowseAction];
      const entry = browsing.get(nonce);
      if (!entry) { await interaction.reply({ content: browseGone, flags: MessageFlags.Ephemeral, ...quiet }).catch(noop); return; }
      if (entry.userId !== interaction.user.id) { await interaction.reply({ content: 'this view is not yours.', flags: MessageFlags.Ephemeral, ...quiet }).catch(noop); return; }
      await interaction.showModal(browseModal(action, nonce, entry.session.dir) as unknown as APIModalInteractionResponseCallbackData).catch(noop);
      return;
    }
    if (interaction.customId.startsWith(grantPrefix)) {
      const panel = panels.get(interaction.message.id);
      if (!panel) { await interaction.reply({ content: grantsGone, flags: MessageFlags.Ephemeral, ...quiet }).catch(noop); return; }
      // A grant can wait on an operator's approval, well past Discord's 3 seconds.
      await interaction.deferUpdate().catch(noop);
      const note = await panel.press(interaction.customId.slice(grantPrefix.length) as Permission, interaction.user.id).catch(error => `that didn't work: ${failure(error)}`);
      await interaction.editReply({ ...grantView(panel) as unknown as BaseMessageOptions, ...quiet }).catch(noop);
      if (note) await interaction.followUp({ content: note, flags: MessageFlags.Ephemeral, ...quiet }).catch(noop);
      return;
    }
    if (interaction.customId.startsWith(showPrefix)) {
      // Anyone in the channel may look; the answer shows to them alone, so the button keeps working for everyone else.
      const answer = handlers.asides.find(interaction.customId.slice(showPrefix.length));
      if (!answer) { await interaction.reply({ content: 'This answer is no longer available.', flags: MessageFlags.Ephemeral }).catch(noop); return; }
      try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        let first = true;
        await sendAside(answer, (content, files) => {
          if (!first) return interaction.followUp({ content, files, flags: MessageFlags.Ephemeral, ...quiet });
          first = false;
          return interaction.editReply({ content, files, ...quiet });
        });
      } catch (error) { log(`Discord: side answer not shown: ${failure(error)}`); }
      return;
    }
    if (interaction.customId.startsWith(summaryPrefix)) {
      const [nonce, action] = interaction.customId.slice(summaryPrefix.length).split(':');
      const answer = await pendingAside(interaction, nonce ?? '');
      if (!answer) return;
      if (action !== 'post' || !answer.summary) { await interaction.update({ content: '-# Summary not posted.', components: [] }).catch(noop); return; }
      sideAnswers.delete(nonce!);
      await interaction.update({ components: [] }).catch(noop);
      try {
        // Sources are inline links; without embeds they stay links instead of cluttering the channel with previews.
        await sendAside({ ...answer, parts: [{ text: answer.summary, files: [] }] }, content => interaction.followUp({ content, flags: MessageFlags.SuppressEmbeds, ...quiet }));
      } catch (error) {
        log(`Discord: side answer summary not posted: ${failure(error)}`);
        await interaction.followUp({ content: 'That summary could not be posted here.', flags: MessageFlags.Ephemeral }).catch(noop);
      }
      return;
    }
    if (interaction.customId.startsWith(planPrefix)) {
      const action = interaction.customId.slice(planPrefix.length) as PlanAction;
      const controls = plans.get(interaction.message.id);
      const refused = controls ? controls.refusal(interaction.user.id) : 'This plan is no longer available: teapilot restarted since, or it was replaced.';
      if (!controls || refused || !(action in planButtons)) { await interaction.reply({ content: refused ?? 'Unknown plan button.', flags: MessageFlags.Ephemeral, ...quiet }).catch(noop); return; }
      if (action === 'change') {
        await interaction.showModal({ custom_id: `${planModalPrefix}${interaction.message.id}`, title: planModal.title, components: [{ type: 1, components: [
          { type: 4, custom_id: planModal.field, label: planModal.label, style: 2, required: true, max_length: planModal.maxLength }] }] } as unknown as APIModalInteractionResponseCallbackData).catch(noop);
        return;
      }
      // The plan's message is edited by the conversation; nothing new is posted for the click.
      await interaction.deferUpdate().catch(noop);
      const note = controls.press(action, { id: interaction.user.id, name: interaction.user.username });
      if (note) await interaction.followUp({ content: note, flags: MessageFlags.Ephemeral, ...quiet }).catch(noop);
      return;
    }
    if (interaction.customId === `${cardPrefix}resume`) {
      const resume = resumers.get(interaction.message.id);
      if (!resume) { await interaction.reply({ content: 'This turn is no longer available: teapilot restarted since, or the turn is too old.', flags: MessageFlags.Ephemeral }).catch(noop); return; }
      await interaction.deferUpdate().catch(noop);
      await resume(interaction).catch(error => log(`Discord: could not resume a status card: ${failure(error)}`));
      return;
    }
    if (interaction.customId.startsWith(viewSourcePrefix)) {
      // Read back from the embed itself, so the button works for anyone, and after a restart.
      const source = viewSource(interaction.customId, interaction.message.embeds[0]?.toJSON(), viewSourcePrefix);
      const block = source && `\`\`\`md\n${source}\n\`\`\``;
      const content = !block ? 'this table can no longer be read back.' : block.length <= MESSAGE_LIMIT ? block : 'the table is attached.';
      const files = block && block.length > MESSAGE_LIMIT ? [{ attachment: Buffer.from(`${source}\n`), name: 'table.md' }] : [];
      await interaction.reply({ content, files, flags: MessageFlags.Ephemeral, ...quiet }).catch(noop);
      return;
    }
    if (interaction.customId.startsWith(cardPrefix)) {
      const press = cards.get(interaction.message.id);
      let reply: { text: string; file?: { name: string; content: string } };
      try { reply = press ? press(interaction.customId.slice(cardPrefix.length) as CardButton, interaction.user.id) : { text: 'This turn is no longer available: teapilot restarted since, or the turn is too old.' }; }
      catch (error) { reply = { text: `That did not work: ${error instanceof Error ? error.message : String(error)}` }; }
      await interaction.reply({ content: reply.text, files: reply.file ? [{ attachment: Buffer.from(reply.file.content), name: reply.file.name }] : [], flags: MessageFlags.Ephemeral, ...quiet }).catch(noop);
      return;
    }
    const [prefix, nonce, verdict] = interaction.customId.split(':');
    if (prefix !== 'teapilot' || !nonce) return;
    const continuation = pendingContinuations.get(nonce);
    const entry = pending.get(nonce);
    const mayAnswer = settings.allowedUserIds.includes(interaction.user.id) || (entry?.users === true && handlers.allowed?.(interaction.user.id) === true);
    if (!mayAnswer) {
      await interaction.reply({ content: 'You are not allowed to approve teapilot actions.', flags: MessageFlags.Ephemeral }).catch(noop);
      return;
    }
    if (!entry && !continuation) { await interaction.reply({ content: 'This approval is no longer pending.', flags: MessageFlags.Ephemeral }).catch(noop); return; }
    if (continuation) {
      const approved = verdict === 'approve';
      if (!continuation.claim()) { await interaction.reply({ content: 'This approval is no longer pending.', flags: MessageFlags.Ephemeral }).catch(noop); return; }
      await interaction.deferUpdate().catch(noop);
      continuation.resolve(approved ? 'approved' : 'denied', interaction.user.id);
      return;
    }
    if (!entry) return;
    pending.delete(nonce);
    const approved = verdict === 'approve';
    await interaction.update({ content: settle(entry.text, `**${approved ? 'Approved' : 'Denied'}** by <@${interaction.user.id}>`), components: [], ...quiet }).catch(noop);
    entry.resolve(approved);
  });

  client.on(Events.MessageCreate, message => {
    const self = client.user;
    if (!self || message.author.id === self.id || !message.channel.isSendable()) return;
    const channel = message.channel;
    const thread = channel.isThread() ? channel : undefined;
    handlers.message({
      authorId: message.author.id,
      authorIsBot: message.author.bot,
      authorName: message.author.username,
      guildId: message.guildId ?? undefined,
      channelId: message.channelId,
      parentId: thread?.parentId ?? undefined,
      ownThread: thread?.ownerId === self.id,
      mentionsBot: message.mentions.users.has(self.id),
      content: strip(message.content, self.id),
      attachments: [...message.attachments.values()].map(incoming),
      replyChain: () => replyChain(message, self.id),
      transport: () => transport(channel),
      replyTransport: () => transport(channel, message),
      react: async emoji => { await message.react(emoji); },
      async startThread(name) {
        const created = await message.startThread({ name: name.slice(0, 90) || 'teapilot', autoArchiveDuration: ThreadAutoArchiveDuration.OneDay });
        return { id: created.id, transport: transport(created) };
      },
    });
  });
  client.on(Events.Error, error => log(`Discord: ${error.message}`));

  // Registering on ready overwrites teapilot's global set, so removed commands disappear on the next start.
  const ready = new Promise<void>(resolve => client.once(Events.ClientReady, () => {
    void (async () => {
      const done = () => log(`Registered ${commandDefinitions.length} app commands.`);
      try { await client.application?.commands.set(commandDefinitions); done(); }
      catch (error) {
        // Discord rejects user-install commands until User Install is enabled in the Developer Portal.
        log(`App command registration failed: ${error instanceof Error ? error.message : String(error)}. Retrying without user-install support.`);
        await client.application?.commands.set(withoutUserInstall(commandDefinitions)).then(done)
          .catch(retry => log(`App command registration failed: ${retry instanceof Error ? retry.message : String(retry)}`));
      }
    })();
    resolve();
  }));
  try { await client.login(settings.token); }
  catch (error) {
    await client.destroy();
    const message = error instanceof Error ? error.message : String(error);
    if (/disallowed intents/i.test(message)) throw new Error('Discord refused the Message Content intent. Enable it in the Developer Portal under Bot → Privileged Gateway Intents, then retry.');
    if (/invalid token|TokenInvalid/i.test(message)) throw new Error('Discord rejected the bot token. Reset it in the Developer Portal and rerun teapilot discord setup.');
    throw error;
  }
  await ready;
  const messages = async (channelId: string) => {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isSendable()) throw new Error('teapilot cannot post in this channel.');
    return channel;
  };
  return {
    botName: client.user?.tag ?? 'bot',
    username: id => client.users.fetch(id).then(user => user.username, () => undefined),
    play: {
      async post(channelId, payload) { return (await (await messages(channelId)).send(raw(payload))).id; },
      async edit(channelId, messageId, payload) { await (await messages(channelId)).messages.edit(messageId, raw(payload, true)); },
      request: (method, route, body) => client.rest.request({ method: method as RequestMethod, fullRoute: route as RouteLike, body }),
    },
    // A custom status carries its text in `state`; the name is required but never shown for this type.
    async setStatus(text) {
      client.user?.setPresence({ activities: text ? [{ name: 'Custom Status', type: ActivityType.Custom, state: text.slice(0, statusLimitChars) }] : [], status: 'online' });
    },
    async close() {
      for (const entry of pending.values()) entry.resolve(false);
      pending.clear();
      for (const entry of choices.values()) entry.resolve(undefined);
      choices.clear();
      await client.destroy();
    },
  };
}
