import { layout, type Message as AnswerMessage, type Resolved } from 'pretty-send';
import { casualLines, paceLines } from '../casual.js';
import { runSession, type SessionExtension } from '../chat.js';
import type { CheckpointView, HostDependencies, HostRequest, HostResult } from '../host.js';
import type { CheckpointDecision } from '../agents/checkpoint.js';
import { formatInterruption } from '../interruption.js';
import { repositoryOffered, repositoryPermissions } from '../execution/grants.js';
import type { Approval, Approve } from '../execution/policy.js';
import type { ConversationTurn, EventSink } from '../integration/events.js';
import type { AccessStore } from './access-store.js';
import { grantControls, type GrantPanel } from './grants-panel.js';
import type { ConversationWorkspace } from '../agents/workspace.js';
import type { WorkspaceSandbox } from '../workspace/sandbox.js';
import { maxFileBytes, type WorkspaceStore } from '../workspace/store.js';
import { storeControls } from '../workspace/commands.js';
import type { MessagePayload } from './play/render.js';
import type { HostedMessage, PlayRuntime, StartOptions } from './play/runtime.js';
import { approvePrompt, changePrompt, extractPlan, juniorsPrompt, planMessages, type PlanAction, type PlanControls, type PlanEmbed } from './plan.js';
import { chunk, StatusCard, throttle, viewSourcePrefix, type CardReply } from './render.js';
import type { SkillPreferences } from '../skills/settings.js';

export type CardButton = 'stop' | 'details';
/** A status card's buttons: Details always, Stop while `stop` is set. */
export interface CardControls { stop: boolean; press(button: CardButton, userId: string): CardReply }

/** Everything the bridge needs from Discord for one conversation (a DM or a thread). */
export interface DiscordTransport {
  send(text: string, options?: { silent?: boolean }): Promise<string>;
  edit(messageId: string, text: string): Promise<void>;
  /** Posts a turn's status card, or with `id` replaces it. Each press is answered privately with `press`'s reply. */
  card(text: string, controls: CardControls, id?: string): Promise<string>;
  /** Post approve/deny buttons. Operators may answer; with `users`, so may whitelisted users. Resolves false when `signal` aborts first. */
  askApproval(text: string, signal: AbortSignal, users?: boolean): Promise<boolean>;
  /** Continuation batches auto-approve after a short response window; absent transports fail closed. */
  askContinuationBudget?(text: string, signal: AbortSignal, timeoutMs?: number): Promise<'approved' | 'denied' | 'auto-approved'>;
  /** A checkpoint card: continue, steer (a form), stop, and private details. Continues by itself after `timeoutMs`. */
  askCheckpoint?(text: string, details: string, signal: AbortSignal, timeoutMs?: number): Promise<CheckpointDecision>;
  typing(): void;
  /** Posts files as attachments, with a line of text. */
  sendFiles?(text: string, files: Array<{ name: string; data: Buffer }>): Promise<string>;
  /** Posts one message of an answer laid out by pretty-send: a table embed or Components V2. */
  answer?(message: AnswerMessage): Promise<string>;
  /** Where teapilot answers through an interaction: posts a discord.play app as a reply to it. */
  postApp?(payload: MessagePayload): Promise<HostedMessage>;
  /**
   * Posts a plan as embeds, one array per message, with its buttons on the last message. With `ids` it edits those
   * messages in place instead: posting more if the plan grew, deleting the extra ones if it shrank. Resolves with the ids.
   */
  plan?(messages: PlanEmbed[][], controls: PlanControls, ids?: string[]): Promise<string[]>;
}

/** A plan on Discord: its messages, and where it is in being refined. */
interface PlanState { text: string; ids: string[]; /** A prompt from its buttons is being worked on. */ revising: boolean; done: boolean }

/** runHost holds the state lock, so turns from every conversation run one at a time. */
export class TurnQueue {
  private tail: Promise<void> = Promise.resolve();
  private active = 0;
  async run<T>(task: () => Promise<T>, onWait?: () => void): Promise<T> {
    if (this.active++) onWait?.();
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise(done => { release = done; });
    try { await previous; return await task(); }
    finally { this.active--; release(); }
  }
}

export interface ConversationOptions {
  key: string;
  transport: DiscordTransport;
  /** Base request: cwd, mode, grants and the session signal. */
  request: HostRequest;
  maxPromptChars: number;
  queue: TurnQueue;
  run: (request: HostRequest, dependencies: Pick<HostDependencies, 'approve' | 'onEvent' | 'onReasoning' | 'onCheckpoint'>) => Promise<HostResult>;
  redact: (text: string) => string;
  /** Operator log in the terminal running teapilot discord start. */
  log: (text: string) => void;
  /** Resolves each message's sender to a role, per-turn permissions and the access-management tools. */
  access?: AccessStore;
  /** Answer one message and end, for transports that cannot receive follow-ups. */
  once?: boolean;
  approvalTimeoutMs?: number;
  /** How long a checkpoint card waits before work continues by itself. */
  checkpointTimeoutMs?: number;
  progressIntervalMs?: number;
  /** How often a running turn's status card moves on by itself. */
  heartbeatMs?: number;
  extension?: SessionExtension;
  skills?: { preferences(userId?: string): SkillPreferences; command(args: string, userId?: string): Promise<string> };
  /** Receives the conversation's turns after each change, so they survive a restart. */
  onHistory?: (history: ConversationTurn[]) => void;
  /** Receives completion after the answer and any status card have been sent. */
  onTurnEnd?: (result: Pick<HostResult, 'status' | 'requestId'>) => void;
  /**
   * discord.play apps; `channelId` is where they run, absent where they cannot be posted, and `post` posts them
   * through an interaction instead. `conversation` manages them, by default this conversation's key.
   */
  play?: { runtime: PlayRuntime; channelId?: string; post?: StartOptions['post']; conversation?: string };
  /** Each conversation's workspace: attachments and files teapilot makes, kept under the same key as its apps. */
  files?: WorkspaceStore;
  /** Runs commands in those workspaces. */
  sandbox?: WorkspaceSandbox;
  /** How long a turn's status card waits for routing to say it is not conversational; 4 seconds by default. */
  cardDelayMs?: number;
  /** The pause before each line of a conversational reply after the first; 0.5–2 seconds by default. */
  lineDelayMs?: () => number;
}

/** Image types Discord shows in a gallery or thumbnail. */
const shown = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const discordHelp ='`/stop` - cancel the running turn\n`/skills` - choose repository sets or individual skills; save conversation, personal or global choices\n`/convo clear` - clear the context window; the workspace keeps its files\n`/convo grants` - see and change what teapilot may do here\n`/workspace clear|name|tree` - delete, name or list the workspace\'s files\n`/new` - clear both\n`/btw` - ask a question without polluting the context window.\n`/plan` - get an implementation plan to discuss before anything is changed.\n`/rfc` - get a design proposal to discuss before anything is changed.';

/** One Discord conversation driving one teapilot session with its own history and grants. */
export class Conversation {
  private readonly inbox: Array<{ text: string; sender?: string; senderName?: string; yolo?: boolean; quiet?: boolean }> = [];
  /** Who sent the message the current turn is answering; a thread can have several people. */
  private speaker?: string;
  private speakerName?: string;
  /** The message being answered asked for every approval to pass without asking; honoured for operators only. */
  private yolo = false;
  /** The message being handled was answered privately already, so what the session says about it only goes to the log. */
  private quiet = false;
  private waiting?: { resolve(text: string): void; reject(error: Error): void };
  private turn?: AbortController;
  private sink?: EventSink;
  private reasoning?: (text: string) => void;
  /** The running turn's status card, and how to show a change on it. */
  private live?: { card: StatusCard; refresh(): void };
  private ended = false;
  private answerOnly = false;
  /** The newest plan shown as embeds; a refined plan replaces it in place. */
  private plan?: PlanState;
  /** A plan button sent the next turn's prompt, so a plan in its answer refines `plan` rather than posting a new one. */
  private refining = false;
  private readonly skillWarnings = new Set<string>();
  readonly done: Promise<void>;

  constructor(private readonly options: ConversationOptions) {
    this.done = this.start();
  }

  /** Deliver a message from an allowed person. Local commands take effect immediately. */
  push(text: string, options: { answerOnly?: boolean; sender?: string; senderName?: string; yolo?: boolean; quiet?: boolean } = {}): void {
    // Only the next turn is answer-only, and only if nothing is running to change mid-turn.
    if (options.answerOnly && !this.turn) this.answerOnly = true;
    const trimmed = text.trim();
    const [command] = trimmed.split(/\s+/);
    if (trimmed === '/clear') { void this.say('Use /convo clear to clear the conversation, or /new to clear the workspace as well.', true); return; }
    if (command === '/stop') {
      if (this.turn && !this.turn.signal.aborted) this.stop();
      else void this.say('nothing is running.', true);
      return;
    }
    if (command === '/cd') { void this.say('The repository root is fixed for Discord sessions. Change it with teapilot discord setup.', true); return; }
    if (command === '/skills' && this.options.skills) {
      void this.options.skills.command(trimmed.slice(7).trim(), options.sender).then(text => this.say(text, true), error => this.say(error instanceof Error ? error.message : String(error), true));
      return;
    }
    if (command === '/help') void this.say(discordHelp, true);
    if (this.turn && !['/exit', '/quit'].includes(command ?? '')) void this.say('Queued as your next message.', true);
    if (this.waiting) { const waiting = this.waiting; this.waiting = undefined; this.speaker = options.sender; this.speakerName = options.senderName; this.yolo = options.yolo === true; this.quiet = options.quiet === true; waiting.resolve(text); }
    else this.inbox.push({ text, sender: options.sender, senderName: options.senderName, yolo: options.yolo, quiet: options.quiet });
  }

  get active(): boolean { return !this.ended; }

  /** `direct` text always goes to Discord; anything else stays in the terminal during an answer-only turn. */
  private async say(text: string, direct = false): Promise<void> {
    if ((this.answerOnly || this.quiet) && !direct) { this.options.log(`${this.options.key}: ${this.options.redact(text)}`); return; }
    for (const part of chunk(this.options.redact(text))) await this.options.transport.send(part).catch(error => this.options.log(`${this.options.key}: send failed: ${error instanceof Error ? error.message : error}`));
  }

  /**
   * A turn's answer, laid out so its tables, dividers, and workspace images and files show where it puts them. A
   * message Discord refuses goes out as its text instead, so nothing in the answer is lost.
   */
  private async answer(text: string): Promise<void> {
    const { transport, files, key, log } = this.options;
    if (!transport.answer) return this.say(text, true);
    const conversation = this.options.play?.conversation ?? key;
    const failed = (what: string, error: unknown) => log(`${key}: ${what}: ${error instanceof Error ? error.message : String(error)}`);
    let reconciled: Promise<unknown> | undefined;
    const resolve = files && (async (ref: string): Promise<Resolved | undefined> => {
      // Files the turn's own tools just wrote are listed once the folder is looked at again.
      await (reconciled ??= files.reconcile(conversation).catch(error => failed('workspace not reconciled', error)));
      const stored = files.read(conversation, ref);
      if (!stored || stored.data.length > maxFileBytes) return undefined;
      return { name: stored.file.name, data: stored.data, image: Boolean(stored.file.width) && shown.has(stored.file.type) };
    });
    for (const message of await layout(this.options.redact(text), { resolve, viewSourcePrefix })) {
      if (message.content !== undefined) await this.say(message.content, true);
      else await transport.answer(message).catch(async error => { failed('answer part not posted', error); await this.say(message.source, true); });
    }
  }

  private input = (): Promise<string> => {
    const next = this.inbox.shift();
    if (next) { this.speaker = next.sender; this.speakerName = next.senderName; this.yolo = next.yolo === true; this.quiet = next.quiet === true; return Promise.resolve(next.text); }
    const signal = this.options.request.signal;
    return new Promise((resolve, reject) => {
      const closed = () => reject(Object.assign(new Error('closed'), { name: 'TerminalClosedError' }));
      if (signal?.aborted) return closed();
      signal?.addEventListener('abort', closed, { once: true });
      this.waiting = { resolve: text => { signal?.removeEventListener('abort', closed); resolve(text); }, reject };
    });
  };

  /** Checkpoints show what is objectively done and let anyone here steer or stop; silence continues the work. */
  private checkpoint = async (view: CheckpointView, signal?: AbortSignal): Promise<CheckpointDecision> => {
    const ask = this.options.transport.askCheckpoint;
    if (!ask) return { action: 'continue' };
    const text = this.options.redact(`**${view.title}**\n${view.lines.map(line => `-# ${line}`).join('\n')}`);
    const signals = [this.options.request.signal, this.turn?.signal, signal].filter((value): value is AbortSignal => Boolean(value));
    const decision = await ask(text, this.options.redact(view.details), AbortSignal.any(signals), this.options.checkpointTimeoutMs ?? 45_000);
    this.options.log(`${this.options.key}: checkpoint ${view.record.generation} ${decision.action}`);
    return decision;
  };

  // Only operators may answer approvals, so only an operator's message can approve everything up front.
  private approve: Approve = approval => this.ask(approval, this.yolo && this.operator(this.speaker));

  private async ask(approval: Approval, yolo: boolean): Promise<boolean> {
    const signals = [AbortSignal.timeout(this.options.approvalTimeoutMs ?? 10 * 60_000), this.options.request.signal, this.turn?.signal, approval.signal].filter((value): value is AbortSignal => Boolean(value));
    const signal = AbortSignal.any(signals);
    if (signal.aborted) return false;
    if (yolo) {
      const summary = this.options.redact(approval.summary).split('\n')[0];
      this.options.log(`${this.options.key}: ${approval.kind} auto-approved (yolo): ${summary}`);
      await this.say(`-# Auto-approved (${approval.kind}): ${summary}`);
      return true;
    }
    const continuationBudget = approval.kind === 'continuation_budget';
    const text = this.options.redact(continuationBudget
      ? `**continue this run?**\n${approval.summary}${approval.details ? `\n\`\`\`\n${approval.details}\n\`\`\`` : ''}\n\nno answer in 45 seconds? this batch will continue automatically.`
      : `**Approval needed** (${approval.kind})\n${approval.summary}${approval.details ? `\n\`\`\`\n${approval.details}\n\`\`\`` : ''}`);
    const parts = chunk(text);
    const live = this.live;
    const previous = live?.card.set('approval');
    live?.refresh();
    // Show everything; the buttons go on the last part so the whole request is read first.
    for (const part of parts.slice(0, -1)) await this.options.transport.send(part);
    // A network request only reaches hosts named in the approval, so anyone using the conversation may answer it.
    const outcome = await (continuationBudget
      ? this.options.transport.askContinuationBudget?.(parts.at(-1) ?? 'continue this run?', signal, 45_000) ?? Promise.resolve('denied' as const)
      : this.options.transport.askApproval(parts.at(-1) ?? 'Approval needed.', signal, approval.kind === 'network').then(approved => approved ? 'approved' as const : 'denied' as const)).finally(() => {
      if (!live || !previous) return;
      // Put the phase back unless something else, such as Stop, changed it meanwhile.
      const current = live.card.set(previous);
      if (current !== 'approval') live.card.set(current);
      live.refresh();
    });
    this.options.log(`${this.options.key}: ${approval.kind} ${outcome}: ${this.options.redact(approval.summary).split('\n')[0]}`);
    return outcome !== 'denied';
  }

  /** The session's access for /convo grants; approvals are asked for here, where the conversation is. */
  grantPanel(): GrantPanel | undefined {
    const grants = this.options.request.authorization;
    if (!grants) return undefined;
    const { access, key, log } = this.options;
    return grantControls({ grants, access, key, log, onEvent: this.onEvent, ask: approval => this.ask(approval, false),
      signal: this.options.request.signal, ended: () => this.ended });
  }

  /** Paints a plan's messages; its buttons are `actions`, none once it is settled or being worked on. */
  private async paint(state: PlanState, actions: PlanAction[], footer?: string): Promise<void> {
    try { state.ids = await this.options.transport.plan!(planMessages(state.text, footer), this.planControls(state, actions), state.ids); }
    catch (error) { this.options.log(`${this.options.key}: plan embed failed: ${error instanceof Error ? error.message : String(error)}`); }
  }

  private planControls(state: PlanState, actions: PlanAction[]): PlanControls {
    const { access } = this.options;
    const refusal = (userId: string) => access && access.roleOf(userId) === undefined ? 'You are not allowed to use teapilot.'
      : this.plan !== state || state.done ? 'This plan has been replaced or settled.'
      : state.revising ? 'teapilot is already working on this plan.' : undefined;
    return { actions, refusal, press: (action, user, request) => {
      const refused = refusal(user.id);
      if (refused) return refused;
      const sender = { sender: user.id, senderName: user.name };
      if (action === 'approve') {
        state.done = true;
        this.push(approvePrompt, sender);
        void this.paint(state, [], `✅ Approved by ${user.name}`);
        return undefined;
      }
      if (action === 'change' && !request?.trim()) return 'Say what should change.';
      const note = action === 'juniors' ? '♟️ Assigning juniors…' : `✍️ Revising: ${request!.replace(/\s+/g, ' ').trim().slice(0, 100)}`;
      state.revising = true; this.refining = true;
      this.push(action === 'juniors' ? juniorsPrompt : changePrompt(request!.trim()), sender);
      void this.paint(state, [], note);
      return undefined;
    } };
  }

  /** Shows an answer's plan as embeds; when `refining`, it edits the plan whose button was pressed instead of posting another. */
  private async showPlan(plan: string, refining: boolean): Promise<void> {
    const previous = this.plan;
    const reuse = refining && previous && !previous.done ? previous : undefined;
    // A plan that is not refined replaces an older one, which keeps its text but loses its buttons.
    if (previous && !reuse && !previous.done) { previous.done = true; await this.paint(previous, [], 'superseded by a newer plan'); }
    const state: PlanState = reuse ?? { text: plan, ids: [], revising: false, done: false };
    state.text = plan; state.revising = false;
    this.plan = state;
    await this.paint(state, ['approve', 'juniors', 'change']);
    if (!state.ids.length) await this.say(plan, true);
  }

  private onEvent: EventSink = event => this.sink?.(event);
  private onReasoning = (text: string) => this.reasoning?.(text);

  /** Operators hold every permission; without roles, everyone who may talk to teapilot counts as one. */
  private operator(id?: string): boolean {
    const { access } = this.options;
    return !access || (id !== undefined && access.roleOf(id) === 'operator');
  }

  private stop(): void {
    this.turn?.abort();
    if (this.live) { this.live.card.set('stopping'); this.live.refresh(); }
  }

  private run = async (base: HostRequest): Promise<HostResult> => {
    // Bind this turn to its sender before anything can check a permission.
    const { access } = this.options;
    const admin = access && this.speaker ? access.adminFor(this.speaker) : undefined;
    // With roles in force, a turn without a known sender holds nothing.
    base.authorization?.setCaller(access ? this.speaker ? access.callerFor(this.speaker) : () => ({ permissions: [] }) : undefined);
    const { play, files, sandbox, transport } = this.options;
    // A conversation with a workspace is offered its repository only in Code mode in one; otherwise nothing asks for it.
    base.authorization?.withhold(files && !await repositoryOffered(base.cwd, base.mode) ? repositoryPermissions : []);
    const conversation = play?.conversation ?? this.options.key;
    const workspace: ConversationWorkspace | undefined = files && { store: files, conversation, sandbox, delivery: 'post', inline: Boolean(transport.answer) && base.side !== true,
      send: transport.sendFiles && (async (text, sent) => { await transport.sendFiles!(this.options.redact(text), sent); }) };
    // A side question (/btw) only reads: it keeps no scratchpad, the session's transcript, and starts no apps.
    const side = base.side === true;
    const request: HostRequest = { ...base, skills: this.options.skills?.preferences(this.speaker), planAction: this.refining ? 'revise' : base.prompt === approvePrompt ? 'approve' : base.planAction, readOnly: base.readOnly || this.refining, sessionId: this.options.key, access: admin, workspace, ...(files && !side ? { scratch: files.scratch(conversation) } : {}),
      play: play && !side ? { runtime: play.runtime, channelId: play.channelId, post: play.post, conversation, owner: this.speaker ? { id: this.speaker, name: this.speakerName } : undefined, files: workspace } : undefined };
    const refining = this.refining; this.refining = false;
    const turn = this.turn = new AbortController();
    const signal = AbortSignal.any([turn.signal, ...(this.options.request.signal ? [this.options.request.signal] : [])]);
    // A side answer shows no card either: it is one message, like a quick reply.
    const answerOnly = this.answerOnly || side;
    // It is still typed like a reply; a transport that answers a slash command has no typing to show.
    const typed = !this.answerOnly;
    const speaker = this.speaker;
    const card = new StatusCard(this.options.redact);
    /** The turn's status once it has ended; from then on the card no longer changes. */
    let outcome: string | undefined;
    const controls = (stop: boolean): CardControls => ({ stop, press: (button, userId) => {
      if (button === 'details') return card.details(outcome ?? 'running');
      if (outcome || this.turn !== turn || turn.signal.aborted) return { text: 'This turn is already ending.' };
      if (userId !== speaker && !this.operator(userId)) return { text: 'Only the person who asked, or an operator, can stop this turn.' };
      this.options.log(`${this.options.key}: stopped from the status card by ${userId}`);
      this.stop();
      return { text: 'stopping…' };
    } });
    const failed = (error: unknown) => { this.options.log(`${this.options.key}: status card failed: ${error instanceof Error ? error.message : String(error)}`); return undefined; };
    let posted: Promise<string | undefined> | undefined;
    /** Posts or replaces the card; false when it could not be posted. */
    const show = async (text: string, stop: boolean): Promise<boolean> => {
      const first = !posted;
      posted ??= this.options.transport.card(text, controls(stop)).catch(failed);
      const id = await posted;
      if (!first && id) await this.options.transport.card(text, controls(stop), id).catch(failed);
      return Boolean(id);
    };
    const update = throttle(async () => { if (outcome === undefined) await show(card.render(), true); }, this.options.progressIntervalMs ?? 1500);
    // The card waits for routing: a conversational turn shows only typing, like a person would. Any other
    // route, a slow one, or anything that needs to be seen (a tool, an approval, a wait in the queue) brings it up.
    let cardState = 'pending' as 'pending' | 'shown' | 'hidden';
    const refresh = (show = true) => {
      if (show && cardState === 'pending') cardState = 'shown';
      if (cardState === 'shown') update.request();
    };
    const pending = answerOnly ? undefined : setTimeout(() => refresh(), this.options.cardDelayMs ?? 4000);
    if (!answerOnly) this.live = { card, refresh: () => refresh() };
    let assistantText = '';
    let messageEnded = false;
    let casual = false;
    let commentary = Promise.resolve();
    // Keep the last message for the normal answer; continued work makes earlier text commentary.
    const postCommentary = () => {
      const text = assistantText; assistantText = ''; messageEnded = false;
      if (!text.trim()) return;
      commentary = commentary.then(async () => {
        for (const part of chunk(this.options.redact(text))) await transport.send(part, { silent: true }).catch(error => this.options.log(`${this.options.key}: commentary failed: ${error instanceof Error ? error.message : error}`));
      });
    };
    this.sink = event => {
      if (event.type === 'skill_discovery_warning' && typeof event.warning === 'string' && !this.skillWarnings.has(event.warning)) {
        this.skillWarnings.add(event.warning);
        if (this.skillWarnings.size > 32) this.skillWarnings.delete(this.skillWarnings.values().next().value!);
        void this.say(`-# ${event.warning}`, true);
      }
      if (event.type === 'route') casual = event.casual === true;
      if (!answerOnly && !this.quiet && !casual && !event.junior) {
        if (event.type === 'text' && typeof event.text === 'string') {
          if (messageEnded) postCommentary();
          assistantText += event.text;
        } else if (event.type === 'message_end') messageEnded = true;
        else if (event.type === 'tool_execution_start') postCommentary();
      }
      if (typeof event.result === 'string') this.options.log(`${this.options.key}: ${String(event.tool)} -> ${this.options.redact(event.result)}`);
      if (event.type === 'route' && cardState === 'pending' && !answerOnly) {
        if (event.casual === true) { cardState = 'hidden'; clearTimeout(pending); } else refresh();
      }
      if (!answerOnly && card.push(event)) refresh(cardState !== 'hidden');
    };
    this.reasoning = answerOnly ? undefined : text => { if (card.reason(text)) refresh(false); };
    const typing = !typed ? undefined : setInterval(() => this.options.transport.typing(), 8000);
    const heartbeat = answerOnly ? undefined : setInterval(() => { card.tick(); refresh(false); }, this.options.heartbeatMs ?? 5000);
    let result: HostResult;
    try {
      result = await this.options.queue.run(async () => {
        signal.throwIfAborted();
        if (typed) this.options.transport.typing();
        if (!answerOnly && card.set('thinking') === 'queued') refresh();
        return await this.options.run({ ...request, signal }, { approve: this.approve, onEvent: this.onEvent, onReasoning: this.onReasoning, onCheckpoint: this.checkpoint });
      }, () => { if (answerOnly) void this.say('Queued behind another task.'); else { card.set('queued'); refresh(); } });
    } catch (error) {
      const stopped = turn.signal.aborted;
      if (!stopped && this.options.request.signal?.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      this.options.log(`${this.options.key}: ${stopped ? 'stopped' : `failed: ${this.options.redact(message)}`}`);
      result = { requestId: '', success: false, status: stopped ? 'stopped' : 'error', text: stopped ? 'stopped' : `couldn’t finish — ${message}`, spentUsd: 0, receipts: [], attempts: 0 };
    } finally {
      clearTimeout(pending);
      clearInterval(typing);
      clearInterval(heartbeat);
      this.sink = undefined;
      this.reasoning = undefined;
      this.live = undefined;
      if (this.turn === turn) this.turn = undefined;
    }
    await commentary;
    const stopped = !result.success && (result.status === 'cancelled' || result.status === 'stopped');
    const reply = result.interruption ? formatInterruption(result.interruption, true) : result.text;
    const quietStop = stopped && (result.interruption ? !result.interruption.edits.length && !result.interruption.shellRan : reply === 'stopped');
    // A conversational reply goes out a line at a time with typing between, and without a card or result line.
    const lines = result.casual && result.success ? casualLines(this.options.redact(result.text)) : undefined;
    if (lines) {
      const { transport } = this.options;
      await paceLines(lines, line => transport.send(line).catch(error => this.options.log(`${this.options.key}: send failed: ${error instanceof Error ? error.message : error}`)),
        { typing: () => transport.typing(), delayMs: this.options.lineDelayMs, signal: this.options.request.signal });
    } else {
      const found = !side && result.success && this.options.transport.plan ? extractPlan(this.options.redact(result.text)) : undefined;
      if (found) {
        if (found.before) await this.say(found.before, true);
        await this.showPlan(found.plan, refining);
        if (found.after) await this.say(found.after, true);
      } else {
        // An aside stays plain text: its menu shares the messages as they were sent.
        if (side) await this.say(`${reply || '(no answer)'}\n-# this is an aside - not part of the main convo.`, true);
        else if (!quietStop || answerOnly) await this.answer(reply || '(no answer)');
        // The turn a button started ended without a plan: give the plan its buttons back.
        if (refining && this.plan?.revising) { this.plan.revising = false; await this.paint(this.plan, ['approve', 'juniors', 'change']); }
      }
    }
    // The terminal log below already records the result of an answer-only turn. Otherwise the card collapses to
    // its result once the answer is up, so the result stays the turn's last word and Details stays under it.
    if (!answerOnly && !(result.casual && result.success && cardState !== 'shown')) {
      outcome = result.status;
      await update.flush();
      const summary = card.summary(result);
      if (!await show(summary, false)) await this.say(summary);
    }
    this.options.log(`${this.options.key}: ${result.status}; $${result.spentUsd.toFixed(6)}`);
    this.options.onTurnEnd?.({ status: result.status, requestId: result.requestId });
    this.answerOnly = false;
    return result;
  };

  private async start(): Promise<void> {
    try {
      await runSession({ request: this.options.request, once: this.options.once, maxPromptChars: this.options.maxPromptChars, input: this.input, run: this.run,
        approve: this.approve, log: text => void this.say(text), onEvent: this.onEvent, extension: this.options.extension, onHistory: this.options.onHistory,
        ...(this.options.files ? { files: storeControls(this.options.files, () => this.options.play?.conversation ?? this.options.key) } : {}) });
      if (!this.options.request.signal?.aborted && !this.options.once) await this.say('Session ended. Send a message to start a new one.');
    } catch (error) {
      if (!this.options.request.signal?.aborted) {
        const message = this.options.redact(error instanceof Error ? error.message : String(error));
        this.options.log(`${this.options.key}: session ended: ${message}`);
        await this.say(`Session ended after an error: ${message}`);
      }
    } finally { this.ended = true; }
  }
}
