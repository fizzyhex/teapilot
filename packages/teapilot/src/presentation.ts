import { formatSize, type HostEvent } from './integration/events.js';
import { stripVTControlCharacters } from 'node:util';
import type { Activity, ActivityUI } from './activity.js';
import { loadClips, Playback, type Clips } from './art/playback.js';
import { cellWidth, graphemes } from './composer.js';
import type { Checkpoint } from './agents/checkpoint.js';

const ACTIVITY_COLOUR = '38;2;186;187;241'; // #babbf1
// this is catpuccin lavender :3
/** Gossip is background chatter: everything, art included, in the composer's light grey. */
const GOSSIP_COLOUR = '38;2;139;148;158';

export function terminalColour(tty: boolean | undefined, env = process.env): boolean {
  return Boolean(tty && env.TERM !== 'dumb' && env.NO_COLOR === undefined);
}
const paint = (text: string, code: string, enabled: boolean) => enabled ? `\x1b[${code}m${text}\x1b[0m` : text;

/** One line summarising a completed tool call, for a per-call progress trail; a junior's calls carry its name. */
export function describeTool(event: HostEvent): string {
  return (typeof event.junior === 'string' ? `${event.junior}: ` : '') + describeCall(event);
}

function describeCall(event: HostEvent): string {
  const tool = String(event.tool ?? '');
  const suffix = event.refused ? ' — refused' : event.isError ? ' — failed' : '';
  const path = typeof event.path === 'string' ? event.path : undefined;
  if ((tool === 'write' || tool === 'edit') && path) {
    const size = typeof event.size === 'number' ? ` (${formatSize(event.size)})` : '';
    return `${tool} ${path}${size}${suffix}`;
  }
  if (tool === 'read' && path) return `read ${path}${suffix}`;
  if (typeof event.command === 'string') return `shell: ${event.command}${suffix}`;
  if (tool === 'web_read' && typeof event.url === 'string') return `web_read ${event.url}${suffix}`;
  if (tool === 'delegate_task' && typeof event.to === 'string') return `delegate_task → ${event.to}${suffix}`;
  return `${tool}${suffix}`;
}

/** One line for a compaction (agents/compaction.ts), which takes a model call of its own, for the same trail. */
export function describeCompaction(event: HostEvent): string {
  const what = event.trigger === 'history' ? 'earlier turns' : 'earlier context';
  const took = typeof event.ms === 'number' ? ` in ${Math.max(1, Math.round(event.ms / 1000))}s` : '';
  if (event.type === 'compaction_failed') return `compacting ${what} failed${took}; carrying on without it`;
  const size = typeof event.tokensBefore === 'number' ? ` (${(event.tokensBefore / 1000).toFixed(1)}k tokens)` : '';
  return `compacted ${what}${size} into a summary${took}`;
}

/** One line for a tip the host gave the model (agents/tips.ts); a junior's carry its name. */
export function describeTip(event: HostEvent): string {
  return `${typeof event.junior === 'string' ? `${event.junior}: ` : ''}💡 ${String(event.name ?? '')}`;
}

/** Style complete lines, retaining every Markdown character and code indent. */
export class MarkdownOutput {
  private pending = '';
  private fence?: string;
  constructor(private readonly write: (text: string) => void, private readonly colour: boolean) { }
  push(text: string): void {
    this.pending += text;
    let end: number;
    while ((end = this.pending.indexOf('\n')) >= 0) {
      this.write(this.line(this.pending.slice(0, end)) + '\n');
      this.pending = this.pending.slice(end + 1);
    }
    // Long unbroken output remains bounded and literal, without guessing markup.
    if (this.pending.length > 4096) { this.write(this.pending); this.pending = ''; }
  }
  get preview(): string { return this.pending; }
  discardPreview(): void { this.pending = ''; this.fence = undefined; }
  finish(): void { if (this.pending) this.write(this.line(this.pending)); this.pending = ''; this.fence = undefined; }
  private line(text: string): string {
    const marker = text.match(/^\s{0,3}(`{3,}|~{3,})/)?.[1];
    if (marker) {
      if (!this.fence) this.fence = marker;
      else if (marker[0] === this.fence[0] && marker.length >= this.fence.length) this.fence = undefined;
      return text;
    }
    if (this.fence || /^( {4}|\t)/.test(text)) return text;
    if (/^#{1,6} /.test(text)) return paint(text, '1;32', this.colour);
    return text.split(/(`+[^`]*`+|https?:\/\/\S+)/g).map((part, index) => index % 2 ? part :
      part.replace(/\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_/g, match => paint(match, match.startsWith('**') || match.startsWith('__') ? '1' : '3', this.colour))).join('');
  }
}

/** Only track text whose cell width is unambiguous in our supported terminals.
 * Other text still streams immediately, but without cursor-relative decoration. */
export function terminalRows(text: string, columns: number): number | undefined {
  if (!columns) return undefined;
  const plain = stripVTControlCharacters(text);
  if (/[^\x20-\x7e\n\u00a0-\u024f\u2010-\u2027]/u.test(plain)) return undefined;
  return plain.split('\n').reduce((rows, line) => rows + Math.max(1, Math.ceil(line.length / columns)), 0);
}

/** Rows occupied when wrapping is certain however the terminal sizes emoji,
 * East Asian text or tabs: the narrowest and widest readings must agree. */
export function certainRows(text: string, columns: number): number | undefined {
  if (!columns) return undefined;
  const plain = stripVTControlCharacters(text).replace(/\r(?=\n)/g, '');
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(plain)) return undefined;
  let total = 0;
  for (const line of plain.split('\n')) {
    let least = 0, most = 0;
    if (/^[\x20-\x7e -ɏ‐-‧]*$/u.test(line)) least = most = line.length;
    else for (const { segment } of graphemes(line)) {
      if (segment === '\t') { least += 1; most += 8; }
      else if (/^[\x20-\x7e -ɏ‐-‧]$/u.test(segment)) { least++; most++; }
      // A cluster may render as one cell, or as two cells per code point.
      else { least += Math.min(1, cellWidth(segment)); most += 2 * [...segment].length; }
    }
    const rows = Math.max(1, Math.ceil(least / columns));
    if (rows !== Math.max(1, Math.ceil(most / columns))) return undefined;
    total += rows;
  }
  return total;
}

export class TerminalPresentation implements ActivityUI {
  private readonly colour = terminalColour(process.stderr.isTTY && process.stdout.isTTY);
  private readonly stream = Boolean(process.stdout.isTTY && process.stderr.isTTY && process.env.TERM !== 'dumb');
  /** A conversational reply is not streamed: it is shown a line at a time once it is complete. */
  private casual = false;
  private readonly markdown = new MarkdownOutput(text => this.output(text), terminalColour(process.stdout.isTTY));
  private readonly playback = new Playback(() => this.draw());
  private current?: Activity;
  private scopes: Array<{ activity: Activity }> = [];
  private base?: Activity;
  private message = '';
  private lastMessage = '';
  private messageOpen = false;
  private literal = false;
  private previewRows = 0;
  // The activity block sits above the output it describes. Output below it is
  // counted so frames can be redrawn relative to the cursor.
  private artRows: string[] = [];
  private belowRows = 0;
  private tail = '';
  private fresh = false;
  private settling = false;
  private prompt?: { touched: boolean; safe: boolean; label?: string; cursor: () => { rows: number; cols: number } };
  private contextRows = 0;
  private suppressed = false;
  private pendingApproval = false;
  private suspended = 0;
  private closed = false;
  private lastLabel = '';
  private listening = false;
  private clipKind?: Activity['kind'];
  private deferred: Array<{ text: string; target: 'stdout' | 'stderr' }> = [];
  private readonly resize = () => {
    if (!this.artRows.length && !this.previewRows && !this.prompt) {
      this.suppressed = false; this.update(); return;
    }
    // Reflow has already happened: never move up using pre-resize coordinates.
    this.playback.stop(); this.forget(); this.previewRows = 0;
    this.suppressed = true;
    if (this.prompt) { this.prompt.touched = true; this.prompt.safe = false; }
    else {
      process.stderr.write('\n');
      // Any live preview is now committed at its reflowed location.
      if (this.messageOpen) { this.literal = true; this.markdown.discardPreview(); }
      this.textStatus();
    }
  };
  private readonly drain = () => { if (!this.closed) this.draw(); };
  constructor(private readonly json: boolean, private readonly noMotion: boolean, private readonly random = Math.random) { }

  /** Whether animation is allowed at all, before terminal size is considered. */
  get motion(): boolean {
    return !this.json && !this.noMotion && process.env.TEAPILOT_NO_MOTION === undefined && !process.env.CI;
  }
  private eligible(): boolean {
    return !this.closed && !this.json && !this.noMotion && this.stream && Boolean(process.stdin.isTTY)
      && process.env.TEAPILOT_NO_MOTION === undefined && !process.env.CI && !this.suppressed
      && (process.stderr.columns || 0) >= 61 && (process.stderr.rows || 0) >= 36;
  }
  private listen(): void {
    if (this.listening) return;
    this.listening = true;
    process.stderr.on('resize', this.resize);
    process.stderr.on('drain', this.drain);
    process.stdout.on('drain', this.drain);
  }
  private writable(): boolean { return !process.stderr.writableNeedDrain && !process.stdout.writableNeedDrain; }
  private label(): string { return this.prompt ? 'Waiting for your input...' : this.current?.label ?? ''; }
  private textStatus(): void {
    const label = this.label();
    if (!this.json && !this.prompt && !this.suspended && label && label !== this.lastLabel) {
      this.lastLabel = label;
      // Do not insert status into a response's unfinished line.
      if (!this.messageOpen) process.stderr.write(`${label}\n`);
    }
  }
  private eraseRows(rows: number): void {
    if (!rows) return;
    process.stderr.write(`\r\x1b[${rows}A` + Array.from({ length: rows }, () => '\x1b[2K\x1b[1B').join('') + `\x1b[${rows}A`);
  }
  /** Erase the unfinished-line preview; the activity block stays in place. */
  clear(): void {
    if (this.prompt) return;
    this.eraseRows(this.previewRows);
    this.belowRows = Math.max(0, this.belowRows - this.previewRows);
    this.previewRows = 0;
  }
  private forget(): void { this.artRows = []; this.belowRows = 0; this.tail = ''; this.fresh = false; this.settling = false; }
  /** Delete the block while it is on-screen, moving later output up intact. */
  private collapse(): void {
    this.playback.stop();
    if (this.prompt) return;
    this.clear();
    const rows = this.artRows.length;
    if (rows && !this.tail && this.belowRows + rows < (process.stderr.rows || 0)) {
      process.stderr.write(`\r\x1b[${this.belowRows + rows}A\x1b[${rows}M` + (this.belowRows ? `\x1b[${this.belowRows}B` : ''));
    }
    this.forget();
  }
  /** Leave the block in scrollback once relative redraws can no longer reach it. */
  private freeze(): void {
    // The block's own position is still known even when the write that
    // triggered this is not: delete every row it drew while that is safe,
    // rather than leaving a stray frame line behind. Only fall back to
    // clearing the status label alone once the block may have scrolled off.
    const rows = this.artRows.length;
    if (!this.tail) {
      if (rows && this.belowRows + rows < (process.stderr.rows || 0)) {
        process.stderr.write(`\r\x1b[${this.belowRows + rows}A\x1b[${rows}M` + (this.belowRows ? `\x1b[${this.belowRows}B` : ''));
      } else process.stderr.write(`\r\x1b[${this.belowRows + 1}A\x1b[2K\r\x1b[${this.belowRows + 1}B`);
    }
    this.playback.stop(); this.forget();
  }
  /** Literal output is untracked: keep the block, but stop redrawing it. */
  private stopTracking(): void {
    this.clear();
    if (this.artRows.length && !this.prompt) this.freeze(); else this.playback.stop();
  }
  /** Write output below the block, tracking the rows it occupies. */
  private output(text: string, target: 'stdout' | 'stderr' = 'stdout'): void {
    if (this.artRows.length && !this.prompt) {
      const columns = process.stderr.columns || 0;
      const lines = (this.tail + stripVTControlCharacters(text)).split('\n');
      const tail = lines.pop()!;
      let below: number | undefined = this.belowRows;
      for (const line of lines) { const rows = certainRows(line, columns); below = below === undefined || rows === undefined ? undefined : below + rows; }
      const tailRows = certainRows(tail, columns);
      // Freeze before a write that is unmeasurable or would scroll the block away.
      if (below === undefined || tailRows === undefined
        || below + tailRows - 1 + this.artRows.length >= (process.stderr.rows || 0)) this.freeze();
      else { this.belowRows = below; this.tail = tail; }
    }
    process[target].write(text);
  }
  private draw(): void {
    if (this.closed || this.suspended || !this.writable()) return;
    if (this.prompt) { this.drawPrompt(); return; }
    if (!this.eligible() || (this.messageOpen && this.literal)) return;
    const frame = this.playback.frame;
    if (!frame || !this.current || this.tail) return;
    const rows = [...frame.split('\n'), this.label().slice(0, process.stderr.columns - 1)];
    if (!this.artRows.length) {
      // A block is allocated only when a clip starts, never inside a response.
      if (!this.fresh || this.messageOpen) return;
      process.stderr.write(paint(rows.join('\n'), this.artColour, this.colour) + '\n');
      this.fresh = false; this.belowRows = 0; this.tail = '';
    } else if (this.artRows.length === rows.length) {
      // Output below is stable between events. Change only artwork rows.
      let update = '';
      rows.forEach((row, index) => {
        if (row !== this.artRows[index]) {
          const distance = this.belowRows + rows.length - index;
          update += `\r\x1b[${distance}A\x1b[2K${paint(row, this.artColour, this.colour)}\r\x1b[${distance}B`;
        }
      });
      if (update) process.stderr.write(update);
    } else return;
    this.artRows = rows;
  }
  private startClip(clips: Clips, delay: number): void {
    const kind = this.current!.kind;
    // Reasoning alternates between working and a tea break, chosen per episode.
    const typing = kind === 'composing' || (kind === 'reasoning' && this.random() < 0.5);
    this.clipKind = kind; this.fresh = !this.artRows.length;
    this.playback.play(typing ? clips.typing : clips['tea-break'], undefined, typing, delay);
  }
  private update(): void {
    const next = this.scopes.at(-1)?.activity ?? this.base;
    const sameKind = next?.kind === this.clipKind;
    this.current = next;
    if (this.prompt || this.suspended || this.closed) return;
    // Received-input paws finish first; their end continues with this activity.
    if (this.settling && next) { this.draw(); return; }
    if (!next) { this.clipKind = undefined; this.collapse(); this.showPreview(); this.lastLabel = ''; return; }
    if (!this.json && !this.noMotion && this.stream && process.env.TEAPILOT_NO_MOTION === undefined && !process.env.CI) this.listen();
    const clips = this.eligible() ? loadClips() : undefined;
    if (!clips) { this.clipKind = undefined; this.collapse(); this.showPreview(); this.textStatus(); return; }
    this.listen();
    if (sameKind) { this.draw(); return; }
    // Short operations never allocate a block; an existing block switches at once.
    this.startClip(clips, this.artRows.length ? 0 : 250);
  }
  setActivity = (activity: Activity | undefined): void => { this.base = activity; this.update(); };
  activity = (activity: Activity): (() => void) => {
    const scope = { activity }; this.scopes.push(scope); this.update();
    let ended = false;
    return () => {
      if (ended) return; ended = true;
      this.scopes = this.scopes.filter(item => item !== scope); this.update();
    };
  };
  start(): void { this.casual = false; this.setActivity({ kind: 'waiting', label: 'Preparing request...' }); }
  pause(): void { this.base = undefined; this.scopes = []; this.current = undefined; this.clipKind = undefined; this.collapse(); }
  suspend = (): (() => void) => {
    this.collapse(); this.suspended++;
    let resumed = false;
    return () => { if (!resumed) { resumed = true; this.suspended--; this.clipKind = undefined; this.playback.frame = undefined; this.update(); } };
  };
  write(text: string, target: 'stdout' | 'stderr' = 'stderr'): void {
    if (this.messageOpen) { this.deferred.push({ text, target }); return; }
    this.clear();
    this.output(text, target);
    this.contextRows += terminalRows(text, process.stderr.columns || 80) ?? process.stderr.rows ?? 36;
    this.draw();
  }
  log(text: string): void { this.write(`${paint(text, this.muted ? GOSSIP_COLOUR : '32', this.colour && !this.json)}\n`); }

  private muted = false;
  private get artColour(): string { return this.muted ? GOSSIP_COLOUR : ACTIVITY_COLOUR; }
  /** Gossip mode until the returned function is called: grey text and art, with the tea-break clip while agents think. */
  gossip(): { line(text: string, kind?: 'header' | 'thought' | 'post' | 'status'): void; activity(label: string | undefined): void; end(): void } {
    this.pause(); this.endMessage(); this.muted = true;
    const style = { header: `1;${GOSSIP_COLOUR}`, thought: `3;${GOSSIP_COLOUR}`, post: GOSSIP_COLOUR, status: `2;${GOSSIP_COLOUR}` };
    return {
      line: (text, kind = 'status') => { if (!this.closed && !this.json) this.write(`${paint(text, style[kind], this.colour)}\n`); },
      activity: label => this.setActivity(label ? { kind: 'reasoning', label } : undefined),
      end: () => { this.pause(); this.muted = false; },
    };
  }
  approval(text: string): void {
    this.endMessage(); this.clipKind = undefined; this.collapse(); this.contextRows = 0;
    this.write(`${paint('Approval', '1;33', this.colour && !this.json)}\n${text}\n`);
    // The next prompt is the confirmation for this approval: keep the command
    // and "Approve this action?" adjacent, with no artwork drawn between them.
    this.pendingApproval = true;
  }

  /** Render host-authored checkpoint facts separately from an unverified model proposal. */
  checkpoint(checkpoint: Readonly<Checkpoint>, redact: (text: string) => string): void {
    this.pause();
    this.write(`\n${paint('1;33', 'Checkpoint', this.colour && !this.json)} · request-local; not resumable after restart\n`);
    for (const fact of checkpoint.summary) this.write(`  • ${redact(fact)}\n`);
    if (checkpoint.continuation) this.write(`  next window: ${checkpoint.continuation.instructorCalls} instructor calls, ${Math.ceil(checkpoint.continuation.activeMs / 60_000)}m active${checkpoint.continuation.freshContext ? ', fresh context' : ''}\n`);
    else this.write('  no continuation window remains inside this request authorization\n');
    if (checkpoint.modelHandoff) this.write(`  model proposal (unverified): ${redact(checkpoint.modelHandoff)}\n`);
  }

  /** Start before readline.question, then paint only while its input is untouched. */
  beginPrompt(label: string, cursor: () => { rows: number; cols: number }): void {
    this.endMessage(); this.clipKind = undefined; this.collapse();
    this.suppressed = false;
    const pendingApproval = this.pendingApproval; this.pendingApproval = false;
    const rows = terminalRows(label, process.stderr.columns || 0);
    const clips = !pendingApproval && this.eligible() && rows !== undefined && this.contextRows + rows + 19 < process.stderr.rows ? loadClips() : undefined;
    this.prompt = { touched: false, safe: Boolean(clips), label: 'Waiting for your input...', cursor };
    if (clips) {
      this.listen();
      // Allocate above the prompt before readline writes it. Subsequent frames
      // move relative to readline's public cursor position, never saved cursors.
      this.artRows = [...clips.pawing.frames[2]!.split('\n'), 'Waiting for your input...'];
      process.stderr.write(
        paint(this.artRows.join('\n'), this.artColour, this.colour) + '\n'
      );
      this.playback.play(clips.pawing, [2, 3]);
    }
  }
  /** Above the chat composer: a sip of tea after the last turn, then open paws. */
  beginComposer(cursor: () => { rows: number; cols: number }): void {
    this.endMessage(); this.clipKind = undefined; this.collapse();
    this.suppressed = false;
    // Room for the art, a spacer, and the composer's initial three rows.
    const clips = this.eligible() && this.contextRows + 22 < process.stderr.rows ? loadClips() : undefined;
    this.prompt = { touched: false, safe: Boolean(clips), cursor };
    if (clips) {
      this.listen();
      const sip = clips['tea-break'];
      this.artRows = sip.frames[0]!.split('\n');
      process.stderr.write(paint(this.artRows.join('\n'), this.artColour, this.colour) + '\n');
      this.playback.play(sip, undefined, false, 0, () => this.playback.play(clips.pawing, [2, 3]));
    }
  }
  touchPrompt = (): void => {
    if (!this.prompt || this.prompt.touched) return;
    this.prompt.touched = true; this.playback.stop();
  };
  private drawPrompt(): void {
    const prompt = this.prompt;
    if (!prompt?.safe || prompt.touched || !this.playback.frame || !this.artRows.length) return;
    const position = prompt.cursor();
    const rows = [...this.playback.frame.split('\n'), ...prompt.label ? [prompt.label] : []];
    if (rows.every((row, index) => row === this.artRows[index])) return;
    const distance = rows.length + position.rows;
    process.stderr.write(
      `\r\x1b[${distance}A` +
      paint(rows.join('\n'), this.artColour, this.colour) +
      `\r\x1b[${position.rows + 1}B` +
      (position.cols ? `\x1b[${position.cols}C` : '')
    );
    this.artRows = rows;
  }
  endPrompt(submitted: boolean, occupiedRows: number): void {
    const prompt = this.prompt;
    this.playback.stop();
    // Once a long input has scrolled, its old artwork belongs to scrollback.
    const reclaim = !this.closed && prompt?.safe && occupiedRows + this.artRows.length < (process.stderr.rows || 0);
    if (reclaim && this.artRows.length) {
      const distance = this.artRows.length + occupiedRows;
      // Delete exactly our artwork rows, moving the accepted prompt up intact.
      process.stderr.write(`\r\x1b[${distance}A\x1b[${this.artRows.length}M`
        + (occupiedRows ? `\x1b[${occupiedRows}B` : ''));
    }
    this.prompt = undefined; this.forget(); this.contextRows = 0; this.clipKind = undefined;
    this.suppressed = !prompt?.safe && this.suppressed;
    const clips = submitted && reclaim && this.eligible() ? loadClips() : undefined;
    if (clips) {
      // A fresh, owned block below the accepted prompt avoids rewriting input.
      // It closes the paws, then becomes the block for whatever runs next.
      this.current = this.scopes.at(-1)?.activity ?? this.base ?? { kind: 'waiting', label: 'Input received' };
      this.fresh = true; this.settling = true;
      this.playback.play(clips.pawing, [4, 5, 6], false, 0, () => { this.settling = false; this.clipKind = undefined; this.update(); });
    } else {
      this.playback.frame = undefined;
      if (this.scopes.length || this.base) this.update();
    }
  }

  private showPreview(): void {
    const text = this.markdown.preview;
    if (!text || this.literal) return;
    const rows = certainRows(text, process.stderr.columns || 0);
    if (!this.eligible() || !this.writable() || rows === undefined || rows + 19 >= process.stderr.rows) {
      this.stopTracking(); this.literal = true; this.markdown.finish(); return;
    }
    this.output(text + '\n'); this.previewRows = rows;
  }
  event(event: HostEvent): void {
    if (this.json) return;
    if (event.type === 'text' && typeof event.text === 'string') {
      if (!this.stream || this.casual) return;
      this.clear();
      if (!this.messageOpen) {
        const clips = this.eligible() ? loadClips() : undefined;
        this.literal = !clips;
        if (!clips) this.collapse();
        // Allocate the block above the response before its first line.
        else if (!this.artRows.length && this.current && !this.settling) this.startClip(clips, 0);
        this.output(paint('\nResponse\n', '1', terminalColour(process.stdout.isTTY)));
        this.messageOpen = true; this.message = '';
      }
      this.message += event.text;
      if (!this.literal) {
        const pending = (this.markdown.preview + event.text).split('\n').at(-1)!;
        const rows = certainRows(pending, process.stderr.columns || 0);
        if (!this.writable() || rows === undefined || rows + 19 >= process.stderr.rows || pending.length > 4096) {
          this.stopTracking(); this.literal = true; this.markdown.finish();
        }
      }
      if (this.literal) this.output(event.text);
      else { this.markdown.push(event.text); this.showPreview(); this.draw(); }
    } else if (event.type === 'route') this.casual = event.casual === true;
    else if (event.type === 'message_end') { this.clear(); this.endMessage(); this.draw(); }
    else if (event.type === 'tool_execution_start') this.setActivity({ kind: 'waiting', label: `${typeof event.junior === 'string' ? `${event.junior}: ` : ''}Running ${String(event.tool)}...` });
    else if (event.type === 'tool_execution_end') this.write(`${paint(describeTool(event), '2', this.colour)}\n`);
    else if (event.type === 'compaction' || event.type === 'compaction_failed') this.write(`${paint(describeCompaction(event), '2', this.colour)}\n`);
    else if (event.type === 'tip') this.write(`${paint(describeTip(event), '2', this.colour)}\n`);
    else if (event.type === 'request_end' || event.type === 'request_error') this.pause();
  }
  private endMessage(): void {
    if (!this.messageOpen) return;
    this.clear();
    if (!this.literal) this.markdown.finish();
    if (!this.message.endsWith('\n')) this.output('\n');
    this.lastMessage = this.message; this.messageOpen = false; this.literal = false;
    for (const output of this.deferred.splice(0)) this.write(output.text, output.target);
  }
  answer(text: string): void {
    this.pause(); this.endMessage();
    if (this.stream && !this.casual && text === this.lastMessage) return;
    this.markdown.push(text); this.markdown.finish();
    if (!text.endsWith('\n')) process.stdout.write('\n');
  }
  close(): void {
    if (this.closed) return;
    this.pause(); this.endMessage(); this.closed = true;
    process.stderr.removeListener('resize', this.resize);
    process.stderr.removeListener('drain', this.drain);
    process.stdout.removeListener('drain', this.drain);
  }
}
