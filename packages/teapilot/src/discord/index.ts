import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAside, proposalRequest } from '../chat.js';
import { loadConfig, type Config } from '../config.js';
import { repositoryOffered, repositoryPermissions, SessionGrants } from '../execution/grants.js';
import { runHost, type HostRequest } from '../host.js';
import { headlessTeachat, openHeadlessTeachat } from '../teachat/session.js';
import type { SetupUI } from '../setup/terminal.js';
import { route, routeReply } from './access.js';
import { AccessStore } from './access-store.js';
import { AsideStore } from './aside-store.js';
import { HistoryStore } from './history-store.js';
import { GrantStore } from './grant-store.js';
import { grantControls, type GrantPanel } from './grants-panel.js';
import { SeatStore, type Seat } from './seat-store.js';
import { Conversation, TurnQueue, type ConversationOptions, type DiscordTransport } from './bridge.js';
import { pictures } from './files.js';
import { receiveFiles } from '../workspace/attach.js';
import { SrtSandbox } from '../workspace/sandbox.js';
import { WorkspaceStore } from '../workspace/store.js';
import { workspaceBrowser } from './browse.js';
import { keptNote, storeControls, workspaceCommand } from '../workspace/commands.js';
import { consultant } from './play/consult.js';
import { summariser } from './summarise.js';
import { PlayRuntime, type Clock, type PlaySurface } from './play/runtime.js';
import { PlayStore } from './play/store.js';
import type { connect, Gateway, GatewayCommand, GatewayCompletion, GatewayMessage, GatewayReply } from './gateway.js';
import { interactionLifetimeMs, setupCommands, type PromptSetup } from './commands.js';
import { chunk, quoteMessage } from './render.js';
import { StatusPresence } from './presence.js';
import { configureDiscord, discordStatus, removeDiscord } from './setup.js';
import { readDiscordSettings, type DiscordSettings } from './settings.js';
import { SkillStore } from '../skills/store.js';
import { skillCache } from '../skills/cache.js';

export const discordActions = ['setup', 'start', 'status', 'remove'] as const;
export interface DiscordCommand { directory: string; cwd: string; ui: SetupUI; signal: AbortSignal; funnel?: boolean }

/** teapilot discord setup|start|status|remove — opt-in, separate from teapilot setup. */
export async function discord(action: string, options: DiscordCommand): Promise<boolean> {
  if (action === 'setup') return configureDiscord(options, options.ui, options.signal);
  if (action === 'status') return discordStatus(options.directory, options.ui, options.signal);
  if (action === 'remove') return removeDiscord(options.directory, options.ui, options.signal);
  if (action === 'start') return startDiscord(options);
  throw new Error(`Use teapilot discord ${discordActions.join('|')}.`);
}

async function startDiscord({ directory, ui, signal, funnel = true }: DiscordCommand): Promise<boolean> {
  const env = { ...process.env };
  const config = await loadConfig(directory, env);
  const settings = readDiscordSettings(env);
  // discord.js loads only here, so every other command starts without it.
  const gateway = await import('./gateway.js');
  await serveDiscord({ config, settings, log: text => ui.log(`${new Date().toLocaleTimeString()} ${text}`), signal, connect: gateway.connect, browser: { funnel } });
  return true;
}

/** Everything `teapilot discord start` runs once settings are read; the Discord simulator supplies its own `connect`. */
export interface DiscordServer {
  browser?: { funnel: boolean };
  config: Config;
  settings: DiscordSettings;
  /** The operator log; lines arrive redacted. */
  log: (text: string) => void;
  signal: AbortSignal;
  connect: typeof connect;
  /** Where the access list and app records live; the profile's state directory by default. */
  stateDir?: string;
  clock?: Clock;
  teachat?: boolean;
  onTurnEnd?: ConversationOptions['onTurnEnd'];
}

/** Connects and serves Discord until `signal` aborts. */
export async function serveDiscord({ config, settings, signal, connect, clock, stateDir = config.stateDir, teachat: withTeachat = true, ...options }: DiscordServer): Promise<void> {
  let root: string;
  try { root = await realpath(settings.root); }
  catch { throw new Error(`Discord repository root ${settings.root} is unavailable. Run teapilot discord setup.`); }
  const secrets = [settings.token, config.router.apiKey, ...Object.values(config.secrets)].filter((value): value is string => Boolean(value));
  const redact = (text: string) => secrets.reduce((result, secret) => result.split(secret).join('[REDACTED]'), text);
  const log = (text: string) => options.log(redact(text));
  // Operators come from setup; whitelisted users and temporary grants live in the state directory.
  const access = AccessStore.at(stateDir, settings.allowedUserIds, config.policy.permissions);
  const allowed = (id: string) => access.roleOf(id) !== undefined;
  const skillStore = new SkillStore(stateDir, config.skills ?? { enabled: true }, skillCache(config.stateDir));
  const queue = new TurnQueue();
  const conversations = new Map<string, Conversation>();
  const histories = HistoryStore.at(stateDir);
  /**
   * Each history's access, one object for all its conversations, so one-shots and restarts carry it on and /convo grants
   * works on it while nothing runs. It is kept on disk until revoked or the history is left for good.
   */
  const grantStore = GrantStore.at(stateDir);
  const sessions = new Map<string, Promise<SessionGrants>>();
  const grantsFor = (historyKey: string): Promise<SessionGrants> => {
    let grants = sessions.get(historyKey);
    if (!grants) {
      grants = SessionGrants.create(root, config, settings.startMode, false, grantStore.load(historyKey)).then(created => {
        created.persist(saved => { try { grantStore.save(historyKey, saved); } catch (error) { log(`${historyKey}: grants not saved: ${error instanceof Error ? error.message : String(error)}`); } });
        return created;
      });
      grants.catch(() => sessions.delete(historyKey));
      sessions.set(historyKey, grants);
    }
    return grants;
  };
  const forgetGrants = (historyKey: string) => { sessions.delete(historyKey); grantStore.save(historyKey, undefined); };
  /** Side answers posted compactly, which their buttons show for as long as the post stays up. */
  const asides = AsideStore.at(stateDir);
  /**
   * The bot's custom status: the games running, the requests answered and the rounds gossipped, this session only.
   * It is bound to the gateway once connected, and each count feeds it from where that count changes.
   */
  const presence = new StatusPresence({ set: async text => { await setStatus?.(text); }, log });
  const teachat = withTeachat ? await openHeadlessTeachat(config, log, { onRound: () => presence.gossipped() }) : undefined;
  const run = (request: HostRequest, dependencies: Parameters<typeof runHost>[2]) => teachat ? teachat.work(() => runHost(config, request, dependencies)) : runHost(config, request, dependencies);
  /** A conversation turn, which counts towards the status; a consult on an app's behalf is not one. */
  const runTurn: typeof run = async (request, dependencies) => {
    try { return await run(request, dependencies); }
    finally { presence.handled(); }
  };
  // The surface is bound once the gateway connects; apps only post after a message arrives or on recovery, both later.
  let surface: PlaySurface | undefined;
  const connected = () => { if (!surface) throw new Error('Discord is not connected yet.'); return surface; };
  /** Set once the gateway is up; until then the status has nowhere to go. */
  let setStatus: Gateway['setStatus'] | undefined;
  const files = WorkspaceStore.at(stateDir);
  /** A conversation's scratchpad is working material for its task, so it goes when its history is cleared; files and apps stay. */
  const clearScratch = (historyKey: string) => { void files.clearScratch(historyKey).catch(error => log(`${historyKey}: scratchpad not cleared: ${error instanceof Error ? error.message : String(error)}`)); };
  const sandbox = new SrtSandbox(stateDir, config.workspace, config.source?.directory);
  void sandbox.status().then(status => log(status.available
    ? `Workspace commands run sandboxed with ${status.tools.map(tool => tool.name).join(', ') || 'no media tools found'}.`
    : `Workspace commands are off: ${status.reason}`));
  const play = new PlayRuntime({
    store: PlayStore.at(stateDir), log, clock, pictures: pictures(files),
    onRunning: count => presence.games(count),
    surface: { post: (...args) => connected().post(...args), edit: (...args) => connected().edit(...args), request: (...args) => connected().request(...args) },
    consult: consultant({ config, root, access, queue, run, signal, skills: (userId, conversation) => skillStore.effective({ userId, conversation, operator: access.roleOf(userId) === 'operator' }) }),
  });
  let browser: Awaited<ReturnType<typeof import('./play/web.js').openPlayWeb>> | undefined;
  let browserHost: typeof browser;

  /**
   * Where teapilot cannot post, each /reply, /prompt or /collab is its own one-shot conversation, since it answers
   * through that interaction. They continue a saved history: each person's own in a channel, so nobody sees or
   * steers another's, or with /collab the one everyone there shares. `seats` records which one each person is in.
   */
  const historyKeyOf = (channelId: string, userId: string, seat: Seat) => seat === 'collab' ? `collab:${channelId}` : `reply:${channelId}:${userId}`;
  const seats = SeatStore.at(stateDir);
  /** The latest one-shot work per history; the next waits for it so neither overwrites the other's turns. */
  const tails = new Map<string, Promise<void>>();
  /** One-shot conversations still running, by history, so /stop can reach them. */
  const runningOneShots = new Map<string, Conversation>();
  const enqueue = (historyKey: string, task: () => Promise<void>): Promise<void> => {
    const turn = (tails.get(historyKey) ?? Promise.resolve()).then(task);
    const tail = turn.catch(() => undefined);
    tails.set(historyKey, tail);
    void tail.then(() => { if (tails.get(historyKey) === tail) tails.delete(historyKey); });
    return turn;
  };
  /**
   * Takes someone out of `seat` at once. Their own conversation's history goes once its running turn ends; a collab's
   * stays for the others, and goes only when the last person has left.
   */
  const leave = (channelId: string, userId: string, seat: Seat): Promise<void> => {
    seats.sit(channelId, userId, undefined);
    const historyKey = historyKeyOf(channelId, userId, seat);
    // Decided now: whoever joins after the last person left starts with a clean collab.
    if (seat === 'collab' && seats.collaborators(channelId)) return Promise.resolve();
    return enqueue(historyKey, async () => {
      histories.save(historyKey, []); clearScratch(historyKey);
      seats.remember(historyKey, undefined); forgetGrants(historyKey);
      skillStore.forget(historyKey);
    });
  };
  const switchNote =
    'You already have your own conversation with teapilot in this channel. Joining the collab clears it; /collab fork later takes a copy of the collab as your own.';

  /**
   * `channelId` is where discord.play apps run; a one-shot posts them through its interaction. `setup` only shapes a new
   * conversation; access still starts from the configured mode, so a chosen Code mode asks for it when needed.
   * `historyKey` is where turns are kept, the conversation's own key unless a one-shot shares a history. `timeLimited` ends
   * the turn when its interaction expires, for one-shots without a status card to resume their updates from.
   */
  const open = async (key: string, transport: DiscordTransport, { channelId, oneShot = false, timeLimited = false, setup = {}, historyKey = key }: { channelId?: string; oneShot?: boolean; timeLimited?: boolean; setup?: PromptSetup; historyKey?: string } = {}): Promise<Conversation> => {
    const existing = conversations.get(key);
    if (existing?.active) return existing;
    // A side question reads the history's access as it is, and its own requests never outlast it.
    const authorization = key.startsWith('btw:') ? await SessionGrants.create(root, config, settings.startMode, false, grantStore.load(historyKey)) : await grantsFor(historyKey);
    const conversation = new Conversation({
      key, transport, queue, redact, log, access, files, sandbox,
      once: oneShot,
      request: { prompt: '', cwd: root, mode: setup.mode ?? settings.startMode, tier: setup.tier, authorization, signal: timeLimited ? AbortSignal.any([signal, AbortSignal.timeout(interactionLifetimeMs)]) : signal,
        // A conversation picks up where it was before a restart, or where the last one-shot in its history left off.
        history: histories.load(historyKey) },
      onHistory: history => { if (!history.length) clearScratch(historyKey); try { histories.save(historyKey, history); } catch (error) { log(`${historyKey}: history not saved: ${error instanceof Error ? error.message : String(error)}`); } },
      maxPromptChars: config.policy.limits.maxPromptChars,
      run: runTurn,
      onTurnEnd: options.onTurnEnd,
      extension: teachat && headlessTeachat(teachat, key),
      skills: {
        preferences: userId => skillStore.effective({ conversation: historyKey.startsWith('btw:') ? undefined : historyKey, userId, operator: !!userId && access.roleOf(userId) === 'operator' }),
        command: async (args, userId) => {
          if (!userId || !allowed(userId)) return 'you are not allowed to choose skills here.';
          return skillStore.command(args, { conversation: historyKey, userId, operator: access.roleOf(userId) === 'operator' }, signal);
        },
      },
      // A one-shot posts apps through its interaction, and later one-shots in the same history manage them.
      play: { runtime: play, conversation: historyKey, ...(!oneShot ? { channelId } : transport.postApp ? { channelId, post: payload => transport.postApp!(payload) } : {}) },
    });
    conversations.set(key, conversation);
    return conversation;
  };

  /** Keeps a message's attachments in the conversation's workspace and says what arrived, for the prompt. */
  const receive = async (conversation: string, message: Pick<GatewayMessage, 'attachments' | 'authorName'>, room: number): Promise<string> => {
    const incoming = message.attachments.map(attachment => ({ name: attachment.name, size: attachment.size, type: attachment.contentType, data: () => attachment.download() }));
    const notes = await receiveFiles(files, conversation, incoming, message.authorName, room);
    if (notes) log(`${conversation}: kept ${message.attachments.length} attachment(s) from @${message.authorName}`);
    return notes;
  };

  /**
   * A side question (/btw) is answered by a one-shot that reads `historyKey`'s saved turns, workspace and all, and
   * never writes them back: it never enters the running conversation, so it cannot steer or lengthen it. Without a
   * history it answers on its own. It still waits its turn in the queue, since every request takes the state lock.
   */
  const side = async (historyKey: string | undefined, prompt: string, transport: DiscordTransport, channelId: string, from: { sender: string; senderName: string }): Promise<void> => {
    const key = `btw:${randomUUID()}`;
    log(`${historyKey ?? key} @${from.senderName} (btw): ${prompt.split('\n')[0]!.slice(0, 80)}`);
    const conversation = await open(key, transport, { channelId, oneShot: true, timeLimited: true, historyKey: historyKey ?? key });
    conversation.push(prompt, from);
    try { await conversation.done; }
    finally { conversations.delete(key); }
  };

  const handle = async (message: GatewayMessage): Promise<void> => {
    const target = route(message, settings, allowed);
    if (!target) return;
    access.rememberName(message.authorId, message.authorName);
    if (!message.content && !message.attachments.length) { await message.transport().send('teapilot reads text messages and attachments only.'); return; }
    // A plan or RFC request with an idea gets a light bulb, so it is clear the message was taken as one; a missing reaction permission is not worth failing over.
    if (proposalRequest(message.content)?.idea) await message.react('💡').catch(error => log(`Discord: could not react: ${error instanceof Error ? error.message : String(error)}`));
    if (isAside(message.content)) {
      // A message cannot be answered privately, so the answer is public, as a reply to it; a mention in a channel is answered in place, without a thread.
      const historyKey = target.kind === 'new-thread' ? undefined : target.key;
      const notes = message.attachments.length && historyKey ? await receive(historyKey, message, config.policy.limits.maxPromptChars - message.content.length - 1500) : '';
      await side(historyKey, [message.content, notes].filter(Boolean).join('\n\n'), message.replyTransport(), message.channelId, { sender: message.authorId, senderName: message.authorName });
      return;
    }
    // A running conversation already holds its earlier turns, so only a new one needs the reply chain.
    const chain = target.kind === 'new-thread' || !conversations.get(target.key)?.active ? await message.replyChain() : undefined;
    let prompt = chain && (chain.messages.length || chain.truncated) ? quoteMessage({ author: message.authorName, text: message.content }, chain) : message.content;
    let key = target.key;
    let channelId = message.channelId;
    let transport: DiscordTransport;
    if (target.kind === 'new-thread') {
      const thread = await message.startThread(message.content);
      key = `thread:${thread.id}`; transport = thread.transport; channelId = thread.id;
    } else transport = message.transport();
    // Files belong to the conversation they arrive in, a new thread included; its apps show them.
    if (message.attachments.length) {
      const notes = await receive(key, message, config.policy.limits.maxPromptChars - prompt.length - 1500);
      prompt = [prompt, notes].filter(Boolean).join('\n\n');
    }
    log(`${key} @${message.authorName}: ${message.content.split('\n')[0]!.slice(0, 80)}`);
    (await open(key, transport, { channelId })).push(prompt, { sender: message.authorId, senderName: message.authorName });
  };
  /** Offers to clear a workspace the conversation kept, after /convo clear. */
  const offerClearFiles = async (command: GatewayCommand, workspace: string, done: string) => {
    const note = keptNote(files.list(workspace).length);
    if (!note) { await command.respond(done); return; }
    const click = await command.choose(`${done} ${note}`, ['clear workspace too!', 'keep it']);
    if (!click) return;
    if (click.choice !== 0) { await click.settle(`${done} The workspace kept its files.`); return; }
    const count = await files.clearFiles(workspace);
    log(`${workspace}: ${command.authorId} cleared the workspace (${count} files)`);
    await click.settle(`${done} Cleared the workspace too.`);
  };
  /** Asks before clearing something everyone in a collab shares; true once confirmed. */
  const confirmShared = async (command: GatewayCommand, what: string): Promise<{ settle(note: string): Promise<void> } | undefined> => {
    const click = await command.choose(`this clears ${what} for everyone in this channel's collab.`, ['clear it', 'cancel']);
    if (!click) return undefined;
    if (click.choice !== 0) { await click.settle('Nothing was cleared.'); return undefined; }
    return click;
  };

  const handleCollab = async (command: GatewayCommand, seat: Seat | undefined): Promise<void> => {
    const [, action] = command.text.split(/\s+/);
    if (!command.oneShot) {
      await command.respond(!command.guildId ? '/collab is for server channels! a DM is between you and teapilot.'
        : !command.parentId ? 'teapilot can post here, so /prompt starts a thread everyone can follow. /collab is for channels where it answers through the command.'
          : 'Everyone in this thread already shares its conversation.');
      return;
    }
    const { channelId, authorId } = command;
    if (action === 'join') {
      if (seat === 'collab') {
        const click = await command.choose('You are in this channel\'s collab. /prompt and /reply go to it.', ['Leave the collab', 'Stay']);
        if (!click || click.choice !== 0) { await click?.settle('You stayed in the collab.'); return; }
        void leave(channelId, authorId, 'collab').catch(failed('Leaving'));
        await click.settle('You left the collab. /prompt and /reply go to your own conversation again.');
        return;
      }
      if (seat === 'solo') {
        const click = await command.choose(switchNote, ['Clear it and join the collab', 'Stay']);
        if (!click || click.choice !== 0) { await click?.settle('You stayed in your own conversation.'); return; }
        void leave(channelId, authorId, 'solo').catch(failed('Switching'));
        seats.sit(channelId, authorId, 'collab');
        await click.settle('You joined this channel\'s collab. /prompt and /reply go to it until you /collab leave.');
        return;
      }
      seats.sit(channelId, authorId, 'collab');
      log(`${historyKeyOf(channelId, authorId, 'collab')}: ${authorId} joined`);
      await command.respond('You joined this channel\'s collab. /prompt and /reply go to it until you /collab leave.');
      return;
    }
    if (seat !== 'collab') { await command.respond('You are not in this channel\'s collab. /collab join joins it.'); return; }
    if (action === 'leave') {
      void leave(channelId, authorId, 'collab').catch(failed('Leaving'));
      await command.respond(seats.collaborators(channelId) ? 'Left the collab. Its history stays for everyone still in it.' : 'Left the collab. You were the last one in it, so its history was cleared.');
      return;
    }
    // Fork: a copy of the collab, taken once its running turn ends, becomes this person's own conversation.
    const collabKey = historyKeyOf(channelId, authorId, 'collab');
    const soloKey = historyKeyOf(channelId, authorId, 'solo');
    const setup = seats.setup(collabKey);
    seats.sit(channelId, authorId, 'solo');
    const copied = enqueue(collabKey, async () => {
      histories.save(soloKey, histories.load(collabKey));
      forgetGrants(soloKey); grantStore.save(soloKey, grantStore.load(collabKey));
      await files.copy(collabKey, soloKey);
      seats.remember(soloKey, undefined); seats.remember(soloKey, setup);
      skillStore.fork(collabKey, soloKey);
      log(`${soloKey}: forked from ${collabKey}`);
    });
    // Their next prompt waits for the copy.
    void enqueue(soloKey, () => copied.catch(() => undefined));
    void copied.then(() => {
      // Leaving after the copy: if this person was the last one in, the collab is cleared only now.
      if (!seats.collaborators(channelId)) return enqueue(collabKey, async () => { histories.save(collabKey, []); clearScratch(collabKey); seats.remember(collabKey, undefined); forgetGrants(collabKey); });
    }).catch(failed('Forking'));
    await command.respond('Forked the collab: you have your own copy of its conversation and workspace, and /prompt and /reply go to it. The collab carries on for everyone else.');
  };

  /**
   * /convo grants for a history, whether or not it is running. While a turn runs, presses go through its conversation,
   * which can post approvals; otherwise only what needs no approval, or an operator's press, is granted.
   */
  const grantPanelFor = async (historyKey: string): Promise<GrantPanel> => {
    const grants = await grantsFor(historyKey);
    const live = () => [conversations.get(historyKey), runningOneShots.get(historyKey)].find(conversation => conversation?.active)?.grantPanel();
    // Idle, nothing has narrowed it for a turn, so withhold what the next turn would: a workspace keeps repository access out of all but Code mode.
    if (!live()) grants.withhold(await repositoryOffered(root, seats.setup(historyKey).mode ?? settings.startMode) ? [] : repositoryPermissions);
    const idle = grantControls({ grants, access, key: historyKey, log, signal });
    return { state: () => grants.offered(), press: (permission, userId) => (live() ?? idle).press(permission, userId) };
  };

  const handleCommand = async (command: GatewayCommand): Promise<void> => {
    if (command.authorIsBot || !allowed(command.authorId)) { await command.respond('You are not allowed to use teapilot here.'); return; }
    const target = route(command, settings, allowed);
    // Seats hold where teapilot answers through the interaction, and /reply, /prompt keep a conversation per seat there.
    const seat = seats.seat(command.channelId, command.authorId);
    if (command.text.startsWith('/collab')) { await handleCollab(command, seat); return; }
    const key = seat ? historyKeyOf(command.channelId, command.authorId, seat) : target?.key || undefined;
    if (/^\/skills(?:\s|$)/.test(command.text)) {
      try {
        const text = await skillStore.command(command.text.slice(7).trim(), { conversation: key, userId: command.authorId, operator: access.roleOf(command.authorId) === 'operator' }, signal);
        // Discord messages are bounded; long catalogs are sent as private follow-ups.
        for (const part of chunk(text)) await command.respond(part);
      } catch (error) { await command.respond(error instanceof Error ? error.message : String(error)); }
      return;
    }
    // The tree is private to whoever asked, with buttons; it never needs the conversation, even a running one.
    const tree = key && /^\/workspace tree(?:\s+([\s\S]*))?$/i.exec(command.text.trim());
    if (tree) {
      const browser = workspaceBrowser(files, key);
      const view = browser.folder(tree[1] ?? '');
      if ('note' in view) await command.respond(view.note); else await command.browse(view.text, browser, view.dir, key);
      return;
    }
    if (command.text === '/convo grants') {
      if (!key) await command.respond(target ? 'no conversation here yet. send a message to start one.' : "you're not in a conversation with teapilot here.");
      else await command.grants(await grantPanelFor(key));
      return;
    }
    const conversation = target && conversations.get(target.key);
    if (target && conversation?.active) {
      log(`${target.key}: ${command.text}`);
      // /convo clear is answered privately, with a button to clear the workspace too.
      const clearing = command.text === '/convo clear';
      conversation.push(command.text, { sender: command.authorId, quiet: clearing });
      if (clearing) await offerClearFiles(command, target.key, 'Cleared the conversation.');
      else await command.respond();
      return;
    }
    if (!key) { await command.respond(target ? 'no active conversation here. send a message to start one.' : "you're not in a conversation with teapilot here."); return; }
    if (command.text === '/stop') {
      const turn = runningOneShots.get(key);
      if (!turn?.active) { await command.respond('Nothing is running.'); return; }
      turn.push('/stop', { sender: command.authorId });
      await command.respond();
      return;
    }
    if (runningOneShots.get(key)?.active) { await command.respond('teapilot is answering here right now. Wait for it, or /stop it first.'); return; }
    /** Clears a conversation that is not running: its history and scratchpad, and with `withFiles` its workspace. */
    const clear = async (withFiles: boolean) => {
      histories.save(key, []); clearScratch(key); seats.remember(key, undefined);
      if (withFiles) { await files.clearFiles(key); files.rename(key, ''); }
      log(`${key}: ${command.authorId} ran ${command.text}`);
    };
    if (command.text === '/convo clear' || command.text === '/new') {
      const withFiles = command.text === '/new';
      if (seat === 'collab') {
        const click = await confirmShared(command, withFiles ? 'the conversation and its workspace' : 'the conversation');
        if (!click) return;
        await clear(withFiles);
        await click.settle(withFiles ? 'Cleared the collab\'s conversation and workspace.' : 'Cleared the collab\'s conversation. Its workspace kept its files.');
        return;
      }
      await clear(withFiles);
      if (withFiles) await command.respond('Started over with an empty workspace.');
      else await offerClearFiles(command, key, 'Cleared the conversation.');
      return;
    }
    if (command.text.startsWith('/workspace')) {
      if (command.text === '/workspace clear' && seat === 'collab') {
        const click = await confirmShared(command, 'the workspace');
        if (!click) return;
        await click.settle((await workspaceCommand(storeControls(files, () => key), command.text))!);
        return;
      }
      await command.respond(await workspaceCommand(storeControls(files, () => key), command.text) ?? 'Unknown teapilot command.');
      return;
    }
    await command.respond('no active conversation here. send a message to start one.');
  };
  /** Folders for /workspace tree and sets or skills for /skills, for Discord to offer as they are typed. */
  const handleComplete = async (completion: GatewayCompletion): Promise<void> => {
    const skills = /^\/skills (\S+)$/.exec(completion.text);
    if (!(skills || completion.text === '/workspace tree') || completion.authorIsBot || !allowed(completion.authorId)) { await completion.respond([]); return; }
    const target = route(completion, settings, allowed);
    const seat = seats.seat(completion.channelId, completion.authorId);
    const key = seat ? historyKeyOf(completion.channelId, completion.authorId, seat) : target?.key || undefined;
    if (skills) {
      const caller = { conversation: key, userId: completion.authorId, operator: access.roleOf(completion.authorId) === 'operator' };
      await completion.respond(await skillStore.suggest(skills[1]!, completion.typed, caller, signal).catch(() => []));
      return;
    }
    const typed = completion.typed.replace(/\\/g, '/').toLowerCase();
    await completion.respond(key ? files.folders(key).filter(folder => folder.toLowerCase().includes(typed)) : []);
  };
  const handleReply = async (reply: GatewayReply): Promise<void> => {
    const target = routeReply(reply, settings, allowed);
    if (!target) { await reply.respond('You are not allowed to use teapilot here.'); return; }
    if (!reply.content) { await reply.respond('teapilot reads text messages only.'); return; }
    /** The prompt with notes on the files that came with it, which are kept in the conversation's workspace. */
    const prompt = async (workspace: string) => reply.attachments.length
      ? [reply.content, await receive(workspace, reply, config.policy.limits.maxPromptChars - reply.content.length - 1500)].filter(Boolean).join('\n\n')
      : reply.content;
    const from = { answerOnly: reply.answerOnly, sender: reply.authorId, senderName: reply.authorName, yolo: reply.yolo };
    if (reply.side) {
      // Answered privately through the interaction, from whichever conversation the asker is in here; seats stay as they are.
      const seat = reply.oneShot ? seats.seat(reply.channelId, reply.authorId) : undefined;
      const historyKey = reply.oneShot ? seat && historyKeyOf(reply.channelId, reply.authorId, seat) : target.kind === 'new-thread' ? undefined : target.key;
      await reply.respond();
      await side(historyKey, historyKey ? await prompt(historyKey) : reply.content, reply.transport(), reply.channelId, { sender: reply.authorId, senderName: reply.authorName });
      return;
    }
    if (reply.oneShot) {
      // /collab join and leave choose where prompts go; without a seat, it is this person's own conversation.
      const seat: Seat = seats.seat(reply.channelId, reply.authorId) ?? 'solo';
      await reply.respond();
      const transport = reply.transport();
      seats.sit(reply.channelId, reply.authorId, seat);
      const historyKey = historyKeyOf(reply.channelId, reply.authorId, seat);
      const setup = seats.remember(historyKey, reply.setup);
      const key = `reply:${reply.id}`;
      log(`${historyKey} @${reply.authorName} (reply): ${reply.title.split('\n')[0]!.slice(0, 80)}`);
      // A one-shot's apps and files live under its history, so later one-shots there still have them.
      const content = await prompt(historyKey);
      await enqueue(historyKey, async () => {
        // A one-shot stops after one input, so the chosen mode and tier go in when it opens rather than as commands.
        const conversation = await open(key, transport, { channelId: reply.channelId, oneShot: true, setup, historyKey });
        runningOneShots.set(historyKey, conversation);
        conversation.push(content, from);
        try { await conversation.done; }
        finally { conversations.delete(key); if (runningOneShots.get(historyKey) === conversation) runningOneShots.delete(historyKey); }
      });
      return;
    }
    let key = target.key;
    let channelId = reply.channelId;
    let transport: DiscordTransport;
    if (target.kind === 'new-thread') {
      try {
        const thread = await reply.startThread(reply.title);
        key = `thread:${thread.id}`; transport = thread.transport; channelId = thread.id;
      } catch (error) {
        await reply.respond(`teapilot could not start a thread here: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    } else transport = reply.transport();
    await reply.respond();
    log(`${key} @${reply.authorName} (reply): ${reply.title.split('\n')[0]!.slice(0, 80)}`);
    // A new conversation starts with the chosen mode and tier; one already running switches to them first.
    const running = conversations.get(key)?.active;
    const content = await prompt(key);
    const conversation = await open(key, transport, { channelId, setup: reply.setup });
    // Switching to Code mode asks for access, which yolo approves as well.
    if (running) for (const command of setupCommands(reply.setup)) conversation.push(command, { sender: reply.authorId, senderName: reply.authorName, yolo: reply.yolo });
    conversation.push(content, from);
  };
  const failed = (what: string) => (error: unknown) => log(`${what} failed: ${error instanceof Error ? error.message : String(error)}`);
  const gateway = await connect(settings, {
    message: message => void handle(message).catch(failed('Message handling')),
    command: command => void handleCommand(command).catch(failed('Command handling')),
    complete: completion => void handleComplete(completion).catch(failed('Completion')),
    reply: reply => void handleReply(reply).catch(failed('Reply handling')),
    allowed,
    component: interaction => void (surface ? play.interact(interaction) : interaction.reply('teapilot is still starting; try again in a moment.')).catch(failed('App interaction')),
    openBrowser: (channelId, messageId, user) => browser?.launch(channelId, messageId, user),
    openEditorForMessage: (messageId, user) => browserHost?.editFileMessage(messageId, user.id),
    bindFileReply: (messageId, conversation, path, user) => browserHost?.bindFileReply(messageId, conversation, path, user.id),
    asides: { keep: answer => asides.keep(answer), find: id => asides.find(id), summarise: summariser({ config, root, access, queue, run, signal, skills: userId => skillStore.effective({ userId, operator: access.roleOf(userId) === 'operator' }) }) },
  }, log);
  surface = gateway.play;
  setStatus = gateway.setStatus;
  presence.start();
  const recovered = await play.recover();
  if (options.browser && !signal.aborted) {
    try { browser = browserHost = await (await import('./play/web.js')).openPlayWeb(play, { ...options.browser, log, signal, workspace: files }); }
    catch (error) { log(`browser play is unavailable: ${error instanceof Error ? error.message : error}`); }
  }
  if (recovered) log(`Loaded ${recovered} discord.play app(s); each one starts again at the next click.`);
  if (!config.policy.permissions.includes('discord.play')) log('discord.play is off: add "discord.play" to "permissions" in this profile\'s policy.json to let teapilot build interactive Discord apps.');

  access.lookup = gateway.username;
  log(`Connected as ${gateway.botName}. Listening to ${settings.allowedUserIds.length} operator(s) and ${access.list().users.length} user(s) in DMs${settings.channelIds.length ? ` and ${settings.channelIds.length === 1 ? 'channel' : 'channels'} ${settings.channelIds.join(', ')}` : ''}.`);
  log(`Repository root: ${root}. Sessions start in ${settings.startMode} mode. Press Ctrl+C to stop.`);
  if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  log('Stopping: pending approvals are denied.');
  presence.close();
  await browser?.close();
  play.close();
  await gateway.close();
  await skillCache(config.stateDir).close();
  await sandbox.close();
  await Promise.allSettled([...conversations.values()].map(conversation => conversation.done));
  await teachat?.close();
}
