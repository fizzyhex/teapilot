import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import type { Action, Effect, Embed, Participants, User, View } from '@teapilot/discord-play';
import { interactionLifetimeMs } from '../commands.js';
import type { PictureSpec } from '../images.js';
import { maxOutputChars, type CallInput, type ContextData, type PlayEngine } from './engine.js';
import { describe, findControl, ignoredKeys, normalizeView, PlayError, renderEmbeds, renderModal, renderView, type Attached, type MessagePayload, type ModalPayload } from './render.js';
import { sandbox } from './sandbox.js';
import type { PlayRecord, PlayStore } from './store.js';
import { trusted, type DiscordRequest } from './trusted.js';
import type { AssetFiles } from './assets.js';
import { PlayDelivery } from './delivery.js';

/** Where an app's message lives; the gateway implements it. */
export interface PlaySurface {
  post(channelId: string, payload: MessagePayload): Promise<string>;
  edit(channelId: string, messageId: string, payload: MessagePayload): Promise<Attached>;
  /** Raw Discord REST, for trusted apps only. */
  request: DiscordRequest;
}
/**
 * An app posted as the reply to an interaction, where teapilot cannot post in the channel. Discord lets that
 * interaction edit it for 15 minutes; after that only a click on the app, which brings its own 15 minutes, can.
 */
export interface HostedMessage { id: string; edit(payload: MessagePayload): Promise<Attached> }
/** One click, selection or form submission on an app's message. */
export interface PlayInteraction {
  playId: string; controlId: string; kind: 'button' | 'select' | 'modal' | 'resend' | 'paste'; user: User;
  /** Repost and /paste can post publicly even where the bot has no channel posting permission. */
  post?: StartOptions['post'];
  /** /paste: the channel the app moves to. */
  channelId?: string;
  /** The message that was used; a copy the app has since moved away from is turned away. */
  messageId?: string;
  values?: string[]; fields?: Record<string, string>;
  /** First response only: show a form. */
  openModal(payload: ModalPayload): Promise<void>;
  /** First response only: a private note, leaving the message alone. */
  reply(content: string): Promise<void>;
  /** First response only: acknowledge now and edit the message later. */
  defer(): Promise<void>;
  /** First response only: edit the app's message as the answer, in one request. Without it, clicks defer and then update. */
  respond?(payload: MessagePayload): Promise<Attached>;
  /** After defer() or respond(): edit the app's message. */
  update(payload: MessagePayload): Promise<Attached>;
  /** After defer(): a private note to the person who acted. */
  followUp(content: string, embeds?: Array<Record<string, unknown>>): Promise<void>;
}
/** Conversation images that apps show with picture(); `check` throws a PlayError for one that cannot be shown. */
export interface Pictures {
  check(conversation: string, spec: PictureSpec): void;
  render(conversation: string, spec: PictureSpec): Promise<{ name: string; data: Buffer }>;
}
/** Asks the model on the app's behalf; resolves with the answer text. */
export type Consultant = (play: { title: string; owner: User; channelId: string; conversation?: string }, prompt: string) => Promise<string>;
export type Source = PlayRecord['source'];
export interface StartOptions {
  title: string; channelId: string; conversation: string; owner: User; source: Source; participants?: Participants; emojis?: Record<string, string>;
  /** The workspace file the code came from, which play_update reloads. */
  file?: string;
  assetFiles?: AssetFiles;
  /** Posts the app through an interaction instead of in the channel. */
  post?: (payload: MessagePayload) => Promise<HostedMessage>;
}
export interface TestAction { kind: Action['kind']; id: string; user?: User; values?: string[]; fields?: Record<string, string>; text?: string; error?: string }
export interface TestExpectation { path: string; equals: unknown }
export interface TestOptions { participants?: Participants; emojis?: Record<string, string>; steps?: boolean; state?: unknown; conversation?: string; expect?: TestExpectation[] }
export interface TestReport {
  text: string; sourceState: 'init' | 'live'; coverage: 'simulation' | 'assertions';
  completed: number; skipped: number; unchanged: number;
  errors: Array<{ step: number; message: string }>;
  assertions: { passed: number; failed: number };
}
/** Time for apps, timers and expiry; a simulator swaps it to skip ahead. `after` returns a cancel function. */
export interface Clock { now(): number; after(ms: number, run: () => void): () => void }
export const systemClock: Clock = {
  now: () => Date.now(),
  after(ms, run) { const timer = setTimeout(run, ms); timer.unref?.(); return () => clearTimeout(timer); },
};

export const playLimits = {
  perChannel: 5, total: 50, hibernateMs: 10 * 60_000, idleMs: 24 * 60 * 60_000, keepFinishedMs: 7 * 24 * 60 * 60_000,
  timers: 10, minTimerMs: 2000, maxTimerMs: 24 * 60 * 60_000, consultsPerHour: 20, consultPromptChars: 4000,
  stateChars: 64_000, log: 20,
};
const idPattern = /^[A-Za-z0-9_.-]{1,64}$/;
/** Spacing between channel edits of one app's message; Discord allows about five a channel every five seconds. */
const editSpacingMs = 1000;
/** How long a click waits for its new view before deferring, well inside Discord's three seconds. */
const answerMs = 1500;

interface Live {
  record: PlayRecord;
  engine?: PlayEngine;
  timers: Map<string, () => void>;
  consulting: boolean;
  chain: Promise<unknown>;
  /** For an app posted through an interaction: the newest interaction that can still edit its message. */
  reach?: { edit(payload: MessagePayload): Promise<Attached>; until: number };
  /** While someone is playing: when the app hibernates unless something happens first. Never stored, so a restart leaves every app asleep. */
  awakeUntil?: number;
  /** Cancels the hibernation that `awakeUntil` is waiting for. */
  sleeper?: () => void;
  delivery?: PlayDelivery;
  /** Last successfully delivered view, before attachment rendering. */
  delivered?: MessagePayload;
  /** The pictures the app's message carries now, so an edit keeps the ones that have not changed. */
  uploads?: { messageId: string; files: Array<{ id: string; name: string; data: Buffer }> };
}
interface Advance { state: unknown; seed: number; view: View; payload: MessagePayload; effects: Effect[]; timers: PlayRecord['timers']; finished?: { summary?: string } }

export const hashFile = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
const moved = 'This app moved to a newer message below.';
const movedAway = 'This app moved to another channel.';
const withNote = (payload: MessagePayload, note?: string): MessagePayload => note ? { ...payload, content: clip(`${payload.content}${payload.content ? '\n' : ''}-# ${note}`, 2000) } : payload;

function normalize(value: unknown): { state: unknown; effects: unknown[] } {
  if (typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'step' && 'state' in value) {
    const effects = (value as { effects?: unknown }).effects;
    return { state: (value as { state: unknown }).state ?? null, effects: Array.isArray(effects) ? effects : [] };
  }
  return { state: value ?? null, effects: [] };
}

function checkEffects(effects: unknown[]): Effect[] {
  return effects.map(effect => {
    const value = effect as Record<string, unknown>;
    if (typeof value !== 'object' || value === null) throw new PlayError('Effects must be built with ephemeral(), after(), cancel(), finish() or consult().');
    const key = (what: string) => { if (typeof value.id !== 'string' || !idPattern.test(value.id)) throw new PlayError(`${what} id must be 1–64 letters, digits, "_", "." or "-", not ${JSON.stringify(value.id).slice(0, 80)}. Use a fixed id such as "reply", and keep what it was about in state.`); return value.id; };
    switch (value.type) {
      case 'ephemeral':
        if (typeof value.content !== 'string' || value.content.length > 2000) throw new PlayError('ephemeral() content must be a string of at most 2000 characters.');
        if (value.embeds !== undefined) renderEmbeds(value.embeds);
        return value.embeds === undefined ? { type: 'ephemeral', content: value.content } : { type: 'ephemeral', content: value.content, embeds: value.embeds as Embed[] };
      case 'after':
        if (typeof value.ms !== 'number' || !Number.isFinite(value.ms) || value.ms < playLimits.minTimerMs || value.ms > playLimits.maxTimerMs) throw new PlayError(`after() takes ${playLimits.minTimerMs} ms to 24 hours; each tick edits the message, and Discord limits how often that can happen.`);
        return { type: 'after', id: key('after()'), ms: value.ms };
      case 'cancel': return { type: 'cancel', id: key('cancel()') };
      case 'finish':
        if (value.summary !== undefined && typeof value.summary !== 'string') throw new PlayError('finish() summary must be a string.');
        return value.summary === undefined ? { type: 'finish' } : { type: 'finish', summary: clip(value.summary, 300) };
      case 'consult':
        if (typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > playLimits.consultPromptChars) throw new PlayError(`consult() prompt must be 1–${playLimits.consultPromptChars} characters.`);
        return { type: 'consult', id: key('consult()'), prompt: value.prompt };
      default: throw new PlayError(`Unknown effect ${JSON.stringify(value.type)}.`);
    }
  });
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function checkState(state: unknown): void {
  const size = JSON.stringify(state)?.length ?? 0;
  if (size > playLimits.stateChars) throw new PlayError(`State is ${size} characters as JSON; the limit is ${playLimits.stateChars}. Keep only what the app needs.`);
}

/**
 * Owns every discord.play app: runs actions one at a time per app, commits a new state only when
 * update, view and rendering all succeed, keeps timers and records on disk so apps survive a restart,
 * and answers every Discord interaction within Discord's three-second window.
 */
export class PlayRuntime {
  private readonly listeners = new Set<(id: string) => void>();
  subscribe(listener: (id: string) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed(id: string): void { for (const listener of this.listeners) { try { listener(id); } catch (error) { this.options.log(`play ${id}: ${errorText(error)}`); } } }
  /** Anyone in the channel can bring an app back without gaining permission to play it. */
  resendTarget(channelId: string, messageId: string): string | undefined {
    return [...this.live.values()].find(({ record }) => record.channelId === channelId && record.messageId === messageId)?.record.id;
  }
  browserTarget(channelId: string, messageId: string, user: User): string | undefined {
    return [...this.live.values()].find(({ record }) => record.channelId === channelId && record.messageId === messageId && this.allowed(record, user.id))?.record.id;
  }
  async browserView(id: string, user: User) {
    const live = this.live.get(id);
    if (!live || !this.allowed(live.record, user.id)) throw new PlayError('this app is unavailable.');
    const record = live.record;
    const payload = await this.attach(record, withNote(renderView(id, record.view, record.status !== 'running'), record.note));
    const unsupported = (record.view.rows ?? []).flatMap(row => row.controls.filter(control => control.type === 'select' || control.opens).map(control => control.id));
    return { title: record.title, status: record.status, payload, unsupported, discordStale: !this.reachable(live) };
  }
  async browserPress(id: string, controlId: string, user: User) {
    const live = this.live.get(id);
    if (!live) throw new PlayError('this app is unavailable.');
    return this.serial(live, async () => {
      const record = live.record;
      if (record.status !== 'running' || !this.allowed(record, user.id)) throw new PlayError('you cannot use this app right now.');
      const control = findControl(record.view, controlId);
      if (!control || control.type !== 'button' || control.disabled || control.opens || control.url) throw new PlayError('use this control in discord.');
      this.wake(live, true);
      const { payload, notes } = await this.dispatch(live, { kind: 'button', id: controlId, user }, `button ${controlId} by ${user.id}`);
      if (this.reachable(live)) this.show(live, payload);
      return notes.map(note => ({ content: note.content, embeds: note.embeds && renderEmbeds(note.embeds) }));
    });
  }
  private readonly live = new Map<string, Live>();
  private readonly deliveries = new Set<PlayDelivery>();
  private sweeper?: () => void;

  constructor(private readonly options: {
    store: PlayStore; surface: PlaySurface; log: (text: string) => void;
    consult?: Consultant; clock?: Clock; pictures?: Pictures;
    /** Try every control before an app is posted or replaced (default true). */
    probe?: boolean;
    /** How many apps are running, whenever that changes; for the bot's Discord status. */
    onRunning?: (count: number) => void;
    /** Minimum spacing between app-message edits; Discord's transport still handles actual rate limits. */
    discordEditMs?: number;
  }) {}

  /** The last count `onRunning` was told, so it only hears about real changes. */
  private reported = 0;

  private get clock(): Clock { return this.options.clock ?? systemClock; }
  private now(): number { return this.clock.now(); }

  private context(record: PlayRecord): ContextData {
    return { now: this.now(), invoker: record.owner, participants: record.participants, emojis: record.emojis, seed: record.seed };
  }

  private async build(source: Source): Promise<PlayEngine> {
    if (source.kind === 'sandbox') return sandbox(source.code, source.assets);
    if (await hashFile(source.path).catch(() => undefined) !== source.sha256) throw new PlayError('The trusted app file changed since it was approved. Start or update it again to re-approve.');
    return trusted(source.path, this.options.surface.request, this.options.log);
  }

  private async engine(live: Live): Promise<PlayEngine> {
    if (!live.engine) {
      try { live.engine = await this.build(live.record.source); }
      catch (error) {
        if (live.record.source.kind === 'trusted') await this.halt(live, 'paused', `Paused: ${errorText(error)}`);
        throw error;
      }
    }
    return live.engine;
  }

  /** Runs one step without committing anything: update (or init), then view, then rendering. */
  private async advance(engine: PlayEngine, record: PlayRecord, action?: Action): Promise<Advance> {
    const input: CallInput = { state: record.state, action, ctx: this.context(record) };
    const result = await engine.call(action ? 'update' : 'init', input);
    const { state, effects } = normalize(result.value);
    checkState(state);
    const checked = checkEffects(effects);
    const shown = await engine.call('view', { state, ctx: { ...input.ctx, seed: result.seed } });
    const finish = checked.find(effect => effect.type === 'finish');
    const view = normalizeView(shown.value);
    const payload = renderView(record.id, view, Boolean(finish));
    this.checkPictures(record, payload);
    const timers = new Map(record.timers.map(({ id, ...pending }) => [id, pending]));
    for (const effect of checked) {
      // A timer is only ever asked for a duration here; arm() is what turns that into a deadline, and only while the app is awake.
      if (effect.type === 'after') timers.set(effect.id, { ms: effect.ms });
      else if (effect.type === 'cancel') timers.delete(effect.id);
    }
    if (finish) timers.clear();
    if (timers.size > playLimits.timers) throw new PlayError(`An app may have ${playLimits.timers} timers pending.`);
    return { state, seed: shown.seed, view: view as View, payload: withNote(payload, finish?.summary), effects: checked, timers: [...timers].map(([id, pending]) => ({ id, ...pending })), finished: finish ? { summary: finish.summary } : undefined };
  }

  /**
   * Uses every enabled control once from a step's state, as its owner would, then lets what that
   * sets off run for a while: timers fire and consults get an unhelpful answer. Nothing is
   * committed. A control that would break when someone uses it stops the app before anyone sees it;
   * finishing while controls are still on show is only returned as a note, since it may be intended.
   */
  private async probe(engine: PlayEngine, record: PlayRecord, from: Advance, running = false): Promise<string[]> {
    if (this.options.probe === false) return [];
    const problems: string[] = [];
    const notes = new Set<string>();
    let budget = 60;
    let timed = from.timers.length > 0;
    const scheduled = new Set(from.timers.map(timer => timer.id));
    // A probe stands in for someone playing, so clocks still waiting for that are counted from here.
    const at = this.now();
    const base: PlayRecord = { ...record, state: from.state, seed: from.seed, timers: from.timers.map(timer => timer.dueAt === undefined ? { ...timer, dueAt: at + (timer.ms ?? 0) } : timer) };
    const before = JSON.stringify(from.state) + describe(from.view);
    const tried: string[] = [], inert: string[] = [];
    // Emoji that reach Discord as plain text: :shortcodes:, and server emoji inside backticks.
    const shortcodes = new Set<string>(), coded = new Set<string>();
    const lookAt = (view: View) => { const shown = describe(view); for (const code of shortcodesIn(shown)) shortcodes.add(code); for (const code of codedEmojiIn(shown)) coded.add(code); };
    lookAt(from.view);
    // With nothing to press and nothing on its way, an app is stuck before anyone can start it.
    const usable = (from.view.rows ?? []).flatMap(row => row.controls).some(control => !control.disabled && !(control.type === 'button' && control.url));
    if (!usable && !from.timers.length && !from.effects.some(effect => effect.type === 'consult')) {
      // Controls written somewhere nothing reads them are the usual cause, so name where they went.
      const meta = (await engine.call('meta', { ctx: this.context(record) })).value as { keys?: string[] } | null;
      const onApp = meta?.keys?.includes('controls') ? ' Controls go in view()\'s rows, not on app().' : '';
      throw new PlayError(`People could not do anything with this app: its view has no controls, and no timer or consult is on its way. Show the controls people need in every state, such as a start or join button.${ignoredKeys(from.view)}${onApp}`);
    }
    for (const control of (from.view.rows ?? []).flatMap(row => row.controls)) {
      if (control.disabled || (control.type === 'button' && control.url)) continue;
      const name = control.type === 'button' ? `[${control.label || control.emoji || control.id}]` : `select ${control.id}`;
      const action: Action = control.type === 'select'
        ? { kind: 'select', id: control.id, user: record.owner, values: control.options.slice(0, 1).map(option => option.value) }
        : control.opens
          ? { kind: 'modal', id: control.opens.id, user: record.owner, fields: Object.fromEntries(control.opens.fields.map(field => [field.id, 'test'])) }
          : { kind: 'button', id: control.id, user: record.owner };
      let current = base;
      let pending: Action[] = [action];
      let label = control.type === 'button' && control.opens ? `submitting the form behind ${name}` : `using ${name}`;
      tried.push(name);
      for (let round = 0; round < 6 && pending.length && budget > 0; round++, budget--) {
        const next = pending.shift()!;
        if (round) label += next.kind === 'timer' ? `, then timer ${next.id}` : `, then an answer to consult ${next.id}`;
        let step: Advance;
        try { step = await this.advance(engine, current, next); }
        catch (error) { problems.push(`${label}: ${errorText(error)}`); break; }
        if (step.timers.length) timed = true;
        for (const timer of step.timers) scheduled.add(timer.id);
        if (!round && !step.effects.length && JSON.stringify(step.state) + describe(step.view) === before) inert.push(name);
        lookAt(step.view);
        if (next.kind !== 'button' && next.kind !== 'select' && next.kind !== 'modal' && step.effects.some(effect => effect.type === 'ephemeral')) notes.add(`${label} returns ephemeral(), but no one pressed anything, so no one sees it. Show that message in the view instead.`);
        if (step.finished) {
          const left = (step.view.rows ?? []).flatMap(row => row.controls).filter(shown => !shown.disabled && !(shown.type === 'button' && shown.url));
          if (left.length) notes.add(`${label} calls finish(), which ends the app and disables ${left.map(shown => shown.type === 'button' ? `[${shown.label || shown.emoji || shown.id}]` : `select ${shown.id}`).join(', ')} for good. If people should still use them (to play again, say), return a state instead of finish().`);
          break;
        }
        const consult = step.effects.find(effect => effect.type === 'consult');
        const timer = [...step.timers].sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0))[0];
        current = { ...current, state: step.state, seed: step.seed, timers: step.timers.filter(entry => entry !== timer) };
        pending = consult ? [{ kind: 'consult', id: consult.id, text: 'Sorry, I cannot help with that.' }] : timer ? [{ kind: 'timer', id: timer.id }] : [];
      }
      if (problems.length >= 3) break;
    }
    if (problems.length) throw new PlayError(`People using the app would hit these errors:\n${problems.map(problem => `- ${clip(problem, 400)}`).join('\n')}`);
    // Timer code that nothing reaches is also never checked, so its mistakes would only show once live.
    if (shortcodes.size) notes.add(`The view shows ${[...shortcodes].slice(0, 5).join(' ')} as plain text: Discord turns :shortcodes: into emoji only when a person types them. Use the Unicode emoji instead, or for a server emoji the whole <:name:id> as it was pasted.`);
    if (coded.size) notes.add(`The view puts ${[...coded].slice(0, 3).join(' ')} inside a code block or inline code, where Discord shows server emoji as their raw <:name:id> text. Keep boards and lines that hold server emoji outside backticks.`);
    if (tried.length && inert.length === tried.length) notes.add(`Using ${inert.join(', ')} changed nothing, so the app looks broken to whoever presses first. ${running ? 'If the kept state is what is stuck (a player now inside a wall, say), fix it in code or pass reset: true to start over from init().' : 'Check the first state: a player placed inside or boxed in by blocking tiles cannot move. If people instead join by acting, add them the first time their id acts.'}`);
    // A timer only an earlier step schedules (a start button long gone, say) never fires in an app already past it.
    const unreached = timed && record.source.kind === 'sandbox' ? [...new Set([...record.source.code.matchAll(/\bafter\(\s*[^,()]+,\s*(["'`])([\w.-]+)\1\s*\)/g)].map(match => match[2]!))].filter(id => !scheduled.has(id)) : [];
    const kick = (id: string) => running ? `This app is already running, so init() and any start button will not run again: to start it now, call play_update with timers: [{ id: "${id}", ms: 2000 }].` : '';
    if (unreached.length) notes.add(`Nothing tried from the current state schedules ${unreached.slice(0, 3).map(id => `after(…, "${id}")`).join(', ')}, so it will not fire yet. ${kick(unreached[0]!) || 'If it should already be running, also schedule it from something that still happens, such as a running tick or the next move.'}`);
    if (!timed && record.source.kind === 'sandbox' && /\bafter\b|["']timer["']/.test(record.source.code)) notes.add(`The code handles timers, but no timer is pending and using each control did not schedule one, so nothing will move on its own and the timer code is untested. ${kick('tick') || 'Schedule the first tick from the control that starts things: return step(state, after(2000, "tick")).'}`);
    return [...notes].slice(0, 3);
  }

  /** Every picture() the view shows names an image this conversation has. */
  private checkPictures(record: PlayRecord, payload: MessagePayload): void {
    if (!payload.pictures?.length) return;
    if (!this.options.pictures) throw new PlayError('picture() is not available here.');
    for (const spec of payload.pictures) this.options.pictures.check(record.conversation, spec);
  }

  /** The payload with its pictures rendered into attachments, ready to send. */
  private async attach(record: PlayRecord, payload: MessagePayload): Promise<MessagePayload> {
    const { pictures, ...rest } = payload;
    if (!pictures?.length) return rest;
    if (!this.options.pictures) throw new Error('picture() is not available here.');
    return { ...rest, files: await Promise.all(pictures.map(spec => this.options.pictures!.render(record.conversation, spec))) };
  }

  private remember(record: PlayRecord, action: string, error?: string): void {
    record.log = [...record.log, { at: this.now(), action, ...(error ? { error: clip(error, 500) } : {}) }].slice(-playLimits.log);
  }

  /** Commits a step and schedules its timers and consults; returns the private notes for whoever acted. */
  private commit(live: Live, step: Advance, action: string): Array<Extract<Effect, { type: 'ephemeral' }>> {
    const { record } = live;
    record.state = step.state; record.seed = step.seed; record.view = step.view; record.updatedAt = this.now();
    this.remember(record, action);
    record.timers = step.timers;
    if (step.finished) { record.status = 'finished'; record.note = step.finished.summary; }
    this.options.store.save(record);
    this.arm(live);
    if (step.finished) this.release(live);
    else for (const effect of step.effects) if (effect.type === 'consult') this.consult(live, effect);
    this.report();
    this.changed(record.id);
    return step.effects.filter((effect): effect is Extract<Effect, { type: 'ephemeral' }> => effect.type === 'ephemeral');
  }

  /** One action, serialized with every other action on the same app. Failures change nothing. */
  private async dispatch(live: Live, action: Action, label: string): Promise<{ payload: MessagePayload; notes: Array<Extract<Effect, { type: 'ephemeral' }>> }> {
    try {
      const step = await this.advance(await this.engine(live), live.record, action);
      return { payload: step.payload, notes: this.commit(live, step, label) };
    } catch (error) {
      this.remember(live.record, label, errorText(error));
      this.options.store.save(live.record);
      throw error;
    }
  }

  private serial<T>(live: Live, task: () => Promise<T>): Promise<T> {
    const run = live.chain.then(task, task);
    live.chain = run.catch(() => undefined);
    return run;
  }

  /** Timers and consult answers: no one is waiting on an interaction, so the message is edited directly. */
  private background(live: Live, action: Action, label: string): Promise<void> {
    return this.serial(live, async () => {
      if (live.record.status !== 'running' || !this.live.has(live.record.id)) return;
      try {
        const { payload, notes } = await this.dispatch(live, action, label);
        if (notes.length) this.options.log(`play ${live.record.id}: ${notes.length} private note(s) from ${label} had no one to go to.`);
        if (this.reachable(live)) this.show(live, payload);
      } catch (error) { this.options.log(`play ${live.record.id}: ${label} failed: ${errorText(error)}`); }
    });
  }

  /** False only for an app posted through an interaction once nothing can edit its message any more. */
  private reachable(live: Live): boolean {
    return !live.record.viaInteraction || (live.reach !== undefined && live.reach.until > this.now());
  }

  private delivery(live: Live): PlayDelivery {
    if (!live.delivery) {
      live.delivery = new PlayDelivery(this.clock, this.options.discordEditMs ?? editSpacingMs,
        error => this.options.log(`play ${live.record.id}: could not update its message: ${errorText(error)}`));
      this.deliveries.add(live.delivery);
    }
    return live.delivery;
  }

  /**
   * Snapshot the target and view; coalesce edits outside the state queue. `edit` answers a click, so it goes
   * out at once. Resolves once this view is sent, skipped or replaced.
   */
  private show(live: Live, payload: MessagePayload, edit?: (payload: MessagePayload) => Promise<Attached>): Promise<void> {
    const record = { ...live.record };
    const originalReach = live.reach;
    if (!record.messageId) return Promise.resolve();
    return this.delivery(live).enqueue(async current => {
      // A picture's source file can change without its spec changing.
      if (!payload.pictures?.length && isDeepStrictEqual(payload, live.delivered)) return false;
      const reach = record.messageId === live.record.messageId ? live.reach : originalReach;
      if (record.viaInteraction && (!reach || reach.until <= this.now())) return false;
      const rendered = await this.attach(record, payload);
      if (!current()) return false;
      const ready = this.reuse(live, record.messageId!, rendered);
      if (!ready.files?.length && isDeepStrictEqual(payload, live.delivered)) return false;
      let attached: Attached;
      if (!record.viaInteraction && edit) attached = await edit(ready);
      else if (!record.viaInteraction) attached = await this.options.surface.edit(record.channelId, record.messageId!, ready);
      else if (reach!.until > this.now()) attached = await reach!.edit(ready);
      else return false;
      if (record.messageId !== live.record.messageId) return;
      live.delivered = payload;
      const files = rendered.files ?? [];
      live.uploads = attached ? { messageId: record.messageId!, files: files.flatMap(file => attached.filter(entry => entry.name === file.name).map(({ id }) => ({ ...file, id }))) } : undefined;
    }, Boolean(edit));
  }

  /** Pictures the message already shows with the same bytes are kept by id instead of uploaded again. */
  private reuse(live: Live, messageId: string, payload: MessagePayload): MessagePayload {
    const shown = live.uploads?.messageId === messageId ? live.uploads.files : [];
    const keep = (payload.files ?? []).flatMap(file => shown.filter(old => old.name === file.name && old.data.equals(file.data)).slice(0, 1));
    if (!keep.length) return payload;
    return { ...payload, files: payload.files!.filter(file => !keep.some(old => old.name === file.name)), keep: keep.map(old => old.id) };
  }

  /** Whether the app is playing now: posted, used or resent within the last ten minutes. */
  private awake(live: Live): boolean {
    return live.awakeUntil !== undefined && live.awakeUntil > this.now();
  }

  /**
   * Someone is playing, so the app runs for the next ten minutes: its clocks start from here, and the
   * ones it was holding pick up with exactly the wait they had left.
   */
  private wake(live: Live, browser = false): void {
    live.sleeper?.();
    const until = this.now() + playLimits.hibernateMs;
    // An app posted through an interaction can only be edited for as long as that interaction lasts.
    const reach = live.record.viaInteraction && !browser ? live.reach?.until : undefined;
    live.awakeUntil = reach !== undefined && reach < until ? reach : until;
    live.sleeper = this.clock.after(Math.max(0, live.awakeUntil - this.now()), () => this.hibernate(live));
    this.arm(live);
  }

  /**
   * Nobody has played for ten minutes, so the app stops costing anything: its clocks put away what
   * they have left to wait, which is what the next click starts them from. Its message is left alone.
   */
  private hibernate(live: Live): void {
    live.sleeper?.();
    live.sleeper = undefined;
    live.awakeUntil = undefined;
    for (const cancel of live.timers.values()) cancel();
    live.timers.clear();
    const { record } = live;
    if (!record.timers.some(timer => timer.dueAt !== undefined)) return;
    const now = this.now();
    record.timers = record.timers.map(({ id, ms, dueAt }) => ({ id, ms: dueAt === undefined ? ms ?? 0 : Math.max(0, dueAt - now) }));
    this.options.store.save(record);
  }

  /** Starts the clocks a playing app is waiting on; one that is hibernating keeps holding its wait. */
  private arm(live: Live): void {
    for (const cancel of live.timers.values()) cancel();
    live.timers.clear();
    const { record } = live;
    if (record.status !== 'running' || !this.awake(live)) return;
    const now = this.now();
    if (record.timers.some(timer => timer.dueAt === undefined)) {
      record.timers = record.timers.map(timer => timer.dueAt === undefined ? { ...timer, dueAt: now + (timer.ms ?? 0) } : timer);
      this.options.store.save(record);
    }
    for (const { id, dueAt } of record.timers) {
      live.timers.set(id, this.clock.after(Math.max(0, dueAt! - now), () => {
        live.timers.delete(id);
        live.record.timers = live.record.timers.filter(entry => entry.id !== id);
        void this.background(live, { kind: 'timer', id }, `timer ${id}`);
      }));
    }
  }

  private consult(live: Live, effect: Extract<Effect, { type: 'consult' }>): void {
    const { record } = live;
    const answer = (result: { text?: string; error?: string }) => void this.background(live, { kind: 'consult', id: effect.id, ...result }, `consult ${effect.id}`);
    record.consults = record.consults.filter(at => at > this.now() - 60 * 60_000);
    if (!this.options.consult) return queueMicrotask(() => answer({ error: 'Consulting the model is not available here.' }));
    if (live.consulting) return queueMicrotask(() => answer({ error: 'Another consult is still running; wait for its answer first.' }));
    if (record.consults.length >= playLimits.consultsPerHour) return queueMicrotask(() => answer({ error: `This app has used its ${playLimits.consultsPerHour} consults for the hour.` }));
    record.consults.push(this.now());
    this.options.store.save(record);
    live.consulting = true;
    void this.options.consult({ title: record.title, owner: record.owner, channelId: record.channelId, conversation: record.conversation }, effect.prompt)
      .then(text => ({ text: clip(text, 4000) }), error => ({ error: errorText(error) }))
      .then(result => {
        live.consulting = false;
        this.options.log(`play ${record.id}: consult ${effect.id} ${'text' in result ? `answered: ${clip(JSON.stringify(result.text), 300)}` : `failed: ${result.error}`}`);
        answer(result);
      });
  }

  private release(live: Live): void {
    live.sleeper?.();
    live.sleeper = undefined;
    live.awakeUntil = undefined;
    for (const cancel of live.timers.values()) cancel();
    live.timers.clear();
    live.engine?.dispose();
    live.engine = undefined;
  }

  /** Ends or pauses an app without running its code: the last view stays, with controls disabled. */
  private async halt(live: Live, status: 'finished' | 'paused', note: string): Promise<void> {
    const { record } = live;
    record.status = status; record.note = note; record.timers = []; record.updatedAt = this.now();
    this.remember(record, status === 'finished' ? 'stop' : 'pause');
    this.release(live);
    this.options.store.save(record);
    this.report();
    if (!record.messageId) return;
    this.changed(record.id);
    let payload: MessagePayload;
    try { payload = renderView(record.id, record.view, true); } catch { payload = { content: '', embeds: [], components: [], allowedMentions: { parse: [] } }; }
    this.show(live, withNote(payload, note));
  }

  private allowed(record: PlayRecord, user: string): boolean {
    return record.participants === 'everyone' || (record.participants === 'invoker' ? record.owner.id === user : record.participants.includes(user));
  }

  private running(channelId?: string): PlayRecord[] {
    return [...this.live.values()].map(live => live.record).filter(record => record.status === 'running' && (!channelId || record.channelId === channelId));
  }

  /** Apps running now, across every channel. */
  runningCount(): number { return this.running().length; }

  /** Called wherever an app may have started, finished, paused or been swept. */
  private report(): void {
    const count = this.running().length;
    if (count === this.reported) return;
    this.reported = count;
    this.options.onRunning?.(count);
  }

  /** Loads the app, checks its first state and view, posts it, and starts its timers. */
  async start(options: StartOptions): Promise<{ record: PlayRecord; preview: string }> {
    if (this.running(options.channelId).length >= playLimits.perChannel) throw new PlayError(`This channel already has ${playLimits.perChannel} apps running; stop one first.`);
    if (this.running().length >= playLimits.total) throw new PlayError(`teapilot already runs ${playLimits.total} apps; stop one first.`);
    const engine = await this.build(options.source);
    try {
      const now = this.now();
      const record: PlayRecord = {
        id: randomBytes(8).toString('hex').slice(0, 10), title: clip(options.title, 100), owner: options.owner, channelId: options.channelId, conversation: options.conversation,
        participants: 'everyone', source: options.source, state: null, seed: randomBytes(4).readUInt32LE(), view: {}, emojis: options.emojis ?? {},
        timers: [], consults: [], status: 'running', log: [], createdAt: now, updatedAt: now,
        ...(options.post ? { viaInteraction: true } : {}), ...(options.file ? { file: options.file } : {}),
        ...(options.assetFiles ? { assetFiles: options.assetFiles } : {}),
      };
      const meta = (await engine.call('meta', { ctx: this.context(record) })).value as { participants?: unknown } | null;
      record.participants = checkParticipants(options.participants ?? meta?.participants ?? 'everyone');
      const step = await this.advance(engine, record);
      const notes = await this.probe(engine, record, step);
      const live: Live = { record, engine, timers: new Map(), consulting: false, chain: Promise.resolve() };
      const ready = await this.attach(record, step.payload);
      if (options.post) {
        const posted = await options.post(ready);
        record.messageId = posted.id;
        live.reach = { edit: posted.edit, until: this.now() + interactionLifetimeMs };
      } else record.messageId = await this.options.surface.post(record.channelId, ready);
      live.delivered = step.payload;
      this.live.set(record.id, live);
      // Posting is activity, so a game with its own clock runs from here until ten minutes with nobody playing.
      this.wake(live);
      this.commit(live, step, 'start');
      return { record, preview: [describe(step.view), ...notes.map(note => `Note: ${note}`)].join('\n') };
    } catch (error) { engine.dispose(); throw error; }
  }

  /** A new version can add top-level defaults without replacing players' existing data. */
  private async fillDefaults(engine: PlayEngine, record: PlayRecord): Promise<string[]> {
    const state = record.state;
    if (!isObject(state)) return [];
    const fresh = normalize((await engine.call('init', { ctx: this.context(record) })).value).state;
    if (!isObject(fresh)) return [];
    const added = Object.keys(fresh).filter(key => !(key in state));
    if (added.length) record.state = { ...Object.fromEntries(added.map(key => [key, fresh[key]])), ...state };
    return added;
  }

  /** Swaps in new code or a title. Keeping state lets a fix land mid-game; the view re-renders in place. */
  /** `start` schedules timers now, for a loop new code adds to an app whose init and start button already ran; `emojis` adds server emoji pasted since it started. */
  async update(id: string, conversation: string, source: Source | undefined, reset: boolean, start: Array<{ id: string; ms: number }> = [], emojis: Record<string, string> = {}, title?: string, assetFiles?: AssetFiles): Promise<{ record: PlayRecord; preview: string }> {
    const live = this.owned(id, conversation);
    return this.serial(live, async () => {
      const engine = source ? await this.build(source) : await this.engine(live);
      // Starting a timer by hand is deliberate, so it runs without waiting for anyone to play.
      const record: PlayRecord = { ...live.record, title: title === undefined ? live.record.title : clip(title, 100), source: source ?? live.record.source, emojis: { ...live.record.emojis, ...emojis }, status: 'running', note: undefined, ...(reset ? { state: null, timers: [] } : {}) };
      if (assetFiles !== undefined) record.assetFiles = assetFiles;
      try {
        // Kept state lacks what the new version's init() adds (a leaderboard, a weather field); fill those in.
        const added = source && !reset ? await this.fillDefaults(engine, record) : [];
        const step = reset ? await this.advance(engine, record) : await (async () => {
          const shown = await engine.call('view', { state: record.state, ctx: this.context(record) });
          const view = normalizeView(shown.value);
          const payload = renderView(record.id, view);
          this.checkPictures(record, payload);
          return { state: record.state, seed: shown.seed, view: view as View, payload, effects: [], timers: record.timers } satisfies Advance;
        })();
        const started = checkEffects(start.map(timer => ({ type: 'after', ...timer }))) as Array<Extract<Effect, { type: 'after' }>>;
        step.timers = [...step.timers.filter(timer => !started.some(entry => entry.id === timer.id)), ...started.map(timer => ({ id: timer.id, ms: timer.ms }))];
        if (step.timers.length > playLimits.timers) throw new PlayError(`An app may have ${playLimits.timers} timers pending.`);
        const notes = await this.probe(engine, record, step, !reset);
        if (live.engine !== engine) live.engine?.dispose();
        live.engine = engine;
        live.record = record;
        this.commit(live, step, reset ? 'restart' : 'update');
        // Starting a timer by hand is deliberate, so it runs without waiting for anyone to play.
        if (start.length) this.wake(live);
        // The change lands even where the message cannot show it yet; the next click does.
        if (this.reachable(live)) this.show(live, step.payload);
        else notes.push('No one has used the app for 15 minutes, so Discord shows this change at the next click.');
        if (added.length) notes.unshift(`The kept state gained ${added.slice(0, 8).join(', ')} from the new init(); fields new inside nested data still need a default where they are read.`);
        return { record, preview: [describe(step.view), ...notes.map(note => `Note: ${note}`)].join('\n') };
      } catch (error) { if (live.engine !== engine) engine.dispose(); throw error; }
    });
  }

  /** A dry run with no message, persistence or timers, so the model can check an app before posting it. */
  async test(source: Source, actions: TestAction[], owner: User, options: TestOptions = {}): Promise<string> {
    return (await this.testDetailed(source, actions, owner, options)).text;
  }

  /** A completed simulation is not proof of correctness; assertions are explicit, final-state checks. */
  async testDetailed(source: Source, actions: TestAction[], owner: User, options: TestOptions = {}): Promise<TestReport> {
    const engine = await this.build(source);
    const record: PlayRecord = { id: 'test', title: 'test', owner, channelId: '', conversation: options.conversation ?? '', participants: options.participants ?? 'everyone', source, state: null, seed: 1, view: {}, emojis: options.emojis ?? {}, timers: [], consults: [], status: 'running', log: [], createdAt: 0, updatedAt: 0 };
    const lines: string[] = [];
    let last: string[] = [];
    // Actions that change nothing (a move into a wall, a turn out of order) are easy to miss in the final state alone.
    let before = '', idle = 0;
    /** The view on screen before each action, and the actions that named a control it did not show. */
    let view: View | undefined;
    const skipped: string[] = [];
    const errors: TestReport['errors'] = [];
    let completed = 0, currentStep = 0;
    const show = (label: string, step: Advance) => {
      view = step.view;
      const now = JSON.stringify(step.state) + describe(step.view);
      if (before && now === before && !step.effects.length) idle++;
      before = now;
      record.state = step.state; record.seed = step.seed;
      last = [`## ${label}`, `state: ${clip(JSON.stringify(step.state), 1500)}`, describe(step.view)];
      if (step.effects.length) last.push(`effects: ${clip(JSON.stringify(step.effects), 800)}`);
      if (options.steps) lines.push(...last);
    };
    try {
      if (options.state === undefined) show('start', await this.advance(engine, record));
      else {
        // A running app's own state, so a dry run of new code shows what people will actually get.
        record.state = options.state;
        await this.fillDefaults(engine, record);
        const shown = await engine.call('view', { state: record.state, ctx: this.context(record) });
        show('current state', { state: record.state, seed: shown.seed, view: normalizeView(shown.value) as View, payload: renderView(record.id, normalizeView(shown.value)), effects: [], timers: [] });
      }
      for (const [index, action] of actions.entries()) {
        currentStep = index + 1;
        const label = `${index + 1}. ${action.kind} ${action.id}`;
        // Nobody can press a control that is not on screen; a wrong id would otherwise read as an app that ignores it.
        if ((action.kind === 'button' || action.kind === 'select') && !findControl(view, action.id)) {
          const ids = (view?.rows ?? []).flatMap(row => row.controls.flatMap(control => control.type === 'select' || control.url === undefined ? [control.id] : []));
          skipped.push(`${label} (on screen: ${ids.join(', ') || 'no controls'})`);
          continue;
        }
        try { show(label, await this.advance(engine, record, toAction(action, owner))); completed++; }
        catch (error) { errors.push({ step: currentStep, message: errorText(error) }); last = [`## ${label}`, `error: ${errorText(error)}`]; lines.push(...last); break; }
      }
    } catch (error) {
      errors.push({ step: currentStep, message: errorText(error) });
      last = [`error: ${errorText(error)}`]; lines.push(...last);
    } finally { engine.dispose(); }
    const assertions = { passed: 0, failed: 0 };
    for (const expected of options.expect ?? []) {
      let value: unknown = record.state;
      for (const part of expected.path ? expected.path.split('.') : []) {
        value = value !== null && typeof value === 'object' && Object.hasOwn(value, part) ? (value as Record<string, unknown>)[part] : undefined;
      }
      if (!errors.length && isDeepStrictEqual(value, expected.equals)) assertions.passed++;
      else { assertions.failed++; lines.push(`assertion failed: state.${expected.path || '(root)'} did not equal the expected value.`); }
    }
    const unchanged = idle ? `${idle} of ${actions.length} actions changed nothing` : '';
    const missing = skipped.length ? [`Skipped, no such control on screen at that point: ${skipped.join('; ')}.`] : [];
    const summary = `start: ${options.state === undefined ? 'fresh init' : 'inherited live state'}; ${completed}/${actions.length} actions completed; ${skipped.length} skipped; ${errors.length} runtime errors. ${options.expect?.length ? `assertions: ${assertions.passed} passed, ${assertions.failed} failed.` : 'simulation only: no assertions supplied; this does not prove the requested rules work.'}`;
    const assertionLines = lines.filter(line => line.startsWith('assertion failed:'));
    return { text: clip([summary, ...(options.steps ? [...missing, ...lines, ...unchanged ? [`(${unchanged})`] : []] : [...missing, `(final of ${actions.length} actions${unchanged ? `; ${unchanged}` : ''}; set steps for each)`, ...last, ...assertionLines])].join('\n'), maxOutputChars / 8),
      sourceState: options.state === undefined ? 'init' : 'live', coverage: options.expect?.length ? 'assertions' : 'simulation', completed, skipped: skipped.length, unchanged: idle, errors, assertions };
  }

  inspect(id: string, conversation: string): string {
    const { record } = this.owned(id, conversation);
    const assets = record.source.kind === 'sandbox' ? Object.entries(record.source.assets ?? {}).map(([name, text]) => ({ name, file: record.assetFiles?.[name], bytes: Buffer.byteLength(text, 'utf8') })) : [];
    return JSON.stringify({ id: record.id, title: record.title, status: record.status, note: record.note, participants: record.participants, source: record.source.kind === 'trusted' ? { trusted: record.source.path } : 'sandbox', assets, timers: record.timers, state: record.state, recentActions: record.log });
  }

  /** The code an app runs now, so a change can be made as small edits to it. */
  source(id: string, conversation: string): Source { return this.owned(id, conversation).record.source; }

  /** The workspace file an app runs from, if any. */
  file(id: string, conversation: string): string | undefined { return this.owned(id, conversation).record.file; }

  /** File selection for an explicit reload; normal callbacks only see the persisted snapshot. */
  assetFiles(id: string, conversation: string): AssetFiles { return { ...this.owned(id, conversation).record.assetFiles }; }

  /** Records the workspace file an app runs from now: one whose code was only inline, or one moved to another file. */
  adopt(id: string, conversation: string, file: string): void {
    const live = this.owned(id, conversation);
    live.record.file = file;
    this.options.store.save(live.record);
  }

  /** The state an app runs with now. */
  state(id: string, conversation: string): unknown { return this.owned(id, conversation).record.state; }

  /** Apps this conversation started, and with `channelId` also the others shown in that channel. */
  list(conversation: string, channelId?: string): Array<{ id: string; title: string; status: string; file?: string }> {
    return [...this.live.values()].map(live => live.record).filter(record => record.conversation === conversation || (channelId !== undefined && record.channelId === channelId)).map(({ id, title, status, file }) => ({ id, title, status, ...(file ? { file } : {}) }));
  }

  /**
   * Posts an app again at the bottom with its current view, when its message is buried. Anyone who can
   * see the app may bring it back, so it is found by conversation or by the channel it is shown in. The
   * old copy says where the app went, and clicks on it are turned away.
   */
  async resend(id: string, conversation: string, target: { channelId: string; post?: StartOptions['post']; messageId?: string; edit?: HostedMessage['edit'] }): Promise<{ record: PlayRecord; preview: string }> {
    const live = this.live.get(id);
    if (!live || (live.record.conversation !== conversation && live.record.channelId !== target.channelId)) throw new PlayError(`No app ${id} here. Use play_list.`);
    return this.serial(live, async () => {
      const { record } = live;
      const ended = record.status !== 'running';
      if (target.messageId && record.messageId !== target.messageId) throw new PlayError(moved);
      const away = target.channelId !== record.channelId;
      if (away && this.running(target.channelId).length >= playLimits.perChannel) throw new PlayError(`That channel already has ${playLimits.perChannel} apps running; stop one first.`);
      if (record.viaInteraction && target.edit) live.reach = { edit: target.edit, until: this.now() + interactionLifetimeMs };
      const payload = await this.attach(record, withNote(renderView(record.id, record.view, ended), ended ? record.note : undefined));
      const old = { messageId: record.messageId, channelId: record.channelId, viaInteraction: record.viaInteraction, reach: this.reachable(live) ? live.reach : undefined };
      if (target.post) {
        const posted = await target.post(payload);
        record.messageId = posted.id; record.viaInteraction = true;
        live.reach = { edit: posted.edit, until: this.now() + interactionLifetimeMs };
      } else {
        record.messageId = await this.options.surface.post(target.channelId, payload);
        delete record.viaInteraction;
        live.reach = undefined;
      }
      record.channelId = target.channelId; record.updatedAt = this.now();
      // Old edits drain before the moved stub. The new message gets an independent generation.
      const retired = live.delivery;
      live.delivery = undefined;
      live.delivered = undefined;
      this.remember(record, 'resend');
      this.options.store.save(record);
      // Timers a hibernating app was holding run again now that it has been brought back.
      this.wake(live);
      if (old.messageId) {
        const stub: MessagePayload = { content: `-# ${away ? movedAway : moved}`, embeds: [], components: [], allowedMentions: { parse: [] } };
        const delivery = retired ?? new PlayDelivery(this.clock, this.options.discordEditMs ?? editSpacingMs,
          error => this.options.log(`play ${record.id}: could not retire its old message: ${errorText(error)}`));
        this.deliveries.add(delivery);
        delivery.enqueue(async () => {
          try { await (old.viaInteraction ? old.reach?.edit(stub) : this.options.surface.edit(old.channelId, old.messageId!, stub)); }
          finally { delivery.close(); this.deliveries.delete(delivery); }
        });
      }
      return { record, preview: describe(record.view) };
    });
  }

  async stop(id: string, conversation: string, summary = 'Stopped.'): Promise<void> {
    const live = this.owned(id, conversation);
    await this.serial(live, () => this.halt(live, 'finished', summary));
  }

  /** An app is managed only from the conversation that started it. */
  private owned(id: string, conversation: string): Live {
    const live = this.live.get(id);
    if (!live || live.record.conversation !== conversation) throw new PlayError(`No app ${id} in this conversation. Use play_list.`);
    return live;
  }

  async interact(interaction: PlayInteraction): Promise<void> {
    const live = this.live.get(interaction.playId);
    const record = live?.record;
    if (live && record?.messageId && interaction.messageId && interaction.messageId !== record.messageId) { await interaction.reply(moved); return; }
    if (interaction.kind === 'resend' || interaction.kind === 'paste') {
      if (!live || !record) { await interaction.reply('this app is no longer available.'); return; }
      await interaction.defer();
      // A paste moves the app wherever it is now; its interaction cannot reach the old copy.
      const target = interaction.kind === 'paste' ? { channelId: interaction.channelId ?? record.channelId, post: interaction.post }
        : { channelId: record.channelId, post: interaction.post, messageId: interaction.messageId, edit: (payload: MessagePayload) => interaction.update(payload) };
      try { await this.resend(record.id, record.conversation, target); }
      catch (error) { await interaction.followUp(`could not ${interaction.kind === 'paste' ? 'paste' : 'repost'} this app: ${clip(errorText(error), 300)}`); }
      return;
    }
    if (!live || !record || record.status !== 'running') { await interaction.reply(record?.status === 'paused' ? `This app is paused. ${record.note ?? ''}`.trim() : 'This app has ended.'); return; }
    if (!this.allowed(record, interaction.user.id)) {
      await interaction.reply(record.participants === 'invoker' ? `Only <@${record.owner.id}> can use this app.` : `This app is for ${(record.participants as string[]).map(id => `<@${id}>`).join(', ')}.`);
      return;
    }
    const current = () => {
      const view = live.record.view;
      if (interaction.kind === 'modal') return (view.rows ?? []).some(row => row.controls.some(control => control.type === 'button' && control.opens?.id === interaction.controlId));
      const control = findControl(view, interaction.controlId);
      return Boolean(control && !control.disabled && (control.type === 'select') === (interaction.kind === 'select'));
    };
    if (!current()) { await interaction.reply('That control is no longer available.'); return; }
    const control = interaction.kind === 'button' ? findControl(record.view, interaction.controlId) : undefined;
    if (control?.type === 'button' && control.opens) { this.wake(live); await interaction.openModal(renderModal(record.id, control.opens)); return; }
    const answer = this.answer(interaction, record.id);
    // Each click can edit the message for its own 15 minutes, which keeps an app posted through an interaction alive.
    if (record.viaInteraction) live.reach = { edit: answer.edit, until: this.now() + interactionLifetimeMs };
    // Someone is playing now, so the app runs again, and any clock it was holding starts from here.
    this.wake(live);
    const replies: Promise<void>[] = [];
    const kind = interaction.kind;
    let shown = Promise.resolve();
    const reply = (content: string, embeds?: Array<Record<string, unknown>>) => {
      replies.push(answer.acknowledged.then(() => interaction.followUp(content, embeds))
        .catch(error => this.options.log(`play ${record.id}: private reply failed: ${errorText(error)}`)));
    };
    await this.serial(live, async () => {
      if (interaction.messageId && interaction.messageId !== live.record.messageId) { reply(moved); return; }
      if (live.record.status !== 'running') { reply('This app has ended.'); return; }
      if (!current()) { reply('That control changed before your action arrived.'); return; }
      const action = toAction({ kind, id: interaction.controlId, values: interaction.values, fields: interaction.fields }, interaction.user);
      try {
        const { payload, notes } = await this.dispatch(live, action, `${interaction.kind} ${interaction.controlId} by ${interaction.user.id}`);
        shown = this.show(live, payload, answer.edit);
        for (const note of notes) reply(note.content, note.embeds && renderEmbeds(note.embeds));
      } catch (error) {
        this.options.log(`play ${record.id}: ${errorText(error)}`);
        reply(`The app hit an error, so nothing changed. ${clip(errorText(error), 300)}`);
      }
    });
    // A view that was unchanged, or overtaken by a newer one, never answered the click.
    void shown.then(answer.ack);
    await Promise.all(replies);
  }

  /**
   * How a click is answered. Its new view goes back as the interaction's response, one request where deferring
   * and then editing takes two. When no view is ready in time, or none comes, it defers instead.
   */
  private answer(interaction: PlayInteraction, playId: string) {
    let first: Promise<unknown> | undefined;
    let acknowledge!: () => void;
    const acknowledged = new Promise<void>(resolve => { acknowledge = resolve; });
    const settle = (response: Promise<unknown>) => {
      clearTimeout(timer);
      first = response;
      void response.then(acknowledge, error => { this.options.log(`play ${playId}: could not answer a click: ${errorText(error)}`); acknowledge(); });
      return response;
    };
    const ack = () => first ?? settle(interaction.defer());
    // Discord's three seconds are wall-clock time, whatever the app's clock says.
    const timer = interaction.respond ? setTimeout(ack, answerMs) : undefined;
    timer?.unref?.();
    if (!interaction.respond) void ack();
    const edit = async (payload: MessagePayload): Promise<Attached> => {
      if (!first && interaction.respond) return settle(interaction.respond(payload)) as Promise<Attached>;
      await ack();
      return interaction.update(payload);
    };
    return { edit, ack: () => { void ack(); }, acknowledged };
  }

  /**
   * Reloads running apps after a restart. They come back hibernating, whatever they were doing before, so a
   * restart never sets abandoned games ticking again; the next click starts their clocks with the wait they
   * had left. Engines load on first use; trusted apps are re-checked then.
   */
  async recover(): Promise<number> {
    let count = 0;
    for (const record of this.options.store.all()) {
      if (this.live.has(record.id)) continue;
      if (record.status !== 'running') {
        if (record.updatedAt < this.now() - playLimits.keepFinishedMs) this.options.store.remove(record.id);
        else if (record.status === 'paused') this.live.set(record.id, { record, timers: new Map(), consulting: false, chain: Promise.resolve() });
        continue;
      }
      // A crash can leave a deadline behind, and how much of it was spent is not knowable, so the wait starts whole.
      record.timers = record.timers.map(({ id, ms }) => ({ id, ms: ms ?? 0 }));
      const live: Live = { record, timers: new Map(), consulting: false, chain: Promise.resolve() };
      this.live.set(record.id, live);
      if (record.source.kind === 'trusted' && await hashFile(record.source.path).catch(() => undefined) !== record.source.sha256) {
        await this.halt(live, 'paused', 'Paused: the trusted app file changed while teapilot was stopped. Ask teapilot to update it to re-approve.');
        continue;
      }
      count++;
    }
    this.report();
    if (!this.sweeper) this.schedule();
    return count;
  }

  private schedule(): void {
    this.sweeper = this.clock.after(10 * 60_000, () => void this.sweep().finally(() => { if (this.sweeper) this.schedule(); }));
  }

  /** Apps nobody has touched for a day end, so abandoned games do not hold resources forever. */
  async sweep(): Promise<void> {
    for (const live of this.live.values()) {
      if (live.record.status === 'running' && live.record.updatedAt < this.now() - playLimits.idleMs) {
        await this.serial(live, () => this.halt(live, 'finished', 'Ended after a day without activity.'));
      }
      if (live.record.status !== 'running' && live.record.updatedAt < this.now() - playLimits.keepFinishedMs) {
        live.delivery?.close();
        if (live.delivery) this.deliveries.delete(live.delivery);
        this.live.delete(live.record.id);
        this.options.store.remove(live.record.id);
      }
    }
    this.report();
  }

  close(): void {
    for (const delivery of this.deliveries) delivery.close();
    this.deliveries.clear();
    this.sweeper?.();
    this.sweeper = undefined;
    // Whatever each clock had left is put away first, so the next start picks it up where it stood.
    for (const live of this.live.values()) { this.hibernate(live); this.release(live); }
  }
}

/** :name: shortcodes, which Discord shows as typed in anything a bot sends; <:name:id> custom emoji are left out. */
function shortcodesIn(text: string): string[] {
  return [...text.matchAll(/(?<![<\w]):([a-z][a-z0-9_+-]{1,40}):(?!\d)/g)].map(match => match[0]);
}

/** Server emoji inside code blocks or inline code, where Discord shows them as typed. */
function codedEmojiIn(text: string): string[] {
  return [...text.matchAll(/```[\s\S]*?```|`[^`\n]+`/g)].flatMap(match => match[0].match(/<a?:\w{2,32}:\d{17,20}>/g) ?? []);
}

function checkParticipants(value: unknown): Participants {
  if (value === 'everyone' || value === 'invoker') return value;
  if (Array.isArray(value) && value.length && value.length <= 25 && value.every(id => typeof id === 'string' && /^\d{17,20}$/.test(id))) return [...new Set(value as string[])];
  throw new PlayError('participants must be "everyone", "invoker" or a list of 1–25 Discord user IDs.');
}

function toAction(action: TestAction, user: User): Action {
  switch (action.kind) {
    case 'button': return { kind: 'button', id: action.id, user: action.user ?? user };
    case 'select': return { kind: 'select', id: action.id, user: action.user ?? user, values: (action.values ?? []).map(String).slice(0, 25) };
    case 'modal': return { kind: 'modal', id: action.id, user: action.user ?? user, fields: Object.fromEntries(Object.entries(action.fields ?? {}).slice(0, 5).map(([key, value]) => [key, String(value).slice(0, 4000)])) };
    case 'timer': return { kind: 'timer', id: action.id };
    case 'consult': return { kind: 'consult', id: action.id, ...(action.error !== undefined ? { error: action.error } : { text: action.text ?? '' }) };
  }
}
