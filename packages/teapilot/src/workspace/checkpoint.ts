import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { Checkpoint } from '../agents/checkpoint.js';
import { replaceFileSync } from '../replace.js';

const ref = z.object({ ref: z.string(), summary: z.string().optional(), status: z.string().optional() });
const checkpointSchema = z.object({
  version: z.literal(1), requestId: z.string(), checkpointId: z.number(), sequence: z.number(), reason: z.enum(['instructor_calls', 'request_calls', 'attempt_time', 'request_time', 'model_calls', 'context_pressure']),
  durability: z.literal('saved'), savedId: z.uuid(), expiresAt: z.number(), summary: z.array(z.string()), modelHandoff: z.string().optional(),
  snapshot: z.object({ originalObjective: z.string().optional(), amendments: z.array(z.string()), artifacts: z.array(ref), checks: z.array(ref), results: z.array(ref), workers: z.array(ref), resources: z.record(z.string(), z.union([z.number(), z.string()])), pendingUncertain: z.array(z.string()), failures: z.array(z.object({ ref: z.string(), summary: z.string() })).optional() }),
});
const schema = z.object({
  version: z.literal(1), id: z.uuid(), root: z.string(), scope: z.string(), owner: z.string().optional(), channel: z.string().optional(),
  createdAt: z.number(), status: z.enum(['pending', 'available', 'resumed', 'finished']), executionId: z.string().optional(),
  prompt: z.string(), correction: z.string().optional(), workload: z.enum(['ask', 'coder']).optional(), readOnly: z.boolean().optional(), constraints: z.array(z.string()).optional(),
  workspace: z.string().optional(), ownWorkspace: z.boolean().optional(),
  checkpoint: checkpointSchema,
});
export type SavedCheckpoint = z.infer<typeof schema>;
export type CheckpointAction = { action: 'list' } | { action: 'resume' | 'redirect' | 'finish'; id: string; amendment?: string };
export interface CheckpointCaller { root: string; scope: string; owner?: string; operator?: boolean; channel?: string }

/** Host-owned state, outside scratchpads that /convo clear removes. Mutations use the host state lock. */
export class CheckpointStore {
  private readonly directory: string;
  constructor(stateDir: string) { this.directory = join(stateDir, 'checkpoints'); }
  private path(id: string): string {
    if (!z.uuid().safeParse(id).success) throw new Error('invalid checkpoint id');
    return join(this.directory, `${id}.json`);
  }
  private safe(path: string): void {
    for (let current = path;; current = dirname(current)) {
      if (existsSync(current)) {
        const info = lstatSync(current);
        if (info.isSymbolicLink() || info.isFile() && info.nlink !== 1) throw new Error('linked checkpoint paths are not allowed');
      }
      if (dirname(current) === current) break;
    }
  }
  read(id: string): SavedCheckpoint {
    const path = this.path(id); this.safe(path);
    if (!existsSync(path)) throw new Error('saved checkpoint not found');
    if (lstatSync(path).size > 256 * 1024) throw new Error('checkpoint exceeds storage limit');
    const saved = schema.parse(JSON.parse(readFileSync(path, 'utf8')));
    if (saved.id !== id || saved.checkpoint.savedId !== id) throw new Error('checkpoint reference mismatch');
    return saved;
  }
  write(saved: SavedCheckpoint): void {
    const text = JSON.stringify(schema.parse(saved));
    if (Buffer.byteLength(text) > 256 * 1024) throw new Error('checkpoint exceeds storage limit');
    const path = this.path(saved.id); this.safe(path);
    mkdirSync(this.directory, { recursive: true });
    const temporary = join(this.directory, `.${randomUUID()}.tmp`);
    try {
      const fd = openSync(temporary, 'wx', 0o600);
      try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
      replaceFileSync(temporary, path);
    } finally { rmSync(temporary, { force: true }); }
  }
  save(checkpoint: Checkpoint, input: Omit<SavedCheckpoint, 'version' | 'id' | 'createdAt' | 'status' | 'checkpoint'>): SavedCheckpoint {
    const id = randomUUID();
    const saved: SavedCheckpoint = { ...input, version: 1, id, createdAt: Date.now(), status: 'pending', checkpoint: { ...checkpoint, durability: 'saved', savedId: id } };
    this.write(saved); return saved;
  }
  authorize(saved: SavedCheckpoint, caller: CheckpointCaller): void {
    if (saved.root !== caller.root || saved.scope !== caller.scope || saved.channel !== caller.channel || saved.owner && saved.owner !== caller.owner && !caller.operator) throw new Error('this checkpoint belongs to a different repository, conversation or requester');
  }
  available(saved: SavedCheckpoint): boolean { return saved.status === 'available' || saved.status === 'pending' && Date.now() >= saved.checkpoint.expiresAt; }
  list(caller: CheckpointCaller): SavedCheckpoint[] {
    this.safe(this.directory);
    if (!existsSync(this.directory)) return [];
    return readdirSync(this.directory).filter(name => /^[\w-]+\.json$/.test(name)).flatMap(name => {
      try { const saved = this.read(name.slice(0, -5)); this.authorize(saved, caller); return this.available(saved) ? [saved] : []; } catch { return []; }
    }).sort((a, b) => b.createdAt - a.createdAt);
  }
  settle(id: string, status: SavedCheckpoint['status'], executionId?: string): void {
    const saved = this.read(id); this.write({ ...saved, status, executionId });
  }
}

export function checkpointCommand(text: string): CheckpointAction | undefined {
  const match = /^\/checkpoint(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return undefined;
  const [action = 'list', id, ...rest] = (match[1] ?? '').trim().split(/\s+/).filter(Boolean);
  if (action === 'list' && !id) return { action: 'list' };
  if (['resume', 'redirect', 'finish'].includes(action) && id && (action === 'redirect' ? rest.length > 0 : !rest.length)) return { action: action as 'resume' | 'redirect' | 'finish', id, ...(action === 'redirect' ? { amendment: rest.join(' ') } : {}) };
  throw new Error('use /checkpoint list|resume <id>|redirect <id> <direction>|finish <id>');
}

export const checkpointNextSteps = (id: string): string => `saved checkpoint: ${id}\nresume starts a new execution with current permissions and fresh limits.\n/checkpoint resume ${id}\n/checkpoint redirect ${id} <direction>\n/checkpoint finish ${id}`;
