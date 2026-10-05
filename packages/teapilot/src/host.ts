import type { ActivitySink } from './activity.js';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Message } from '@earendil-works/pi-ai';
import { defaultPolicy, JevRouter } from 'jevrouter';
import type { AccessAdmin } from './agents/access.js';
import type { PlayContext } from './agents/play.js';
import type { ConversationWorkspace } from './agents/workspace.js';
import { runAttempt, type AttemptResult, type Resume } from './agents/run.js';
import { tiers, type Config, type Tier, type TierPreference, type Workload } from './config.js';
import { ExecutionPolicy, type Approve, type BeforeMutation } from './execution/policy.js';
import { prepareConversation, type ConversationTurn, type TextContext, type EventSink } from './integration/events.js';
import { formatInterruption, type Interruption } from './interruption.js';
import { lockState, SpendGovernor } from './inference/budget.js';
import { budgetedJev, localAvailable, type CancellableJevProvider } from './inference/providers.js';
import { capabilities } from './routing/capabilities.js';
import { Telemetry } from './telemetry/outcome.js';
import { assessCandidate } from './routing/selection.js';
import { checkSearch, searchRepair } from './search.js';
import { sideReadable, withPrerequisites, workloadFor, type Mode, type SessionGrants, type Permission } from './execution/grants.js';
import { capabilityPlanner, conversationQuestions, playQuestion, readCasual, readPlayGrant, readRoutingPlan, readWebAutoGrant, teachatIdentityQuestion, readTeachatIdentity, type TeachatIdentityAnswer, type WebBasis } from './routing/intent.js';
import { markWork } from './teachat/busy.js';
import { directTier, effectiveProfile, modelFor, profileFor, thinkingFor } from './routing/execution.js';
import { WebController } from './web/controller.js';
import { RequestRecovery } from './agents/recovery.js';
import { checkpointCard, checkpointDetails, continuation, Workflow, type CheckpointDecision, type CheckpointRecord, type HandoffReason } from './agents/checkpoint.js';
import { RequestAllowance, planningCallLimit, resolveToolBudget } from './agents/allowance.js';
import { TaskStore } from './workspace/task.js';
import { PlanStore, compactPlan, planNotice, planText } from './workspace/plan.js';
import { skillCache } from './skills/cache.js';
import { SkillStore } from './skills/store.js';
import type { SkillPreferences } from './skills/settings.js';
import type { SkillCatalog } from './workspace/skills.js';

export interface HostRequest { prompt: string; cwd: string; workload?: Workload; web?: boolean; correction?: string; signal?: AbortSignal; history?: ConversationTurn[]; context?: TextContext[]; mode?: Mode; conversational?: boolean; authorization?: SessionGrants; access?: AccessAdmin; play?: PlayContext; workspace?: ConversationWorkspace; tier?: TierPreference; relatedTier?: Tier; sessionId?: string; taskId?: string;
  /** A side question (/btw): it sees the conversation but only reads, and its turn is not kept. */
  side?: boolean;
  /** The session's scratchpad folder, from the surface that owns the session. */
  scratch?: string;
  /** A host notice put before the prompt, such as why the previous request stopped. */
  notice?: string;
  /** Explicit task constraints supplied by a trusted surface; models cannot rewrite them. */
  constraints?: string[];
  /** Surface-provided objective without presentation templates; readOnly proposals cannot mutate project files or apps. */
  taskObjective?: string;
  readOnly?: boolean;
  skills?: SkillPreferences;
  planAction?: 'new' | 'revise' | 'approve';
  /** Teachat roster (username → bio). The router call also asks which identity would get this request. */
  teachatIdentities?: Record<string, string> }
export interface HostResult {
  requestId: string; success: boolean; status: string; text: string;
  taskId?: string;
  /** A bounded replacement for a plan's full text in replayed conversation history. */
  historyText?: string;
  capability?: string; spentUsd: number; receipts: string[]; attempts: number;
  check?: 'passed' | 'failed'; models?: string[];
  tier?: Tier;
  /** On a stopped request: the calls that failed across its attempts, so the next turn does not repeat them. */
  failedCalls?: Array<{ call: string; error: string }>;
  /** On a stopped request: what the model itself last said, as `text` is then the host's diagnostic. */
  reply?: string;
  /** Partial-work facts for surface-specific interruption messages and Details. */
  interruption?: Interruption;
  teachatIdentity?: TeachatIdentityAnswer;
  /** Answered in conversational mode: the text is short lines, each meant to be sent as its own message. */
  casual?: boolean;
  /** What the tools did before the final reply; kept with the turn so later turns can replay it. */
  steps?: Message[];
}
export interface HostDependencies {
  approve: Approve;
  onActivity?: ActivitySink;
  provider?: CancellableJevProvider;
  localProbe?: () => Promise<boolean>;
  onProgress?: (message: string) => void;
  onEvent?: EventSink; beforeMutation?: BeforeMutation;
  /** The model's reasoning as it streams, redacted; see AttemptInput.onReasoning. */
  onReasoning?: (text: string) => void;
  /** Asked when search is granted mid-request but unusable; without it the request goes on without search. */
  continueWithoutSearch?: (message: string) => Promise<boolean>;
  /** Asked at each checkpoint; without it, work continues. Surfaces should not hold it open for long. */
  onCheckpoint?: (checkpoint: CheckpointView, signal?: AbortSignal) => Promise<CheckpointDecision>;
}
/** A checkpoint as surfaces show it: a title and a few lines, with the full record behind details. */
export interface CheckpointView { record: CheckpointRecord; title: string; lines: string[]; details: string }

export async function runHost(config: Config, request: HostRequest, dependencies: HostDependencies): Promise<HostResult> {
  if (config.routingMode === 'direct' && !request.workload && !request.authorization) throw new Error('Direct routing requires teapilot ask or teapilot code.');
  const prompt = request.prompt.trim();
  const userRequest = `${request.planAction === 'new' ? request.taskObjective ?? prompt : prompt}${request.correction ? `\nuser correction: ${request.correction}` : ''}`;
  if (!prompt || prompt.length + (request.correction?.length ?? 0) > config.policy.limits.maxPromptChars) throw new Error(`Prompt must contain 1–${config.policy.limits.maxPromptChars} characters`);
  dependencies.onActivity?.({ kind: 'waiting', label: 'Checking request availability...' });
  const cwd = await realpath(request.cwd);
  if (request.authorization && request.authorization.root !== cwd) throw new Error('Session grants belong to a different repository.');
  if (!(await stat(cwd)).isDirectory()) throw new Error('Working directory is not a directory');
  const contextPolicy = new ExecutionPolicy(cwd, config, dependencies.approve);
  for (const context of request.context ?? []) if (context.path) await contextPolicy.path(context.path, false);
  const plans = request.scratch && !request.side && config.scratchpad?.enabled !== false ? new PlanStore(request.scratch, request.taskId ?? request.sessionId ?? 'conversation') : undefined;
  let currentPlan = plans?.current();
  if (currentPlan && request.planAction === 'approve') currentPlan = { ...currentPlan, status: 'approved' };
  const currentPrompt = (currentPlan && request.planAction !== 'new' ? `${planNotice(currentPlan)}\n\n` : '') + (request.notice ? `${request.notice}\n\n` : '') + prompt + (request.correction ? `\nUser correction:\n${request.correction}` : '');
  // Leave room for system instructions and tool schemas while retaining whole,
  // recent turns. The inference boundary remains the final exact admission check.
  const currentLength = currentPrompt.length + (request.context?.length ? JSON.stringify(request.context).length + 64 : 0);
  const historyLimit = Math.max(currentLength, Math.min(config.policy.limits.maxPromptChars, 8_000));
  const conversation = prepareConversation(currentPrompt, request.context ?? [], request.history ?? [], historyLimit);
  if (conversation.omitted) dependencies.onEvent?.({ type: 'history_omitted', turns: conversation.omitted });
  if (request.web && !request.authorization) {
    dependencies.onActivity?.({ kind: 'waiting', label: 'Checking web search...' });
    await checkSearch(config, request.signal);
  }
  const idle = await markWork(config);
  let unlock: () => Promise<void>;
  try { unlock = await lockState(config.stateDir); } catch (error) { await idle(); throw error; }
  const requestId = randomUUID();
  let teachatIdentity: TeachatIdentityAnswer | undefined;
  // Conversational mode, decided once from the first routing call; see routing/intent.ts.
  let casual = false;
  const telemetry = new Telemetry(config.stateDir, requestId, [config.router.apiKey, ...Object.values(config.secrets)].filter((value): value is string => Boolean(value)), dependencies.onEvent);
  const budget = new SpendGovernor(join(config.stateDir, 'spend.jsonl'), requestId, config.policy.budget);
  // URLs the user wrote or earlier tools returned may be read; anything the model composes may not.
  const web = new WebController(config, { event: (type, fields) => telemetry.event(type, fields) });
  const recovery = new RequestRecovery();
  // Checkpoints need an orchestrator that keeps working; side questions and read-only proposals never hand off.
  // Uncapped unless configured: spend, permissions and cancellation still bound the request.
  const checkpointLimit = config.policy.limits.maxCheckpoints ?? Infinity;
  const workflow = checkpointLimit > 0 && !request.side && !request.readOnly
    ? Workflow.open(requestId, checkpointLimit, request.scratch && config.scratchpad?.enabled !== false ? request.scratch : undefined) : undefined;
  if (workflow) {
    workflow.onTask = task => dependencies.onEvent?.({ type: 'task', id: task.id, label: task.label, junior: task.junior, state: task.state });
    // Tasks a parked workflow left open are still in progress here.
    for (const task of workflow.tasks.values()) workflow.onTask(task);
  }
  let task: TaskStore | undefined;
  let skillCatalog: SkillCatalog | undefined;
  let taskId = request.taskId ?? requestId;
  web.remember(currentPrompt);
  for (const turn of request.history ?? []) {
    web.remember(turn.user);
    for (const step of turn.steps ?? []) if (step.role === 'toolResult') web.remember(JSON.stringify(step.content));
  }
  // Pictures people attached with this request: every attempt at it is shown them, if its model can see.
  const images = request.workspace?.store.takeImages(request.workspace.conversation);
  const receipts: string[] = [];
  let attempts = 0;
  let selected: string | undefined;
  let check: 'passed' | 'failed' | undefined;
  const models: string[] = [];
  const changedFiles = new Set<string>();
  const fileSizes = new Map<string, number>();
  const failedCalls = new Map<string, { call: string; error: string }>();
  let shellRan = false;
  let interruption: Interruption | undefined;
  const activePermissions: Permission[] = ['inference'];
  let searchDisabled = false;
  let searchUnverified = false;
  let accessFailure: string | undefined;
  // Conditions under which Jev (or an explicit --web) lets web.search be granted without a prompt.
  let webAutoBasis: WebBasis[] = request.web ? ['explicit'] : [];
  // With `optional`, an unusable search service quietly skips the grant instead of prompting or failing the request.
  const activate = async (required: Permission[], reason: string, signal = request.signal, optional = false): Promise<boolean> => {
    if (!request.authorization) return true;
    if (accessFailure) return false;
    if (request.side && !required.every(sideReadable)) return false;
    if (required.some(permission => !config.policy.permissions.includes(permission))) {
      accessFailure = `Required access is disabled by configuration: ${required.filter(permission => !config.policy.permissions.includes(permission)).join(', ')}.`;
      return false;
    }
    if (optional && !request.authorization.allows('web.search')) {
      try { await checkSearch(config, signal); } catch { signal?.throwIfAborted(); return false; }
    }
    // Only web.search is ever auto-approved; repository access always goes through the user.
    const auto = webAutoBasis.length > 0 && required.every(permission => permission === 'web.search');
    const approve: Approve = auto
      ? async approval => { await telemetry.event('grant_auto', { permissions: approval.kind === 'capability' ? approval.permissions : required, basis: webAutoBasis }); return true; }
      : dependencies.approve;
    if (!await request.authorization.request(required, reason, approve, signal,
      (type, fields) => telemetry.event(type, fields))) {
      accessFailure = `Required session access was not approved: ${required.join(', ')}. Grant access interactively to continue.`;
      return false;
    }
    if (required.includes('web.search') && !activePermissions.includes('web.search') && !searchDisabled) {
      try { await checkSearch(config, signal); }
      catch (error) {
        signal?.throwIfAborted();
        // A request goes on without search unless the host declines: the model can still use what it has, marked unverified.
        const proceed = dependencies.continueWithoutSearch ? await dependencies.continueWithoutSearch(error instanceof Error ? error.message : 'Web search is unavailable.') : true;
        if (!proceed) {
          accessFailure = 'Web search is unavailable. Repair search before retrying.';
          return false;
        }
        searchDisabled = true; searchUnverified = true;
      }
    }
    for (const permission of withPrerequisites(required)) if (!activePermissions.includes(permission) && !(permission === 'web.search' && searchDisabled)) activePermissions.push(permission);
    return true;
  };
  const incomplete = (attempt: AttemptResult, fallback?: string) => {
    const stop = attempt.stopped ?? attempt.reason ?? 'incomplete';
    const usedRepository = selected?.startsWith('coder.') || changedFiles.size > 0 || shellRan;
    const termination = attempt.ending?.termination;
    const actions: Record<string, string> = {
      approval_denied: 'review the denied action before deciding whether to approve it.',
      provider_error: termination?.eosReason === 'loop_detected'
        ? 'the provider stopped a token loop; affected calls did not run. retry a targeted step rather than the same generation, or check the model with teapilot doctor --live.'
        : termination?.eosReason === 'max_new_tokens' || termination?.finishReason === 'length'
        ? 'the tool call reached its output-token limit and did not run. split it into smaller operations.'
        : termination?.malformedTools
        ? 'the provider sent malformed tool arguments; affected calls did not run. check its tool protocol with teapilot doctor --live.'
        : 'the provider failed or returned no usable tool call. check the models with teapilot doctor --live; call size is not a confirmed cause.',
      unsupported: 'check the model’s context and tool support with teapilot doctor --live.',
      context_limit: 'try a smaller request, or /tier reasoning or /tier deep if a larger context window is configured; /convo clear clears the conversation history.',
      payload_limit: 'try sending a smaller request or attachment.',
      budget: 'check the request and daily spending limits before retrying.',
      ineffective_calls: usedRepository ? 'check the current files, then ask for a smaller concrete change.' : 'try a narrower question, or check search with teapilot doctor --live.',
      test_failures: 'use the failing check output as the next task.',
      tool_failures: 'check the tool’s path or command before retrying.',
      search_unavailable: `check the search connection and JSON output. ${searchRepair(config)}`,
    };
    const largest = stop === 'context_limit' && attempt.largestToolResult ? `largest tool call: ${attempt.largestToolResult.tool} (~${attempt.largestToolResult.chars} chars, arguments and result).` : undefined;
    interruption = {
      reason: stop, edits: [...changedFiles].map(path => ({ path, size: fileSizes.get(path) })), shellRan, check: attempt.check,
      advice: stop === 'cancelled' ? undefined : actions[stop] ?? 'review the partial work, then try a smaller task.',
      detail: [fallback, largest].filter(Boolean).join('\n') || undefined,
      reply: attempt.text ? `${searchUnverified ? 'search was unavailable; this partial reply wasn’t checked against current sources.\n\n' : ''}${attempt.text}` : undefined,
    };
    return formatInterruption(interruption);
  };
  let previous: AttemptResult | undefined;
  let previousTier: Tier | undefined;
  /** The last failure handed off, so a failure straight after it ends the request rather than looping. */
  let failedOver: { reason: HandoffReason; generation: number } | undefined;
  const finish = async (success: boolean, status: string, text: string): Promise<HostResult> => {
    if (!success && request.signal?.aborted) status = 'cancelled';
    // All abort exits use the same acknowledgement, including stops between attempts.
    if (status === 'cancelled') text = incomplete({ ...previous, success: false, text: previous?.text ?? '', turns: 0, toolCalls: 0, stopped: 'cancelled', check });
    dependencies.onActivity?.({ kind: 'waiting', label: 'Finalising request...' });
    const result = { requestId, success, status, ...(previous?.steps?.length ? { steps: redactSteps(previous.steps, telemetry.redact.bind(telemetry)) } : {}), text: telemetry.redact((searchUnverified && success ? 'Web search was unavailable. This answer is unverified against current sources.\n\n' : '') + text), capability: selected, tier: selected?.split('.')[1] as Tier | undefined, spentUsd: budget.spent().request, receipts, attempts, check, models, ...(teachatIdentity && { teachatIdentity }), ...(casual && { casual }),
      ...(!success && interruption ? { interruption: { ...interruption,
        edits: interruption.edits.map(edit => ({ ...edit, path: telemetry.redact(edit.path) })),
        advice: interruption.advice && telemetry.redact(interruption.advice), detail: interruption.detail && telemetry.redact(interruption.detail),
        reply: interruption.reply && telemetry.redact(interruption.reply),
      } } : {}),
      ...(!success && previous?.text.trim() ? { reply: telemetry.redact(previous.text.trim().slice(0, 20_000)) } : {}),
      ...(!success && failedCalls.size ? { failedCalls: [...failedCalls.values()].slice(-8).map(({ call, error }) => ({ call: telemetry.redact(call), error: telemetry.redact(error) })) } : {}) };
    const body = success && plans ? planText(result.text) : undefined;
    if (body && plans) {
      currentPlan = plans.save(body, request.planAction === 'new');
      task?.setPlan(currentPlan);
      await telemetry.event('plan_saved', { ...currentPlan });
    }
    const historyText = body && currentPlan ? compactPlan(result.text, currentPlan) : undefined;
    // Research and reads remain in the transcript/evidence store; replaying them can reintroduce an old full plan.
    const steps = historyText ? undefined : result.steps;
    await telemetry.event('request_end', { success, status, capability: selected, spentUsd: result.spentUsd, attempts });
    task?.finish(status);
    return { ...result, steps, ...(historyText ? { historyText } : {}), ...(task ? { taskId } : {}) };
  };
  try {
    await budget.load();
    if (request.planAction === 'approve') currentPlan = plans?.approve();
    await mkdir(config.stateDir, { recursive: true });
    await telemetry.event('request_start', { correction: Boolean(request.correction), web: Boolean(request.web) });
    if (request.authorization && !request.authorization.allows('inference')) return await finish(false, 'blocked', 'Inference access is not granted. Start a new session to restore it.');
    if (request.authorization && request.web && !await activate(['web.search'], 'You requested web research with --web.')) return await finish(false, 'approval_denied', accessFailure!);
    // discord.play is open to everyone in Discord and needs no prompt; once a conversation has it, it stays active.
    const playable = Boolean(request.play && request.authorization?.available().includes('discord.play'));
    if (playable && request.authorization!.allows('discord.play')) activePermissions.push('discord.play');
    // Apps outlive a conversation's history (a restart starts it over), so an app still running here keeps discord.play, even one another conversation started in this channel.
    else if (playable && request.play!.runtime.list(request.play!.conversation, request.play!.channelId).some(app => app.status === 'running')) await activate(['discord.play'], 'An app is still running here.');
    // Where the repository is not on offer (a conversation's workspace is its only place for files) it is neither planned nor routed to.
    const repositoryOnOffer = !request.authorization || request.authorization.available().includes('repository.read');
    const provider = config.routingMode === 'direct' ? undefined : budgetedJev(config, budget, telemetry, dependencies.provider, request.signal);
    const router = provider ? new JevRouter(request.authorization ? capabilityPlanner(provider, { ...conversationQuestions, ...(request.teachatIdentities && teachatIdentityQuestion(request.teachatIdentities)), ...(playable ? playQuestion : {}) }, repositoryOnOffer) : provider, { ...defaultPolicy, ...config.policy.router, single_stage_max_candidates: 32, allow_unavailable_fallback: false }) : undefined;
    const physicalOnline = dependencies.localProbe
      ? { fast: await dependencies.localProbe(), capable: await dependencies.localProbe() }
      : { fast: await localAvailable(config, 'fast'), capable: await localAvailable(config, 'capable') };
    const localOnline = physicalOnline.fast || physicalOnline.capable;
    let scope: { workload: Workload; tier: Tier } | undefined;
    const basePrompt = conversation.current;
    for (let index = 0; index <= config.policy.escalation.maxEscalations; index++) {
      if (request.signal?.aborted) return await finish(false, 'cancelled', 'Request cancelled.');
      const candidates = capabilities(config, budget, localOnline, scope, { physicalOnline, explicitTier: request.tier && request.tier !== 'auto' ? request.tier : undefined, relatedLock: request.relatedTier });
      if (request.tier && request.tier !== 'auto') for (const candidate of candidates) if (!candidate.id.endsWith(`.${request.tier}`)) candidate.availability = { available: false, reason: 'Outside explicit tier preference' };
      if (request.workload) for (const candidate of candidates) {
        if (!candidate.id.startsWith(`${request.workload}.`)) candidate.availability = { available: false, reason: 'Outside requested workload' };
      }
      if (!repositoryOnOffer) for (const candidate of candidates) {
        if (candidate.id.startsWith('coder.')) candidate.availability = { available: false, reason: 'Repository access is not offered here' };
      }
      if (!router && request.authorization && !scope) for (const candidate of candidates) {
        if (!candidate.id.startsWith('ask.')) candidate.availability = { available: false, reason: 'Start with dialogue; activate repository tools only when needed' };
      }
      if (request.web) for (const candidate of candidates) {
        const tier = candidate.id.split('.')[1] as Tier;
        if (!modelFor(config, tier).toolCalling) candidate.availability = { available: false, reason: 'Web search requires tool calling' };
      }
      if (!candidates.some(c => c.availability?.available)) return await finish(false, 'unavailable', previous?.text || 'No capability fits the configured availability and budget. Run teapilot doctor.');
      dependencies.onProgress?.(scope ? `Routing escalation to ${scope.workload}.${scope.tier} (${previous?.reason}).` : router ? 'Routing with JevRouter.' : 'Selecting the requested workload directly.');
      dependencies.onActivity?.({ kind: 'waiting', label: router ? 'Routing with JevRouter...' : 'Selecting workload...' });
      const decision = router ? await router.route({
        request: basePrompt,
        context: {
          preference: 'Use the lowest suitable local execution profile. Default repository and agentic work to normal; use fast only for genuinely tiny standalone work. Scale capable work through normal, reasoning, deep when evidence warrants it. Choose coder only when the user request needs repository access; ordinary questions use ask.',
          mode: request.mode,
          granted_access: request.authorization?.list(),
          web_enabled: Boolean(request.web),
          history: conversation.history.map(({ user, assistant }) => ({ user, assistant })),
          ...(scope ? { escalation: { ...scope, evidence: previous?.reason } } : {}),
        },
        actor_permissions: request.authorization?.available() ?? config.policy.permissions,
      }, candidates) : undefined;
      if (request.signal?.aborted) return await finish(false, 'cancelled', 'Request cancelled.');
      if (decision) receipts.push(await telemetry.receipt(decision));
      if (router) webAutoBasis = request.web ? ['explicit'] : readWebAutoGrant(decision?.raw_jev);
      if (request.teachatIdentities) teachatIdentity ??= readTeachatIdentity(decision?.raw_jev);
      if (playable && !activePermissions.includes('discord.play') && readPlayGrant(decision?.raw_jev, config.policy.router.min_confidence)) await activate(['discord.play'], 'Planned for your request before starting.');
      // A side question may need to read or send a file, which a conversational reply has no tools for.
      if (!scope && request.authorization && !request.side) casual = readCasual(decision?.raw_jev, config.policy.router.min_confidence);

      const routedSelection = decision?.status !== 'no_decision' ? decision?.decision.selected ?? undefined : undefined;
      // An unconfident route falls back to the workload the session's mode already
      // states (coder in Code mode, ask in Ask/Chat) rather than always dialogue,
      // so Code-mode requests still reach the coder agent.
      const fallbackWorkload = request.workload ?? scope?.workload ?? (decision?.status === 'no_decision' ? repositoryOnOffer ? workloadFor(request.mode ?? 'chat') : 'ask' : undefined);
      const fallbackSelection = fallbackWorkload
        // The router was unsure, so start at the default tier rather than the smallest model.
        ? [`${fallbackWorkload}.normal`, ...candidates.map(candidate => candidate.id)].find(id => id.startsWith(`${fallbackWorkload}.`) && candidates.some(candidate => candidate.id === id && assessCandidate(config, candidate).allowed))
        : undefined;
      const usedRoutingFallback = Boolean(decision?.status === 'no_decision' && fallbackSelection);
      const directSelectionTier = scope?.tier ?? directTier(fallbackWorkload ?? 'ask', request.tier && request.tier !== 'auto' ? request.tier : undefined, basePrompt, request.relatedTier, Boolean(request.web));
      selected = routedSelection ?? (decision ? fallbackSelection : candidates.find(c => c.id === `${fallbackWorkload ?? 'ask'}.${directSelectionTier}` && assessCandidate(config, c).allowed)?.id);

      if (!selected) {
        return await finish(false, 'unavailable', decision
          ? `JevRouter returned no usable route (${decision.fallback.type ?? 'manual_review'}), and no host-approved fallback capability was available.`
          : 'No capability passed the direct selection policy. Run teapilot doctor.');
      }

      if (usedRoutingFallback) {
        dependencies.onProgress?.(`JevRouter returned no confident route (${decision!.fallback.type ?? 'manual_review'}); using host-approved fallback ${selected}.`);
        await telemetry.event('routing_fallback', { decisionId: decision!.decision_id, capability: selected, reason: decision!.fallback.type ?? 'manual_review' });
      }

      let candidate = candidates.find(c => c.id === selected);
      let assessment = !usedRoutingFallback ? decision?.decision.candidates.find(c => c.id === selected) : undefined;
      if (!candidate || !assessCandidate(config, candidate).allowed || (decision && !usedRoutingFallback && (!assessment || assessment.router.filtered || !assessment.router.allowed))) return await finish(false, 'blocked', 'Selected capability did not pass the execution boundary.');
      if (casual) {
        // Conversational mode runs on the allowed ask tier that reasons least; with none, the turn is an ordinary one.
        const routerAllows = (id: string) => usedRoutingFallback || !decision || Boolean(decision.decision.candidates.find(c => c.id === id && c.router.allowed && !c.router.filtered));
        const chosen = [...(['ask.fast', 'ask.normal'].includes(selected) ? [selected] : []), 'ask.normal', 'ask.fast', 'ask.reasoning', 'ask.deep']
          .map(id => candidates.find(c => c.id === id)).find(c => c && assessCandidate(config, c).allowed && routerAllows(c.id));
        if (chosen) {
          selected = chosen.id; candidate = chosen; assessment = !usedRoutingFallback ? decision?.decision.candidates.find(c => c.id === chosen.id) : undefined;
          await telemetry.event('casual', { capability: selected });
        } else casual = false;
      }
      const selectedWorkload = selected!.split('.')[0]!;
      // Only a confident access plan earns an upfront grant prompt. An unconfident one
      // continues with current access; the agent requests more mid-run if needed.
      const plan = request.authorization && decision && !usedRoutingFallback && !casual ? readRoutingPlan(decision.raw_jev, config.policy.router.min_confidence, selectedWorkload, repositoryOnOffer) : undefined;
      if (plan) {
        if (!previous && plan.relatedness === 'new') taskId = requestId;
        if ((!request.tier || request.tier === 'auto') && plan.tier && plan.tier !== 'auto') {
          const preferred = candidates.find(candidate => candidate.id === `${selectedWorkload}.${plan.tier}`);
          const preferredAssessment = preferred && decision?.decision.candidates.find(c => c.id === preferred.id);
          if (preferred && preferredAssessment && assessCandidate(config, preferred).allowed && preferredAssessment.router.allowed && !preferredAssessment.router.filtered) { selected = preferred.id; candidate = preferred; assessment = preferredAssessment; }
        }
        // web.search may be auto-approved on its own; the rest of the plan is still asked of the user.
        const web = plan.permissions.filter(permission => permission === 'web.search');
        // A side question only reads, so it never asks for write or shell access up front.
        const rest = plan.permissions.filter(permission => permission !== 'web.search' && (!request.side || sideReadable(permission)));
        if (web.length && !await activate(web, 'Planned for your request before starting.')) return await finish(false, 'approval_denied', accessFailure!);
        if (rest.length && !await activate(rest, 'Planned for your request before starting.')) return await finish(false, 'approval_denied', accessFailure!);
      }
      // Jev can also establish a web.search basis without a confident access plan (or when the plan
      // did not ask for search), so grant it whenever it is usable rather than waiting for a mid-run request.
      // Where search needs no approval anyway (Discord), a missed basis must not leave the model answering from memory.
      if (request.authorization && !casual && (webAutoBasis.length || request.authorization.free('web.search')) && !activePermissions.includes('web.search') && config.searchUrl
        && config.policy.permissions.includes('web.search') && modelFor(config, selected.split('.')[1] as Tier).toolCalling) {
        await activate(['web.search'], webAutoBasis.length ? `Web search allowed automatically (${webAutoBasis.join(', ')}).` : 'Web search needs no approval here.', request.signal, true);
      }
      if (!decision) await telemetry.event('direct_selection', { capability: selected });
      if (request.signal?.aborted) return await finish(false, 'cancelled', 'Request cancelled.');
      if (assessCandidate(config, candidate).confirmation || (!usedRoutingFallback && (decision?.status === 'needs_confirmation' || assessment?.router.requires_confirmation))) {
        const approved = await dependencies.approve({ kind: 'route', summary: `Execute ${selected}?`, details: `Model: ${candidate.metadata?.model}\nMaximum inference charge per turn: $${Number(candidate.metadata?.max_call_usd).toFixed(6)}\nRequest ceiling: $${config.policy.budget.requestUsd}; already charged/reserved: $${budget.spent().request.toFixed(6)}\n${basePrompt}` });
        await telemetry.event('approval', { decisionId: decision?.decision_id, capability: selected, approved });
        if (request.signal?.aborted) return await finish(false, 'cancelled', 'Request cancelled.');
        if (!approved) return await finish(false, 'approval_denied', 'Route was not approved.');
      }
      const [workload, tier] = selected.split('.') as [Workload, Tier];
      // Surfaces decide how to show the turn from this: a conversational one gets no progress display.
      dependencies.onEvent?.({ type: 'route', capability: selected, casual });
      dependencies.onProgress?.(`Executing ${selected} using ${modelFor(config, tier).id} (${thinkingFor(config, tier)}).`);
      attempts++;
      models.push(modelFor(config, tier).id);
      dependencies.onEvent?.({ type: 'attempt_start', attempt: attempts, model: modelFor(config, tier).id, tier });
      // A retry on the same model carries on from what it last saw, with this tier's settings, rather than starting
      // over from a summary of it and reading everything again.
      const resume = previous?.resume && previousTier && profileFor(previousTier).model === profileFor(tier).model ? previous.resume : undefined;
      if (!task && config.taskState?.enabled === true && config.scratchpad?.enabled !== false && request.scratch && !request.side && !casual && modelFor(config, tier).toolCalling) {
        // Only an explicit task identity resumes state. Conversation identity alone never merges objectives.
        const scope = JSON.stringify([cwd, request.sessionId ?? request.workspace?.conversation ?? '', taskId]);
        task = TaskStore.open(config.stateDir, scope, request.taskObjective ?? prompt, request.scratch, text => telemetry.redact(text), request.constraints);
        if (currentPlan) task.setPlan(currentPlan);
        task.configure({ currentRequest: userRequest, ...(request.planAction === 'new' ? { objective: request.taskObjective ?? prompt } : {}), ...(request.constraints ? { constraints: request.constraints } : {}) });
        const multiplier = config.policy.escalation.maxEscalations + 1;
        task.startRequest(requestId, { calls: request.readOnly ? Math.min(config.policy.limits.maxToolCalls, config.policy.limits.planningToolCalls ?? planningCallLimit) : config.policy.limits.maxToolCalls, modelCalls: config.policy.limits.maxTurns * multiplier, timeoutMs: config.policy.limits.attemptTimeoutMs * multiplier, delegations: config.policy.limits.maxJuniorTurns, readOnly: request.readOnly, ...resolveToolBudget(config, { readOnly: request.readOnly, casual, side: request.side }) });
        await telemetry.event('task_start', { task: task.snapshot().id, resumed: Boolean(request.taskId), revision: task.snapshot().revision });
      }
      if (!skillCatalog && !casual && modelFor(config, tier).toolCalling && config.skills?.enabled !== false) {
        const settings = config.skills ?? { enabled: true };
        const preferences = request.skills ?? new SkillStore(config.stateDir, settings).effective({ operator: true });
        skillCatalog = await skillCache(config.stateDir).catalog(settings, preferences, request.signal);
        for (const warning of skillCatalog.warnings) dependencies.onProgress?.(warning);
      }
      const flow = workflow && !casual && modelFor(config, tier).toolCalling ? workflow : undefined;
      // With checkpoints the orchestrator's window ends in a handoff, not a request to approve another batch.
      const budgetLimits = { ...resolveToolBudget(config, { readOnly: request.readOnly, casual, side: request.side }), ...(flow ? { maxContinuationBatches: 0 } : {}) };
      // A parked workflow is offered to this request's first orchestrator; the person's message decides whether it resumes.
      const parked = !previous && flow?.parked ? `${continuation(flow.parked, true)}\n\n[the person's new message follows. continue the parked workflow only if it asks you to.]\n\n` : '';
      if (parked && flow?.parked) { flow.save({ ...flow.parked, status: 'resumed' }); flow.parked = undefined; }
      const attempt = (prompt: string, resume: Resume | undefined, carrySkills?: string[]) => runAttempt({
        allowance: recovery.allowance ??= new RequestAllowance({ calls: request.readOnly ? Math.min(config.policy.limits.maxToolCalls, config.policy.limits.planningToolCalls ?? planningCallLimit) : config.policy.limits.maxToolCalls, modelCalls: config.policy.limits.maxTurns * (config.policy.escalation.maxEscalations + 1), timeoutMs: config.policy.limits.attemptTimeoutMs * (config.policy.escalation.maxEscalations + 1), delegations: config.policy.limits.maxJuniorTurns ?? 6 }, task, budgetLimits),
        workflow: flow, config, skillCatalog, workload, tier, cwd, web: request.authorization ? activePermissions.includes('web.search') : Boolean(request.web), budget, telemetry, recovery, task, taskId: task ? taskId : undefined, readOnly: request.readOnly,
        mode: request.mode, conversational: request.conversational, side: request.side, casual, authorization: request.authorization, access: request.access, play: request.play, workspace: request.workspace,
        currentRequest: userRequest,
        expectsPlan: request.planAction === 'new' || request.planAction === 'revise',
        activePermissions: request.authorization ? activePermissions : undefined,
        requestCapabilities: request.authorization ? async (required, reason, signal) => {
          if (required.some(permission => permission.startsWith('repository.'))) {
            const repository = capabilities(config, budget, localOnline, { workload: 'coder', tier }, { physicalOnline, explicitTier: tier }).find(value => value.id === `coder.${tier}`)!;
            const admission = assessCandidate(config, repository);
            if (!admission.allowed) { accessFailure = admission.reason ?? 'Repository capability unavailable'; return false; }
            if (admission.confirmation && workload !== 'coder' && !activePermissions.includes('repository.read')) {
              if (!await dependencies.approve({ kind: 'route', summary: `Use repository tools with ${modelFor(config, tier).id}?`, details: reason, signal })) return false;
            }
          }
          return activate(required, reason, signal);
        } : undefined,
        unresolvedChecks: previous?.unresolvedChecks, searchUnavailable: searchDisabled, webController: web, scratch: request.scratch, attempt: attempts - 1, requestText: currentPrompt,
        // Each attempt fits earlier turns, with their steps, to its own model's context.
        history: request.history, onEvent: dependencies.onEvent, onActivity: dependencies.onActivity, onReasoning: dependencies.onReasoning, beforeMutation: dependencies.beforeMutation,
        approve: async approval => {
          const approved = await dependencies.approve(approval);
          await telemetry.event('approval', { kind: approval.kind, approved });
          return approved;
        },
        signal: request.signal, resume, images, prompt, carrySkills,
      });
      previous = await attempt(resume ? resumeNotice(config, previousTier!, tier, previous!.reason)
        : parked + basePrompt + (previous ? `\nPrevious attempt stopped: ${previous.reason}. ${previous.changedFiles?.length || previous.shellRan ? 'Existing edits are still in the repository; inspect them before proceeding. Do not restart blindly.' : 'It changed no files; continue the task from the context below.'}\nRecent execution context:\n${previous.handoff ?? previous.text.slice(-6000)}` : ''), resume);
      // A failure that would end the request hands off to a fresh orchestrator instead, with advice in place of the error.
      const ending = async (status: string, fallback?: string) => {
        const record = flow && !request.signal?.aborted ? await failover(flow, previous!, failedOver) : undefined;
        if (!record) return await finish(false, status, incomplete(previous!, fallback));
        failedOver = { reason: record.host.reason, generation: record.generation };
        // An answer the next agent gives without search is marked like one begun without it.
        if (record.host.reason === 'search_unavailable') searchUnverified = true;
        previous = { ...previous!, checkpoint: record };
        accessFailure = undefined;
        return undefined;
      };
      // Ends in a return, or a break that moves on to another tier; a failure handed off goes round again.
      for (;;) {
        // Each checkpoint hands the request to a fresh orchestrator on the same tier, with renewed limits and no routing.
        for (;;) {
          previousTier = tier;
          check = previous.check;
          for (const path of previous.changedFiles ?? []) changedFiles.add(path);
          for (const [path, size] of Object.entries(previous.fileSizes ?? {})) fileSizes.set(path, size);
          for (const failed of previous.failedCalls ?? []) failedCalls.set(`${failed.call}\n${failed.error}`, failed);
          shellRan ||= Boolean(previous.shellRan);
          // A later attempt in the same request gains nothing from searching a dead or exhausted service again.
          if (previous.searchExhausted) {
            searchDisabled = true;
            if (activePermissions.includes('web.search')) activePermissions.splice(activePermissions.indexOf('web.search'), 1);
          }
          const record = flow && !request.signal?.aborted && !accessFailure ? previous.checkpoint ?? await forcedCheckpoint(flow, previous) : undefined;
          if (!record) break;
          const view: CheckpointView = { record, ...checkpointCard(record), details: checkpointDetails(record, flow!.path(record)) };
          dependencies.onEvent?.({ type: 'checkpoint', generation: record.generation, title: view.title, lines: view.lines, forced: record.host.forced });
          const decision: CheckpointDecision = await dependencies.onCheckpoint?.(view, request.signal).catch(() => ({ action: 'continue' as const })) ?? { action: 'continue' };
          await telemetry.event('checkpoint_decision', { generation: record.generation, action: decision.action, forced: record.host.forced });
          if (request.signal?.aborted) return await finish(false, 'cancelled', 'Request cancelled.');
          if (decision.action === 'stop') {
            flow!.save({ ...record, status: 'parked' });
            return await finish(false, 'parked', `parked at checkpoint ${record.generation}. ask to continue it whenever you're ready.`);
          }
          if (decision.action === 'steer') { record.steer = decision.text.trim().slice(0, 2000); flow!.save(record); }
          recovery.allowance = undefined;
          attempts++;
          models.push(modelFor(config, tier).id);
          dependencies.onEvent?.({ type: 'attempt_start', attempt: attempts, model: modelFor(config, tier).id, tier, checkpoint: record.generation });
          previous = await attempt(continuation(record), undefined, record.host.skills);
        }
        if (accessFailure) { const ended = await ending('approval_denied', accessFailure); if (ended) return ended; continue; }
        await telemetry.event('attempt_end', { decisionId: decision?.decision_id, capability: selected, success: previous.success, reason: previous.reason, stopped: previous.stopped, turns: previous.turns, toolCalls: previous.toolCalls, check: previous.check, ...(previous.success ? {} : { ending: previous.ending }) });
        if (previous.success) return await finish(true, 'completed', previous.text);
        if (task && (!task.remaining().calls || !task.remaining().modelCalls || !task.remaining().ms)) {
          const status = !task.remaining().ms ? 'timeout' : !task.remaining().calls ? 'tool_limit' : 'turn_limit';
          return await finish(false, status, incomplete({ ...previous, stopped: status }));
        }
        if (casual || !previous.reason || ['budget', 'approval_denied', 'cancelled', 'timeout', 'tool_limit', 'search_unavailable'].includes(previous.stopped ?? '') || index === config.policy.escalation.maxEscalations) {
          const ended = await ending(previous.stopped ?? previous.reason ?? 'incomplete', index === config.policy.escalation.maxEscalations ? 'Fallback: configured escalation limit reached.' : undefined);
          if (ended) return ended;
          continue;
        }
        // Overthinking steps down to less reasoning on the same model; everything else steps up.
        const onward = previous.reason === 'overthinking'
          ? tiers.slice(0, tiers.indexOf(tier)).reverse().filter(lower => profileFor(lower).model === profileFor(tier).model)
          : tiers.slice(tiers.indexOf(tier) + 1);
        const fallback = onward.map(nextTier => {
          const candidate = capabilities(config, budget, localOnline, { workload, tier: nextTier }, { physicalOnline, relatedLock: request.relatedTier }).find(c => c.id === `${workload}.${nextTier}`)!;
          if (request.web && !modelFor(config, nextTier).toolCalling) candidate.availability = { available: false, reason: 'Web search requires tool calling' };
          const currentModel = modelFor(config, tier), nextModel = modelFor(config, nextTier);
          if (previous?.reason === 'provider_error' && currentModel.provider === nextModel.provider && currentModel.baseUrl === nextModel.baseUrl && currentModel.id === nextModel.id)
            candidate.availability = { available: false, reason: 'this provider/model already exhausted recovery; a different tier is not a different model' };
          return { tier: nextTier, assessment: assessCandidate(config, candidate) };
        });
        const next = fallback.find(item => item.assessment.allowed)?.tier;
        if (!next) {
          const resumableSameTier = ['unsupported', 'turn_limit', 'ineffective_calls', 'tool_failures', 'test_failures'];
          const repositoryWork = selected?.startsWith('coder.') || changedFiles.size > 0 || shellRan;
          // Without repository work, resuming the same model after repeated calls just repeats them.
          const madeProgress = previous.reason === 'ineffective_calls' ? repositoryWork : previous.turns > 0 || repositoryWork;
          if (!previous.reason || !resumableSameTier.includes(previous.reason) || !madeProgress) {
            const ended = await ending('escalation_unavailable', `Fallback unavailable: ${fallback.map(item => `${item.tier}: ${item.assessment.reason}`).join('; ') || `no ${previous.reason === 'overthinking' ? 'lower' : 'higher'} tier configured`}.`);
            if (ended) return ended;
            continue;
          }
          dependencies.onProgress?.(`No higher-tier fallback is available; continuing ${selected} with its execution handoff.`);
          await telemetry.event('continuation', { capability: selected, reason: previous.reason, fallback: 'unavailable' });
          scope = { workload, tier };
          break;
        }
        await telemetry.event('escalation', { from: selected, to: `${workload}.${next}`, reason: previous.reason });
        scope = { workload, tier: next };
        break;
      }
    }
    return await finish(false, 'limit', 'Escalation limit reached.');
  } catch (error) {
    if (request.signal?.aborted) return await finish(false, 'cancelled', 'Request cancelled.');
    await telemetry.event('request_error', { name: error instanceof Error ? error.name : 'Error' });
    throw error;
  } finally { try { await unlock(); } finally { await idle(); dependencies.onActivity?.(undefined); } }
}

/** The host's own checkpoint, for an orchestrator that ran out without submitting one: its notes are absent, its facts are not. */
async function forcedCheckpoint(flow: Workflow, attempt: AttemptResult): Promise<CheckpointRecord | undefined> {
  if (!flow.canCheckpoint) return undefined;
  const stops: Record<string, HandoffReason> = { timeout: 'time', tool_limit: 'tool_calls', turn_limit: 'model_calls' };
  const reason = attempt.checkpointMissed?.reason ?? stops[attempt.stopped ?? ''] ?? (attempt.reason === 'turn_limit' ? 'model_calls' : undefined);
  if (!reason) return undefined;
  return flow.checkpoint({ reason, forced: true, attempts: attempt.checkpointMissed?.attempts ?? 0 });
}

/** A failure that would end the request, as a checkpoint; not for the agent a failure already handed to, so failures never chain. */
async function failover(flow: Workflow, attempt: AttemptResult, last?: { reason: HandoffReason; generation: number }): Promise<CheckpointRecord | undefined> {
  const failures: Record<string, HandoffReason> = { approval_denied: 'cancelled', context_limit: 'context_limit', search_unavailable: 'search_unavailable', ineffective_calls: 'ineffective_calls' };
  const reason = failures[attempt.stopped ?? ''] ?? failures[attempt.reason ?? ''];
  if (!reason || !flow.canCheckpoint || last?.generation === flow.generation) return undefined;
  return flow.checkpoint({ reason, forced: true, attempts: 0 });
}

/** What a retry on the same model is told: why the last attempt stopped, and what this one has that it lacked. */
function resumeNotice(config: Config, from: Tier, to: Tier, reason?: string): string {
  const thinking = thinkingFor(config, to), reply = effectiveProfile(config, to).maxOutputTokens;
  const now = [thinking !== thinkingFor(config, from) ? `${thinking === 'off' ? 'no' : thinking} reasoning` : '', reply > effectiveProfile(config, from).maxOutputTokens ? `replies of up to ${reply} tokens` : ''].filter(Boolean).join(' and ');
  const advice = reason === 'turn_limit' ? 'Carry on from where it stopped.' : 'Work out what went wrong above before calling tools again, and do not repeat calls that already gave the same result.';
  return `[notice] That attempt stopped (${(reason ?? 'incomplete').replaceAll('_', ' ')}).${now ? ` It carries on here with ${now}.` : ''} ${advice}`;
}

/** Steps outlive the request (Discord keeps them on disk), so secrets are masked like the answer text; if masking breaks them they are dropped. */
function redactSteps(steps: Message[], redact: (text: string) => string): Message[] | undefined {
  try { return JSON.parse(redact(JSON.stringify(steps))) as Message[]; } catch { return undefined; }
}
