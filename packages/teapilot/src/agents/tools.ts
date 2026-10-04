import { readFileSync, type Dirent } from 'node:fs';
import { access, glob, open, readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import {
  createBashTool, createEditTool, createEditToolDefinition, createFindTool, createGrepTool, createLsTool,
  createReadTool, createWriteTool, createWriteToolDefinition, type FindOperations, type LsOperations,
} from '@earendil-works/pi-coding-agent';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { sniffImage } from '../discord/images.js';
import { cleanChildEnvironment, protectedPart, within, type ExecutionPolicy } from '../execution/policy.js';
import { IMAGE_MAX_BYTES, IMAGE_SIDE } from '../inference/context.js';
import { gitBash } from '../execution/shell.js';
import { ensureRipgrep } from '../workspace/toolchain.js';
import { fingerprint, RequestRecovery, type ToolOutcome } from './recovery.js';

// The small execution context cannot afford a whole-file read; default to a window the model can page through with offset.
export const DEFAULT_READ_LINES = 200;
export function boundedRead(tool: AgentTool): AgentTool {
  return { ...tool, execute: (id, args, ...rest) => tool.execute(id, { limit: DEFAULT_READ_LINES, ...(args as object) } as typeof args, ...rest) };
}

/**
 * Folders no listing descends into unless asked for by path: dependencies, version control, and what a workspace's
 * commands keep for themselves (packages, caches, temporary files).
 */
const skipped = new Set(['node_modules', '.git', '__pycache__', '.packages', '.cache', '.tmp', '.appdata']);
/** A walk stops here, so a listing of a huge tree still answers. */
const walkLimits = { entries: 20_000, ms: 5000 };

/** .gitignore rules from `top` down to each path, read as the walk reaches each folder. */
class GitIgnores {
  private readonly rules = new Map<string, Ignore | null>();
  constructor(private readonly top: string) {}
  private at(folder: string): Ignore | null {
    let found = this.rules.get(folder);
    if (found === undefined) {
      try { found = ignore().add(readFileSync(join(folder, '.gitignore'), 'utf8')); } catch { found = null; }
      this.rules.set(folder, found);
    }
    return found;
  }
  ignored(path: string, directory: boolean): boolean {
    const rel = relative(this.top, path);
    if (!rel || !within(this.top, path)) return false;
    const parts = rel.split(sep);
    let folder = this.top, ignored = false;
    for (let index = 0; index < parts.length; index++) {
      const rules = this.at(folder);
      if (rules) {
        const result = rules.test(parts.slice(index).join('/') + (directory ? '/' : ''));
        if (result.ignored) ignored = true;
        else if (result.unignored) ignored = false;
      }
      folder = join(folder, parts[index]!);
    }
    return ignored;
  }
}

/** .gitignore rules for a walk from `cwd`: from the root when it is in the repository, else from where it starts. */
const ignoresFor = (policy: ExecutionPolicy, cwd: string) => new GitIgnores(within(policy.root, cwd, true) ? policy.root : cwd);

/**
 * Paths under `cwd` matching `pattern`, as pi's find gives them: a pattern without a slash matches names at any
 * depth, as fd does. .gitignore'd, skipped, protected and linked paths are left out. Node's own glob, so no fd.
 */
async function walk(policy: ExecutionPolicy, cwd: string, pattern: string, limit: number): Promise<{ paths: string[]; complete: boolean }> {
  const rules = ignoresFor(policy, cwd);
  const deadline = Date.now() + walkLimits.ms;
  let visited = 0, complete = true;
  const exclude = (entry: Dirent) => {
    if (++visited > walkLimits.entries || Date.now() > deadline) { complete = false; return true; }
    if (skipped.has(entry.name) || protectedPart(entry.name) || entry.isSymbolicLink()) return true;
    return rules.ignored(join(entry.parentPath, entry.name), entry.isDirectory());
  };
  const paths: string[] = [];
  for await (const entry of glob(pattern.includes('/') ? pattern : `**/${pattern}`, { cwd, exclude, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    if (!await policy.listable(path)) continue;
    paths.push(path);
    if (paths.length >= limit) { complete = false; break; }
  }
  return { paths, complete };
}

const lsOperations = (policy: ExecutionPolicy): LsOperations => ({
  exists: path => access(path).then(() => true, () => false),
  stat: path => stat(path),
  // Protected and linked entries are left out, as they are from every other tool.
  readdir: async path => {
    const kept: string[] = [];
    for (const name of await readdir(path)) if (await policy.listable(join(path, name))) kept.push(name);
    return kept;
  },
});

const findOperations = (policy: ExecutionPolicy): FindOperations => ({
  exists: path => access(path).then(() => true, () => false),
  glob: async (pattern, cwd, { limit }) => (await walk(policy, cwd, pattern, limit)).paths,
});

/**
 * pi's grep runs rg with --hidden, which finds what no other tool shows: result lines from protected or linked files
 * are dropped, and from .gitignore'd ones, which rg only skips inside a git repository. rg itself is the system's,
 * or teapilot's pinned copy (workspace/toolchain.ts).
 */
function guardedGrep(policy: ExecutionPolicy, stateDir: string): AgentTool {
  const tool = createGrepTool(policy.root);
  return { ...tool, execute: async (id, params, signal, update) => {
    try { await ensureRipgrep(stateDir); }
    catch (error) { throw new Error(`grep is unavailable here: ripgrep could not be installed (${error instanceof Error ? error.message : String(error)}). Use find and read instead.`); }
    const result = await tool.execute(id, params as never, signal, update);
    // The policy has made the path absolute by now; a single file was checked like any read.
    const searched = String((params as { path?: unknown }).path ?? policy.root);
    if (!(await stat(searched).catch(() => undefined))?.isDirectory()) return result;
    const rules = ignoresFor(policy, searched);
    const allowed = new Map<string, Promise<boolean>>();
    const shown = async (line: string) => {
      const match = /^(.+?)([:-])(\d+)\2 /.exec(line);
      if (!match) return true;
      const file = resolve(searched, match[1]!);
      if (!allowed.has(file)) allowed.set(file, rules.ignored(file, false) || relative(searched, file).split(sep).some(part => skipped.has(part)) ? Promise.resolve(false) : policy.listable(file));
      return allowed.get(file)!;
    };
    let hidden = false;
    const content = await Promise.all(result.content.map(async part => {
      if (part.type !== 'text') return part;
      const lines: string[] = [];
      for (const line of part.text.split('\n')) if (await shown(line)) lines.push(line); else hidden = true;
      return { ...part, text: lines.join('\n').trim() || 'No matches found' };
    }));
    return hidden ? { ...result, content } : result;
  } };
}

/**
 * The shell on the host: the repository's own, where each command asks for approval (execution/policy.ts). It is bash
 * everywhere, Git Bash on Windows; without it there is no shell, and the instructions say so.
 */
function hostShell(root: string): AgentTool | undefined {
  if (!gitBash()) return undefined;
  return createBashTool(root, { exposeSessionEnvironment: false, spawnHook: context => ({ ...context, env: cleanChildEnvironment() }) });
}

/** read, for a model that can see: a picture comes back as one, at the size a model is sent (inference/context.ts). */
function seeingRead(root: string): AgentTool {
  const detectImageMimeType = async (path: string) => {
    const file = await open(path, 'r');
    try {
      const head = Buffer.alloc(12);
      const { bytesRead } = await file.read(head, 0, 12, 0);
      return sniffImage(head.subarray(0, bytesRead)) ?? null;
    } finally { await file.close(); }
  };
  return boundedRead(createReadTool(root, { operations: { readFile, access, detectImageMimeType }, resizeOptions: { maxWidth: IMAGE_SIDE, maxHeight: IMAGE_SIDE, maxBytes: IMAGE_MAX_BYTES } }));
}

export interface SessionToolOptions {
  /** Whether the model can see pictures, so that read shows them rather than their bytes. */
  vision?: boolean;
  /** The session's shell: on the host, the sandboxed one of a workspace root (agents/workspace.ts), or none. */
  shell?: 'host' | AgentTool;
  /** Where teapilot keeps its own tools, such as the pinned rg. */
  stateDir: string;
  /** Hears of each write or edit in the conversation's workspace, so its list of files keeps up. */
  changed?: () => Promise<unknown>;
  /** Holds the workspace mutation lease through the file write and its index reconciliation. */
  beginMutation?: () => () => void;
  recovery?: RequestRecovery;
}

/** Inside the policy boundary: inspect only a validated mutation target, never arbitrary model paths. */
export function guardedMutation(tool: AgentTool, recovery: RequestRecovery): AgentTool {
  if (!['edit', 'write'].includes(tool.name)) return tool;
  return { ...tool, execute: async (id, params, ...rest) => {
    const args = params as { path: string; content?: string; oldText?: string; newText?: string; edits?: Array<{ oldText: string; newText: string }> };
    const outcome = (message: string, code: ToolOutcome['code'], failed = false) => ({ content: [{ type: 'text' as const, text: message }], details: { outcome: { code, changed: false, failed } } });
    const edits = args.edits ?? (typeof args.oldText === 'string' && typeof args.newText === 'string' ? [{ oldText: args.oldText, newText: args.newText }] : []);
    const lf = (text: string) => text.replace(/\r\n/g, '\n');
    if (tool.name === 'edit' && edits.length && edits.every(edit => typeof edit.oldText === 'string' && typeof edit.newText === 'string' && lf(edit.oldText) === lf(edit.newText)))
      return outcome('no change: oldText and newText are identical. nothing was written. do not repeat this replacement; provide different replacement text, or continue if no change is needed.', 'no_change');
    const current = await readFile(args.path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (tool.name === 'write' && current !== undefined && typeof args.content === 'string' && current.equals(Buffer.from(args.content)))
      return outcome('no change: the file already contains this exact content. nothing was written. do not repeat this write; continue or make a different change.', 'no_change');
    const key = fingerprint([tool.name, args, current === undefined ? null : fingerprint(current.toString('base64'))]);
    const previous = recovery.fileFailures.get(key);
    if (previous) return outcome(`repeat refused: this exact edit already failed and the file is unchanged. ${previous} change the replacement or inspect the relevant lines; do not retry unchanged.`, 'repeat_refused', true);
    try {
      return await tool.execute(id, params, ...rest);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/No changes made .*identical content/i.test(message)) {
        return outcome('no change: the replacement produced identical content. nothing was written. provide a replacement that changes the file; do not repeat this edit.', 'no_change');
      }
      if (/Could not find the exact text|Found \d+ occurrences|oldText.*unique|multiple matches/i.test(message)) {
        const advice = /Could not find/.test(message) ? 'the replacement target was not found. read the current lines and use their exact text.'
          : 'the replacement target is ambiguous. include enough surrounding text to make it unique.';
        recovery.fileFailures.set(key, advice);
        return outcome(advice, 'invalid_edit', true);
      }
      throw error;
    }
  } };
}

/**
 * Every tool-using session's file and command tools, from pi's own factories: read, write, edit, ls, find, grep, and
 * bash. They share one root, the repository or else the conversation's workspace (or scratchpad), so a
 * file name means the same file to all of them. Each is wrapped by the policy, which checks paths, permissions and
 * approvals; teapilot keeps only that, and how much output reaches the model (agents/scratchpad.ts).
 */
export function sessionTools(policy: ExecutionPolicy, options: SessionToolOptions): AgentTool[] {
  const root = policy.root;
  const { changed } = options;
  const recovery = options.recovery ?? new RequestRecovery();
  const noticed = (tool: AgentTool): AgentTool => ['write', 'edit'].includes(tool.name) && (changed || options.beginMutation) ? { ...tool, execute: async (id, params, ...rest) => {
    const release = options.beginMutation?.();
    try {
      const result = await tool.execute(id, params, ...rest);
      // The policy has made the path absolute by now.
      const path = String((params as { path?: unknown }).path ?? '');
      if (changed && (result.details as { outcome?: ToolOutcome })?.outcome?.changed !== false && policy.owns(path) && !policy.inScratch(path)) await changed().catch(() => undefined);
      return result;
    } finally { release?.(); }
  } } : tool;
  const shell = options.shell === 'host' ? hostShell(root) : options.shell;
  return [
    options.vision ? seeingRead(root) : boundedRead(createReadTool(root, { operations: { readFile, access, detectImageMimeType: async () => null } })),
    createWriteTool(root), createEditTool(root),
    createLsTool(root, { operations: lsOperations(policy) }),
    createFindTool(root, { operations: findOperations(policy) }),
    guardedGrep(policy, options.stateDir),
    ...shell ? [shell] : [],
  ].map(tool => noticed(policy.wrap(guardedMutation(tool, recovery))));
}

/**
 * pi's own guidance for writing and editing files, as its coding agent gives it: one line each. Every line is paid
 * for on every call, so those that repeat what the model already has are left out: read's (use it instead of cat)
 * is in the instructions, and edit's on exact and original-file matching are in the descriptions of its parameters.
 */
export function toolGuidelines(): string {
  return [...[createWriteToolDefinition('.'), createEditToolDefinition('.')].flatMap(definition => definition.promptGuidelines ?? [])
    .filter(line => !/must match exactly|matched against the original file/.test(line)).map(line => `- ${line}`),
    '- check tool/runtime limits before planning; never repeat unchanged no-op or failed calls.'].join('\n');
}

/**
 * The root at the start of a code session: its entries, with a file count for each folder, so a root of many
 * projects shows all of them rather than the inside of the first.
 */
export async function inventory(policy: ExecutionPolicy, limit = 40): Promise<string> {
  const root = policy.root;
  const rules = new GitIgnores(root);
  const entries: string[] = [];
  const names = (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  let more = 0;
  for (const entry of names) {
    const path = join(root, entry.name);
    if (skipped.has(entry.name) || rules.ignored(path, entry.isDirectory()) || !await policy.listable(path)) continue;
    if (entries.length >= limit) { more++; continue; }
    if (!entry.isDirectory()) { entries.push(entry.name); continue; }
    const { paths, complete } = await walk(policy, path, '**/*', 5000);
    const files = (await Promise.all(paths.map(file => stat(file).then(info => info.isFile(), () => false)))).filter(Boolean).length;
    entries.push(`${entry.name}/ (${files ? `${files}${complete ? '' : '+'} file${files === 1 && complete ? '' : 's'}` : 'empty'})`);
  }
  if (!entries.length) return '(empty directory)';
  return `${entries.join('\n')}${more ? `\n[and ${more} more; ls shows them all]` : ''}`;
}
