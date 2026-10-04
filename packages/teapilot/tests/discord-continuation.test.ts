import { afterEach, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({ client: undefined as any }));

vi.mock('discord.js', () => {
  class Builder {
    data: Record<string, any> = {};
    components: Builder[] = [];
    addComponents(...components: Builder[]) { this.components.push(...components); return this; }
    setCustomId(custom_id: string) { this.data.custom_id = custom_id; return this; }
    setLabel(label: string) { this.data.label = label; return this; }
    setStyle(style: number) { this.data.style = style; return this; }
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
  return {
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

const operator = 'operator';
const interaction = (customId: string, message: any) => ({
  customId, message, user: { id: operator, username: operator },
  isButton: () => true, isStringSelectMenu: () => false, isModalSubmit: () => false,
  isMessageContextMenuCommand: () => false, isChatInputCommand: () => false, isAutocomplete: () => false,
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
  return { gateway, sent, channel, client: harness.client, transport: incoming.transport() };
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

it('askContinuationBudget auto-approves after 45 seconds and clears its timer exactly once', async () => {
  vi.useFakeTimers();
  const { gateway, sent, channel, transport } = await setup();
  const controller = new AbortController();
  const result = transport.askContinuationBudget!('continue?', controller.signal);
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  expect(vi.getTimerCount()).toBe(1);
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(45_000);
  await expect(result).resolves.toBe('auto-approved');
  expect(sent[0].payload).toMatchObject({ content: 'continue?' });
  expect(sent[0].edits).toHaveLength(1);
  expect(sent[0].edits[0]).toMatchObject({ content: expect.stringContaining('auto-approved after 45 seconds'), components: [] });
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
  await expect(result).resolves.toBe(order === 'abort-first' ? 'denied' : 'auto-approved');
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
