import { afterEach, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({ client: undefined as any }));

vi.mock('discord.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('discord.js');
  class Builder {
    data: Record<string, any> = {};
    components: Builder[] = [];
    addComponents(...components: Builder[]) { this.components.push(...components); return this; }
    setCustomId(custom_id: string) { this.data.custom_id = custom_id; return this; }
    setLabel(label: string) { this.data.label = label; return this; }
    setStyle(style: number) { this.data.style = style; return this; }
    setDisabled(disabled: boolean) { this.data.disabled = disabled; return this; }
    toJSON(): Record<string, any> { return { ...this.data, type: this.components.length ? 1 : 2, ...(this.components.length ? { components: this.components.map(component => component.toJSON()) } : {}) }; }
  }
  class Client {
    listeners = new Map<string, Array<(...args: any[]) => void>>();
    user = { id: 'bot', tag: 'bot', setPresence: () => undefined };
    application = { commands: { set: async () => undefined } };
    channels: any;
    users = { fetch: async () => undefined };
    rest = { request: async () => undefined };
    constructor() { harness.client = this; }
    on(event: string, handler: (...args: any[]) => void) { this.listeners.set(event, [...(this.listeners.get(event) ?? []), handler]); return this; }
    once(event: string, handler: (...args: any[]) => void) { return this.on(event, (...args) => { this.listeners.set(event, (this.listeners.get(event) ?? []).filter(value => value !== handler)); handler(...args); }); }
    emit(event: string, ...args: any[]) { for (const handler of this.listeners.get(event) ?? []) handler(...args); }
    async login() { this.emit('clientReady'); }
    async destroy() {}
  }
  return { ...actual,
    ActionRowBuilder: Builder, ButtonBuilder: Builder,
    ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4 },
    ActivityType: { Custom: 4 }, ApplicationIntegrationType: { GuildInstall: 0 },
    Client, Events: { Raw: 'raw', InteractionCreate: 'interactionCreate', MessageCreate: 'messageCreate', Error: 'error', ClientReady: 'clientReady' },
    GatewayIntentBits: { Guilds: 1, GuildMessages: 2, DirectMessages: 3, MessageContent: 4 },
    InteractionContextType: { PrivateChannel: 1 }, MessageFlags: { SuppressEmbeds: 4, SuppressNotifications: 4096, Ephemeral: 64 },
    MessageReferenceType: { Default: 0 }, Partials: { Channel: 1 }, PermissionFlagsBits: { ViewChannel: 1, SendMessages: 2, SendMessagesInThreads: 3 },
    StringSelectMenuBuilder: Builder, ThreadAutoArchiveDuration: { OneDay: 1440 },
  };
});

import { connect } from '../src/discord/gateway.js';
import type { Checkpoint } from '../src/agents/checkpoint.js';
import { promptCommand } from '../src/discord/commands.js';
import { checkMessage } from '../scripts/discord-sim/validate.js';

const operator = 'operator';
const interaction = (customId: string, message: any) => ({
  customId, message, user: { id: operator, username: operator },
  isButton: () => true, isStringSelectMenu: () => false, isModalSubmit: () => false,
  isMessageContextMenuCommand: () => false, isChatInputCommand: () => false, isAutocomplete: () => false, isFromMessage: () => true,
  deferUpdate: vi.fn(async () => undefined), update: vi.fn(async () => undefined),
  reply: vi.fn(async () => undefined),
});

async function setup(extraHandlers: Record<string, any> = {}) {
  let nextId = 0;
  const sent: any[] = [];
  const channel: any = {
    id: 'channel', isSendable: () => true, isThread: () => false,
    send: async (payload: any) => {
      const message = { id: `m${++nextId}`, payload, edits: [] as any[], edit: vi.fn(async (update: any) => { message.edits.push(update); return message; }) };
      sent.push(message); return message;
    },
    sendTyping: async () => undefined, messages: { fetch: async (id: string) => sent.find(message => message.id === id) },
  };
  harness.client = undefined;
  let incoming: any;
  const handlers = { message(value: any) { incoming = value; }, command: vi.fn(), reply: vi.fn(), component: vi.fn(), asides: { keep: vi.fn(), find: vi.fn(), summarise: vi.fn() }, ...extraHandlers };
  const gateway = await connect({ token: 'test', allowedUserIds: [operator], channelIds: [], root: '.', startMode: 'ask' } as any,
    handlers, vi.fn());
  harness.client.channels = { fetch: async () => channel };
  const source = { author: { id: operator, bot: false, username: operator }, channel, channelId: channel.id, guildId: null,
    content: 'test', mentions: { users: { has: () => false } }, attachments: new Map() };
  harness.client.emit('messageCreate', source);
  return { gateway, sent, channel, client: harness.client, handlers, transport: incoming.transport() };
}

it('opens a fresh private editor link from an authorized file-reply button', async () => {
  const openEditorForMessage = vi.fn((messageId: string, user: { id: string }) => user.id === operator ? `https://edit.test/${messageId}/fresh` : undefined);
  const { gateway, client } = await setup({ openEditorForMessage });
  const click = interaction('teapilot:edit-file:open', { id: 'file-reply-1' });
  client.emit('interactionCreate', click);
  await vi.waitFor(() => expect(click.reply).toHaveBeenCalledOnce());
  expect(openEditorForMessage).toHaveBeenCalledWith('file-reply-1', { id: operator, name: operator });
  expect(click.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('https://edit.test/file-reply-1/fresh'), flags: 64 }));
  await gateway.close();
});

afterEach(() => { vi.useRealTimers(); });

it('edits play messages by id without fetching them first', async () => {
  const { gateway, channel } = await setup();
  channel.messages.fetch = vi.fn();
  channel.messages.edit = vi.fn(async () => undefined);
  try {
    await gateway.play.edit('channel', 'uncached-message', { content: 'latest', embeds: [], components: [], allowedMentions: { parse: [] } });
    expect(channel.messages.fetch).not.toHaveBeenCalled();
    expect(channel.messages.edit).toHaveBeenCalledWith('uncached-message', expect.objectContaining({ content: 'latest', attachments: [] }));
  } finally { await gateway.close(); }
});

const buttonId = (message: any, label: string) => message.payload.components[0].components.find((button: any) => button.data.label === label).data.custom_id;
const press = async (client: any, id: string, message: any) => {
  const click = interaction(id, message);
  client.emit('interactionCreate', click);
  await vi.waitFor(() => expect(click.deferUpdate).toHaveBeenCalledOnce());
  return click;
};

const uiCheckpoint: Checkpoint = { version: 1, requestId: 'r', checkpointId: 9, sequence: 1, reason: 'request_calls', durability: 'request-local', expiresAt: Date.now() + 30_000,
  snapshot: { amendments: [], artifacts: [], checks: [], results: [], workers: [], resources: {}, pendingUncertain: [] }, summary: ['check failed'], continuation: { offerId: 'lease', instructorCalls: 2, activeMs: 10_000, freshContext: false } };

it('routes durable checkpoint buttons and forms by saved id even after gateway restart', async () => {
  const first = await setup();
  const id = '11111111-1111-4111-8111-111111111111';
  await first.transport.savedCheckpoint!('saved checkpoint', id);
  const card = first.sent[0];
  card.flags = { has: () => false };
  expect(card.payload.components[0].components.map((button: any) => button.data.label)).toEqual(['Resume', 'Change direction', 'Finish']);
  checkMessage({ ...card.payload, components: card.payload.components.map((row: any) => row.toJSON()) });
  await first.gateway.close();
  const savedCheckpoint = vi.fn(async () => 'new execution authorized');
  const state = await setup({ savedCheckpoint, allowed: (user: string) => user === operator });
  const savedClick = (label: string): any => ({ ...interaction(buttonId(card, label), card), channelId: 'channel', channel: state.channel,
    deferReply: vi.fn(async () => undefined), editReply: vi.fn(async () => undefined), showModal: vi.fn(async () => undefined) });
  const resume = savedClick('Resume');
  state.client.emit('interactionCreate', resume);
  await vi.waitFor(() => expect(savedCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ id, action: 'resume', channelId: 'channel', user: { id: operator, name: operator } })));
  expect(resume.deferReply).toHaveBeenCalledWith({ flags: 64 });
  const change = savedClick('Change direction');
  state.client.emit('interactionCreate', change);
  await vi.waitFor(() => expect(change.showModal).toHaveBeenCalledOnce());
  const modalId = change.showModal.mock.calls[0][0].custom_id;
  const submit = { ...savedClick('Change direction'), customId: modalId, isButton: () => false, isModalSubmit: () => true,
    fields: { getTextInputValue: () => 'keep it small' } };
  state.client.emit('interactionCreate', submit);
  await vi.waitFor(() => expect(savedCheckpoint).toHaveBeenLastCalledWith(expect.objectContaining({ id, action: 'redirect', amendment: 'keep it small' })));
  const stranger = { ...savedClick('Resume'), user: { id: 'stranger', username: 'stranger' } };
  state.client.emit('interactionCreate', stranger);
  await vi.waitFor(() => expect(stranger.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('not authorised') })));
  expect(savedCheckpoint).toHaveBeenCalledTimes(2);
  await state.gateway.close();
});

it('routes a private one-shot /prompt through the webhook checkpoint modal path', async () => {
  let reply: any;
  const { gateway, client, handlers } = await setup({ reply: (value: any) => { reply = value; } });
  const privateChannel = { ...client.channels.fetch, isSendable: () => true, isThread: () => false };
  const command: any = { id: 'interaction-one-shot', createdTimestamp: Date.now(), user: { id: operator, username: operator, bot: false }, commandName: promptCommand,
    channelId: 'private', channel: privateChannel, context: 1, authorizingIntegrationOwners: {}, appPermissions: undefined,
    isButton: () => false, isStringSelectMenu: () => false, isModalSubmit: () => false, isMessageContextMenuCommand: () => false, isChatInputCommand: () => true, isAutocomplete: () => false, inGuild: () => false,
    options: { getString: (name: string) => name === 'prompt' ? 'task' : null, getBoolean: () => false, getAttachment: () => null },
    deferReply: vi.fn(async () => undefined), editReply: vi.fn(async () => ({ id: 'webhook-card' })), followUp: vi.fn(async () => ({ id: 'followup' })), reply: vi.fn(async () => undefined), deleteReply: vi.fn(async () => undefined) };
  client.emit('interactionCreate', command);
  await vi.waitFor(() => expect(reply).toBeDefined());
  expect(reply.oneShot).toBe(true);
  const transport = reply.transport();
  const controller = new AbortController();
  const pending = transport.checkpoint!('one-shot checkpoint', uiCheckpoint, controller.signal,
    (_action: string, _user: string, amendment?: string) => ({ requestId: 'r', checkpointId: 9, action: 'redirect', offerId: 'lease', amendment } as any), () => ({ text: 'stopping…' }));
  await vi.waitFor(() => expect(command.editReply).toHaveBeenCalled());
  const payload = command.editReply.mock.calls.at(-1)![0];
  const changeId = payload.components[0].components.find((button: any) => button.data.label === 'Change direction').data.custom_id;
  const change: any = interaction(changeId, { id: 'webhook-card' });
  change.showModal = vi.fn(async (modal: any) => { change.modal = modal; });
  client.emit('interactionCreate', change);
  await vi.waitFor(() => expect(change.showModal).toHaveBeenCalledOnce());
  const submit: any = { customId: change.modal.custom_id, message: { id: 'webhook-card' }, user: { id: operator, username: operator },
    isButton: () => false, isModalSubmit: () => true, isStringSelectMenu: () => false, isMessageContextMenuCommand: () => false, isChatInputCommand: () => false, isAutocomplete: () => false, isFromMessage: () => true,
    fields: { getTextInputValue: () => 'redirect safely' }, deferUpdate: vi.fn(async () => undefined), editReply: vi.fn(async () => undefined), reply: vi.fn(async () => undefined) };
  client.emit('interactionCreate', submit);
  await expect(pending).resolves.toMatchObject({ action: 'redirect', amendment: 'redirect safely' });
  await vi.waitFor(() => expect(submit.editReply).toHaveBeenCalledOnce());
  expect(submit.message.edit).toBeUndefined();
  controller.abort(); await gateway.close();
});

it('opens Change direction modal immediately, accepts one amendment, and rejects stale duplicate submits', async () => {
  const { gateway, sent, client, transport } = await setup();
  const controller = new AbortController();
  const decide = vi.fn((_action: string, _user: string, amendment?: string) => ({ requestId: 'r', checkpointId: 9, action: 'redirect', offerId: 'lease', amendment } as const));
  const pending = transport.checkpoint!('checkpoint card', uiCheckpoint, controller.signal, decide, () => ({ text: 'stopping…' }));
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  const card = sent[0];
  const modalClick: any = interaction(buttonId(card, 'Change direction'), card);
  modalClick.showModal = vi.fn(async (payload: any) => { modalClick.modal = payload; });
  client.emit('interactionCreate', modalClick);
  await vi.waitFor(() => expect(modalClick.showModal).toHaveBeenCalledOnce());
  expect(modalClick.showModal.mock.calls[0]![0]).toMatchObject({ title: 'change direction', components: [{ components: [{ custom_id: 'amendment', required: true, max_length: 1000 }] }] });
  expect(decide).not.toHaveBeenCalled();

  const submit: any = { customId: modalClick.modal.custom_id, message: card, user: { id: operator, username: operator }, isButton: () => false, isMessageContextMenuCommand: () => false, isChatInputCommand: () => false, isAutocomplete: () => false,
    isStringSelectMenu: () => false, isModalSubmit: () => true, isFromMessage: () => true,
    fields: { getTextInputValue: () => 'avoid the old parser' }, deferUpdate: vi.fn(async () => undefined), editReply: vi.fn(async () => undefined), reply: vi.fn(async () => undefined) };
  client.emit('interactionCreate', submit);
  await expect(pending).resolves.toMatchObject({ action: 'redirect', amendment: 'avoid the old parser' });
  await vi.waitFor(() => expect(submit.editReply).toHaveBeenCalledOnce());
  expect(card.edit).not.toHaveBeenCalled();
  expect(decide).toHaveBeenCalledTimes(1);
  const stale = { ...submit, reply: vi.fn(async () => undefined) };
  client.emit('interactionCreate', stale);
  await vi.waitFor(() => expect(stale.reply).toHaveBeenCalledWith(expect.objectContaining({ content: 'this checkpoint is no longer open.' })));
  await gateway.close();
});

it('resolves a claimed Continue before a stalled Discord message update', async () => {
  const { gateway, sent, client, transport } = await setup();
  let resolveUpdate!: () => void;
  const clickUpdate = new Promise<void>(resolve => { resolveUpdate = resolve; });
  const controller = new AbortController();
  const pending = transport.checkpoint!('checkpoint card', uiCheckpoint, controller.signal,
    () => ({ requestId: 'r', checkpointId: 9, action: 'continue', offerId: 'lease' }), () => ({ text: 'stopping…' }));
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  const click = interaction(buttonId(sent[0], 'Continue'), sent[0]);
  click.update = vi.fn(async () => { await clickUpdate; return undefined; });
  client.emit('interactionCreate', click);
  await expect(pending).resolves.toMatchObject({ action: 'continue', offerId: 'lease' });
  expect(click.update).toHaveBeenCalledOnce();
  resolveUpdate();
  await gateway.close();
});

it('aborts during a delayed Discord post, then removes controls when the post eventually arrives', async () => {
  vi.useFakeTimers();
  const { gateway, sent, channel, transport } = await setup();
  let publish!: (message: any) => void;
  channel.send = vi.fn(() => new Promise(resolve => { publish = resolve; }));
  const controller = new AbortController();
  const pending = transport.checkpoint!('checkpoint card', uiCheckpoint, controller.signal,
    () => ({ requestId: 'r', checkpointId: 9, action: 'continue', offerId: 'lease' }), () => ({ text: 'stopping…' }));
  expect(vi.getTimerCount()).toBeGreaterThan(0);
  controller.abort();
  await expect(pending).resolves.toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
  const posted: any = { id: 'delayed', payload: {}, edits: [], edit: vi.fn(async (payload: any) => { posted.edits.push(payload); }) };
  publish(posted);
  await vi.waitFor(() => expect(posted.edit).toHaveBeenCalledOnce());
  expect(posted.edits[0]).toMatchObject({ components: [], content: expect.stringContaining('checkpoint cancelled') });
  expect(sent).toHaveLength(0);
  await gateway.close();
});

it('bounds the entire checkpoint message, including facts, proposal and expiry footer', async () => {
  const { gateway, sent, transport } = await setup();
  const controller = new AbortController();
  const huge = { ...uiCheckpoint, expiresAt: Date.now() + 60_000, summary: Array.from({ length: 80 }, () => 'verified check detail '.repeat(20)), modelHandoff: 'proposal '.repeat(500) };
  const pending = transport.checkpoint!('checkpoint card '.repeat(400), huge, controller.signal, () => undefined, () => ({ text: 'stopping…' }));
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0].payload.content.length).toBeLessThanOrEqual(2000);
  const row = sent[0].payload.components[0];
  checkMessage({ content: sent[0].payload.content, components: [{ type: 1, components: row.components.map((button: any) => ({ type: 2, custom_id: button.data.custom_id, label: button.data.label, style: button.data.style, disabled: button.data.disabled })) }] });
  controller.abort(); await expect(pending).resolves.toBeUndefined();
  await gateway.close();
});

it('leaves a dismissed direction modal paused; abort wins and late Continue is rejected', async () => {
  const { gateway, sent, client, transport } = await setup();
  const controller = new AbortController();
  const decide = vi.fn(() => ({ requestId: 'r', checkpointId: 9, action: 'continue', offerId: 'lease' } as const));
  const pending = transport.checkpoint!('checkpoint card', uiCheckpoint, controller.signal, decide, () => ({ text: 'stopping…' }));
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  const card = sent[0];
  const click: any = interaction(buttonId(card, 'Change direction'), card);
  click.showModal = vi.fn(async () => undefined);
  client.emit('interactionCreate', click);
  await vi.waitFor(() => expect(click.showModal).toHaveBeenCalledOnce());
  expect(sent[0].edits).toHaveLength(0); // closing the form is not a decision
  controller.abort();
  await expect(pending).resolves.toBeUndefined();
  const late = interaction(buttonId(card, 'Continue'), card);
  client.emit('interactionCreate', late);
  await vi.waitFor(() => expect(late.reply).toHaveBeenCalledWith(expect.objectContaining({ content: 'this checkpoint is no longer open.' })));
  expect(decide).not.toHaveBeenCalled();
  await gateway.close();
});

it('expires the checkpoint into a disabled card and rejects a late Continue', async () => {
  vi.useFakeTimers();
  const { gateway, sent, client, transport } = await setup();
  const controller = new AbortController();
  const expiring = { ...uiCheckpoint, expiresAt: Date.now() + 100 };
  const pending = transport.checkpoint!('checkpoint card', expiring, controller.signal, () => ({ requestId: 'r', checkpointId: 9, action: 'continue', offerId: 'lease' }), () => ({ text: 'stopping…' }));
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  const card = sent[0];
  await vi.advanceTimersByTimeAsync(100);
  await expect(pending).resolves.toBeUndefined();
  expect(card.edits[0]).toMatchObject({ components: [], content: expect.stringContaining('checkpoint expired or cancelled') });
  const stale = interaction(buttonId(card, 'Continue'), card);
  client.emit('interactionCreate', stale);
  await vi.waitFor(() => expect(stale.reply).toHaveBeenCalledWith(expect.objectContaining({ content: 'this checkpoint is no longer open.' })));
  await gateway.close();
});

it('askContinuationBudget fails closed after its response window and clears its timer exactly once', async () => {
  vi.useFakeTimers();
  const { gateway, sent, channel, transport } = await setup();
  const controller = new AbortController();
  const result = transport.askContinuationBudget!('continue?', controller.signal);
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  expect(vi.getTimerCount()).toBe(1);
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(45_000);
  await expect(result).resolves.toBe('denied');
  expect(sent[0].payload).toMatchObject({ content: 'continue?' });
  expect(sent[0].edits).toHaveLength(1);
  expect(sent[0].edits[0]).toMatchObject({ content: expect.stringContaining('no response — run paused'), components: [] });
  controller.abort();
  expect(sent[0].edits).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
  await gateway.close();
});

it.each([
  ['Approve batch', 'approved'],
  ['Stop run', 'denied'],
] as const)('settles a continuation button press (%s)', async (label, expected) => {
  vi.useFakeTimers();
  const { gateway, sent, client, transport } = await setup();
  const result = transport.askContinuationBudget!('continue?', new AbortController().signal);
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  await press(client, buttonId(sent[0], label), sent[0]);
  await expect(result).resolves.toBe(expected);
  expect(sent[0].edits).toHaveLength(1);
  expect(sent[0].edits[0].components).toEqual([]);
  expect(sent[0].edits[0].content).toContain(expected === 'approved' ? 'batch approved' : 'run stopped');
  expect(vi.getTimerCount()).toBe(0);
  await gateway.close();
});

it('lets an already-clicked deny win even if Discord is slow to defer the interaction', async () => {
  vi.useFakeTimers();
  const { gateway, sent, client, transport } = await setup();
  const result = transport.askContinuationBudget!('continue?', new AbortController().signal);
  await vi.waitFor(() => expect(sent).toHaveLength(1));

  let finishDefer!: () => void;
  const click = interaction(buttonId(sent[0], 'Stop run'), sent[0]);
  click.deferUpdate.mockImplementation(() => new Promise<undefined>(resolve => { finishDefer = () => resolve(undefined); }));
  client.emit('interactionCreate', click);
  await vi.waitFor(() => expect(click.deferUpdate).toHaveBeenCalledOnce());

  await vi.advanceTimersByTimeAsync(45_000);
  finishDefer();
  await expect(result).resolves.toBe('denied');
  await vi.waitFor(() => expect(sent[0].edits).toHaveLength(1));
  expect(sent[0].edits[0].content).toContain('run stopped');
  expect(vi.getTimerCount()).toBe(0);
  await gateway.close();
});

it('keeps cancellation when an in-flight click resumes after the signal aborts', async () => {
  vi.useFakeTimers();
  const { gateway, sent, client, transport } = await setup();
  const controller = new AbortController();
  const result = transport.askContinuationBudget!('continue?', controller.signal);
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  let finishDefer!: () => void;
  const click = interaction(buttonId(sent[0], 'Approve batch'), sent[0]);
  click.deferUpdate.mockImplementation(() => new Promise<undefined>(resolve => { finishDefer = () => resolve(undefined); }));
  client.emit('interactionCreate', click);
  await vi.waitFor(() => expect(click.deferUpdate).toHaveBeenCalledOnce());
  controller.abort();
  finishDefer();
  await expect(result).resolves.toBe('denied');
  await vi.waitFor(() => expect(sent[0].edits).toHaveLength(1));
  expect(sent[0].edits[0].content).toContain('run stopped');
  expect(vi.getTimerCount()).toBe(0);
  await gateway.close();
});

it('denies an already-aborted continuation without posting or starting a timer', async () => {
  vi.useFakeTimers();
  const { gateway, sent, transport } = await setup();
  const controller = new AbortController(); controller.abort();
  await expect(transport.askContinuationBudget!('continue?', controller.signal)).resolves.toBe('denied');
  expect(sent).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
  await gateway.close();
});

it('aborts a pending continuation, settles once, cleans up the timer, and rejects a stale button', async () => {
  vi.useFakeTimers();
  const { gateway, sent, client, transport } = await setup();
  const controller = new AbortController();
  const result = transport.askContinuationBudget!('continue?', controller.signal);
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  const id = buttonId(sent[0], 'Approve batch');
  controller.abort();
  await expect(result).resolves.toBe('denied');
  await vi.waitFor(() => expect(sent[0].edits).toHaveLength(1));
  expect(sent[0].edits[0].content).toContain('run stopped');
  expect(vi.getTimerCount()).toBe(0);
  const stale = interaction(id, sent[0]);
  client.emit('interactionCreate', stale);
  await vi.waitFor(() => expect(stale.reply).toHaveBeenCalledOnce());
  expect(stale.reply).toHaveBeenCalledWith(expect.objectContaining({ content: 'This approval is no longer pending.' }));
  await vi.advanceTimersByTimeAsync(45_000);
  expect(sent[0].edits).toHaveLength(1);
  await gateway.close();
});

it.each(['abort-first', 'timeout-first'] as const)('settles exactly once when abort races timeout (%s)', async order => {
  vi.useFakeTimers();
  const { gateway, sent, client, transport } = await setup();
  const controller = new AbortController();
  const result = transport.askContinuationBudget!('continue?', controller.signal, 100);
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  const id = buttonId(sent[0], 'Approve batch');
  if (order === 'abort-first') {
    controller.abort();
    await vi.advanceTimersByTimeAsync(100);
  } else {
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
  }
  await expect(result).resolves.toBe('denied');
  await vi.waitFor(() => expect(sent[0].edits).toHaveLength(1));
  expect(vi.getTimerCount()).toBe(0);
  const stale = interaction(id, sent[0]);
  client.emit('interactionCreate', stale);
  await vi.waitFor(() => expect(stale.reply).toHaveBeenCalledOnce());
  expect(sent[0].edits).toHaveLength(1);
  await gateway.close();
});

it('ordinary askApproval still denies abort and never auto-approves', async () => {
  vi.useFakeTimers();
  const { gateway, sent, client, transport } = await setup();
  const controller = new AbortController();
  const result = transport.askApproval('approve action?', controller.signal);
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  controller.abort();
  await expect(result).resolves.toBe(false);
  expect(sent[0].edits).toHaveLength(1);
  expect(sent[0].edits[0]).toMatchObject({ content: expect.stringContaining('Denied'), components: [] });
  expect(vi.getTimerCount()).toBe(0);

  const fresh = new AbortController();
  const second = transport.askApproval('still waiting?', fresh.signal);
  await vi.waitFor(() => expect(sent).toHaveLength(2));
  await vi.advanceTimersByTimeAsync(45_000);
  expect(sent[1].edits).toHaveLength(0);
  let settled = false;
  void second.then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  fresh.abort();
  await expect(second).resolves.toBe(false);
  await gateway.close();
});
