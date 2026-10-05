import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { replaceFileSync } from '../replace.js';
import { relativeSkillPath } from '../workspace/skills.js';
import { skillCache, type SkillCache } from './cache.js';
import { defaultSkillSets, maxSkillSets, normalizeSets,preferencesSchema, repositorySource, starterSets, type SkillPreferences, type SkillSet, type SkillSettings } from './settings.js';

export const skillScopes = ['conversation', 'personal', 'global'] as const;
export type SkillScope = typeof skillScopes[number];
const dataSchema = z.object({ global: preferencesSchema.optional(), personal: z.record(z.string(), preferencesSchema), conversations: z.record(z.string(), preferencesSchema) }).strict();
type Data = z.infer<typeof dataSchema>;
export interface SkillCaller { userId?: string; conversation?: string; operator: boolean }

/** Selection state is separate from shared immutable repository bytes. Each mutation reloads the state. */
export class SkillStore {
  readonly file: string;
  constructor(readonly stateDir: string, readonly settings: SkillSettings, readonly cache: SkillCache = skillCache(stateDir)) { this.file = join(stateDir, 'skill-selections.json'); }
  private load(): Data {
    try { return dataSchema.parse(JSON.parse(readFileSync(this.file, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { personal: {}, conversations: {} }; throw new Error('skill selections are unreadable; repair the selection file before changing them'); }
  }
  private save(data: Data): void {
    mkdirSync(dirname(this.file), { recursive: true }); const temporary = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 }); replaceFileSync(temporary, this.file);
  }
  private defaults(data: Data): SkillPreferences { return { sets: this.settings.sets ?? defaultSkillSets(), offline: this.settings.offline ?? false, ...data.global }; }
  effective(caller: SkillCaller): SkillPreferences {
    if (!this.settings.enabled || this.settings.directory) return { sets: [], offline: true };
    const data = this.load(), defaults = this.defaults(data);
    const personal = caller.userId ? { ...defaults, ...data.personal[caller.userId] } : defaults;
    if (!caller.conversation) return structuredClone(personal);
    const saved = data.conversations[caller.conversation];
    if (saved) return structuredClone(saved);
    // Seed once: later speakers and edits to personal defaults cannot silently change a shared conversation.
    if (Object.keys(data.conversations).length >= 2000) throw new Error('skill selection storage is full');
    data.conversations[caller.conversation] = structuredClone(personal); this.save(data); return structuredClone(personal);
  }
  fork(from: string, to: string): void {
    const data = this.load(); const saved = data.conversations[from];
    if (saved) { data.conversations[to] = structuredClone(saved); this.save(data); }
  }
  forget(conversation: string): void { const data = this.load(); delete data.conversations[conversation]; this.save(data); }
  private scoped(data: Data, caller: SkillCaller, scope: SkillScope): SkillPreferences {
    if (scope === 'global') { if (!caller.operator) throw new Error('only operators can change global skill defaults'); return { ...this.defaults(data) }; }
    if (scope === 'personal') {
      if (!caller.userId) throw new Error('personal skills need a user identity');
      return { ...this.defaults(data), ...data.personal[caller.userId] };
    }
    if (!caller.conversation) throw new Error('no conversation here yet; choose personal or global scope');
    return data.conversations[caller.conversation] ?? { ...this.defaults(data), ...(caller.userId ? data.personal[caller.userId] : {}) };
  }
  private put(data: Data, caller: SkillCaller, scope: SkillScope, value?: SkillPreferences): void {
    if (scope === 'global') data.global = value;
    else {
      const records = scope === 'personal' ? data.personal : data.conversations;
      const key = (scope === 'personal' ? caller.userId : caller.conversation)!;
      if (value) {
        if (!(key in records) && Object.keys(records).length >= 2000) throw new Error('skill selection storage is full');
        records[key] = value;
      } else delete records[key];
    }
    this.save(data);
  }
  async command(args: string, caller: SkillCaller, signal?: AbortSignal): Promise<string> {
    const words = args.trim().split(/\s+/).filter(Boolean);
    const action = words.shift() ?? 'list';
    const last = words.at(-1), scope: SkillScope = skillScopes.includes(last as SkillScope) ? words.pop() as SkillScope : caller.conversation ? 'conversation' : caller.userId ? 'personal' : 'global';
    const target = words.shift();
    if (words.length) throw new Error('use /skills action [set or set::skill] [conversation|personal|global]');
    const data = this.load(), preferences = structuredClone(this.scoped(data, caller, scope));
    const sets = normalizeSets(preferences.sets ?? defaultSkillSets());
    if (action === 'reset' && !target) { this.put(data, caller, scope); return `reset ${scope} skill choices.`; }
    if (action === 'offline') {
      if (!['on', 'off'].includes(target ?? '')) throw new Error('use /skills offline on|off [scope]');
      preferences.offline = target === 'on'; this.put(data, caller, scope, preferences);
      return `${scope} skills offline: ${target}.${target === 'off' && this.settings.offline ? ' configuration still forces offline mode.' : ''}`;
    }
    const [repository, skill, extra] = target?.split('::') ?? [];
    if (extra || (skill !== undefined && !relativeSkillPath(skill))) throw new Error('invalid skill ID');
    const candidate = repository ? setFromId(repository) : undefined;
    const id = candidate && repositorySource(candidate).id;
    const existing = sets.find(set => repositorySource(set).id === id);
    if (['enable', 'add', 'disable', 'remove'].includes(action)) {
      if (!candidate) throw new Error('choose a set or source-qualified skill ID');
      const enabling = action === 'enable' || action === 'add';
      if (!skill) {
        if (enabling && !existing) sets.push(candidate);
        else if (enabling && existing) { delete existing.include; delete existing.exclude; }
        else if (!enabling && existing) sets.splice(sets.indexOf(existing), 1);
      } else {
        const selected = existing ?? { ...candidate, include: [] };
        if (!existing && enabling) sets.push(selected);
        if (enabling) {
          if (selected.include && !selected.include.includes(skill)) selected.include.push(skill);
          selected.exclude = selected.exclude?.filter(folder => folder !== skill);
        } else {
          if (selected.include) selected.include = selected.include.filter(folder => folder !== skill);
          else selected.exclude = [...new Set([...(selected.exclude ?? []), skill])];
        }
      }
      preferences.sets = normalizeSets(sets); this.put(data, caller, scope, preferences);
      return `${enabling ? 'enabled' : 'disabled'} ${target} for ${scope}. takes effect on the next request.`;
    }
    if (action === 'update') {
      if (!this.settings.enabled) throw new Error('skills are disabled by configuration');
      if (this.settings.offline || preferences.offline) throw new Error('skills are offline; turn offline off before updating');
      if (candidate && !existing) throw new Error('enable the set in this scope before updating it');
      for (const set of candidate ? [existing!] : sets) await this.cache.refresh(set, true, signal);
      return 'skill sets updated. running requests keep their current revisions.';
    }
    if (action !== 'list') return 'skills: list [set], add|enable|disable|remove set[::skill], update [set], offline on|off, reset; optional scope: conversation|personal|global.';
    const lines = [`${scope} skills${this.settings.offline || preferences.offline ? ' (offline)' : ''}${!this.settings.enabled ? ' (disabled by configuration)' : ''}:`];
    if (!candidate) {
      for (const set of sets) lines.push(`on  ${repositorySource(set).id}${set.include ? ` (${set.include.length} selected)` : ' (all skills)'}${set.exclude?.length ? `; ${set.exclude.length} excluded` : ''}`);
      for (const source of starterSets) if (!sets.some(set => repositorySource(set).id === source)) lines.push(`off ${source}`);
      lines.push('list a set to browse its skills. use enable or disable to choose sets or individual skills.');
    } else {
      const catalog = await this.cache.catalog({ ...this.settings, directory: undefined }, { ...preferences, sets: [candidate] }, signal);
      for (const metadata of catalog.skills) {
        const folder = metadata.id.split('::')[1]!;
        const enabled = existing && (!existing.include || existing.include.includes(folder)) && !existing.exclude?.includes(folder);
        lines.push(`${enabled ? 'on ' : 'off'} ${metadata.id} — ${metadata.name}`);
      }
      lines.push(...catalog.warnings);
    }
    return lines.join('\n');
  }
  /** Targets to offer as /skills is typed: chosen and starter sets, plus their cached skills for actions that take one. Never waits on the network. */
  async suggest(action: string, typed: string, caller: SkillCaller, signal?: AbortSignal): Promise<string[]> {
    if (!this.settings.enabled || this.settings.directory) return [];
    const data = this.load();
    const preferences = (caller.conversation && data.conversations[caller.conversation]) || { ...this.defaults(data), ...(caller.userId ? data.personal[caller.userId] : {}) };
    const sets = new Map<string, SkillSet>();
    for (const { include: _include, exclude: _exclude, ...set } of [...normalizeSets(preferences.sets ?? defaultSkillSets()), ...starterSets.map((source): SkillSet => ({ source }))]) {
      const id = repositorySource(set).id;
      if (!sets.has(id) && sets.size < maxSkillSets) sets.set(id, set);
    }
    const skills = ['enable', 'add', 'disable', 'remove'].includes(action)
      ? (await this.cache.catalog({ ...this.settings, offline: true }, { sets: [...sets.values()] }, signal)).skills.map(skill => skill.id)
      : [];
    const needle = typed.trim().toLowerCase();
    return [...sets.keys(), ...skills].filter(id => id.toLowerCase().includes(needle));
  }
}

function setFromId(text: string): SkillSet {
  const [source, path, extra] = text.split('?path=');
  if (extra) throw new Error('invalid skill set ID');
  return normalizeSets([{ source: source!, ...(path ? { path } : {}) }])[0]!;
}
