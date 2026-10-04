import { during, type ActivityUI } from './activity.js';
import { Agent, type AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type ImageContent } from '@earendil-works/pi-ai';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config, Tier } from './config.js';
import { tiers } from './config.js';
import { runAttempt } from './agents/run.js';
import { canvasLibrary } from './discord/images.js';
import { SpendGovernor, lockState } from './inference/budget.js';
import { budgetedJev, guardedStream, piModel, type InferenceState } from './inference/providers.js';
import { Telemetry } from './telemetry/outcome.js';
import { defaultPolicy, JevRouter } from 'jevrouter';
import { capabilities } from './routing/capabilities.js';
import { effectiveProfile, modelFor, profileAvailable, profileFor, reasoningTier, thinkingFor, type ThinkingLevel } from './routing/execution.js';
import { managedRuntimes, runtimeHints, type Runtimes } from './runtime/index.js';
import { configureWorkspace } from './workspace/configure.js';

/** Hints from the runtimes TeaPilot manages, for a model whose endpoint check failed. */
export async function endpointHint(config: Config, tier: Tier, log: (text: string) => void, signal?: AbortSignal, runtimes?: Runtimes): Promise<void> {
  for (const hint of await runtimeHints(modelFor(config, tier), signal ?? new AbortController().signal, runtimes)) log(hint);
}

export async function routingCheck(config: Config, consent: (message: string) => Promise<boolean>, log: (text: string) => void, signal?: AbortSignal): Promise<boolean> {
  if (!config.router.apiKey) { log('Hosted routing: FAIL (missing key). Run teapilot setup to configure routing.'); return false; }
  if (!await consent(`Verify hosted routing with one paid routing call (maximum $${config.router.maxCallUsd}, within request/day budgets)? No local model will be called.`)) {
    log('Hosted routing: NOT TESTED (paid check declined).'); return false;
  }
  signal?.throwIfAborted();
  const unlock = await lockState(config.stateDir);
  try {
    const id = randomUUID();
    const budget = new SpendGovernor(join(config.stateDir, 'spend.jsonl'), id, config.policy.budget);
    await budget.load();
    const telemetry = new Telemetry(config.stateDir, id, [config.router.apiKey]);
    const router = new JevRouter(budgetedJev(config, budget, telemetry), { ...defaultPolicy, ...config.policy.router, single_stage_max_candidates: 32 });
    const decision = await router.route({ request: 'Explain dependency injection. Diagnostic routing only; do not execute.', actor_permissions: config.policy.permissions }, capabilities(config, budget, true));
    await telemetry.receipt(decision);
    signal?.throwIfAborted();
    const passed = Boolean(decision.decision.selected && decision.status !== 'no_decision');
    log(`Hosted routing: ${passed ? 'PASS' : 'FAIL (no authorized route)'}; accounted $${budget.spent().request.toFixed(6)}. Execution readiness is checked separately.`);
    return passed;
  } catch {
    signal?.throwIfAborted();
    log('Hosted routing: FAIL. Check routing credentials, provider settings, and remaining budget; rerun teapilot doctor --live.');
    return false;
  } finally { await unlock(); }
}

/** Why a model's endpoint cannot serve it: the server is not ready, its API is incompatible, or the model is missing. */
export interface EndpointProblem { layer: 'not-ready' | 'api' | 'model-missing'; message: string }

/** The cheap check: API metadata only, never generation. */
export async function endpointStatus(config: Config, tier: Tier, signal?: AbortSignal): Promise<EndpointProblem | undefined> {
  const model = modelFor(config, tier); const secret = config.secrets[profileFor(tier).model];
  try {
    const response = await fetch(`${model.baseUrl.replace(/\/$/, '')}/models`, {
      headers: secret ? { Authorization: `Bearer ${secret}` } : {},
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000), redirect: 'error',
    });
    if (!response.ok) return { layer: 'api', message: `Model listing returned HTTP ${response.status}; check the endpoint and credential.` };
    const body = await response.json() as { data?: Array<{ id?: string }> };
    if (!Array.isArray(body.data)) return { layer: 'api', message: 'Endpoint did not return an OpenAI-compatible model list.' };
    if (!body.data.some(item => item.id === model.id)) return { layer: 'model-missing', message: 'Selected model is not installed/available; rerun teapilot setup.' };
    return undefined;
  } catch {
    signal?.throwIfAborted();
    return { layer: 'not-ready', message: 'Endpoint is unreachable; start the model server and check its URL.' };
  }
}

/** Process-level state of the managed runtimes serving the configured models. Cheap: no generation. */
async function runtimeStatus(config: Config, log: (text: string) => void, signal: AbortSignal, runtimes: Runtimes = managedRuntimes()): Promise<void> {
  const urls = new Set(Object.values(config.models).filter(model => model.enabled).map(model => model.baseUrl.replace(/\/$/, '')));
  for (const driver of Object.values(runtimes)) {
    if (!driver) continue;
    const state = await driver.inspect(signal).catch(() => { signal.throwIfAborted(); return undefined; });
    if (!state?.baseUrl || !urls.has(state.baseUrl.replace(/\/$/, ''))) continue;
    log(`Runtime: ${driver.label}: ${state.ready ? `running${state.version ? ` (${state.version})` : ''}` : 'NOT RUNNING'}${state.detail ? `; ${state.detail}` : ''}`);
    for (const warning of state.warnings ?? []) log(`Runtime: ${driver.label}: WARNING ${warning}`);
  }
}

export async function modelStatus(config: Config, tier: Tier, signal?: AbortSignal): Promise<string | undefined> {
  return (await endpointStatus(config, tier, signal))?.message;
}

/**
 * The layer a live check stopped at, so setup and doctor need not match message text:
 * the server could not load the model, rejected the request as incompatible, or
 * the streamed answer, tool continuation or coding edit failed.
 */
export type LiveFailure = 'load' | 'api' | 'answer' | 'tools' | 'coding';
export interface LiveReport {
  ask: boolean; tools: boolean; coding: boolean; spentUsd: number;
  /** An image sent to the model was seen; set only when the model is configured for vision. */
  vision?: boolean;
  /** Reasoning levels whose own streamed answer passed; set only when candidates were given. */
  reasoning?: ThinkingLevel[];
  failure?: LiveFailure;
}
const failureAdvice: Record<LiveFailure, string> = {
  load: 'The server could not load the model; choose another model or free memory on the server.',
  api: 'The server rejected the request as unsupported; check that it is OpenAI-compatible and serves this model.',
  answer: 'Try another model or update the model server.',
  tools: 'Try another model or update the model server.',
  coding: 'Check context capacity or choose another model.',
};

/** A plain red square, large enough for a vision model's smallest image size. */
async function probeImage(): Promise<ImageContent> {
  const { createCanvas } = await canvasLibrary();
  const canvas = createCanvas(128, 128);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ff0000';
  context.fillRect(0, 0, 128, 128);
  return { type: 'image', data: canvas.toBuffer('image/png').toString('base64'), mimeType: 'image/png' };
}

// Uses the production metered streaming adapter and real pi file tools. The probe
// never executes generated code; coding file tools are confined to its disposable directory.
// Each reasoning candidate is enabled only by its own streamed answer on its tier.
export async function liveCheck(config: Config, tier: Tier, signal?: AbortSignal, progress: (text: string) => void = () => {}, reasoning: ThinkingLevel[] = []): Promise<LiveReport> {
  if (!config.policy.permissions.includes('inference')) throw new Error('Live inference is disabled by the configured permission policy.');
  const unlock = await lockState(config.stateDir);
  let scratch: string | undefined;
  const report: LiveReport = { ask: false, tools: false, coding: false, spentUsd: 0 };
  try {
    scratch = await mkdtemp(join(tmpdir(), 'teapilot-probe-'));
    const requestId = randomUUID();
    const budget = new SpendGovernor(join(config.stateDir, 'spend.jsonl'), requestId, config.policy.budget);
    await budget.load();
    const telemetry = new Telemetry(config.stateDir, requestId, [config.router.apiKey, ...Object.values(config.secrets)].filter((v): v is string => Boolean(v)));
    const probeConfig = structuredClone(config);
    // Probes decode greedily at every level, so a pass does not depend on sampling luck.
    const probed = modelFor(probeConfig, tier);
    probed.temperature = 0;
    for (const sampling of Object.values(probed.sampling ?? {})) sampling.temperature = 0;
    probeConfig.policy.limits.maxTurns = Math.min(6, config.policy.limits.maxTurns);
    // Probes send exactly what production sends for the tier: any reasoning
    // request comes from the model's protocol, never from a prompt suffix.
    async function run(prompt: string, tools: AgentTool[] = [], probeTier = tier, images?: ImageContent[]): Promise<{ text: string; ok: boolean; failure?: string; layer?: LiveFailure }> {
      const state: InferenceState = { turns: 0 };
      const agent = new Agent({
        initialState: { model: piModel(modelFor(probeConfig, probeTier), effectiveProfile(probeConfig, probeTier)), systemPrompt: 'Follow the diagnostic task exactly. Use only the provided tools. Do not use markdown in the final answer. Align with the user\'s typing style and tone - leaning towards informal lowercase responses', tools, thinkingLevel: thinkingFor(probeConfig, probeTier) },
        streamFn: guardedStream(probeConfig, probeTier, budget, telemetry, state), toolExecution: 'sequential',
      });
      const abort = () => agent.abort();
      const timer = setTimeout(abort, config.policy.limits.attemptTimeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      try { signal?.throwIfAborted(); await agent.prompt(prompt, images); }
      finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
      signal?.throwIfAborted();
      const last = agent.state.messages.findLast(message => message.role === 'assistant');
      const stopReason = last?.role === 'assistant' ? last.stopReason : 'no response';
      return {
        ok: stopReason === 'stop', text: last?.role === 'assistant' ? last.content.filter(part => part.type === 'text').map(part => part.text).join('') : '',
        failure: state.providerDetail ?? (state.stop ? `inference stopped (${state.stop})` : stopReason !== 'stop' ? `stop reason ${stopReason}` : undefined),
        layer: state.providerDetail ? 'load' : state.stop === 'unsupported' ? 'api' : undefined,
      };
    }
    progress('Checking streamed answers...');
    const answer = await run('Reply with exactly TEAPILOT_OK.');
    report.ask = answer.ok && answer.text.includes('TEAPILOT_OK');
    if (!report.ask) {
      report.failure = answer.layer ?? 'answer';
      progress(`Answer check failed: ${answer.failure ?? 'reply did not contain TEAPILOT_OK'}. ${failureAdvice[report.failure]}`);
    }
    // A server that ignores images still answers, so the colour has to come back.
    if (report.ask && modelFor(config, tier).vision) {
      progress('Checking image input...');
      const seen = await run('What colour is this image? Reply with one word.', [], tier, [await probeImage()]);
      report.vision = seen.ok && /\bred\b/i.test(seen.text);
      if (!report.vision) progress(`Image check failed: ${seen.failure ?? `the model answered "${seen.text.trim().slice(0, 80)}" to a red image`}. Images stay off for this model.`);
    }
    const candidates = reasoning.filter(level => level !== 'off' && profileFor(reasoningTier[level]).model === profileFor(tier).model);
    if (report.ask && candidates.length) {
      report.reasoning = [];
      const model = modelFor(probeConfig, tier);
      const verified = model.reasoningEfforts; const deepEffort = probeConfig.policy.reasoning;
      for (const level of candidates) {
        const levelTier = reasoningTier[level];
        // The candidate counts as enabled during its own probe, so its tier gets its own limits.
        model.reasoningEfforts = [...new Set([...verified, level])];
        // Deep runs medium or xhigh; its probe asks for the level being checked.
        if (level === 'medium' || level === 'xhigh') probeConfig.policy.reasoning = { deepEffort: level };
        progress(`Checking ${levelTier} (${level}) answers...`);
        const result = await run('Reply with exactly TEAPILOT_OK.', [], levelTier);
        if (result.ok && result.text.includes('TEAPILOT_OK')) report.reasoning.push(level);
        else progress(`${levelTier[0]!.toUpperCase()}${levelTier.slice(1)} check failed: ${result.failure ?? 'reply did not contain TEAPILOT_OK'}. ${level} reasoning stays unavailable.`);
      }
      model.reasoningEfforts = verified; probeConfig.policy.reasoning = deepEffort;
    }
    if (report.ask && modelFor(config, tier).toolCalling) {
      progress('Checking tool calls and continuation...');
      const token = randomUUID();
      let called = false;
      const tool: AgentTool = {
        name: 'teapilot_probe', label: 'Diagnostic', description: 'Return the diagnostic token.', parameters: Type.Object({}),
        execute: async () => { called = true; return { content: [{ type: 'text', text: token }], details: {} }; },
      };
      const result = await run('Call teapilot_probe, then reply with the exact token returned by the tool.', [tool]);
      report.tools = called && result.ok && result.text.includes(token);
      if (!report.tools) {
        report.failure = result.layer ?? 'tools';
        progress(`Tool check failed: executed=${called}, completed=${result.ok}, returned token=${result.text.includes(token)}. ${failureAdvice[report.failure]}`);
      }
      if (report.tools) {
        progress('Checking a disposable coding task...');
        const nonce = randomUUID();
        const before = `// ${nonce}\nexport const add = (a, b) => a - b;\n`;
        const expected = before.replace('a - b', 'a + b');
        await writeFile(join(scratch, 'fixture.js'), before);
        probeConfig.policy.permissions = probeConfig.policy.permissions.filter(permission => ['inference', 'repository.read', 'repository.write'].includes(permission));
        const result = await runAttempt({ config: probeConfig, skillCatalog: { root: '', skills: [], warnings: [] }, tier, workload: 'coder', cwd: scratch,
          prompt: 'Read fixture.js. Change only the subtraction operator to addition, preserving every other character including the comment and final newline. Write fixture.js, then reply DONE. Do not call any shell.',
          web: false, budget, telemetry, approve: async () => false, signal });
        signal?.throwIfAborted();
        report.coding = result.success && result.toolCalls >= 2 && await readFile(join(scratch, 'fixture.js'), 'utf8') === expected;
        if (!report.coding) {
          report.failure = 'coding';
          progress(`Coding check failed: ${result.stopped ?? result.reason ?? 'file edit did not match the fixture'}; ${result.toolCalls} tool calls. ${failureAdvice.coding}`);
        }
      }
    }
    report.spentUsd = budget.spent().request;
    await telemetry.event('diagnostic', { tier, ...report });
    return report;
  } finally {
    try { if (scratch) await rm(scratch, { recursive: true, force: true }); }
    finally { await unlock(); }
  }
}

export async function doctor(config: Config, cwd: string, options: ActivityUI & { live?: boolean; signal?: AbortSignal; consent: (message: string) => Promise<boolean>; log: (text: string) => void; runtimes?: Runtimes }): Promise<boolean> {
  const { log } = options;
  let healthy = true;
  if (config.source) {
    log(`Configuration: ${config.source.directory} (${config.source.reason})`);
    if (config.source.overrides.length) log(`Environment overrides (names only): ${config.source.overrides.join(', ')}`);
  }
  log(`Repository: ${cwd} (--cwd; independent of configuration)`);
  if (!options.live) log('Basic check: endpoint metadata only. Answers, tool use, and coding: NOT TESTED in this check.');
  log(`Routing: ${config.routingMode ?? 'hosted'}`);
  if (config.routingMode !== 'direct') {
    log(`Hosted routing credential: ${config.router.apiKey ? 'configured (not live-tested)' : 'MISSING; run teapilot setup'}`);
    healthy &&= Boolean(config.router.apiKey);
    if (options.live) healthy = await during(options, 'Verifying hosted routing...', () => routingCheck(config, options.consent, log, options.signal)) && healthy;
  }
  try {
    await access(cwd);
    await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
    const probe = await mkdtemp(join(config.stateDir, '.doctor-'));
    await rm(probe, { recursive: true });
    log('Workspace and state directory: accessible');
  } catch { log('Workspace or state directory is inaccessible; check paths and permissions.'); healthy = false; }
  await during(options, 'Checking model runtimes...', () => runtimeStatus(config, log, options.signal ?? new AbortController().signal, options.runtimes));
  let available = false;
  for (const tier of tiers) {
    const model = modelFor(config, tier);
    if (!model.enabled) continue;
    const availability = profileAvailable(config, tier);
    if (!availability.available) { log(`${tier}: unavailable (${availability.reason}); rerun setup to verify it.`); continue; }
    const problem = await during(options, `Checking ${tier} endpoint...`, () => endpointStatus(config, tier, options.signal));
    const error = problem?.message;
    log(`${tier}: ${model.id}; endpoint ${model.baseUrl}: ${error ? `FAIL: ${error}` : 'PASS (model found; live inference checked separately)'}`);
    if (config.policy.disabledCapabilities.includes(`coder.${tier}`)) log(`${tier}: coding is disabled by configuration; rerun setup to reconfigure and validate it.`);
    if (error) { healthy = false; await during(options, 'Checking local endpoint...', () => endpointHint(config, tier, log, options.signal, options.runtimes)); continue; }
    available = true;
    if (options.live) {
      if (!await options.consent(`Run local ${tier} diagnostic calls within the configured request/day limits?`)) { log(`${tier}: live check declined`); healthy = false; continue; }
      const result = await during(options, `Verifying ${tier} answers and coding...`, () => liveCheck(config, tier, options.signal, log));
      log(`${tier}: answers ${result.ask ? 'PASS' : 'FAIL'}; tools ${result.tools ? 'PASS' : 'unverified'}; coding ${result.coding ? 'PASS' : 'unverified'}; accounted $${result.spentUsd.toFixed(6)}`);
      healthy &&= result.ask && (!model.toolCalling || result.coding);
    }
  }
  await configureWorkspace(config, { ...options, confirm: options.consent }, options.signal ?? new AbortController().signal);
  log(`Budgets: $${config.policy.budget.requestUsd}/request; $${config.policy.budget.dailyUsd}/UTC day`);
  if (!options.live) log('Run teapilot doctor --live to verify streamed inference and coding.');
  return healthy && available;
}
