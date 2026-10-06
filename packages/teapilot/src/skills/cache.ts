import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { extract } from 'tar-stream';
import { z } from 'zod';
import { parseFrontmatter } from '@earendil-works/pi-coding-agent';
import { replaceFileSync } from '../replace.js';
import { catalogSkillText, discoverSkills, relativeSkillPath, skillFlags, skillText, type SkillCatalog } from '../workspace/skills.js';
import { defaultSkillSets, normalizeSets, repositorySource, type RepositorySource, type SkillPreferences, type SkillSettings } from './settings.js';

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export const skillCacheLimits = { downloadBytes: 32 * 1024 * 1024, expandedBytes: 128 * 1024 * 1024, fileBytes: 8 * 1024 * 1024, entries: 10000, cacheBytes: 512 * 1024 * 1024 };
const refreshMs = 6 * 60 * 60_000;
const snapshotSchema = z.object({ source: z.string().max(600), revision: z.string().regex(/^[\da-f]{40}$/), bytes: z.number().int().nonnegative(), skills: z.array(z.object({ id: z.string().refine(relativeSkillPath), name: z.string().min(1).max(200), description: z.string().min(1).max(2000), flags: z.array(z.string()).optional() }).strict()).max(200), files: z.record(z.string().refine(relativeSkillPath), z.string().regex(/^[\da-f]{64}$/)) }).strict();
type Snapshot = z.infer<typeof snapshotSchema>;
const pointerSchema = z.object({ revision: z.string().regex(/^[\da-f]{40}$/).optional(), checkedAt: z.number(), failures: z.number().int().nonnegative().default(0), error: z.string().optional() }).strict();
type Pointer = z.infer<typeof pointerSchema>;
const downloads = new Map<string, Promise<void>>();
const updates = new Map<string, Promise<void>>();
async function untilAbort(job: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return job;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    void job.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
export interface SkillTransport {
  revision(source: RepositorySource, signal: AbortSignal): Promise<string>;
  archive(source: RepositorySource, revision: string, signal: AbortSignal): Promise<Uint8Array>;
}
async function responseBytes(response: Response, maximum: number): Promise<Uint8Array> {
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`repository request failed (${response.status})`); }
  const chunks: Uint8Array[] = []; let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > maximum) throw new Error('repository response exceeds its size limit');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}
/** Fixed HTTPS hosts and rejected redirects keep user-supplied sources out of the local network. */
export const githubTransport: SkillTransport = {
  async revision(source, signal) {
    // Ask for just the SHA: commit JSON includes patches which can dwarf the skills themselves.
    const response = await fetch(`https://api.github.com/repos/${source.owner}/${source.repo}/commits/${encodeURIComponent(source.ref ?? 'HEAD')}`, { signal, redirect: 'error', headers: { Accept: 'application/vnd.github.sha', 'User-Agent': 'teapilot' } });
    return z.string().regex(/^[\da-f]{40}$/).parse(Buffer.from(await responseBytes(response, 128)).toString('utf8').trim());
  },
  async archive(source, revision, signal) {
    return responseBytes(await fetch(`https://codeload.github.com/${source.owner}/${source.repo}/tar.gz/${revision}`, { signal, redirect: 'error' }), skillCacheLimits.downloadBytes);
  },
};

/** Keep skill files and repository license notices; nothing is executed. */
export async function extractSkills(bytes: Uint8Array, directory: string, path: string, signal?: AbortSignal): Promise<{ files: Record<string, string>; bytes: number }> {
  if (bytes.length > skillCacheLimits.downloadBytes || (path !== '.' && !relativeSkillPath(path))) throw new Error('invalid skill archive');
  const parser = extract(), files: Record<string, string> = {}, seen = new Set<string>();
  let entryJob: Promise<void> | undefined;
  let entries = 0, expanded = 0, stored = 0, top: string | undefined;
  parser.on('entry', (header, stream, next) => {
    entryJob = (async () => {
      signal?.throwIfAborted();
      const name = header.name.replace(/\/$/, '');
      if (++entries > skillCacheLimits.entries || !relativeSkillPath(name) || (header.type !== 'file' && header.type !== 'directory') || (header.size ?? 0) > skillCacheLimits.fileBytes) throw new Error('unsafe or oversized skill archive entry');
      const [prefix, ...parts] = name.split('/'); top ??= prefix;
      if (prefix !== top) throw new Error('skill archive has multiple roots');
      const relative = parts.join('/');
      const notice = path !== '.' && /^(?:LICENSE|LICENCE|COPYING|NOTICE)(?:[._-][\w.-]+)?$/i.test(relative);
      const selected = notice || (path === '.' ? !!relative : relative.startsWith(`${path}/`));
      const folder = notice ? `.repository/${relative}` : path === '.' ? relative : relative.slice(path.length + 1);
      if (header.type === 'directory' || !selected) {
        await new Promise<void>((resolve, reject) => {
          stream.on('end', resolve); stream.on('error', reject); stream.on('close', () => reject(new Error('incomplete skill archive entry'))); stream.resume();
        });
        return;
      }
      if (!relativeSkillPath(folder) || seen.has(folder.toLowerCase()) || folder.split('/').some(part => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('unsafe or duplicate skill archive path');
      seen.add(folder.toLowerCase());
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of stream) {
        if (!Buffer.isBuffer(chunk)) throw new Error('invalid skill archive bytes');
        size += chunk.length; if (size > skillCacheLimits.fileBytes) throw new Error('skill file exceeds its size limit'); chunks.push(chunk);
      }
      if (size !== header.size) throw new Error('incomplete skill file');
      signal?.throwIfAborted();
      const contents = Buffer.concat(chunks, size), file = join(directory, folder);
      await mkdir(dirname(file), { recursive: true }); await writeFile(file, contents, { flag: 'wx', mode: 0o600, signal });
      files[folder] = sha(contents); stored += size;
    })().then(() => next(), error => { stream.resume(); next(error instanceof Error ? error : new Error(String(error))); });
    void entryJob.catch(error => parser.destroy(error instanceof Error ? error : new Error(String(error))));
  });
  const bound = new Transform({ transform(chunk: Buffer, _encoding, done) { expanded += chunk.length; done(expanded > skillCacheLimits.expandedBytes ? new Error('expanded skill archive exceeds its size limit') : null, chunk); } });
  try { await pipeline(Readable.from([bytes]), createGunzip(), bound, parser, { signal }); }
  finally { await entryJob?.catch(() => undefined); }
  return { files, bytes: stored };
}

async function indexSkills(root: string, signal: AbortSignal): Promise<SkillCatalog> {
  const catalog: SkillCatalog = { root, skills: [], warnings: [] };
  const walk = async (folder: string, prefix = '', depth = 0): Promise<void> => {
    signal.throwIfAborted();
    if (depth > 5) return;
    const found = await discoverSkills(folder);
    for (const skill of found.skills) {
      catalog.skills.push({ ...skill, id: `${prefix}${skill.id}` });
      if (catalog.skills.length > 200) throw new Error('skill set exceeds 200 skills');
    }
    // Do not descend into an actual skill's supporting files.
    for (const entry of await readdir(folder, { withFileTypes: true })) if (entry.isDirectory() && !entry.isSymbolicLink() && !found.skills.some(skill => skill.id === entry.name)) {
      signal.throwIfAborted();
      if (await stat(join(folder, entry.name, 'SKILL.md')).then(() => true, () => false)) continue;
      await walk(join(folder, entry.name), `${prefix}${entry.name}/`, depth + 1);
    }
    catalog.warnings.push(...found.warnings.filter(warning => !warning.includes('ENOENT')));
  };
  await walk(root);
  catalog.skills.sort((a, b) => a.id.localeCompare(b.id));
  return catalog;
}

export class SkillCache {
  private readonly indexes = new Map<string, Snapshot>();
  private readonly pending = new Map<AbortController, Promise<void>>();
  constructor(readonly stateDir: string, private readonly transport: SkillTransport = githubTransport, private readonly now: () => number = Date.now) {}
  private base(source: RepositorySource): string { return join(this.stateDir, 'skill-sets', sha(source.id)); }
  private async pointer(source: RepositorySource): Promise<Pointer | undefined> {
    try { return pointerSchema.parse(JSON.parse(await readFile(join(this.base(source), 'current.json'), 'utf8'))); } catch { return undefined; }
  }
  private async savePointer(source: RepositorySource, value: Pointer): Promise<void> {
    const base = this.base(source); await mkdir(base, { recursive: true });
    const temporary = join(base, `${randomUUID()}.json.tmp`);
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    try { replaceFileSync(temporary, join(base, 'current.json')); } finally { await rm(temporary, { force: true }); }
  }
  private async snapshot(source: RepositorySource, revision: string): Promise<Snapshot> {
    const key = `${source.id}:${revision}`, known = this.indexes.get(key); if (known) return known;
    const file = join(this.base(source), revision, 'index.json');
    if ((await stat(file)).size > 4 * 1024 * 1024) throw new Error('oversized skill index');
    const value = snapshotSchema.parse(JSON.parse(await readFile(file, 'utf8')));
    if (value.source !== source.id || value.revision !== revision) throw new Error('skill snapshot identity mismatch');
    // Older indexes omitted flags; recover them from the integrity-checked immutable source.
    for (const skill of value.skills) if (skill.flags === undefined) {
      const text = await skillText(join(this.base(source), revision, 'files'), skill.id);
      if (value.files[`${skill.id}/SKILL.md`] !== sha(Buffer.from(text))) throw new Error('cached skill file failed its integrity check');
      skill.flags = skillFlags(parseFrontmatter(text.replace(/^\uFEFF/, '')).frontmatter.flags);
    }
    this.indexes.set(key, value); return value;
  }
  /** Serialized across processes, separate from the inference state lock. No active snapshot is deleted. */
  async refresh(set: import('./settings.js').SkillSet, force = false, signal?: AbortSignal): Promise<void> {
    const source = repositorySource(set), key = this.base(source), active = downloads.get(key); if (active) return untilAbort(active, signal);
    const controller = new AbortController();
    const stop = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const previous = updates.get(this.stateDir) ?? Promise.resolve();
    const job = previous.catch(() => undefined).then(() => this.update(source, force, stop)).finally(() => {
      this.pending.delete(controller);
      downloads.delete(key); if (updates.get(this.stateDir) === job) updates.delete(this.stateDir);
    });
    this.pending.set(controller, job);
    downloads.set(key, job); updates.set(this.stateDir, job); return untilAbort(job, signal);
  }
  /** Surface shutdown waits for cancellation and staging cleanup; warm requests never wait on these jobs. */
  async close(): Promise<void> {
    const pending = [...this.pending];
    for (const [controller] of pending) controller.abort(new DOMException('skill refresh stopped', 'AbortError'));
    await Promise.allSettled(pending.map(([, job]) => job));
  }
  private async update(source: RepositorySource, force: boolean, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    let before = await this.pointer(source);
    if (!force && before && this.now() - before.checkedAt < (before.failures ? Math.min(refreshMs, 60_000 * 2 ** Math.min(before.failures, 8)) : refreshMs)) return;
    const cache = join(this.stateDir, 'skill-sets'), lock = join(cache, '.update-lock');
    await mkdir(cache, { recursive: true });
    try { await mkdir(lock); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (this.now() - (await stat(lock)).mtimeMs > 5 * 60_000) { await rm(lock, { recursive: true, force: true }); await mkdir(lock); }
      else throw new Error('another skill set update is running; try again shortly');
    }
    let temporary: string | undefined;
    try {
      before = await this.pointer(source);
      const bounded = AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]);
      const revision = source.ref && /^[\da-f]{40}$/.test(source.ref) ? source.ref : await this.transport.revision(source, bounded);
      if (!/^[\da-f]{40}$/.test(revision)) throw new Error('invalid repository revision');
      if (!await this.snapshot(source, revision).then(() => true, () => false)) {
        temporary = join(cache, `.download-${randomUUID()}`); await mkdir(join(temporary, 'files'), { recursive: true });
        const extracted = await extractSkills(await this.transport.archive(source, revision, bounded), join(temporary, 'files'), source.path, bounded);
        const catalog = await indexSkills(join(temporary, 'files'), bounded);
        if (!catalog.skills.length || catalog.warnings.length) throw new Error(`invalid skill set: ${catalog.warnings.slice(0, 3).join('; ') || 'no skills found'}`);
        let used = 0;
        for (const folder of await readdir(cache, { withFileTypes: true })) if (folder.isDirectory() && !folder.name.startsWith('.')) {
          bounded.throwIfAborted();
          for (const entry of await readdir(join(cache, folder.name), { withFileTypes: true })) if (entry.isDirectory()) {
            try { const text = await readFile(join(cache, folder.name, entry.name, 'index.json'), 'utf8'); used += snapshotSchema.parse(JSON.parse(text)).bytes + Buffer.byteLength(text); } catch { throw new Error('skill cache accounting failed'); }
          }
        }
        if (used + extracted.bytes > skillCacheLimits.cacheBytes) throw new Error('skill cache is full; free cache space while teapilot is stopped');
        const snapshot: Snapshot = { source: source.id, revision, skills: catalog.skills.map(skill => ({ ...skill, flags: skill.flags ?? [] })), ...extracted };
        const index = JSON.stringify(snapshot);
        if (used + extracted.bytes + Buffer.byteLength(index) > skillCacheLimits.cacheBytes) throw new Error('skill cache is full; free cache space while teapilot is stopped');
        await writeFile(join(temporary, 'index.json'), index, { mode: 0o600 });
        bounded.throwIfAborted();
        await mkdir(this.base(source), { recursive: true });
        const destination = join(this.base(source), revision);
        // A previously validated immutable revision may already exist from another ref's update.
        if (!await this.snapshot(source, revision).then(() => true, () => false)) await rename(temporary, destination);
      }
      bounded.throwIfAborted();
      await this.savePointer(source, { revision, checkedAt: this.now(), failures: 0 });
    } catch (error) {
      if (!(signal?.aborted && signal.reason?.name === 'AbortError')) await this.savePointer(source, { ...before, checkedAt: this.now(), failures: (before?.failures ?? 0) + 1, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
      throw error;
    } finally { if (temporary) await rm(temporary, { recursive: true, force: true }); await rm(lock, { recursive: true, force: true }); }
  }
  async catalog(settings: SkillSettings, preferences: SkillPreferences = {}, signal?: AbortSignal): Promise<SkillCatalog> {
    if (!settings.enabled) return { root: '', skills: [], warnings: [] };
    if (settings.directory) return discoverSkills(settings.directory);
    const catalog: SkillCatalog = { root: '', skills: [], warnings: [], locations: {} };
    const offline = settings.offline === true || preferences.offline === true;
    // A cold catalog has one bounded wait budget, not one timeout per enabled source.
    const coldSignal = AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]);
    for (const set of normalizeSets(preferences.sets ?? settings.sets ?? defaultSkillSets())) {
      signal?.throwIfAborted();
      if (set.include?.length === 0) continue;
      const source = repositorySource(set); let pointer = await this.pointer(source);
      let failure: string | undefined;
      const retryDue = !pointer || this.now() - pointer.checkedAt >= Math.min(refreshMs, 60_000 * 2 ** Math.min(pointer.failures, 8));
      if (!pointer?.revision && !offline && retryDue && !coldSignal.aborted) {
        try { await this.refresh(set, true, coldSignal); pointer = await this.pointer(source); } catch (error) { failure = error instanceof Error ? error.message : String(error); }
      }
      if (!pointer?.revision) {
        const reason = pointer?.error ?? failure;
        catalog.warnings.push(`${source.id}: unavailable${offline ? ' offline' : ''} (no cached snapshot)${reason ? `; ${reason}` : ''}`); continue;
      }
      try {
        const snapshot = await this.snapshot(source, pointer.revision), root = join(this.base(source), pointer.revision, 'files');
        for (const metadata of snapshot.skills) {
          if ((set.include && !set.include.includes(metadata.id)) || set.exclude?.includes(metadata.id)) continue;
          const id = `${source.id}::${metadata.id}`;
          const { flags, ...rest } = metadata;
          catalog.skills.push({ ...rest, ...(flags?.length ? { flags } : {}), id, set: source.id, revision: pointer.revision });
          catalog.locations![id] = { root, folder: metadata.id, hashes: snapshot.files };
        }
        if (pointer.error) catalog.warnings.push(`${source.id}: using cached ${pointer.revision.slice(0, 8)}; ${pointer.error}`);
        const interval = pointer.failures ? Math.min(refreshMs, 60_000 * 2 ** Math.min(pointer.failures, 8)) : settings.refreshMs ?? refreshMs;
        if (!offline && !(source.ref && /^[\da-f]{40}$/.test(source.ref)) && this.now() - pointer.checkedAt >= interval) void this.refresh(set, true).catch(() => undefined);
      } catch (error) { catalog.warnings.push(`${source.id}: cached skills unavailable: ${error instanceof Error ? error.message : String(error)}`); }
    }
    signal?.throwIfAborted();
    return catalog;
  }
}

const caches = new Map<string, SkillCache>();
export function skillCache(stateDir: string): SkillCache {
  let cache = caches.get(stateDir); if (!cache) { cache = new SkillCache(stateDir); caches.set(stateDir, cache); } return cache;
}
export async function verifySkillText(catalog: SkillCatalog, id: string, file: string): Promise<string> {
  const text = await catalogSkillText(catalog, id, file), location = catalog.locations?.[id];
  if (location?.hashes && location.hashes[`${location.folder}/${file}`] !== sha(Buffer.from(text))) throw new Error('cached skill file failed its integrity check');
  return text;
}
