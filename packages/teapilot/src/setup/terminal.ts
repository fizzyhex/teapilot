import { createInterface } from 'node:readline/promises';
import { PassThrough, Writable } from 'node:stream';
import { stripVTControlCharacters, styleText } from 'node:util';
import { terminalColour, terminalRows, type TerminalPresentation } from '../presentation.js';
import type { ActivityUI } from '../activity.js';
import type { ComposerContext } from '../composer.js';
import { SetupScreen } from './screen.js';
import type { Checkpoint, CheckpointDecision } from '../agents/checkpoint.js';

export interface SetupUI extends ActivityUI {
  input(message: string, fallback?: string, secret?: boolean, signal?: AbortSignal): Promise<string>;
  choose(message: string, choices: string[], fallback?: number, signal?: AbortSignal): Promise<number>;
  confirm(message: string, signal?: AbortSignal): Promise<boolean>;
  log(message: string): void;
  /** Take over the terminal for tabbed setup, when it is interactive and large enough. */
  screen?(): SetupScreen | undefined;
}

/** Bounded checkpoint choices shared by the real terminal and its UI tests. */
export async function terminalCheckpointDecision(checkpoint: Readonly<Checkpoint>, ui: Pick<SetupUI, 'choose' | 'input'> | undefined,
  signal: AbortSignal, options: { interactive: boolean; json: boolean; now?: () => number }): Promise<CheckpointDecision | undefined> {
  const { interactive, json } = options;
  const now = options.now ?? Date.now;
  if (!ui || !interactive || json || signal.aborted || now() >= checkpoint.expiresAt) return undefined;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), Math.max(0, checkpoint.expiresAt - now()));
  const boundedSignal = AbortSignal.any([signal, deadline.signal]);
  const choices = checkpoint.continuation ? ['Continue', 'Change direction', 'Finish partial'] : ['Finish partial'];
  try {
    const choice = await ui.choose('Checkpoint paused. Use Change direction to steer this task; ordinary messages start the next turn.', choices, choices.length - 1, boundedSignal);
    if (boundedSignal.aborted || now() >= checkpoint.expiresAt) return undefined;
    if (!checkpoint.continuation || choice === choices.length - 1) return { requestId: checkpoint.requestId, checkpointId: checkpoint.checkpointId, action: 'finish_partial' };
    if (choice === 0) return { requestId: checkpoint.requestId, checkpointId: checkpoint.checkpointId, action: 'continue', offerId: checkpoint.continuation.offerId };
    if (choice !== 1) return undefined;
    let amendment = '';
    while (!amendment.trim()) {
      amendment = await ui.input('What should change? (blank keeps the checkpoint paused)', undefined, false, boundedSignal);
      if (boundedSignal.aborted || now() >= checkpoint.expiresAt) return undefined;
    }
    return { requestId: checkpoint.requestId, checkpointId: checkpoint.checkpointId, action: 'redirect', offerId: checkpoint.continuation.offerId, amendment: amendment.trim().slice(0, 1000) };
  } catch { return undefined; }
  finally { clearTimeout(timer); }
}

export async function chooseMany(ui: SetupUI, message: string, choices: string[], fallback = 0): Promise<number[]> {
  ui.log(`\n${message}\n${choices.map((choice, index) => `  ${index + 1}. ${choice}`).join('\n')}`);
  for (;;) {
    const answer = (await ui.input('Choose one or more numbers, separated by commas or spaces', String(fallback + 1))).trim() || String(fallback + 1);
    const parts = answer.split(/[\s,]+/);
    const values = parts.map(Number);
    if (parts.every(part => /^\d+$/.test(part)) && values.every(value => Number.isInteger(value) && value >= 1 && value <= choices.length)) {
      return [...new Set(values.map(value => value - 1))];
    }
    ui.log(`Enter numbers from 1 to ${choices.length}, for example 1, 2.`);
  }
}

export function terminalUI(signal: AbortSignal, presentation?: TerminalPresentation): SetupUI & { close(): void; prompt(message: string, cwd: string, context?: ComposerContext): Promise<string> } {
  const colour = terminalColour(process.stderr.isTTY) && !process.env.NODE_DISABLE_COLORS;
  const paint = (format: Parameters<typeof styleText>[0], text: string) => colour ? styleText(format, text, { validateStream: false }) : text;
  // `£` marks anything that can incur charges.
  const charge = paint(['bold', 'yellow'], '£');
  let hidden = false;
  const output = new Writable({ write(chunk, _encoding, callback) {
    if (!hidden) process.stderr.write(chunk);
    callback();
  } });
  Object.defineProperty(output, 'columns', { get: () => process.stderr.columns });
  const resize = () => output.emit('resize');
  process.stderr.on('resize', resize);
  const input = new PassThrough();
  const forward = (chunk: Buffer) => input.write(chunk);
  process.stdin.on('data', forward);
  const terminal = createInterface({ input, output, terminal: Boolean(process.stdin.isTTY) });
  // Readline must not echo stray keys into an operation's live display.
  terminal.pause();
  process.stdin.pause();
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  const write = (text: string) => presentation ? presentation.write(text) : process.stderr.write(text);
  const touch = () => presentation?.touchPrompt();
  process.stdin.prependListener('data', touch);
  const ui = {
    activity: presentation?.activity,
    suspend: () => {
      const resume = presentation?.suspend();
      terminal.pause();
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      return () => resume?.();
    },
    log: (message: string) => {
      const format = message.trim() === 'Ready to save' ? 'bold' : /FAIL|failed|Invalid/.test(message) ? 'red' : /NOT TESTED|not tested|unverified|Not verified|Partial|Skipped/.test(message) ? 'yellow' : /PASS|Passed|Ready|saved/.test(message) ? 'green' : /^(Next:|Then:|  \w+:)/.test(message) ? 'cyan' : 'dim';
      write(`${paint(format, message)}\n`);
    },
    async input(message: string, fallback?: string, secret = false, extraSignal?: AbortSignal): Promise<string> {
      signal.throwIfAborted();
      const label = `${paint('bold', message)}${fallback !== undefined && !secret && fallback !== '' ? paint('cyan', ` [${fallback}]`) : ''}: `;
      const combined = extraSignal ? AbortSignal.any([signal, extraSignal]) : signal;
      const plainLabel = stripVTControlCharacters(label);
      presentation?.beginPrompt(label, () => secret
        ? { rows: Math.floor(plainLabel.length / (process.stderr.columns || 80)), cols: plainLabel.length % (process.stderr.columns || 80) }
        : terminal.getCursorPos());
      let submitted = false;
      let answer = '';
      if (secret) { process.stderr.write(label); hidden = true; }
      try {
        process.stdin.resume();
        if (process.stdin.isTTY) process.stdin.setRawMode(true);
        answer = await terminal.question(secret ? '' : label, { signal: combined });
        submitted = true;
        return answer.trim() || fallback || '';
      } finally {
        terminal.pause();
        process.stdin.pause();
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        hidden = false;
        if (secret || !submitted) process.stderr.write('\n');
        const text = plainLabel + (secret ? '' : answer);
        const occupied = submitted && terminalRows(text, process.stderr.columns || 80) !== undefined
          ? Math.floor(text.length / (process.stderr.columns || 80)) + 1 : undefined;
        presentation?.endPrompt(submitted, occupied ?? Number.MAX_SAFE_INTEGER);
      }
    },
    async choose(message: string, choices: string[], fallback = 0, extraSignal?: AbortSignal): Promise<number> {
      write(`\n${paint('bold', message)}\n\n`);
      choices.forEach((choice, index) => write(`  ${paint('cyan', String(index + 1))}. ${choice}\n`));
      for (;;) {
        const value = Number(await ui.input('Choose', String(fallback + 1), false, extraSignal));
        if (Number.isInteger(value) && value >= 1 && value <= choices.length) return value - 1;
        ui.log(`Enter a number from 1 to ${choices.length}.`);
      }
    },
    confirm: async (message: string, extraSignal?: AbortSignal) => {
      try { let r = (await ui.input(`${message} Type yes to confirm`, 'no', false, extraSignal)); return r === 'yes' || r === "ya"; }
      catch (error) { if (signal.aborted || extraSignal?.aborted) return false; throw error; }
    },
    prompt: async (message: string, cwd: string, context?: ComposerContext) => {
      const { promptInput } = await import('../prompt.js');
      terminal.pause();
      process.stdin.removeListener('data', forward);
      presentation?.pause();
      const art = presentation && context ? { begin: presentation.beginComposer.bind(presentation), end: presentation.endPrompt.bind(presentation) } : undefined;
      try { return await promptInput(message, cwd, signal, context, art); }
      finally { process.stdin.on('data', forward); }
    },
    screen: () => {
      if (!process.stdin.isTTY || !process.stderr.isTTY || process.env.TERM === 'dumb' || (process.stderr.columns || 0) < 60 || (process.stderr.rows || 0) < 24) return undefined;
      presentation?.pause();
      terminal.pause();
      // The screen reads keys itself until it closes.
      process.stdin.removeListener('data', forward);
      process.stdin.removeListener('data', touch);
      const screen = new SetupScreen({ colour, motion: presentation?.motion ?? false, onClose: () => { process.stdin.on('data', forward); process.stdin.prependListener('data', touch); } });
      screen.open();
      return screen;
    },
    close: () => { process.stdin.removeListener('data', forward); input.destroy(); process.stdin.pause(); process.stdin.removeListener('data', touch); process.stderr.removeListener('resize', resize); terminal.close(); },
  };
  terminal.on('SIGINT', () => process.emit('SIGINT'));
  return ui;
}
