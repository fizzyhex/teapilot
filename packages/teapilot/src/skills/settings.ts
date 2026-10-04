import { z } from 'zod';
import { relativeSkillPath } from '../workspace/skills.js';

export const starterSets = ['gh:fizzyhex/tea-skills', 'gh:anthropics/skills'] as const;
export const maxSkillSets = 16;
const folders = z.array(z.string().max(240).refine(relativeSkillPath)).max(200);
const skillDirectory = (path: string) => path === '.' || relativeSkillPath(path);
export const setSchema = z.object({ source: z.string().min(1).max(300), path: z.string().max(240).refine(skillDirectory).optional(), include: folders.optional(), exclude: folders.optional() }).strict();
export type SkillSet = z.infer<typeof setSchema>;
export const preferencesSchema = z.object({ sets: z.array(setSchema).max(maxSkillSets).optional(), offline: z.boolean().optional() }).strict();
export const skillConfigSchema = preferencesSchema.extend({ refreshHours: z.number().min(1).max(168).optional() });
export type SkillPreferences = z.infer<typeof preferencesSchema>;
export interface SkillSettings extends SkillPreferences { enabled: boolean; directory?: string; refreshMs?: number }
export const defaultSkillSets = (): SkillSet[] => [{ source: starterSets[0] }];

export interface RepositorySource { id: string; owner: string; repo: string; ref?: string; path: string }
/** Public hosted sources only; credentials and arbitrary download endpoints are never accepted. */
export function repositorySource(set: SkillSet): RepositorySource {
  let text = set.source;
  if (/^https:\/\//i.test(text)) {
    const url = new URL(text);
    if (url.hostname !== 'github.com' || url.port || url.username || url.password || url.search) throw new Error('use a public github repository URL or gh:owner/repo');
    text = `gh:${url.pathname.replace(/^\//, '').replace(/\/$/, '').replace(/\.git$/, '')}${url.hash}`;
  }
  const match = /^gh:([a-z\d](?:[a-z\d-]{0,38}))\/([a-z\d_.-]{1,100})(?:#(.{1,100}))?$/i.exec(text);
  if (!match || /^(\.|\.\.)$/.test(match[2]!)) throw new Error('use gh:owner/repo, optionally #branch, #tag or #commit');
  const owner = match[1]!.toLowerCase(), repo = match[2]!.toLowerCase();
  const ref = match[3] && /^[\da-f]{40}$/i.test(match[3]) ? match[3].toLowerCase() : match[3];
  if (ref && (!/^[\w./-]+$/.test(ref) || ref.startsWith('-') || ref.split('/').some(part => !part || part === '.' || part === '..'))) throw new Error('invalid repository revision');
  const path = set.path ?? 'skills';
  if (!skillDirectory(path)) throw new Error('invalid skills directory');
  const id = `gh:${owner}/${repo}${ref ? `#${ref}` : ''}${path === 'skills' ? '' : `?path=${path}`}`;
  return { id, owner, repo, ...(ref ? { ref } : {}), path };
}
export function normalizeSets(sets: SkillSet[]): SkillSet[] {
  if (sets.length > maxSkillSets) throw new Error(`choose at most ${maxSkillSets} skill sets`);
  const seen = new Set<string>();
  return sets.map(raw => {
    const set = setSchema.parse(raw), source = repositorySource(set);
    if (seen.has(source.id)) throw new Error('duplicate skill set');
    seen.add(source.id);
    return { ...set, source: `gh:${source.owner}/${source.repo}${source.ref ? `#${source.ref}` : ''}` };
  });
}
