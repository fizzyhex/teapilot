import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, opendirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { cp, lstat, readdir, rm } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { z } from 'zod';
import { imageInfo } from '../discord/images.js';
import { replaceFileSync } from '../replace.js';
import { TaskStore } from './task.js';

/** Discord's upload limit for bots in servers without boosts; files people send and teapilot posts stay within it. */
export const maxFileBytes = 10 * 1024 * 1024;
export const fileLimits = { perMessage: 5, workspaceBytes: 500 * 1024 * 1024, listed: 40, walked: 20_000 };
export const editorMaxBytes = 1024 * 1024;

const entrySchema = z.object({
  name: z.string(), size: z.number(), type: z.string(), width: z.number().optional(), height: z.number().optional(),
  /** Who shared it: a person's name, or teapilot for what it made. */
  from: z.string(), at: z.number(),
  /** When the bytes last changed, so a file rewritten in place is noticed. */
  mtimeMs: z.number().optional(),
});
export type StoredFile = z.infer<typeof entrySchema>;
/** `name` is the label people give the workspace with /workspace name. */
const indexSchema = z.object({ files: z.array(entrySchema), domains: z.array(z.string()).default([]), name: z.string().optional() });
type Index = z.infer<typeof indexSchema>;

/** A name safe on every filesystem and in attachment:// URLs, keeping its extension. */
export function fileName(name: string): string {
  const base = name.split(/[\\/]/).at(-1)!.replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').slice(-100);
  return base || 'file';
}

const textTypes = /^(text\/|application\/(json|javascript|typescript|xml|x-sh|x-python|toml|yaml))/;
const textExtensions = new Set(['.txt', '.md', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.py', '.lua', '.css', '.html', '.xml', '.yml', '.yaml', '.toml', '.csv', '.sh', '.ps1', '.c', '.h', '.cpp', '.cs', '.java', '.go', '.rs', '.rb', '.php', '.sql', '.ini', '.cfg', '.log', '.srt', '.vtt']);
/** Text a model can read: a known text type or extension, valid UTF-8 without NUL bytes. */
export function asText(name: string, data: Buffer, type?: string): string | undefined {
  if (!(type && textTypes.test(type)) && !textExtensions.has(extname(name).toLowerCase())) return undefined;
  const text = data.toString('utf8');
  return text.includes('\0') || text.includes('�') ? undefined : text;
}

const mediaTypes: Record<string, string> = {
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.opus': 'audio/opus', '.flac': 'audio/flac', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.gif': 'image/gif',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.csv': 'text/csv', '.json': 'application/json', '.txt': 'text/plain', '.md': 'text/markdown',
  '.py': 'text/x-python', '.js': 'text/javascript', '.html': 'text/html', '.svg': 'image/svg+xml',
};
const typeOf = (name: string) => mediaTypes[extname(name).toLowerCase()] ?? 'application/octet-stream';
const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

export { size as formatBytes };
const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

interface TreeFolder { folders: Map<string, TreeFolder>; files: { name: string; size: string }[] }
interface TreeRow { left: string; icon?: string; text: string; size?: string }
/** Files shown in each folder of /workspace tree before "… N more files". */
const treeFilesPerFolder = 3;
const emojis: Record<string, string> = {
  '🐍': 'py', '🖼️': 'png jpg jpeg gif webp bmp svg', '📝': 'md txt rst', '💬': 'srt vtt ass', '📜': 'js mjs cjs ts tsx jsx',
  '⚙️': 'json yaml yml toml xml ini', '📊': 'csv tsv xlsx xls', '📕': 'pdf', '📦': 'zip tar gz tgz 7z', '🎵': 'mp3 wav ogg flac m4a',
  '🎬': 'mp4 mov webm mkv avi', '🌐': 'html htm css', '🖥️': 'sh bash ps1 bat',
};
const fileEmoji = (name: string): string => {
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return Object.entries(emojis).find(([, list]) => list.split(' ').includes(extension))?.[0] ?? '📄';
};
/** One line per file, as the model sees it. */
export function describeFile(file: StoredFile): string {
  const kind = file.width ? `${file.type.replace('image/', '').toUpperCase()} image ${file.width}×${file.height}` : file.type;
  return `${file.name} (${kind}, ${size(file.size)}, from ${file.from})`;
}

/**
 * Packages, caches and temporary files a workspace's commands keep for themselves. They count toward its size but
 * are never listed or sent, so a `pip install` does not bury the files people care about.
 */
export function internal(name: string): boolean {
  return name.split('/').some((part, index) =>
    (part.startsWith('.') && !(index === 0 && (part === '.scratch' || name === '.gitignore')))
    || part === 'node_modules' || part === '__pycache__');
}

/** Every regular file under `directory` by relative path, never following links; stops after `limit` entries. */
async function walk(directory: string, limit = fileLimits.walked): Promise<Map<string, { size: number; mtimeMs: number }>> {
  const found = new Map<string, { size: number; mtimeMs: number }>();
  const visit = async (folder: string): Promise<void> => {
    let entries;
    try { entries = await readdir(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (found.size >= limit) return;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        try { const info = await lstat(path); found.set(relative(directory, path).split(sep).join('/'), { size: info.size, mtimeMs: info.mtimeMs }); } catch { /* removed meanwhile */ }
      }
    }
  };
  await visit(directory);
  return found;
}
export type Snapshot = Awaited<ReturnType<typeof walk>>;

const validWorkspacePath = (name: string) => typeof name === 'string' && name.length > 0 && name.length <= 200
  && !name.includes('\\') && !name.startsWith('/') && !name.split('/').some(part => !part || part === '.' || part === '..' || part.includes(':'));
function walkSync(directory: string, found = new Map<string, { size: number }>(), root = directory, limit = fileLimits.walked, entries = { count: 0 }): Map<string, { size: number }> {
  const folder = opendirSync(directory);
  try {
    let entry;
    while ((entry = folder.readSync()) !== null) {
      if (++entries.count > limit) throw new Error('workspace walk limit exceeded');
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walkSync(path, found, root, limit, entries);
      else if (entry.isFile()) { const info = lstatSync(path); if (info.isFile() && !info.isSymbolicLink()) found.set(relative(root, path), { size: info.size }); }
    }
  } finally { folder.closeSync(); }
  return found;
}
const validUnicode = (text: string) => !text.includes('\0') && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
/** Read at most max+1 bytes from a regular file, even if it grows between stat and read. */
function readCapped(path: string, max: number): Buffer {
  const expected = lstatSync(path);
  if (!expected.isFile() || expected.isSymbolicLink() || expected.nlink > 1) throw new Error('not a plain workspace file');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.dev !== expected.dev || info.ino !== expected.ino || info.nlink > 1 || info.size > max) throw new Error('file exceeds limit');
    const buffer = Buffer.alloc(max + 1);
    let offset = 0;
    while (offset < buffer.length) { const count = readSync(fd, buffer, offset, buffer.length - offset, offset); if (!count) break; offset += count; }
    if (offset > max) throw new Error('file exceeds limit');
    const after = lstatSync(path);
    if (!after.isFile() || after.isSymbolicLink() || after.nlink > 1 || after.dev !== info.dev || after.ino !== info.ino) throw new Error('workspace path changed during read');
    return buffer.subarray(0, offset);
  } finally { closeSync(fd); }
}

/** What a command changed in a workspace, as the model is told. */
export interface Changes { added: StoredFile[]; changed: StoredFile[]; removed: string[]; overQuota?: { bytes: number; dropped: string[] } }

/**
 * A folder per conversation where people's attachments land, sandboxed commands work, and what teapilot makes is
 * kept. Who shared each file lives in an index outside the folder, so code running in it cannot rewrite that. Files
 * outlive a conversation's history and a restart; a Discord conversation's apps show them with picture().
 */
export class WorkspaceStore {
  constructor(readonly directory: string, private readonly indexes: string, private readonly legacy?: string, readonly limits = fileLimits) {}
  static at(stateDir: string): WorkspaceStore {
    return new WorkspaceStore(join(stateDir, 'workspaces'), join(stateDir, 'workspace-index'), join(stateDir, 'discord-files'));
  }

  /** Pictures people attached since a request last took them, by conversation. Not kept across a restart. */
  private readonly arrived = new Map<string, string[]>();
  /** In-process command mutation lease. Editor reads/saves fail closed while a sandbox command is mutating files. */
  private readonly activeCommands = new Set<string>();
  beginCommand(conversation: string): () => void {
    return this.acquire([conversation], 'a workspace command is already running');
  }
  private acquire(conversations: string[], error = 'workspace is busy'): () => void {
    if (conversations.some(conversation => this.activeCommands.has(conversation))) throw new Error(error);
    for (const conversation of conversations) this.activeCommands.add(conversation);
    return () => { for (const conversation of conversations) this.activeCommands.delete(conversation); };
  }
  /** Notes that a picture just arrived, to be shown to the model with its next request. */
  arrive(conversation: string, name: string): void {
    this.arrived.set(conversation, [...(this.arrived.get(conversation) ?? []).filter(known => known !== name), name].slice(-this.limits.perMessage));
  }
  /** The pictures that arrived since the last call, which forgets them: one request shows them to the model. */
  takeImages(conversation: string): string[] {
    const names = this.arrived.get(conversation) ?? [];
    this.arrived.delete(conversation);
    return names;
  }

  private id(conversation: string): string { return createHash('sha256').update(conversation).digest('hex').slice(0, 24); }
  private indexPath(conversation: string): string { return join(this.indexes, `${this.id(conversation)}.json`); }

  /** The conversation's folder, created on first use; files from before workspaces move in once. */
  folder(conversation: string): string {
    const folder = join(this.directory, this.id(conversation));
    if (existsSync(folder)) return folder;
    mkdirSync(this.directory, { recursive: true });
    const old = this.legacy && join(this.legacy, this.id(conversation));
    if (old && existsSync(old)) {
      renameSync(old, folder);
      try {
        const files = z.array(entrySchema).parse(JSON.parse(readFileSync(join(folder, 'index.json'), 'utf8')));
        this.write(conversation, { files, domains: [] });
      } catch { /* an unreadable old index: its files are adopted by the next reconcile */ }
      rmSync(join(folder, 'index.json'), { force: true });
    } else mkdirSync(folder, { recursive: true });
    return folder;
  }

  private index(conversation: string): Index {
    try { return indexSchema.parse(JSON.parse(readFileSync(this.indexPath(conversation), 'utf8'))); }
    catch { return { files: [], domains: [] }; }
  }
  private write(conversation: string, index: Index): void {
    mkdirSync(this.indexes, { recursive: true });
    const file = this.indexPath(conversation);
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(index));
    replaceFileSync(temporary, file);
  }

  /**
   * The conversation's scratchpad (workspace/scratch.ts): a folder inside its workspace, so sandboxed commands
   * reach it as .scratch/ and people can browse its files. Not created here.
   */
  scratch(conversation: string): string { return join(this.directory, this.id(conversation), '.scratch'); }

  /** The files people and teapilot can refer to, oldest first; internal folders are left out. */
  list(conversation: string): StoredFile[] { this.folder(conversation); return this.index(conversation).files; }
  get(conversation: string, name: string): StoredFile | undefined {
    const files = this.list(conversation);
    const wanted = name.replace(/\\/g, '/').replace(/^\.\//, '');
    return files.find(file => file.name === wanted) ?? files.find(file => file.name.toLowerCase() === wanted.toLowerCase())
      ?? files.find(file => file.name.toLowerCase() === fileName(wanted).toLowerCase())
      // A bare name finds a file in a subfolder when only one has it.
      ?? (() => { const matches = files.filter(file => file.name.split('/').at(-1)!.toLowerCase() === fileName(wanted).toLowerCase()); return matches.length === 1 ? matches[0] : undefined; })();
  }

  /**
   * A file's bytes, read only when the path is a plain file inside the workspace. Sandboxed commands can plant
   * symbolic links, junctions and hard links; following one would hand them a file of the host.
   */
  read(conversation: string, name: string): { file: StoredFile; data: Buffer } | undefined {
    const file = this.get(conversation, name);
    if (!file) return undefined;
    const path = this.safePath(conversation, file.name);
    if (!path) return undefined;
    try { return { file, data: readFileSync(path) }; } catch { return undefined; }
  }

  /** Exact-path UTF-8 editing. Revision hashes the original bytes; saves never evict other workspace files. */
  readEditable(conversation: string, name: string): { file: StoredFile; content: string; revision: string } | undefined {
    if (this.activeCommands.has(conversation)) return undefined;
    if (!validWorkspacePath(name)) return undefined;
    const registered = this.list(conversation).find(file => file.name === name);
    const path = registered && this.safePath(conversation, name);
    if (!registered || !path) return undefined;
    try {
      const data = readCapped(path, editorMaxBytes);
      if (data.length > editorMaxBytes || data.includes(0)) return undefined;
      const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
      const withoutBom = content.startsWith('\uFEFF') ? content.slice(1) : content;
      return { file: registered, content: withoutBom, revision: createHash('sha256').update(data).digest('hex') };
    } catch { return undefined; }
  }

  /** Compare-and-swap exact-path save, atomic and quota-safe; editor changes do not alter ownership metadata. */
  saveEditable(conversation: string, name: string, content: string, revision: string, user: string): { file: StoredFile; content: string; revision: string } | 'conflict' | undefined {
    if (!validWorkspacePath(name) || !validUnicode(content) || Buffer.byteLength(content, 'utf8') > editorMaxBytes || this.activeCommands.has(conversation)) return undefined;
    const registered = this.list(conversation).find(file => file.name === name);
    const path = registered && this.safePath(conversation, name);
    if (!registered || !path) return undefined;
    try {
      const original = readCapped(path, editorMaxBytes);
      const currentRevision = createHash('sha256').update(original).digest('hex');
      if (currentRevision !== revision) return 'conflict';
      if (original.length > editorMaxBytes || original.includes(0)) return undefined;
      const originalText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(original);
      const bom = originalText.startsWith('\uFEFF');
      const oldBody = bom ? originalText.slice(1) : originalText;
      const eol = oldBody.includes('\r\n') ? '\r\n' : oldBody.includes('\r') ? '\r' : '\n';
      const body = content.replace(/\r\n|\r|\n/g, '\n').replace(/\n/g, eol);
      const output = Buffer.from(`${bom ? '\uFEFF' : ''}${body}`, 'utf8');
      if (output.length > editorMaxBytes) return undefined;
      let total: number;
      try { total = [...walkSync(this.folder(conversation), new Map(), this.folder(conversation), this.limits.walked).values()].reduce((sum, file) => sum + file.size, 0); } catch { return undefined; }
      if (total - original.length + output.length > this.limits.workspaceBytes) return undefined;
      const info = lstatSync(path), temporary = `${path}.${randomUUID()}.tmp`;
      if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) return undefined;
      try {
        writeFileSync(temporary, output, { mode: info.mode });
        try { chmodSync(temporary, info.mode); } catch { /* platform permissions */ }
        // Recheck the byte revision and inode identity immediately before replacing. This is an in-process CAS;
        // external processes are not serialized by this store.
        const currentInfo = lstatSync(path), current = readCapped(path, editorMaxBytes);
        if (!currentInfo.isFile() || currentInfo.isSymbolicLink() || currentInfo.nlink > 1 || currentInfo.dev !== info.dev || currentInfo.ino !== info.ino
          || createHash('sha256').update(current).digest('hex') !== revision) return 'conflict';
        if (this.activeCommands.has(conversation)) return undefined;
        replaceFileSync(temporary, path);
      } finally { try { unlinkSync(temporary); } catch { /* already replaced or cleanup unavailable */ } }
      const at = Date.now();
      const fresh = { ...registered, size: output.length, from: user, at, mtimeMs: statSync(path).mtimeMs };
      const index = this.index(conversation);
      index.files = index.files.map(file => file.name === name ? fresh : file);
      this.write(conversation, index);
      return { file: fresh, content: body, revision: createHash('sha256').update(output).digest('hex') };
    } catch { return undefined; }
  }
  /** The absolute path of a plain, unlinked file inside the workspace, or undefined. */
  safePath(conversation: string, name: string): string | undefined {
    const folder = this.folder(conversation);
    let current = folder;
    try {
      for (const part of name.split('/')) {
        if (!part || part === '.' || part === '..' || part.includes(':')) return undefined;
        current = join(current, part);
        const info = lstatSync(current);
        if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1)) return undefined;
      }
      const actual = relative(realpathSync(folder), realpathSync(current));
      if (!actual || actual === '..' || actual.startsWith(`..${sep}`) || isAbsolute(actual)) return undefined;
      return lstatSync(current).isFile() ? current : undefined;
    } catch { return undefined; }
  }

  /** Keeps `data` as `name`, replacing a file of that name; the oldest files go if the workspace outgrows its limit. */
  save(conversation: string, name: string, data: Buffer, from: string, type?: string): Promise<StoredFile> {
    return this.keep(conversation, fileName(name), data, from, type);
  }

  /** Keeps a user's attachment in the scratchpad under a new name, never replacing an existing entry. */
  async saveAttachment(conversation: string, name: string, data: Buffer, from: string, type?: string): Promise<StoredFile> {
    let directory = this.folder(conversation);
    for (const part of ['.scratch', 'user-attachments']) {
      directory = join(directory, part);
      const info = lstatSync(directory, { throwIfNoEntry: false });
      if (!info) mkdirSync(directory);
      else if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${part} is not a folder in the scratchpad.`);
    }
    const clean = fileName(name);
    const extension = extname(clean);
    const stem = clean.slice(0, clean.length - extension.length);
    const taken = new Set(readdirSync(directory).map(entry => entry.toLowerCase()));
    for (let copy = 0; ; copy++) {
      const candidate = copy ? `${stem}-${copy}${extension}` : clean;
      if (taken.has(candidate.toLowerCase())) continue;
      try { return await this.keep(conversation, `.scratch/user-attachments/${candidate}`, data, from, type, true); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        taken.add(candidate.toLowerCase());
      }
    }
  }

  /** As save, at a path with folders (apps/game.js), each part made safe; never through a link a command left. */
  async saveAt(conversation: string, path: string, data: Buffer, from: string): Promise<StoredFile> {
    const parts = path.split(/[\\/]/).filter(part => part && part !== '.' && part !== '..').map(fileName);
    let current = this.folder(conversation);
    for (const part of parts.slice(0, -1)) {
      current = join(current, part);
      const info = lstatSync(current, { throwIfNoEntry: false });
      if (!info) mkdirSync(current);
      else if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${part} is not a folder in the workspace.`);
    }
    return this.keep(conversation, parts.join('/') || 'file', data, from);
  }

  private async keep(conversation: string, clean: string, data: Buffer, from: string, type?: string, exclusive = false): Promise<StoredFile> {
    if (data.length > maxFileBytes) throw new Error(`${clean} is ${size(data.length)}; files may be at most ${size(maxFileBytes)}.`);
    const folder = this.folder(conversation);
    // Never write through a link a command left under this name.
    if (!exclusive) rmSync(join(folder, clean), { force: true });
    writeFileSync(join(folder, clean), data, { flag: exclusive ? 'wx' : 'w' });
    const entry = await this.describe(clean, data, from, type);
    const index = this.index(conversation);
    index.files = [...index.files.filter(file => file.name !== clean), { ...entry, mtimeMs: lstatSync(join(folder, clean)).mtimeMs }];
    this.write(conversation, index);
    await this.fit(conversation, [clean]);
    return entry;
  }

  private async describe(name: string, data: Buffer, from: string, type?: string, at = Date.now()): Promise<StoredFile> {
    const image = await imageInfo(data);
    return { name, size: data.length, type: image?.type ?? type ?? typeOf(name), ...(image ? { width: image.width, height: image.height } : {}), from, at };
  }

  /** Every file in the workspace, internal ones included, for comparing before and after a command. */
  snapshot(conversation: string): Promise<Snapshot> { return walk(this.folder(conversation)); }

  /**
   * Brings the index up to date with the folder after a command ran in it: new and rewritten files are teapilot's,
   * deleted ones leave the index. With `before`, files that command made are removed again if it left the
   * workspace over its size limit.
   */
  async reconcile(conversation: string, before?: Snapshot): Promise<Changes> {
    const folder = this.folder(conversation);
    const now = await walk(folder);
    const index = this.index(conversation);
    const known = new Map(index.files.map(file => [file.name, file]));
    const changes: Changes = { added: [], changed: [], removed: [] };
    const total = [...now.values()].reduce((sum, file) => sum + file.size, 0);
    if (before && total > this.limits.workspaceBytes) {
      const dropped = [...now.keys()].filter(name => !before.has(name));
      for (const name of dropped) await rm(join(folder, ...name.split('/')), { force: true });
      for (const name of dropped) now.delete(name);
      changes.overQuota = { bytes: total, dropped: dropped.filter(name => !internal(name)) };
    }
    const files: StoredFile[] = [];
    for (const file of index.files) {
      const current = now.get(file.name);
      if (!current) { changes.removed.push(file.name); continue; }
      if (current.size === file.size && current.mtimeMs === file.mtimeMs) { files.push(file); continue; }
      const path = this.safePath(conversation, file.name);
      const data = path && imageExtensions.has(extname(file.name).toLowerCase()) && current.size <= maxFileBytes * 5 ? readFileSync(path) : Buffer.alloc(0);
      const updated = path ? { ...await this.describe(file.name, data, 'teapilot'), size: current.size, mtimeMs: current.mtimeMs } : undefined;
      if (updated) { files.push(updated); changes.changed.push(updated); }
    }
    const added = [...now.entries()].filter(([name]) => !known.has(name) && !internal(name)).sort(([, a], [, b]) => a.mtimeMs - b.mtimeMs);
    for (const [name, info] of added) {
      const path = this.safePath(conversation, name);
      if (!path) continue;
      // Images are measured; anything else only needs its size, so large media is not read.
      const data = imageExtensions.has(extname(name).toLowerCase()) && info.size <= maxFileBytes * 5 ? readFileSync(path) : Buffer.alloc(0);
      const entry = { ...await this.describe(name, data, 'teapilot'), size: info.size, mtimeMs: info.mtimeMs };
      files.push(entry); changes.added.push(entry);
    }
    index.files = files;
    this.write(conversation, index);
    return changes;
  }

  /** Removes the oldest listed files, never those in `keep`, until the workspace fits its limit again. */
  private async fit(conversation: string, keep: string[]): Promise<void> {
    const folder = this.folder(conversation);
    const now = await walk(folder);
    let total = [...now.values()].reduce((sum, file) => sum + file.size, 0);
    if (total <= this.limits.workspaceBytes) return;
    const index = this.index(conversation);
    const kept: StoredFile[] = [];
    for (const file of [...index.files].sort((a, b) => a.at - b.at)) {
      if (total > this.limits.workspaceBytes && !keep.includes(file.name)) { await rm(join(folder, ...file.name.split('/')), { force: true }); total -= now.get(file.name)?.size ?? 0; }
      else kept.push(file);
    }
    index.files = index.files.filter(file => kept.includes(file));
    this.write(conversation, index);
  }

  /** Hosts people approved for this conversation's commands, such as a package registry. */
  domains(conversation: string): string[] { return this.index(conversation).domains; }
  allowDomains(conversation: string, hosts: string[]): void {
    const index = this.index(conversation);
    index.domains = [...new Set([...index.domains, ...hosts])];
    this.write(conversation, index);
  }

  /** The label given with /workspace name; an empty one removes it. */
  name(conversation: string): string | undefined { return this.index(conversation).name; }
  rename(conversation: string, name: string): void {
    const index = this.index(conversation);
    const label = name.trim().slice(0, 100);
    if (label) index.name = label; else delete index.name;
    this.write(conversation, index);
  }

  /** Clears the scratchpad and its listed files, including user attachments and queued pictures. */
  async clearScratch(conversation: string): Promise<void> {
    const release = this.acquire([conversation]);
    try {
      const index = this.index(conversation);
      index.files = index.files.filter(file => !file.name.startsWith('.scratch/'));
      this.write(conversation, index);
      this.arrived.delete(conversation);
      rmSync(this.scratch(conversation), { recursive: true, force: true });
      TaskStore.clearScratch(dirname(this.directory), this.scratch(conversation));
    } finally { release(); }
  }

  /** Deletes the files, packages and caches, keeping the scratchpad, the name and the approved hosts. */
  async clearFiles(conversation: string): Promise<number> {
    const release = this.acquire([conversation]);
    try {
      const folder = this.folder(conversation);
      const entries = await readdir(folder).catch(() => [] as string[]);
      for (const entry of entries) if (entry !== '.scratch') await rm(join(folder, entry), { recursive: true, force: true });
      const index = this.index(conversation);
      const kept = index.files.filter(file => file.name.startsWith('.scratch/'));
      const count = index.files.length - kept.length;
      index.files = kept;
      this.write(conversation, index);
      return count;
    } finally { release(); }
  }

  /** Copies a workspace, scratchpad included, over another's, for a conversation forked from it. */
  async copy(from: string, to: string): Promise<void> {
    const release = this.acquire([from, to]);
    try {
      TaskStore.clearScratch(dirname(this.directory), this.scratch(to));
      await rm(join(this.directory, this.id(to)), { recursive: true, force: true });
      await rm(this.indexPath(to), { force: true });
      const source = this.folder(from);
      // Links planted by sandboxed commands are copied as links and never followed, so they reach nothing new.
      await cp(source, this.folder(to), { recursive: true, verbatimSymlinks: true });
      this.write(to, this.index(from));
    } finally { release(); }
  }

  /** The listed files as a tree under one folder, files before folders; undefined when that folder has none. */
  tree(conversation: string, dir = '', limit = fileLimits.listed): string | undefined {
    const prefix = dir.replace(/\\/g, '/').replace(/^\.?\/+|\/+$/g, '');
    const files = this.list(conversation).filter(file => !prefix || file.name.toLowerCase().startsWith(`${prefix.toLowerCase()}/`));
    if (!files.length) return undefined;
    const root: TreeFolder = { folders: new Map(), files: [] };
    for (const file of files) {
      const parts = (prefix ? file.name.slice(prefix.length + 1) : file.name).split('/');
      let folder = root;
      for (const part of parts.slice(0, -1)) {
        if (!folder.folders.has(part)) folder.folders.set(part, { folders: new Map(), files: [] });
        folder = folder.folders.get(part)!;
      }
      folder.files.push({ name: parts[parts.length - 1]!, size: size(file.size) });
    }
    const rows: TreeRow[] = [];
    const walkFolder = (folder: TreeFolder, indent: string, top: boolean) => {
      const files = [...folder.files].sort((a, b) => a.name.localeCompare(b.name));
      const shown = top ? files : files.slice(0, treeFilesPerFolder);
      const hidden = files.slice(shown.length);
      const folders = [...folder.folders].sort(([a], [b]) => a.localeCompare(b));
      const total = shown.length + folders.length + (hidden.length ? 1 : 0);
      let index = 0;
      const branch = () => `${indent}${++index === total ? '└── ' : '├── '}`;
      for (const file of shown) rows.push({ left: branch(), icon: fileEmoji(file.name), text: file.name, size: file.size });
      folders.forEach(([name, child]) => {
        if (top && index > 0) rows.push({ left: '│', text: '' });
        const last = index + 1 === total;
        rows.push({ left: branch(), icon: '📂', text: `${name}/` });
        walkFolder(child, `${indent}${last ? '    ' : '│   '}`, false);
      });
      if (hidden.length) rows.push({ left: branch(), icon: fileEmoji(hidden[0]!.name), text: `… ${hidden.length} more file${hidden.length === 1 ? '' : 's'}` });
    };
    walkFolder(root, '', true);
    // Emoji are two cells wide, plus the space after them.
    const cells = (row: TreeRow) => row.left.length + (row.icon ? 3 : 0) + row.text.length;
    const width = Math.max(...rows.map(cells)) + 2;
    const sizes = Math.max(...rows.map(row => row.size?.length ?? 0));
    const lines = [`📂 ${prefix || 'workspace'}/`, ...rows.map(row =>
      `${row.left}${row.icon ? `${row.icon} ` : ''}${row.text}${row.size ? `${' '.repeat(width - cells(row) + sizes - row.size.length)}${row.size}` : ''}`)];
    return (lines.length > limit ? [...lines.slice(0, limit), `… and ${lines.length - limit} more`] : lines).join('\n');
  }

  /** Folders holding listed files, for completing a path someone is typing. */
  folders(conversation: string): string[] {
    const found = new Set<string>();
    for (const file of this.list(conversation)) {
      const parts = file.name.split('/');
      for (let depth = 1; depth < parts.length; depth++) found.add(parts.slice(0, depth).join('/'));
    }
    return [...found].sort();
  }

  /** Deletes the workspace and its index, for sessions that end with their files. */
  async remove(conversation: string): Promise<void> {
    const release = this.acquire([conversation]);
    try {
      TaskStore.clearScratch(dirname(this.directory), this.scratch(conversation));
      await rm(join(this.directory, this.id(conversation)), { recursive: true, force: true });
      await rm(this.indexPath(conversation), { force: true });
    } finally { release(); }
  }
}
