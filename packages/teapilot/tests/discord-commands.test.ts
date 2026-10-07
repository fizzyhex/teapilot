import { expect, it } from 'vitest';
import { commandDefinitions, commandText, promptSetup, setupCommands, withoutUserInstall } from '../src/discord/commands.js';
import { grantView } from '../src/discord/grants-panel.js';
import { permissions } from '../src/execution/grants.js';

it('maps slash commands to session commands', () => {
  expect(commandText('mode', null, 'code')).toBe('/mode code');
  expect(commandText('stop')).toBe('/stop');
  expect(commandText('mode')).toBeUndefined();
  expect(commandText('cd', null, '..')).toBeUndefined();
});

it('maps permissions subcommands', () => {
  expect(commandText('permissions', 'list')).toBe('/permissions');
  expect(commandText('permissions', 'grant', 'web.search')).toBe('/grant web.search');
  expect(commandText('permissions', 'revoke', 'repository.write')).toBe('/revoke repository.write');
  expect(commandText('permissions', 'grant')).toBeUndefined();
  expect(commandText('permissions')).toBeUndefined();
});

it('offers valid choices for option commands', () => {
  const mode = commandDefinitions.find(command => command.name === 'mode' && 'options' in command)! as Extract<typeof commandDefinitions[number], { options?: unknown }>;
  expect(mode.options![0]).toMatchObject({ choices: [{ value: 'chat' }, { value: 'ask' }, { value: 'code' }] });
  for (const command of commandDefinitions) if ('description' in command) expect(command.description.length).toBeLessThanOrEqual(100);
});

it('registers reply as a slash command and a message context menu without session text', () => {
  expect(commandDefinitions).toContainEqual(expect.objectContaining({ type: 3, name: 'Reply' }));
  expect(commandDefinitions.some(command => command.name === 'reply' && 'options' in command)).toBe(true);
  expect(commandText('reply', null, 'hello')).toBeUndefined();
});

it('registers repost this! in the Apps context menu for server and user installations', () => {
  expect(commandDefinitions).toContainEqual({ type: 3, name: 'repost this!', integration_types: [0, 1], contexts: [0, 1, 2] });
});

it('offers reply in user-installed contexts and can drop that for server-only registration', () => {
  const reply = commandDefinitions.filter(command => command.name.toLowerCase() === 'reply');
  expect(reply).toHaveLength(2);
  for (const command of reply) expect(command).toMatchObject({ integration_types: [0, 1], contexts: [0, 1, 2] });
  for (const command of withoutUserInstall(commandDefinitions)) expect(command).not.toHaveProperty('integration_types');
  expect(withoutUserInstall(commandDefinitions)).toHaveLength(commandDefinitions.length);
});

it('maps /prompt mode and reasoning to a starting mode and tier', () => {
  const prompt = commandDefinitions.find(command => command.name === 'prompt' && 'options' in command)! as Extract<typeof commandDefinitions[number], { options?: unknown }>;
  expect(prompt.options).toMatchObject([{ name: 'prompt', required: true }, { name: 'mode', required: false }, { name: 'reasoning', required: false },
    { type: 5, name: 'yolo', required: false },
    ...[1, 2, 3, 4].map(index => ({ type: 11, name: `attachment${index}`, required: false }))]);
  expect(commandText('prompt', null, 'hello')).toBeUndefined();
  expect(promptSetup('code', 'medium')).toEqual({ mode: 'code', tier: 'deep' });
  expect(promptSetup(null, 'low')).toEqual({ tier: 'reasoning' });
  // xhigh is the policy's to opt into, not a per-prompt choice.
  expect(promptSetup(null, 'xhigh')).toEqual({});
  expect((prompt.options as Array<{ name: string; choices?: Array<{ value: string }> }>).find(option => option.name === 'reasoning')?.choices?.map(choice => choice.value)).toEqual(['off', 'low', 'medium']);
  expect(promptSetup(null, 'off')).toEqual({ tier: 'normal' });
  expect(promptSetup('nonsense', 'nonsense')).toEqual({});
  expect(setupCommands({ mode: 'code', tier: 'deep' })).toEqual(['/mode code', '/tier deep']);
  expect(setupCommands({})).toEqual([]);
});

it('offers /convo, /workspace and /new in place of /clear, and /collab as join, leave and fork', () => {
  const find = (name: string) => commandDefinitions.find(command => command.name === name) as Extract<typeof commandDefinitions[number], { options?: unknown }> | undefined;
  expect(find('clear')).toBeUndefined();
  expect(find('exit')).toBeUndefined();
  expect(commandText('convo', 'clear')).toBe('/convo clear');
  expect(commandText('convo', 'grants')).toBe('/convo grants');
  expect(commandText('convo')).toBeUndefined();
  expect(commandText('workspace', 'clear')).toBe('/workspace clear');
  expect(commandText('workspace', 'name', 'tea notes')).toBe('/workspace name tea notes');
  expect(commandText('workspace', 'tree')).toBe('/workspace tree');
  expect(commandText('workspace', 'tree', 'src')).toBe('/workspace tree src');
  expect(commandText('new')).toBe('/new');
  for (const action of ['join', 'leave', 'fork']) expect(commandText('collab', action)).toBe(`/collab ${action}`);
  expect(commandText('collab', null, 'hello')).toBeUndefined();
  expect(find('workspace')?.options).toContainEqual(expect.objectContaining({ name: 'tree', options: [expect.objectContaining({ name: 'dir', autocomplete: true })] }));
  for (const name of ['collab', 'convo', 'workspace', 'new', 'stop']) expect(find(name)).toMatchObject({ integration_types: [0, 1], contexts: [0, 1, 2] });
});

it('shows /convo grants as a button per permission, green when granted and grey when not, five to a row', () => {
  const view = grantView({ state: () => permissions.map(permission => ({ permission, granted: permission === 'inference' })), press: async () => undefined });
  expect(view.components.map(row => row.components.length)).toEqual([5, 1]);
  expect(view.components[0]!.components.slice(0, 2)).toEqual([
    { type: 2, style: 3, label: 'inference', custom_id: 'teapilot-grant:inference' },
    { type: 2, style: 2, label: 'repository.read', custom_id: 'teapilot-grant:repository.read' },
  ]);
  expect(grantView({ state: () => [], press: async () => undefined })).toEqual({ content: 'this conversation cannot be granted anything.', components: [] });
});
