import { lstat, open, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseFrontmatter } from '@earendil-works/pi-coding-agent';
import { within } from '../execution/policy.js';
import { scratchLimits } from './scratch.js';

export interface SkillMetadata { id: string; name: string; description: string; set?: string; revision?: string }
export interface SkillLocation { root: string; folder: string; hashes?: Record<string, string> }
export interface SkillCatalog { root: string; skills: SkillMetadata[]; warnings: string[]; locations?: Record<string, SkillLocation> }
export const skillIdLimit = 800;
export function relativeSkillPath(path: string): boolean {
  return path.length > 0 && path.length <= 240 && !/[\\:\x00-\x1f<>"|?*]/.test(path) && !path.startsWith('/') && !path.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part));
}

/** Host-owned skill files never grant broader filesystem access, even through a planted link. */
export async function skillText(root: string, id: string, file = 'SKILL.md'): Promise<string> {
  if (!relativeSkillPath(id) || !relativeSkillPath(file)) throw new Error('invalid skill ID or relative file');
  const folder = resolve(root, id), path = resolve(folder, file);
  if (!within(folder, path)) throw new Error('skill file is outside its folder');
  let current = path;
  for (;;) {
    const info = await lstat(current);
    if (info.isSymbolicLink() || (info.isFile() && info.nlink !== 1)) throw new Error('linked skill paths are not allowed');
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > scratchLimits.fileBytes) throw new Error('skill file is not a bounded regular file');
    const bytes = Buffer.alloc(info.size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== info.size) throw new Error('skill file changed or was not completely read');
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, bytesRead));
    if (text.includes('\0')) throw new Error('skill retrieval requires a text file');
    return text;
  } finally { await handle.close(); }
}

export async function discoverSkills(root: string): Promise<SkillCatalog> {
  const catalog: SkillCatalog = { root: resolve(root), skills: [], warnings: [] };
  let entries;
  try { entries = await readdir(catalog.root, { withFileTypes: true }); }
  catch (error) { catalog.warnings.push(`skills unavailable: ${error instanceof Error ? error.message : String(error)}`); return catalog; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    try {
      const text = await skillText(catalog.root, entry.name);
      if (!/^\uFEFF?---\r?\n/.test(text)) throw new Error('SKILL.md needs YAML frontmatter');
      const { frontmatter } = parseFrontmatter(text.replace(/^\uFEFF/, ''));
      const { name, description } = frontmatter;
      if (typeof name !== 'string' || !name.trim() || name.length > 200 || typeof description !== 'string' || !description.trim() || description.length > 2000) throw new Error('frontmatter needs bounded name and description strings');
      if (frontmatter['disable-model-invocation'] === true) continue;
      catalog.skills.push({ id: entry.name, name, description });
    } catch (error) { catalog.warnings.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return catalog;
}

export async function catalogSkillText(catalog: SkillCatalog, id: string, file = 'SKILL.md'): Promise<string> {
  const location = catalog.locations?.[id];
  return skillText(location?.root ?? catalog.root, location?.folder ?? id, file);
}

/** Catalog pages never carry instructions or supporting-file content. */
export function skillPage(catalog: SkillCatalog, offset = 0, limit = 100): string {
  const page: SkillMetadata[] = [];
  for (const metadata of catalog.skills.slice(offset, offset + limit)) {
    let shown = metadata;
    while (JSON.stringify([shown]).length > scratchLimits.retrievalChars - 200) shown = { ...shown, description: shown.description.slice(0, Math.floor(shown.description.length / 2)) + '…' };
    if (JSON.stringify([...page, shown]).length > scratchLimits.retrievalChars - 200) break;
    page.push(shown);
  }
  const next = offset + page.length < catalog.skills.length ? offset + page.length : null;
  return JSON.stringify({ skills: page, total: catalog.skills.length, next });
}
