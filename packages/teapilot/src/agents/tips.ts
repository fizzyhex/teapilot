/**
 * Tips: a line of guidance appended to the tool result that called for it (run.ts, afterToolCall), rather than
 * advice in the instructions every request pays for. A tip is given only while its text is not already in what the
 * model was sent, so it shows once per context and comes back once a compaction (or history trimming) drops it.
 * Each one given is a `tip` telemetry event, which the terminal and Discord show as `💡 name`.
 */
import type { Message } from '@earendil-works/pi-ai';

/** The tool call a tip may answer, with what the host knows around it. */
export interface TipCall {
  tool: string;
  path?: string;
  /** What the call wrote: a write's content, or an edit's replacement text. */
  content?: string;
  succeeded: boolean;
  /** The path is in the session's scratchpad. */
  scratch: boolean;
  /** The tools the model has right now. */
  tools: ReadonlySet<string>;
  /** The context is close to being compacted. */
  pressure: boolean;
  /** The files are in a workspace that is a git repository (workspace/git.ts). */
  repository?: boolean;
}
export interface Tip { name: string; content: string; when: (call: TipCall) => boolean }

const extension = (path: string | undefined) => /\.([a-z0-9]+)$/i.exec(path ?? '')?.[1]?.toLowerCase();
const changes = (call: TipCall) => call.succeeded && (call.tool === 'write' || call.tool === 'edit');

/** In priority order: a call gets the first tip that fits and has not been given. */
export const TIPS: readonly Tip[] = [
  {
    name: 'useJavascript', content: 'discord is not available through python - request `discord.play` and use js `@teapilot/discord-play`',
    when: call => changes(call) && extension(call.path) === 'py' && /^\s*(import|from)\s+discord\b/m.test(call.content ?? '')
      && (call.tools.has('request_capabilities') || [...call.tools].some(tool => tool.startsWith('play_'))),
  },
  { name: 'takeNotes', content: 'context is nearly full: keep only unresolved steps and source-backed findings in `task_state`; retrieve older evidence by ID rather than replaying transcripts.', when: call => call.pressure && call.tools.has('task_state') },
  { name: 'takeNotes', content: 'your context window is nearly full: maintain a brief `markdown` document for yourself to keep track of tasks, blockers and further work.', when: call => call.pressure && !call.tools.has('task_state') && call.tools.has('write') },
];

export const tipText = (tip: Tip) => `[tip] ${tip.content}`;

/** The first tip that fits the call and whose text `shown` has not seen. */
export function pickTip(call: TipCall, shown: (text: string) => boolean, tips: readonly Tip[] = TIPS): Tip | undefined {
  return tips.find(tip => !shown(tipText(tip)) && tip.when(call));
}

/** Tip texts already in `messages`, as tool result parts. */
export function shownTips(messages: readonly unknown[]): Set<string> {
  const texts = new Set(TIPS.map(tipText));
  const found = new Set<string>();
  for (const message of messages as Message[]) {
    if (message?.role !== 'toolResult') continue;
    for (const part of message.content) if (part.type === 'text' && texts.has(part.text)) found.add(part.text);
  }
  return found;
}
