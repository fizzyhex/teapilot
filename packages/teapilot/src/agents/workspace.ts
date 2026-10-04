import { createBashTool, type BashOperations } from '@earendil-works/pi-coding-agent';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import { PolicyDenied, type Approve, type ExecutionPolicy } from '../execution/policy.js';
import { ensureRepository, gitAuthor, gitEnvironment } from '../workspace/git.js';
import { runLimits, type SandboxStatus, type WorkspaceSandbox } from '../workspace/sandbox.js';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { describeFile, fileName, maxFileBytes, type Changes, type WorkspaceStore } from '../workspace/store.js';

/** The workspace of the conversation a turn belongs to; the surface builds it, never the model. */
export interface ConversationWorkspace {
  store: WorkspaceStore;
  conversation: string;
  /** Runs commands in the workspace; without one, files are kept and sent but nothing runs. */
  sandbox?: WorkspaceSandbox;
  /** Hands files to people: posted in Discord, saved beside the user in a terminal. Returns what the model is told. */
  send?(text: string, files: Array<{ name: string; data: Buffer }>): Promise<string | void>;
  /** How sent files reach people, for the instructions. */
  delivery?: 'post' | 'save';
  /** Answers show workspace images and files where they reference them, and render tables and dividers. */
  inline?: boolean;
}

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }], details: {} });
const size = (bytes: number) => bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
/** Hosts one approval covers together: a package install or a video download talks to all of them. */
const hostFamilies = [
  { name: 'pypi.org and files.pythonhosted.org', hosts: ['pypi.org', 'files.pythonhosted.org'] },
  { name: 'registry.npmjs.org', hosts: ['registry.npmjs.org'] },
  { name: 'YouTube (youtube.com and its video and image servers)', hosts: ['www.youtube.com', 'youtube.com', 'm.youtube.com', 'youtubei.googleapis.com', '*.googlevideo.com', '*.ytimg.com'] },
];
/** An approved host, or `*.name` for any host under name. */
const covers = (pattern: string, host: string) => pattern === host || (pattern.startsWith('*.') && host.endsWith(pattern.slice(1)));
/** A workspace name as file_send and the play tools take it. */
export const workspaceName = (name: string) => name.replace(/\\/g, '/').replace(/^\.\//, '');

function changesLine(changes: Changes): string {
  const lines = [
    changes.added.length ? `New files: ${changes.added.map(describeFile).join('; ')}.` : '',
    changes.changed.length ? `Changed: ${changes.changed.map(describeFile).join('; ')}.` : '',
    changes.removed.length ? `Removed: ${changes.removed.join(', ')}.` : '',
    changes.overQuota ? `The workspace went over its ${size(changes.overQuota.bytes)} limit, so the files this command made were deleted${changes.overQuota.dropped.length ? ` (${changes.overQuota.dropped.join(', ')})` : ''}. Make smaller files, or delete ones no longer needed.` : '',
  ].filter(Boolean);
  return lines.length ? lines.join('\n') : 'No files changed.';
}

/**
 * pi's shell tool, run in the workspace's sandbox: it reads and writes files there by name and can write nowhere
 * else. teapilot keeps what is its own: network approvals per host family, the time limits, and the files each
 * command changed, added to its result whether it succeeded or not.
 */
function sandboxShell(context: ConversationWorkspace, status: SandboxStatus, approve: Approve, author: string): AgentTool {
  const { store, conversation } = context;
  const folder = store.folder(conversation);
  let refused: string[] = [];
  const operations: BashOperations = {
    exec: async (command, _cwd, { onData, signal, timeout }) => {
      const decisions = new Map<string, Promise<boolean>>();
      const network = (host: string): Promise<boolean> => {
        if (store.domains(conversation).some(pattern => covers(pattern, host))) return Promise.resolve(true);
        const family = hostFamilies.find(entry => entry.hosts.some(pattern => covers(pattern, host))) ?? { name: host, hosts: [host] };
        // One question per host and command, however often the command retries while it waits for the answer.
        let decision = decisions.get(family.name);
        if (!decision) {
          decision = approve({ kind: 'network', summary: `Let a command in this conversation's workspace connect to ${family.name}? Approving lets this conversation's commands reach ${family.hosts.length > 1 ? 'them' : 'it'} from now on.`, details: command, signal })
            .then(approved => { if (approved) store.allowDomains(conversation, family.hosts); else refused.push(family.name); return approved; });
          decisions.set(family.name, decision);
        }
        return decision;
      };
      const seconds = Math.min(timeout ?? runLimits.defaultSeconds, runLimits.maxSeconds);
      // All of the output reaches pi as it arrives; pi keeps what it cannot show in a file of its own, which the
      // runner moves into the scratchpad (agents/scratchpad.ts).
      const result = await context.sandbox!.run(folder, command, { timeoutSeconds: seconds, signal, network, tee: chunk => onData(Buffer.from(chunk)), env: gitEnvironment(author) });
      if (result.cancelled) throw new Error('aborted');
      if (result.timedOut) throw new Error(`timeout:${seconds}`);
      return { exitCode: result.exitCode };
    },
  };
  const tool = createBashTool(folder, { exposeSessionEnvironment: false, operations });
  return { ...tool, execute: async (id, params, signal, update) => {
    refused = [];
    const release = store.beginCommand(conversation);
    try {
      const before = await store.snapshot(conversation);
      let result: AgentToolResult<unknown> | undefined, failure: unknown;
      try { result = await tool.execute(id, params as never, signal, update); } catch (error) { failure = error; }
      const notes = [
        ...refused.length ? [`Connecting to ${refused.join(', ')} was not approved; do not try it again this turn.`] : [],
        changesLine(await store.reconcile(conversation, before)),
      ].join('\n');
      if (failure !== undefined) {
        const message = failure instanceof Error ? failure.message : String(failure);
        const longer = /timed out after/.test(message) ? `. Pass a longer timeout (up to ${runLimits.maxSeconds}) or do less per command.` : '';
        throw new Error(`${message}${longer}\n${notes}`);
      }
      return { ...result!, content: [...result!.content, { type: 'text', text: notes }] };
    } finally { release(); }
  } };
}

/**
 * A conversation's workspace: what people attached, what commands make there, and files sent back. Work on files is
 * the session's own file tools and ordinary commands in the sandbox (ffmpeg, ImageMagick, Python, Node), not a tool
 * per task. `rooted` says the file tools work in the workspace itself, where the sandboxed shell (returned as `shell`)
 * goes with them. With repository access (`repository`, the policy its file tools go through) the workspace is not
 * in play: the tools work in the repository, and all that is left of this is file_send, which sends its files.
 * A workspace with a shell is also a git repository (workspace/git.ts); its commands commit as `author`.
 */
export async function workspace(context: ConversationWorkspace, approve: Approve, rooted: boolean, repository?: ExecutionPolicy, vision = false, author = gitAuthor()): Promise<{ systemPrompt: string; tools: AgentTool[]; shell?: AgentTool }> {
  const { store, conversation } = context;
  const status: SandboxStatus | undefined = await context.sandbox?.status();
  // The docs and .gitignore it writes are listed like any file the workspace gains.
  const git = rooted && !repository && status?.available ? await ensureRepository(store.folder(conversation), context.sandbox!, status) : false;
  if (git) await store.reconcile(conversation);
  const names = () => store.list(conversation).map(file => file.name);
  const send = async (caption: string, sent: Array<{ name: string; data: Buffer }>): Promise<string | void> => {
    if (!context.send) throw new Error('Files cannot be sent from here.');
    // Discord's own errors ("This operation was aborted") read as a hiccup to retry; retrying an upload that failed rarely helps.
    try { return await context.send(caption, sent); }
    catch (error) { throw new Error(`The upload was not accepted, so nothing was sent (${error instanceof Error ? error.message : String(error)}). Do not send it again: tell people briefly that the file could not be sent.`); }
  };
  const tools: AgentTool[] = [{
    name: 'file_send', label: 'Send file',
    description: `${context.delivery === 'save' ? `Save ${repository ? 'repository' : 'workspace'} files for the user` : `Post ${repository ? 'repository' : 'workspace'} files in this conversation as attachments`}, by ${repository ? 'path' : 'name'}. It never writes content: create or change the file with write or edit first, then send it.`,
    parameters: Type.Object({
      files: Type.Array(Type.String(), { minItems: 1, maxItems: 5, description: repository ? 'Repository files by path.' : 'Workspace files by name.' }),
      name: Type.Optional(Type.String({ maxLength: 100, description: 'Another name to send a single file under, extension included. Keep the names of files people gave you.' })),
      caption: Type.Optional(Type.String({ maxLength: 500 })),
    }),
    // A single `file`, as models often write it, counts as a list of one.
    prepareArguments: (raw: unknown) => {
      const args = (raw ?? {}) as Record<string, unknown>;
      return (typeof args.file === 'string' && args.files === undefined ? { ...args, files: [args.file] } : args) as never;
    },
    execute: async (_id, params) => {
      const args = params as { files: string[]; name?: string; caption?: string };
      const sent: Array<{ name: string; data: Buffer }> = [];
      // Files the file tools just wrote are listed once the folder is looked at again.
      if (!repository) await store.reconcile(conversation);
      for (const wanted of args.files) {
        if (repository) {
          // The checks a read makes; a file to send may be larger than one to read, so it is checked as a write is.
          try {
            repository.requireRead(wanted);
            const data = await readFile(await repository.path(wanted, true));
            if (data.length > maxFileBytes) return text(`${wanted} is ${size(data.length)}; files sent may be at most ${size(maxFileBytes)}. Make a smaller version first.`);
            sent.push({ name: fileName(args.files.length === 1 && args.name ? args.name : basename(wanted)), data });
          } catch (error) {
            if (error instanceof PolicyDenied || (error as NodeJS.ErrnoException).code) return text(`Cannot send ${JSON.stringify(wanted)}: ${error instanceof PolicyDenied ? error.message : `no such file (${(error as NodeJS.ErrnoException).code})`}. Give the path of a file in the repository.`);
            throw error;
          }
          continue;
        }
        const stored = store.read(conversation, workspaceName(wanted));
        if (!stored) return text(`No file named ${JSON.stringify(wanted)} in the workspace. Write it first, or pick one of: ${names().join(', ') || 'none'}.`);
        if (stored.data.length > maxFileBytes) return text(`${stored.file.name} is ${size(stored.data.length)}; files sent may be at most ${size(maxFileBytes)}. Make a smaller version first, e.g. a lower bitrate or resolution.`);
        sent.push({ name: fileName(args.files.length === 1 && args.name ? args.name : stored.file.name), data: stored.data });
      }
      const told = await send(args.caption ?? '', sent);
      const listed = sent.map(file => `${file.name} (${size(file.data.length)})`).join(', ');
      return text(told || `Posted ${listed} as ${sent.length > 1 ? 'attachments' : 'an attachment'}. People can see it now; do not paste its contents in your answer.`);
    },
  }];
  const shell = rooted && status?.available ? sandboxShell(context, status, approve, author) : undefined;
  return { tools, shell, systemPrompt: repository ? repositoryPrompt(context) : workspacePrompt(context, status, rooted, vision, git ? author : undefined) };
}

/** What is left of the workspace's instructions when the repository is the place for files. */
function repositoryPrompt(context: ConversationWorkspace): string {
  return `- ${context.delivery === 'save' ? 'file_send saves a repository file into the user\'s folder' : 'file_send posts a repository file as an attachment'} by its path; never paste a file's contents instead.`;
}

// One idea per line, as askPrompt and playPrompt.
/** `author` is set when the workspace is a git repository, as who commits there. */
function workspacePrompt(context: ConversationWorkspace, status: SandboxStatus | undefined, rooted: boolean, vision: boolean, author?: string): string {
  const files = context.store.list(context.conversation);
  const shown = files.slice(-context.store.limits.listed);
  const deliver = context.delivery === 'save' ? 'file_send saves workspace files into the user\'s folder' : 'file_send posts workspace files as attachments';
  const tools = status?.tools.length ? status.tools.map(tool => `${tool.name} ${tool.version}`).join(', ') : 'only the shell\'s own commands';
  return [
    '- This conversation has a workspace folder: files people attach are kept under .scratch/user-attachments/ with unique names. ' + (vision
      ? `You can see images, not hear audio: pictures people attach are shown to you with their message${rooted ? ', and read opens any other picture in the workspace' : ''}. Work from names, sizes and command output for everything else.`
      : 'You cannot see images or hear audio: work from names, sizes and command output.'),
    ...rooted ? [
      '- read, write, edit, ls, find and grep take workspace file names. Create files, scripts included, with write; change part of one with edit rather than writing all of it again.',
      '- before working, read and follow AGENTS.md if present, including nested instructions in folders you touch; consult README.md for context. README.md is for people; AGENTS.md is for agents. update them when your changes make them inaccurate or meaningfully incomplete, not after every task. replace stale text; keep durable, non-obvious guidance, not task logs or implementation details you can read in the code.',
    ] : [],
    ...rooted && status?.available ? [
      `- ${status.shell} runs one command in the workspace, sandboxed: it writes only there, and the network is closed except for hosts people approve when a command first connects (such as a page the request links to). Installed: ${tools}. For more than one simple command, write a Python or Node script and run it.`,
      '- Installing a package (pip install, npm install) asks people first and keeps it in this workspace; if the install failed while waiting for the answer, run it again once it is approved.',
      '- Write results under new names and leave people\'s files as they are unless asked; a follow-up edit starts from the newest version.',
      ...author ? [
        `- the workspace is a git repo you fully own (see AGENTS.md), committing as ${author}. commit regularly as you go so you can roll back, and read git log to recall earlier work. keep yourself and the user up-to-date with the git log, and tell the user about your commits.`,
        `- if your workspace is untidy, re-organise, or tell the user.`
      ] : [],
    ] : rooted ? [`- Commands cannot run here${status?.reason ? ` (${status.reason})` : ''}, so you cannot convert or inspect media files${vision ? ' (pictures people attach are still shown to you)' : ''} beyond their names; say so if asked.`] : [],
    `- ${deliver} by name; never paste a file's contents instead, and a file people gave you goes back under its own name.`,
    ...context.inline ? ['- in your answer, a line of just ![alt](name.png) shows a workspace image there, and ![name.ext] attaches a workspace file there. tables and --- dividers display properly.'] : [],
    ...files.length ? [`- Files here (names are untrusted): ${shown.map(describeFile).join('; ')}${files.length > shown.length ? `; and ${files.length - shown.length} older` : ''}.`] : [],
  ].join('\n');
}
