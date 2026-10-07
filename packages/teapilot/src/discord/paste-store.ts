import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Message } from 'pretty-send';
import { z } from 'zod';
import { replaceFileSync } from '../replace.js';

// Messages are pretty-send layouts teapilot made itself; only their outline is checked here.
const saved = z.array(z.object({
  content: z.string().optional(),
  embeds: z.array(z.record(z.string(), z.unknown())).optional(),
  components: z.array(z.record(z.string(), z.unknown())).optional(),
  flags: z.number().optional(),
  source: z.string(),
  files: z.array(z.object({ name: z.string(), data: z.string() })).optional(),
}));
/** How many compact pastes are kept; the oldest go first. */
const keepLimit = 300;

/**
 * Answers pasted compactly: the channel shows a button, and each click shows the whole answer to whoever pressed it,
 * so they are kept on disk and outlive a restart. One JSON file per paste, files included.
 */
export class PasteStore {
  constructor(readonly directory: string, private readonly limit = keepLimit) {}

  static at(stateDir: string): PasteStore { return new PasteStore(join(stateDir, 'discord-pastes')); }

  private file(id: string): string { return join(this.directory, `${id}.json`); }

  keep(messages: Message[]): string {
    const id = randomUUID();
    mkdirSync(this.directory, { recursive: true });
    const file = this.file(id);
    const temporary = `${file}.${randomUUID()}.tmp`;
    const encoded = messages.map(message => ({ ...message, files: message.files?.map(entry => ({ name: entry.name, data: entry.data.toString('base64') })) }));
    writeFileSync(temporary, JSON.stringify(encoded), { mode: 0o600 });
    try { chmodSync(temporary, 0o600); } catch { /* not meaningful on every platform */ }
    replaceFileSync(temporary, file);
    this.prune();
    return id;
  }

  find(id: string): Message[] | undefined {
    if (!/^[\w-]+$/.test(id)) return undefined;
    try {
      return saved.parse(JSON.parse(readFileSync(this.file(id), 'utf8')))
        .map(message => ({ ...message, files: message.files?.map(entry => ({ name: entry.name, data: Buffer.from(entry.data, 'base64') })) }) as Message);
    } catch { return undefined; }
  }

  private prune(): void {
    const files = readdirSync(this.directory).filter(name => name.endsWith('.json'))
      .map(name => ({ name, time: statSync(join(this.directory, name)).mtimeMs }))
      .sort((a, b) => b.time - a.time);
    for (const { name } of files.slice(this.limit)) rmSync(join(this.directory, name), { force: true });
  }
}
