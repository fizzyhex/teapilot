import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, readdirSync, statSync } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Config } from '../config.js';
import { StreamRedactor } from '../integration/events.js';
import { clip } from './sandbox.js';

/**
 * A session's scratchpad: an ordinary folder beside its workspace files where the agent keeps helper scripts,
 * intermediate data and notes, and where the host keeps the full copy of output too long to show. It is never part
 * of the user's project, and it goes when the conversation is cleared.
 */
export const scratchLimits = {
  /** A saved file stops here and is kept as incomplete. */
  fileBytes: 8 * 1024 * 1024,
  /** Results longer than this are kept in full, since later turns replay them cut down. */
  keepChars: 2000,
  /** Results longer than this are shown as their start and end, with the rest in the saved file. */
  previewChars: 2000,
  /** Explicit retrieval windows can be larger than ordinary previews, but never grow without a bound. */
  retrievalChars: 4000,
  /** How much of the folder's listing the instructions carry. */
  describeChars: 1200,
};

/** The line a saved copy leaves in a result; later turns keep it when they cut the result down. */
export const savedLine = /^(?:Full (?:output|page text) saved to |Output beyond this excerpt was not kept|skill reference: ).*$/gm;

/** Every secret teapilot holds, for redacting what leaves it or is kept. */
export function secretsOf(config: Config): string[] {
  return [config.router.apiKey ?? '', ...Object.values(config.secrets).map(value => value ?? '')];
}

export interface Saved { id: string; sha256: string; path: string; lines: number; bytes: number; complete: boolean; indexed?: boolean }
export type Kind = 'logs' | 'pages' | 'outputs';

const size = (bytes: number) => bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export class Scratch {
  private swept = false;
  constructor(readonly folder: string, private readonly secrets: string[] = [], private readonly onSave?: (saved: Saved, kind: Kind) => boolean | void) {}

  /**
   * Creates the folder, and refuses one that is not a plain folder: sandboxed commands can write in the workspace
   * around it, so a link planted in its place must never lead the host's own writes elsewhere.
   */
  async ready(): Promise<void> {
    await mkdir(this.folder, { recursive: true });
    const info = await lstat(this.folder);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('The scratchpad folder is a link, not a folder');
  }

  /**
   * Keeps `source` in full under kind/stem-N.ext, redacted, and stops at the size limit. The file appears only once
   * it is written, so a crash never leaves a half file that looks whole; leftovers are cleared on the next save.
   * `partial` marks a source already known to be cut short, such as a command that was stopped.
   */
  async save(kind: Kind, stem: string, source: string | AsyncIterable<string | Buffer>, extension = '.log', partial = false): Promise<Saved> {
    await this.ready();
    const directory = join(this.folder, kind);
    await mkdir(directory, { recursive: true });
    if ((await lstat(directory)).isSymbolicLink()) throw new Error(`The scratchpad's ${kind} folder is a link, not a folder`);
    if (!this.swept) { this.swept = true; await this.sweep(); }
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    const redactor = new StreamRedactor(this.secrets);
    const decoder = new StringDecoder('utf8');
    const hash = createHash('sha256');
    const file = await open(temporary, 'wx');
    let bytes = 0, lines = 0, full = false, last = '';
    const write = async (text: string) => {
      if (!text) return;
      let data = Buffer.from(text);
      if (bytes + data.length > scratchLimits.fileBytes) {
        let end = scratchLimits.fileBytes - bytes;
        while (end > 0 && (data[end]! & 0xc0) === 0x80) end--;
        data = data.subarray(0, end); full = true;
      }
      await file.write(data);
      hash.update(data);
      bytes += data.length;
      for (const byte of data) if (byte === 10) lines++;
      if (data.length) last = String.fromCharCode(data[data.length - 1]!);
    };
    try {
      for await (const chunk of typeof source === 'string' ? [source] : source) {
        await write(redactor.push(typeof chunk === 'string' ? decoder.end() + chunk : decoder.write(chunk)));
        if (full) break;
      }
      if (!full) await write(redactor.push(decoder.end(), true));
    } catch (error) {
      await file.close(); await rm(temporary, { force: true });
      throw error;
    }
    await file.close();
    const complete = !full && !partial;
    if (bytes && last !== '\n') lines++;
    const safe = stem.replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').slice(0, 60) || 'output';
    const taken = new Set(await readdir(directory));
    let index = 1;
    const name = () => `${safe}-${index}${complete ? '' : '.partial'}${extension}`;
    while (taken.has(`${safe}-${index}${extension}`) || taken.has(`${safe}-${index}.partial${extension}`)) index++;
    const path = join(directory, name());
    await rename(temporary, path);
    const saved = { id: `a-${randomUUID()}`, sha256: hash.digest('hex'), path, lines, bytes, complete };
    const indexed = this.onSave ? this.onSave(saved, kind) !== false : false;
    return { ...saved, indexed };
  }

  /** Where the session's transcript is kept (agents/compaction.ts); like the other kinds, never a link in its place. */
  async sessions(): Promise<string> {
    await this.ready();
    const directory = join(this.folder, 'sessions');
    await mkdir(directory, { recursive: true });
    if ((await lstat(directory)).isSymbolicLink()) throw new Error("The scratchpad's sessions folder is a link, not a folder");
    return directory;
  }

  /** A file's content streamed from disk, for keeping a copy another tool already wrote. */
  static stream(path: string): AsyncIterable<Buffer> { return createReadStream(path); }

  /** The newest files, for the instructions: names and sizes only. */
  describe(): string {
    const files: Array<{ path: string; bytes: number; at: number }> = [];
    const visit = (directory: string, prefix: string, depth: number) => {
      let entries;
      try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.name.endsWith('.tmp')) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory() && depth < 4) visit(path, `${prefix}${entry.name}/`, depth + 1);
        else if (entry.isFile()) try { const info = statSync(path); files.push({ path: prefix + entry.name, bytes: info.size, at: info.mtimeMs }); } catch { /* removed meanwhile */ }
      }
    };
    visit(this.folder, '', 0);
    if (!files.length) return '';
    files.sort((a, b) => b.at - a.at);
    let text = '', shown = 0;
    for (const file of files) {
      const entry = `${shown ? '; ' : ''}${file.path} (${size(file.bytes)})`;
      if (text.length + entry.length > scratchLimits.describeChars) break;
      text += entry; shown++;
    }
    return files.length > shown ? `${text}; and ${files.length - shown} more` : text;
  }

  async clear(): Promise<void> { await rm(this.folder, { recursive: true, force: true }); }

  /** Removes what an interrupted save left behind. */
  private async sweep(): Promise<void> {
    for (const kind of ['logs', 'pages', 'outputs']) {
      let entries: string[];
      try { entries = await readdir(join(this.folder, kind)); } catch { continue; }
      await Promise.all(entries.filter(name => name.endsWith('.tmp')).map(name => rm(join(this.folder, kind, name), { force: true })));
    }
  }
}

/** How the model is told where a full copy went. */
export function savedNote(saved: Saved, what: 'output' | 'page text' = 'output'): string {
  return `Full ${what} saved to ${saved.path} (${saved.lines} lines${saved.complete ? '' : ', incomplete'})${saved.indexed ? ` [artifact ${saved.id}]` : ''}; read or search it for anything not shown here.`;
}
export function notKept(error: unknown): string {
  return `Output beyond this excerpt was not kept (${error instanceof Error ? error.message : String(error)}).`;
}

/**
 * Keeps a long tool result and returns what the model sees: the result itself when it fits, or its start and end
 * when it does not, each followed by where the whole of it is. A failure to keep never changes the tool's outcome.
 */
export async function keepResult(scratch: Scratch, tool: string, text: string, previewChars = scratchLimits.previewChars): Promise<{ text: string; saved?: Saved } | undefined> {
  if (text.length <= scratchLimits.keepChars) return undefined;
  const long = text.length > previewChars;
  try {
    const saved = await scratch.save('outputs', tool, text, '.txt');
    return { text: `${long ? clip(text, previewChars) : text}\n${savedNote(saved)}`, saved };
  } catch (error) {
    return long ? { text: `${clip(text, previewChars)}\n${notKept(error)}` } : undefined;
  }
}
