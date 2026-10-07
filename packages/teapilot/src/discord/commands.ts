import { reasoningLevels, tierPreferences, type ReasoningLevel, type TierPreference } from '../config.js';
import { modes, permissions, type Mode } from '../execution/grants.js';
import { reasoningTier } from '../routing/execution.js';
import { skillScopes } from '../skills/store.js';

type Choice = { name: string; value: string };
/** 3 = string, 5 = boolean, 11 = attachment. */
type Option = { type: 3; name: string; description: string; required: boolean; choices?: Choice[]; autocomplete?: boolean }
  | { type: 5 | 11; name: string; description: string; required: boolean };
/** Discord application-command JSON; kept free of discord.js so it can be tested and registered from anywhere. */
export type CommandDefinition = Placement & (
  | { name: string; description: string; options?: Array<Option | { type: 1; name: string; description: string; options?: Option[] }> }
  /** Message context menu entry (right-click → Apps); Discord forbids a description here. */
  | { type: 3; name: string });
/** 0 = installed to a server, 1 = installed to a user; contexts 0 = server, 1 = bot DM, 2 = other DMs and group chats. */
interface Placement { integration_types?: Array<0 | 1>; contexts?: Array<0 | 1 | 2> }
const everywhere: Placement = { integration_types: [0, 1], contexts: [0, 1, 2] };

/** Discord expires an interaction's webhook after 15 minutes; stop a little before so replies never race it. */
export const interactionLifetimeMs = 14 * 60_000;

/** Commands that start or continue a conversation instead of controlling one; the gateway handles them itself. */
export const replyCommand = 'reply';
export const promptCommand = 'prompt';
/** Joins, leaves or forks the conversation everyone in a channel shares, where teapilot answers through the interaction. */
export const collabCommand = 'collab';
/** /workspace tree's folder, which Discord completes as it is typed. */
export const treeOption = 'dir';
export const replyMenu = 'Reply';
export const browserMenu = 'Open In Browser';
export const resendMenu = 'repost this!';
/** Copies an answer or an app, which /paste then posts in another channel. */
export const shareMenu = 'Share';
export const pasteCommand = 'paste';

const value = (description: string, values: readonly string[]): Option =>
  ({ type: 3, name: 'value', description, required: true, choices: values.map(item => ({ name: item, value: item })) });
const optional = (name: string, description: string, values: readonly string[]): Option =>
  ({ type: 3, name, description, required: false, choices: values.map(item => ({ name: item, value: item })) });
const choice = (name: string, description: string, values: readonly string[]): CommandDefinition =>
  ({ name, description, options: [value(description, values)] });
/** How many files /prompt takes: `attachment1` to `attachment4`. */
export const promptAttachments = 4;
export const attachmentOption = (index: number) => `attachment${index + 1}`;
// Each runs its own tier; medium picks deep, which runs xhigh only when the policy opts in.
const promptEfforts: readonly ReasoningLevel[] = reasoningLevels.filter(level => level !== 'xhigh');
const promptOptions: Option[] = [
  { type: 3, name: 'prompt', description: 'What to ask teapilot', required: true },
  optional('mode', 'Session mode for this and later turns', modes),
  optional('reasoning', 'Reasoning effort for this and later turns', promptEfforts),
  { type: 5, name: 'yolo', description: 'Approve every action this prompt asks for without asking (operators only)', required: false },
  ...Array.from({ length: promptAttachments }, (_, index): Option => ({ type: 11, name: attachmentOption(index), description: 'A file for teapilot to read', required: false })),
];
const subcommand = (name: string, description: string, options?: Option[]) => ({ type: 1 as const, name, description, ...(options ? { options } : {}) });

/** These mirror the session commands the bridge already understands; /cd is fixed for Discord. */
export const commandDefinitions: CommandDefinition[] = [
  { name: 'skills', description: 'Choose repository skill sets and individual skills', options: [
    ...['list', 'enable', 'disable', 'add', 'remove', 'update'].map(action => subcommand(action, `${action} skill sets or skills`, [
      { type: 3, name: 'target', description: 'gh:owner/repo, optionally #revision or ::skill', required: ['enable', 'disable', 'add', 'remove'].includes(action), autocomplete: true } as Option,
      optional('scope', 'Where to keep this choice', skillScopes),
    ])),
    subcommand('offline', 'Use cached skill sets without network requests', [value('Offline mode', ['on', 'off']), optional('scope', 'Where to keep this choice', skillScopes)]),
    subcommand('reset', 'Restore inherited skill choices', [optional('scope', 'Where to restore choices', skillScopes)]),
  ], ...everywhere },
  choice('mode', 'Switch the session mode', modes),
  choice('tier', 'Set the model tier preference', tierPreferences),
  {
    name: 'permissions', description: 'Show, grant or revoke session access',
    options: [
      subcommand('list', 'List the access granted to this session'),
      subcommand('grant', 'Ask to grant a permission for this session', [value('Permission to grant', permissions)]),
      subcommand('revoke', 'Revoke a session permission', [value('Permission to revoke', permissions)]),
    ],
  },
  {
    name: replyCommand, description: 'Talk to teapilot in this channel',
    options: [{ type: 3, name: 'message', description: 'What to ask teapilot', required: true }],
    ...everywhere,
  },
  { name: promptCommand, description: 'Talk to teapilot with a chosen mode and reasoning', options: promptOptions, ...everywhere },
  {
    name: collabCommand, description: 'The conversation everyone in this channel shares',
    options: [
      subcommand('join', 'Join it: /prompt and /reply go there until you leave'),
      subcommand('leave', 'Leave it and go back to your own conversation'),
      subcommand('fork', 'Leave it, taking a copy of its conversation and workspace as your own'),
    ],
    ...everywhere,
  },
  { type: 3, name: replyMenu, ...everywhere },
  { type: 3, name: browserMenu, ...everywhere },
  { type: 3, name: resendMenu, ...everywhere },
  { type: 3, name: shareMenu, ...everywhere },
  { name: pasteCommand, description: 'Paste what you copied with Apps → Share', ...everywhere },
  // Also where teapilot is not invited, where they act on the conversation /reply or /prompt keeps there.
  { name: 'convo', description: 'Your conversation with teapilot here', options: [
    subcommand('clear', 'Clear its context; the workspace keeps its files'),
    subcommand('grants', 'Show its access as buttons to grant or revoke'),
  ], ...everywhere },
  {
    name: 'workspace', description: 'The files this conversation works on',
    options: [
      subcommand('clear', 'Delete every file in the workspace'),
      subcommand('name', 'Give the workspace a name', [{ type: 3, name: 'name', description: 'The name', required: true }]),
      subcommand('tree', 'List the files in the workspace', [{ type: 3, name: treeOption, description: 'subdirectory path', required: false, autocomplete: true }]),
    ],
    ...everywhere,
  },
  { name: 'new', description: 'Clear the conversation and the workspace', ...everywhere },
  { name: 'stop', description: 'Cancel the running turn', ...everywhere },
  { name: 'help', description: 'Show teapilot commands' },
];

/** Server-install only, for when Discord rejects user-install registration because the portal has it disabled. */
export const withoutUserInstall = (definitions: CommandDefinition[]): CommandDefinition[] =>
  definitions.map(({ integration_types: _types, contexts: _contexts, ...rest }) => rest as CommandDefinition);

/** The session text equivalent to an invocation, or undefined for anything teapilot does not define. */
export function commandText(name: string, subcommandName?: string | null, argument?: string | null, scope?: string | null): string | undefined {
  const definition = commandDefinitions.find(candidate => candidate.name === name);
  if (!definition || !('description' in definition) || [replyCommand, promptCommand, pasteCommand].includes(name)) return undefined;
  if (name === 'permissions') {
    if (subcommandName === 'list') return '/permissions';
    return (subcommandName === 'grant' || subcommandName === 'revoke') && argument ? `/${subcommandName} ${argument}` : undefined;
  }
  const subcommands = definition.options?.filter(option => option.type === 1) ?? [];
  if (subcommands.length) {
    const chosen = subcommands.find(option => option.name === subcommandName);
    if (!chosen) return undefined;
    return [`/${name}`, chosen.name, ...(argument ? [argument] : []), ...(name === 'skills' && scope ? [scope] : [])].join(' ');
  }
  return definition.options ? (argument ? `/${name} ${argument}` : undefined) : `/${name}`;
}

/** The mode and tier /prompt asks for; either is left out when not chosen or not recognised. */
export interface PromptSetup { mode?: Mode; tier?: TierPreference }

export function promptSetup(mode?: string | null, reasoning?: string | null): PromptSetup {
  return {
    ...(modes.includes(mode as Mode) ? { mode: mode as Mode } : {}),
    ...(promptEfforts.includes(reasoning as ReasoningLevel) ? { tier: reasoningTier[reasoning as ReasoningLevel] } : {}),
  };
}

/** The session commands that apply `setup` to a conversation that is already running. */
export const setupCommands = (setup: PromptSetup): string[] =>
  [...(setup.mode ? [`/mode ${setup.mode}`] : []), ...(setup.tier ? [`/tier ${setup.tier}`] : [])];
