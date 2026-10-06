import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { Policy } from '../config.js';
import { savedLine } from '../workspace/scratch.js';
import { RequestRecovery } from '../agents/recovery.js';

/** overthinking: the reply ran out of tokens while still thinking, so a retry thinks less rather than more. */
export type EscalationReason = 'test_failures' | 'tool_failures' | 'ineffective_calls' | 'unsupported' | 'uncertainty' | 'turn_limit' | 'provider_error' | 'overthinking';
export const SEARCH_UNAVAILABLE = 'No results: the search engines were unavailable';
export const READS_SPENT = 'Not read: the page-reading budget for this request is spent';
// A hard ceiling on consecutive tool failures, independent of the escalation policy's own
// (much lower) threshold: the model is warned as it nears this, then the attempt pauses for
// the user to explicitly approve continuing, rather than escalating or stopping on its own.
const CONSECUTIVE_FAILURE_LIMIT = 15;
const CONSECUTIVE_FAILURE_WARNING_LEAD = 5;
/** Keep the check classifier shared by live escalation and durable task execution state. */
export function isCheckCommand(command: string): boolean {
  return /\b(test|build|check|typecheck|pytest|cargo|dotnet)\b/i.test(command);
}
export class Evidence {
  reason?: EscalationReason;
  toolCalls = 0;
  failures = 0;
  testFailures = 0;
  lastCheck?: 'passed' | 'failed';
  warning?: string;
  /** Set once consecutive tool failures reach CONSECUTIVE_FAILURE_LIMIT; the caller must get the user's explicit approval before another tool call runs. */
  awaitingContinue = false;
  changedFiles = new Set<string>();
  fileSizes = new Map<string, number>();
  largestResult?: { tool: string; chars: number };
  unresolvedChecks: Set<string>;
  checks: Array<{ command: string; status: 'passed' | 'failed' }> = [];
  private readonly explicitUnresolvedChecks: Set<string>;
  /** The latest calls for a retry to continue from: what each was asked, how it ended, and where its full output went. */
  observations: Array<{ tool: string; args?: string; failed: boolean; detail: string; saved?: string }> = [];
  /** Distinct failed calls and the first line of each error, for a later turn to avoid repeating them. */
  failedCalls: Array<{ call: string; error: string }> = [];
  // Set once a search repeats after its warning: further searches are refused so the model answers instead.
  searchExhausted = false;
  // Set once page reads are spent or keep returning the same page: web_read is withdrawn like search.
  readsExhausted = false;
  // Calls refused before execution (unknown tool, invalid arguments, host refusal) never reach observe().
  // A streak of them first withdraws tools so the model answers, then stops the attempt.
  get refused(): number { return this.recovery.refused; }
  set refused(value: number) { this.recovery.refused = value; }
  answerNow = false;
  /** Why tools are withdrawn when answerNow is set, for the notice that asks for the answer. */
  answerWhy = 'Those calls could not run';
  /**
   * `scratch` tells the agent's own scratchpad files apart: writing them changes nothing in the project.
   * `context` names the context this attempt works in (a junior's turn, an orchestrator's checkpoint generation): a fresh
   * context does not see what an earlier one read or loaded, so doing it again is not a repeat. Repeated failures stay request-wide.
   */
  constructor(private readonly thresholds: Policy['escalation'], unresolvedChecks: string[] = [], private readonly scratch?: (path: string) => boolean,
    private readonly recovery = new RequestRecovery(), private readonly readOnly = false, private readonly context = '') {
    this.explicitUnresolvedChecks = new Set(unresolvedChecks);
    this.unresolvedChecks = new Set(this.explicitUnresolvedChecks);
  }
  /** Reconcile durable failures without dropping unresolved checks supplied only by the caller. */
  syncUnresolvedChecks(hostChecks: string[]): void {
    this.unresolvedChecks = new Set([...this.explicitUnresolvedChecks, ...hostChecks]);
  }
  refuse(): void {
    if (++this.refused < this.thresholds.repeatedToolCalls) return;
    if (this.answerNow || this.recovery.refusalWarned) this.reason = 'ineffective_calls';
    else { this.answerNow = true; this.refused = 0; this.recovery.refusalWarned = true; }
  }
  /** Observe sequential paging, not semantic relevance: different slices may still be useful evidence. */
  observePaging(name: string, args: unknown, failed: boolean, pressure: boolean, actor = 'instructor'): string | undefined {
    const data = args as { path?: string; id?: string; url?: string; offset?: number; search?: string };
    const source = name === 'web_read' ? data.url : ['read', 'artifact_read'].includes(name) && !data.search ? data.path ?? data.id : undefined;
    if (failed || !source) { this.recovery.paging.delete(actor); return undefined; }
    const offset = data.offset ?? 1;
    const previous = this.recovery.paging.get(actor);
    const consecutive = previous?.source === source && (name === 'web_read' || offset >= previous.offset);
    const current = { source, offset, count: consecutive ? previous.count + 1 : 1, warned: consecutive ? previous.warned : false };
    this.recovery.paging.set(actor, current);
    if (current.count >= 6 && current.warned && pressure && this.readOnly) {
      this.answerNow = true; this.answerWhy = 'continued sequential paging under context pressure';
      return 'exploration is finished: report source-backed findings and gaps from the evidence already read.';
    }
    if (current.count >= 4 && !current.warned) {
      current.warned = true;
      return 'you have read several consecutive sections of this source; search for the specific question or report the findings you already have.';
    }
    return undefined;
  }
  observe(name: string, args: unknown, failed: boolean, result?: string, saved?: string, changed?: boolean, identity?: string): void {
    this.warning = undefined; this.refused = 0; this.recovery.refusalWarned = false;
    const data = args as { path?: string; command?: string };
    const asked = args && typeof args === 'object' ? ['command', 'path', 'url', 'query'].map(key => (args as Record<string, unknown>)[key]).find(value => typeof value === 'string') as string | undefined : undefined;
    this.observations.push({ tool: name, ...(asked ? { args: asked.slice(0, 200) } : {}), failed, detail: (result ?? '').slice(0, 700), ...(saved ? { saved } : {}) });
    this.observations = this.observations.slice(-6);
    // Cheap signal for which call likely dominated context, without re-serializing on demand.
    const chars = (result ?? '').length + JSON.stringify(args ?? {}).length;
    if (!this.largestResult || chars > this.largestResult.chars) this.largestResult = { tool: name, chars };
    this.failures = failed ? this.failures + 1 : 0;
    const remaining = CONSECUTIVE_FAILURE_LIMIT - this.failures;
    if (this.failures >= CONSECUTIVE_FAILURE_LIMIT) this.awaitingContinue = true;
    else if (this.failures && remaining <= CONSECUTIVE_FAILURE_WARNING_LEAD) this.warning = `You have had ${this.failures} consecutive tool failures. ${remaining} more in a row will require the user's approval to continue. Make sure you are taking the right approach.`;
    if (failed) {
      // Where a long result was saved differs per call; the error itself is what repeats.
      const error = (result ?? '').replace(savedLine, '').trim();
      const call = asked ? `${name}: ${asked.slice(0, 200)}` : name;
      const first = error.split('\n').find(line => line.trim())?.trim().slice(0, 200) ?? '';
      if (!this.failedCalls.some(item => item.call === call && item.error === first)) this.failedCalls = [...this.failedCalls, { call, error: first }].slice(-8);
      // The same error from the same tool, whatever the arguments, is a loop; a project edit in between clears the count.
      const key = `${name}:${data.path ?? ''}:failed:${createHash('sha256').update(error).digest('hex')}`;
      if (name === 'bash') this.recovery.commands.set(key, String(data.command ?? ''));
      const same = (this.recovery.repeated.get(key) ?? 0) + 1;
      this.recovery.repeated.set(key, same);
      if (same >= this.thresholds.repeatedToolCalls) this.reason = 'tool_failures';
    }
    if (name === 'bash' && isCheckCommand(String((args as { command?: string }).command))) {
      this.lastCheck = failed ? 'failed' : 'passed';
      if (failed) this.unresolvedChecks.add(String(data.command));
      else {
        this.unresolvedChecks.delete(String(data.command));
        this.explicitUnresolvedChecks.delete(String(data.command));
      }
      this.checks.push({ command: String(data.command).slice(0, 1000), status: this.lastCheck });
      this.checks = this.checks.slice(-8);
      this.testFailures = failed ? this.testFailures + 1 : 0;
      if (this.testFailures >= this.thresholds.consecutiveFailures) this.reason = 'test_failures';
    }
    if (!failed && changed !== false && ['edit', 'write'].includes(name)) {
      // A changed file makes running the same command again a new experiment, a scratchpad script's too; only project files count as changes.
      if (!(typeof data.path === 'string' && this.scratch?.(data.path))) { this.changedFiles.add(String(data.path)); this.lastCheck = undefined; }
      // Only relevant progress unlocks retries. Notes and unrelated files do not reset inspection loops.
      for (const key of this.recovery.repeated.keys()) {
        if (key.startsWith(`read:${data.path}:`) || key.startsWith(`edit:${data.path}:`) || key.startsWith(`write:${data.path}:`)
          || key.startsWith('bash:') && (!this.scratch?.(String(data.path)) || (this.recovery.commands.get(key) ?? '').includes(basename(String(data.path))))) {
          this.recovery.repeated.delete(key); this.recovery.inspectionWarnings.delete(key);
          this.recovery.commands.delete(key);
        }
      }
      return;
    }
    const search = name === 'web_search' && !failed;
    const reading = name === 'web_read' && !failed;
    // A search with every engine down cannot improve on retry; refuse further searches at once.
    if (search && result?.startsWith(SEARCH_UNAVAILABLE)) this.searchExhausted = true;
    if (reading && result?.startsWith(READS_SPENT)) this.readsExhausted = true;
    const inspection = (['ls', 'find', 'grep', 'read', 'artifact_read'].includes(name) && !failed) || search || reading;
    // Equal bounded inspection results provide no new evidence, even if the
    // caller varies query spelling or optional arguments. Never normalize shell grammar.
    // discord.play tools read the app from the reply, so equal arguments often carry new code: only an equal result repeats.
    const play = name.startsWith('play_');
    const byResult = inspection || play;
    // Fresh handles are storage metadata, not progress. A full result/image identity distinguishes changes hidden by a preview.
    const observed = identity ?? result?.replace(savedLine, '').trim();
    const signature = `${name}:${['read', 'edit', 'write'].includes(name) ? data.path ?? '' : ''}:${createHash('sha256').update(JSON.stringify(byResult && observed !== undefined ? [name, observed] : [name, args])).digest('hex')}${this.context && `:${this.context}`}`;
    if (name === 'bash') this.recovery.commands.set(signature, String(data.command ?? ''));
    const count = (this.recovery.repeated.get(signature) ?? 0) + 1;
    this.recovery.repeated.set(signature, count);
    if (count >= this.thresholds.repeatedToolCalls) {
      if (inspection && !this.recovery.inspectionWarnings.has(signature)) {
        this.recovery.inspectionWarnings.add(signature);
        this.warning = search
          ? 'Repeated searches produced no new evidence. Stop searching now and answer from the results already found, clearly stating any gaps. Further searches will be refused.'
          : reading
          ? 'Repeated reads returned the same page. Stop reading it again and answer from what you have, clearly stating any gaps. Further repeats withdraw web_read.'
          : this.readOnly ? 'Repeated inspection added no evidence; finish the proposal from verified sources, stating missing evidence. Further repeats withdraw tools for a synthesis turn.'
          : 'Repeated inspection produced no new evidence. Change approach now: use the information already found [*clearly* stating knowledge gaps!], narrow the search, or create the requested files if the repository is empty. Another repeated inspection will stop this attempt.';
      } else if (search) this.searchExhausted = true;
      else if (reading) this.readsExhausted = true;
      else if (inspection && this.readOnly) {
        this.answerNow = true;
        this.answerWhy = 'repeated inspection added no evidence to this read-only request';
      }
      // An app is shown to people as it goes, so a stuck attempt answers about what is live rather than starting over.
      else if (play && !this.answerNow) { this.answerNow = true; this.answerWhy = 'Those calls keep giving the same result'; }
      else this.reason ??= 'ineffective_calls';
    }
  }
}
