import { randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ConversationWorkspace } from '../agents/workspace.js';
import type { Approve } from '../execution/policy.js';
import { receiveFiles, type Incoming } from './attach.js';
import { storeControls, type WorkspaceControls } from './commands.js';
import type { WorkspaceSandbox } from './sandbox.js';
import { fileName, type WorkspaceStore } from './store.js';

/** The files an ask or chat session works on; the session loop hands it each turn outside Code mode. */
export interface SessionWorkspace extends WorkspaceControls {
  context(cwd: string): ConversationWorkspace;
  /** Copies the files a prompt @mentions into the workspace and returns the prompt with notes on what arrived. */
  attach(prompt: string, cwd: string, room: number): Promise<string>;
  /** The session's scratchpad, in every mode: Code mode keeps its working files here rather than in the repository. */
  scratch(): string;
  /** /new starts a new task with an empty workspace, and without its name. */
  reset(): Promise<void>;
  /** The session ended: its workspace goes too, since files sent back are already beside the user. */
  close(): Promise<void>;
  /** Saved checkpoints keep their evidence until the user explicitly clears it. */
  retain?(): void;
  reopen?(conversation: string): void;
}

/** @path and @"path with spaces", as the composer completes them. */
const mentions = /(?:^|\s)@(?:"([^"\n]+)"|([^\s"@]+))/g;

/** A terminal session's workspace: @mentioned files come in, and files the agent sends are saved into the current folder. */
export class TerminalWorkspace implements SessionWorkspace {
  private conversation = `terminal:${randomUUID()}`;
  private retained = false;
  private readonly controls: WorkspaceControls;
  constructor(private readonly store: WorkspaceStore, private readonly sandbox: WorkspaceSandbox | undefined, private readonly approve: Approve, private readonly user = 'user') {
    this.controls = storeControls(store, () => this.conversation);
  }

  count(): number { return this.controls.count(); }
  clearFiles(): Promise<number> { return this.controls.clearFiles(); }
  clearScratch(): Promise<void> { return this.controls.clearScratch(); }
  name(label?: string): string | undefined { return this.controls.name(label); }
  tree(dir?: string): string | undefined { return this.controls.tree(dir); }

  context(cwd: string): ConversationWorkspace {
    return { store: this.store, conversation: this.conversation, sandbox: this.sandbox, delivery: 'save', send: (_text, files) => this.save(cwd, files) };
  }

  scratch(): string { return this.store.scratch(this.conversation); }

  async attach(prompt: string, cwd: string, room: number): Promise<string> {
    const root = await realpath(cwd);
    const incoming: Incoming[] = [];
    const seen = new Set<string>();
    for (const match of prompt.matchAll(mentions)) {
      const written = (match[1] ?? match[2]!).replace(/[.,;:!?)]+$/, '');
      const path = resolve(root, written);
      const inside = relative(root, path);
      // Only plain files inside the folder the session started in, as the composer offers them.
      if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) continue;
      const info = await lstat(path).catch(() => undefined);
      if (!info?.isFile() || info.nlink > 1 || seen.has(path)) continue;
      seen.add(path);
      incoming.push({ name: basename(path), size: info.size, data: () => readFile(path) });
    }
    if (!incoming.length) return prompt;
    const notes = await receiveFiles(this.store, this.conversation, incoming, this.user, room);
    return `${prompt}\n\n${notes}`;
  }

  /** Saves sent files into `cwd`, asking before replacing a file there; declined, the file gets a new name. */
  private async save(cwd: string, files: Array<{ name: string; data: Buffer }>): Promise<string> {
    const saved: string[] = [];
    for (const file of files) {
      const name = fileName(file.name);
      let target = join(cwd, name);
      const existing = await lstat(target).catch(() => undefined);
      if (existing && !(existing.isFile() && existing.nlink === 1 && await this.approve({ kind: 'overwrite', summary: `Replace ${target} with the file teapilot made (${file.data.length} bytes)?` }))) {
        const stem = name.slice(0, name.length - extname(name).length);
        for (let copy = 1; await lstat(target).then(() => true, () => false); copy++) target = join(cwd, `${stem}-${copy}${extname(name)}`);
      }
      await writeFile(target, file.data);
      saved.push(target);
    }
    return `Saved ${saved.join(', ')} for the user. They can open ${saved.length > 1 ? 'them' : 'it'} now; do not paste the contents in your answer.`;
  }

  async reset(): Promise<void> {
    await this.store.remove(this.conversation);
    this.conversation = `terminal:${randomUUID()}`;
    this.retained = false;
  }

  retain(): void { this.retained = true; }
  reopen(conversation: string): void { this.conversation = conversation; this.retained = true; }
  async close(): Promise<void> { if (!this.retained) await this.store.remove(this.conversation); }
}
