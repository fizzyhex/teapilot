import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SandboxStatus, WorkspaceSandbox } from './sandbox.js';

/**
 * Git in a workspace: each conversation's folder is a repository teapilot owns, so it can roll back, see who did
 * what, and recall earlier work from its log. Commits are the agent's own; the host only starts the repository.
 */

/** Who commits: teapilot-orchestrator, or tea-junior-<name> for a junior (agents/delegate.ts). */
export const gitAuthor = (junior?: string) => junior ? `tea-${junior}` : 'teapilot-orchestrator';

/** The environment a command commits under as `author`. */
export function gitEnvironment(author: string): Record<string, string> {
  const email = `${author}@teapilot.local`;
  return { GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: author, GIT_COMMITTER_EMAIL: email };
}

/** teapilot's internal captures are disposable; scratch utilities and plans can still be tracked. */
const ignored = ['/.scratch/sessions/', '/.scratch/outputs/', '/.scratch/logs/', '/.scratch/juniors/*/sessions/', '/.scratch/juniors/*/outputs/', '/.scratch/juniors/*/logs/', '.tmp/', '.packages/', '.cache/', '.appdata/', '.gitconfig', 'node_modules/', '__pycache__/'];

// Loaded once; edits to the shipped templates apply after a restart.
const legacyReadme = readFileSync(new URL('./template/legacy-README.txt', import.meta.url), 'utf8');
const readme = readFileSync(new URL('./template/README.txt', import.meta.url), 'utf8');
const agents = readFileSync(new URL('./template/AGENTS.txt', import.meta.url), 'utf8');

export const hasRepository = (folder: string) => existsSync(join(folder, '.git'));

/**
 * Makes `folder` a repository with a first commit, once, when the sandbox has git. A workspace from before this
 * commits its files as they are. Seeds missing docs and migrates only the untouched legacy README, even in an
 * existing workspace repository. Failures are quiet: without a repository the agent is simply not told about one.
 */
export async function ensureRepository(folder: string, sandbox: WorkspaceSandbox, status: SandboxStatus): Promise<boolean> {
  const repository = hasRepository(folder);
  if (!repository && (!status.available || !status.tools.some(tool => tool.kind === 'git'))) return false;
  try {
    // Existing instructions stay theirs; only the exact old generated README is replaced.
    if (!existsSync(join(folder, 'AGENTS.md'))) await writeFile(join(folder, 'AGENTS.md'), agents);
    const readmePath = join(folder, 'README.md');
    if (!existsSync(readmePath) || await readFile(readmePath, 'utf8') === legacyReadme) await writeFile(readmePath, readme);
    if (repository) return true;
    if (!existsSync(join(folder, '.gitignore'))) await writeFile(join(folder, '.gitignore'), `${ignored.join('\n')}\n`);
    const result = await sandbox.run(folder, 'git init -q -b main && git add -A && git commit -q -m "start workspace"', {
      timeoutSeconds: 60, network: async () => false, env: gitEnvironment('teapilot'),
    });
    return result.exitCode === 0 && hasRepository(folder);
  } catch { return repository; }
}
