import { MESSAGE_LIMIT } from 'pretty-send';
import { describeCompaction, describeTip, describeTool } from '../presentation.js';
import type { HostEvent } from '../integration/events.js';
import { interruptionDetails, type Interruption } from '../interruption.js';
import { blockerSchema, type Blocker } from '../workspace/blocker.js';

export { chunk, MESSAGE_LIMIT } from 'pretty-send';
/** Starts the custom id of a table's "view source" button. */
export const viewSourcePrefix = 'teapilot-table:';

export interface QuotedMessage { author: string; text: string }
/** `messages` are oldest first; `truncated` means the chain goes back further than could be fetched. */
export interface ReplyChain { messages: QuotedMessage[]; truncated: boolean }

const truncatedNote = 'Note: this reply chain goes back further than teapilot could fetch (it may lack access to the channel, or the chain is too long), so earlier context may be missing.';

/**
 * The selected message as teapilot receives it, attributed because its author may not be the invoker.
 * The messages it replies to come first, so teapilot reads the conversation in order.
 */
export function quoteMessage(message: QuotedMessage, chain: ReplyChain = { messages: [], truncated: false }): string {
  const selected = `Message from @${message.author}:\n${message.text}`;
  if (!chain.messages.length && !chain.truncated) return selected;
  const earlier = chain.messages.map(({ author, text }) => `@${author}: ${text || '(no text)'}`);
  return `Reply chain, oldest first:\n${[...(chain.truncated ? [truncatedNote] : []), ...earlier, selected].join('\n\n')}`;
}

/** What a turn is doing now, as its status card's first line shows it. */
export type CardPhase = 'queued' | 'thinking' | 'running' | 'writing' | 'compacting' | 'approval' | 'stopping';
/** What a press on a status card shows the person who pressed it, and only them. */
export interface CardReply { text: string; file?: { name: string; content: string } }
/** A tool call, reasoning, or something the host did between them (a compaction, a tip), which is listed but not counted as a step. */
type Step = { tool: string } | { reasoning: string } | { note: string };

const phases: Record<CardPhase, string> = {
  queued: '⏳ queued behind another task', thinking: '🫖 thinking', running: '⚙️ running', writing: '✍️ writing',
  compacting: '🗜️ compacting earlier context', approval: '⏸️ waiting for approval', stopping: '⏹️ stopping',
};
/** Reasoning kept per turn for Details, so a runaway model cannot grow it without bound. */
const reasoningLimit = 100_000;
/** A step other than reasoning, as one line. */
const line = (step: { tool: string } | { note: string }) => 'tool' in step ? step.tool : step.note;

/** Literal text inside Discord markdown: nothing in it formats, links or mentions. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\*_~`|>#[\]<]/g, '\\$&').replace(/^([-+]|\d+\.) /, '\\$1 ');
}
/** The last `max` characters of `text` on one line, starting at a word where one is near. */
export function tail(text: string, max: number): string {
  const line = text.replace(/<\/?think>/g, ' ').replace(/\s+/g, ' ').trim();
  if (line.length <= max) return line;
  const cut = line.slice(-max);
  const word = cut.indexOf(' ');
  return `…${word >= 0 && word < 30 ? cut.slice(word + 1) : cut}`;
}
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/**
 * One status card per turn. While the turn runs it says what is happening now, lists the latest steps, and
 * previews the reasoning or answer being written in small text. `summary` collapses it to one line, and
 * `details` is the whole log for whoever asks.
 */
const taskIcons: Record<string, string> = { open: '♟️', running: '♟️', awaiting_verification: '🔎', blocked: '⛔' };

export class StatusCard {
  private readonly steps: Step[] = [];
  /** Delegated tasks by id; those not yet verified or cancelled show under the header. */
  private readonly tasks = new Map<string, { label: string; junior?: string; state: string; blocker?: Blocker }>();
  private phase: CardPhase = 'thinking';
  private running?: string;
  private answer = '';
  private reasoned = 0;
  private frame = 0;
  private readonly started: number;
  /** Set by `summary`: the turn is over and its clock stops. */
  private ended?: number;
  private result?: { status: string; spentUsd: number; requestId?: string; interruption?: Interruption };
  constructor(private readonly redact: (text: string) => string, private readonly options: { now?: () => number; maxSteps?: number } = {}) {
    this.started = this.now();
  }
  private now(): number { return (this.options.now ?? Date.now)(); }

  /** Returns whether the card changed. */
  push(event: HostEvent): boolean {
    if (event.type === 'tool_execution_start') { this.phase = 'running'; this.running = this.redact(describeTool(event)); this.answer = ''; return true; }
    if (event.type === 'tool_execution_end') { this.phase = 'thinking'; this.running = undefined; this.steps.push({ tool: this.redact(describeTool(event)) }); return true; }
    if (event.type === 'text' && typeof event.text === 'string') { this.phase = 'writing'; this.answer = (this.answer + event.text).slice(-2000); return true; }
    if (event.type === 'message_end') { if (this.phase === 'writing') this.phase = 'thinking'; this.answer = ''; return true; }
    if (event.type === 'compaction_start') { this.phase = 'compacting'; return true; }
    if (event.type === 'compaction' || event.type === 'compaction_failed') { this.phase = 'thinking'; this.steps.push({ note: this.redact(describeCompaction(event)) }); return true; }
    if (event.type === 'tip') { this.steps.push({ note: describeTip(event) }); return true; }
    if (event.type === 'task' && typeof event.id === 'string') {
      const parsed = event.state === 'blocked' ? blockerSchema.safeParse(event.blocker) : undefined;
      const blocker = parsed?.success ? { ...parsed.data, reason: this.redact(parsed.data.reason), ...(parsed.data.next ? { next: this.redact(parsed.data.next) } : {}) } : undefined;
      this.tasks.set(event.id, { label: this.redact(String(event.label ?? '')), junior: typeof event.junior === 'string' ? event.junior : undefined, state: String(event.state), blocker });
      return true;
    }
    return false;
  }
  /** Reasoning as it streams. Returns whether the card changed. */
  reason(text: string): boolean {
    if (this.reasoned >= reasoningLimit) return false;
    const kept = this.redact(text).slice(0, reasoningLimit - this.reasoned);
    this.reasoned += kept.length;
    const last = this.steps.at(-1);
    if (last && 'reasoning' in last) last.reasoning += kept;
    else this.steps.push({ reasoning: kept });
    if (this.phase === 'writing') this.phase = 'thinking';
    return true;
  }
  /** Sets the phase and returns the one it replaces, so a pause can put it back. */
  set(phase: CardPhase): CardPhase { const previous = this.phase; this.phase = phase; return previous; }
  /** The heartbeat: moves the card on when nothing else has, so it never looks stuck. */
  tick(): void { this.frame++; }

  render(): string {
    const label = this.phase === 'running' && this.running ? `⚙️ running ${escapeMarkdown(this.running.slice(0, 120))}` : phases[this.phase];
    const header = `${label}${this.phase === 'stopping' ? '' : '.'.repeat(this.frame % 3 + 1)} · ${elapsed(this.now() - this.started)}`;
    const last = this.steps.at(-1);
    const preview = this.phase === 'writing' && this.answer.trim() ? `-# ${escapeMarkdown(tail(this.redact(this.answer), 160))}`
      : this.phase === 'thinking' && last && 'reasoning' in last && last.reasoning.trim() ? `-# 💭 ${escapeMarkdown(tail(last.reasoning, 160))}` : undefined;
    const tools = this.steps.flatMap(step => 'reasoning' in step ? [] : [line(step)]).map(step => step.replace(/\s+/g, ' ').trim()).map(text => `-# ${escapeMarkdown(text.length > 150 ? `${text.slice(0, 147)}...` : text)}`);
    let shown = tools.slice(-(this.options.maxSteps ?? 8));
    const ongoing = [...this.tasks].filter(([, task]) => task.state !== 'verified' && task.state !== 'cancelled')
      .map(([id, task]) => {
        const title = `-# ${taskIcons[task.state] ?? '♟️'} ${id} ${escapeMarkdown(task.label.slice(0, 60))}${task.junior ? ` · ${escapeMarkdown(task.junior)}` : ''} · ${task.state.replaceAll('_', ' ')}`;
        if (task.state !== 'blocked') return title;
        const reason = escapeMarkdown(tail(task.blocker?.reason ?? 'reason not recorded', 160));
        const next = task.blocker?.next ? `\n-# ${task.blocker.needsInput ? 'needs your input' : 'next'}: ${escapeMarkdown(tail(task.blocker.next, 160))}` : task.blocker?.needsInput ? '\n-# needs your input' : '';
        return `${title}... ${reason}${next}`;
      });
    let omittedTasks = 0;
    const compose = () => [header, ...ongoing, ...(omittedTasks ? [`-# … ${omittedTasks} more tasks (details)`] : []), ...(tools.length > shown.length ? [`-# … ${tools.length - shown.length} earlier`] : []), ...shown, ...(preview ? [preview] : [])].join('\n');
    while (shown.length && compose().length > MESSAGE_LIMIT) shown = shown.slice(1);
    while (ongoing.length && compose().length > MESSAGE_LIMIT) { ongoing.pop(); omittedTasks++; }
    return compose().slice(0, MESSAGE_LIMIT);
  }

  private facts(status: string): string {
    const count = this.steps.filter(step => 'tool' in step).length;
    return `${status} · ${count} step${count === 1 ? '' : 's'} · ${elapsed((this.ended ?? this.now()) - this.started)}`;
  }
  /** The card once the turn has ended: one line, with the whole log behind Details. */
  summary(result: { status: string; spentUsd: number; requestId?: string; interruption?: Interruption }): string {
    this.ended ??= this.now();
    this.result = result;
    return result.status === 'cancelled' || result.status === 'stopped' ? `-# ${this.facts('stopped')}` : `-# Result: ${this.facts(result.status)}`;
  }
  /** Every step, with the reasoning between them; attached as a file when too long for a message. */
  details(status: string): CardReply {
    const { steps } = this;
    const title = `**Turn details** · ${this.facts(status)}`;
    const diagnostics = this.result ? [
      `accounted $${this.result.spentUsd.toFixed(6)}`,
      this.result.requestId ? `request ${escapeMarkdown(this.redact(this.result.requestId))}` : undefined,
      this.result.interruption ? this.redact(interruptionDetails(this.result.interruption)) : undefined,
    ].filter(Boolean).join('\n') : '';
    const tasks = [...this.tasks].filter(([, task]) => task.state !== 'verified' && task.state !== 'cancelled').map(([id, task]) => {
      const title = `${id} ${task.label} · ${task.state.replaceAll('_', ' ')}`;
      if (task.state !== 'blocked') return title;
      const next = task.blocker?.next ? `\n${task.blocker.needsInput ? 'needs your input' : 'next'}: ${task.blocker.next}` : task.blocker?.needsInput ? '\nneeds your input' : '';
      return `${title}... ${task.blocker?.reason ?? 'reason not recorded'}${next}`;
    }).join('\n');
    const markdown = steps.map(step => 'reasoning' in step ? step.reasoning.trim().split('\n').map((line, index) => `> ${index ? '' : '💭 '}${escapeMarkdown(line)}`).join('\n') : `- ${escapeMarkdown(line(step))}`).join('\n');
    const text = [title, diagnostics || undefined, tasks ? escapeMarkdown(tasks) : undefined, markdown || (this.ended === undefined ? 'No steps yet.' : 'No steps.')].filter(Boolean).join('\n');
    if (text.length <= MESSAGE_LIMIT) return { text };
    const plain = steps.map(step => 'reasoning' in step ? `\n${step.reasoning.trim()}\n` : `- ${line(step)}`).join('\n');
    return { text: `${title}\nThe full log is attached.`, file: { name: 'turn-details.md', content: `${this.facts(status)}\n\n${diagnostics ? `${diagnostics}\n\n` : ''}${tasks ? `${tasks}\n\n` : ''}${plain.trim()}\n` } };
  }
}

/** Coalesce frequent updates into at most one call per interval, always delivering the latest. */
export function throttle(action: () => Promise<void>, intervalMs: number): { request(): void; flush(): Promise<void> } {
  let last = 0;
  let timer: NodeJS.Timeout | undefined;
  let chain: Promise<void> = Promise.resolve();
  const run = () => { timer = undefined; last = Date.now(); chain = chain.then(action).catch(() => undefined); return chain; };
  return {
    request() {
      if (timer) return;
      const wait = Math.max(0, last + intervalMs - Date.now());
      timer = setTimeout(run, wait);
    },
    async flush() {
      if (timer) { clearTimeout(timer); await run(); }
      await chain;
    },
  };
}
