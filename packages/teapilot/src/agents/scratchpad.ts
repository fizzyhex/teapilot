import { open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import type { TestHooks } from '../config.js';
import type { ExecutionPolicy } from '../execution/policy.js';
import { clip } from '../workspace/sandbox.js';
import { keepResult, notKept, savedNote, Scratch, scratchLimits, type Saved } from '../workspace/scratch.js';

// One idea per line, as askPrompt and workspacePrompt. `inWorkspace`: the scratchpad is .scratch/ in the workspace.
export function scratchPrompt(scratch: Scratch, inWorkspace: boolean): string {
  const files = scratch.describe();
  return [
    inWorkspace
      ? '- Your scratchpad is .scratch/ in the workspace: a temp folder for this session. Put helper scripts, intermediate data and notes there; knowing it\'ll be deleted after this chat.'
      : `- Your scratchpad is ${scratch.folder}: a temp folder for this session only. Put helper scripts, intermediate data and notes there; knowing it may be deleted after this chat.`,
    '- Long output is kept there in full: when you need a detail it left out, read or grep the saved file instead of running the command or reading the page again.',
    ...files ? [`- In the scratchpad: ${files}.`] : [],
  ].join('\n');
}

/** Tools whose results are bounded by their own source, kept by their own tool, or are the scratchpad being read. */
const ownBounds = new Set(['web_read', 'file_send', 'request_escalation', 'request_capabilities', 'task_state', 'artifact_read', 'skill']);
const shells = new Set(['bash']);

/** pi's shell tools keep output they cut in a temp file of their own, and name it at the end of the result. */
function piOutputFile(text: string, details: unknown): string | undefined {
  const named = (details as { fullOutputPath?: unknown } | undefined)?.fullOutputPath;
  const path = typeof named === 'string' ? named : [...text.matchAll(/Full output: ([^\]\n]+)\]/g)].at(-1)?.[1];
  // Only a file pi itself writes: command output could name any path.
  if (!path || !/^pi-[a-z]+-[\w-]+\.log$/i.test(basename(path))) return undefined;
  const same = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  return same(resolve(dirname(path)), resolve(tmpdir())) ? path : undefined;
}

/** The first lines of a saved file, since pi keeps only the end of what it cuts. */
async function head(path: string, lines = 20, bytes = 2000): Promise<string> {
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await file.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8').replace(/�$/, '').split('\n').slice(0, lines).join('\n');
  } finally { await file.close(); }
}

/**
 * Keeps the whole of a long tool result in the scratchpad and returns what the model sees instead, or nothing when
 * the result stands as it is. The tool's outcome never changes, and a failure to keep only adds a note saying so.
 */
export async function captureResult(scratch: Scratch | undefined, policy: ExecutionPolicy, tool: string, args: unknown, text: string, details: unknown, previewChars = scratchLimits.previewChars): Promise<{ text: string; saved?: Saved } | undefined> {
  if (ownBounds.has(tool) || tool.startsWith('play_') || tool.startsWith('access_') || tool.startsWith('teachat_')) return undefined;
  // Retrieval does not recursively generate artifacts. pi bounds read by bytes/lines, not model context.
  if (tool === 'read' && policy.inScratch(String((args as { path?: unknown }).path ?? ''))) return text.length <= scratchLimits.retrievalChars ? undefined : { text: clip(text, scratchLimits.retrievalChars) };
  // Without a scratchpad a long result is still bounded; what it leaves out is gone. pi's shells keep up to 50 KB,
  // too much for a small context, so theirs is cut to the same size.
  if (!scratch) return text.length <= previewChars ? undefined : { text: clip(text, previewChars) };
  if (shells.has(tool)) {
    const command = String((args as { command?: unknown }).command ?? '');
    // Reading the scratchpad's own files again is not new output to keep.
    if (command.includes(scratch.folder) || /(^|[\s"'/\\])\.scratch\b/.test(command)) return text.length <= previewChars ? undefined : { text: clip(text, previewChars) };
    const temporary = piOutputFile(text, details);
    if (temporary) {
      const trailer = `. Full output: ${temporary}]`;
      try {
        const saved = await scratch.save('logs', tool, Scratch.stream(temporary));
        await rm(temporary, { force: true }).catch(() => undefined);
        const start = await head(saved.path).catch(() => '');
        const shown = clip(text.replace(trailer, '.]'), Math.max(200, previewChars - start.length));
        return { text: `${start ? `First lines:\n${start}\n[…]\n` : ''}${shown}\n${savedNote(saved)}`, saved };
      } catch (error) {
        return { text: `${clip(text, previewChars)}\n${notKept(error)}` };
      }
    }
  } else if (typeof (args as { path?: unknown }).path === 'string' && (args as { path: string }).path && policy.inScratch((args as { path: string }).path)) return undefined;
  return keepResult(scratch, tool, text, previewChars);
}

/** A scratchpad file a call touched, relative to the scratchpad, for evaluating how it is used. */
export function scratchTouched(scratch: Scratch, policy: ExecutionPolicy, tool: string, args: unknown): string | undefined {
  const data = (args ?? {}) as { path?: unknown; command?: unknown };
  // File tools have made their path absolute by now.
  if (typeof data.path === 'string' && data.path && policy.inScratch(data.path)) return relative(scratch.folder, policy.resolve(data.path)).split(sep).join('/') || '.';
  if (typeof data.command === 'string' && (data.command.includes(scratch.folder) || /(^|[\s"'/\\])\.scratch\b/.test(data.command))) return '(command)';
  return undefined;
}

/**
 * A benchmark's stand-in for a real command (TEAPILOT_FIXTURE_TOOL): each call returns the same file's text, and is
 * counted rather than refused, so repeats show up in the results. Its output is bounded and kept like any other.
 */
export function fixtureTool(fixture: NonNullable<TestHooks['fixture']>, counted: () => Promise<void>): AgentTool {
  return {
    name: fixture.name, label: fixture.name, description: fixture.description,
    parameters: Type.Object({}),
    execute: async () => {
      await counted();
      return { content: [{ type: 'text', text: await readFile(fixture.file, 'utf8') }], details: {} };
    },
  };
}
