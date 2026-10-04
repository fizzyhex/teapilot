import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenv } from 'dotenv';
import { readTeachatSettings, type TeachatSettings } from './teachat/settings.js';
import { readerModes, type ReaderSettings } from './web/settings.js';
import type { WorkspaceSettings } from './workspace/sandbox.js';
import { z } from 'zod';
import { normalizeSets, skillConfigSchema, type SkillSettings } from './skills/settings.js';

const money = z.number().finite().nonnegative();
const endpoint = z.string().url().refine(value => {
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
}, 'Use an HTTP(S) endpoint without embedded credentials, query, or fragment');
export const reasoningLevels = ['off', 'low', 'medium', 'xhigh'] as const;
export type ReasoningLevel = typeof reasoningLevels[number];
const effort = z.enum(reasoningLevels);
// How a model's server is asked for each reasoning level. It describes the wire
// format only: reasoningEfforts remains the one record of which levels passed
// their live check. A level without a value sends no reasoning field.
//   reasoning_effort:     { reasoning_effort: values[level] }
//   chat_template_kwargs: { chat_template_kwargs: values[level] }, for servers whose
//                         chat template decides thinking (e.g. enable_thinking: false)
const templateValue = z.union([z.string(), z.number(), z.boolean()]);
const reasoningSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('reasoning_effort'), values: z.object({ off: z.string().min(1), low: z.string().min(1), medium: z.string().min(1), xhigh: z.string().min(1) }).partial().strict() }).strict(),
  z.object({ type: z.literal('chat_template_kwargs'), values: z.object(Object.fromEntries(reasoningLevels.map(level => [level, z.record(z.string().regex(/^[a-z_][a-z0-9_]*$/i), templateValue)])) as Record<ReasoningLevel, z.ZodRecord<z.ZodString, typeof templateValue>>).partial().strict() }).strict(),
]);
export type ReasoningProtocol = z.infer<typeof reasoningSchema>;
// Decoding settings for each reasoning level, sent with every request at that level.
// Unset fields are left to the server's defaults.
const samplingSchema = z.object({
  temperature: z.number().min(0).max(2), top_p: z.number().gt(0).max(1), top_k: z.number().int().min(0),
  min_p: z.number().min(0).max(1), presence_penalty: z.number().min(-2).max(2), repetition_penalty: z.number().gt(0).max(2),
}).partial().strict();
export type Sampling = z.infer<typeof samplingSchema>;
const thinkingSamplingSchema = z.object(Object.fromEntries(reasoningLevels.map(level => [level, samplingSchema])) as Record<ReasoningLevel, typeof samplingSchema>).partial().strict();
export type ThinkingSampling = z.infer<typeof thinkingSamplingSchema>;
const modelSchema = z.object({
  enabled: z.boolean(), id: z.string().min(1), provider: z.string().min(1), baseUrl: endpoint,
  apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/), contextTokens: z.number().int().min(4096).max(2_000_000),
  maxOutputTokens: z.number().int().min(128).max(32768), inputUsdPerMillion: money, outputUsdPerMillion: money,
  vision: z.boolean().default(false), toolCalling: z.boolean().default(true), supportsDeveloperRole: z.boolean().default(false),
  supportsUsage: z.boolean().default(true), temperature: z.number().min(0).max(2).optional(),
  sampling: thinkingSamplingSchema.optional(),
  reasoningEfforts: z.array(effort).min(1).default(['off']), reasoning: reasoningSchema.optional(), compatibility: z.boolean().default(false),
}).strict().refine(m => m.maxOutputTokens + 2048 < m.contextTokens, 'Context must leave room for input')
  .refine(m => !m.reasoning || m.reasoningEfforts.every(level => level === 'off' || m.reasoning!.values[level]), 'Every verified reasoning level needs a value in the reasoning protocol');

export const tiers = ['fast', 'normal', 'reasoning', 'deep'] as const;
export type Tier = typeof tiers[number];
export const tierPreferences = ['auto', ...tiers] as const;
export type TierPreference = typeof tierPreferences[number];
export const isTierPreference = (value: unknown): value is TierPreference => tierPreferences.includes(value as TierPreference);
export const physicalModels = ['fast', 'capable'] as const;
export type PhysicalModel = typeof physicalModels[number];
export type Workload = 'coder' | 'ask';
export type ModelConfig = z.infer<typeof modelSchema>;
const canonicalModelsSchema = z.object({ fast: modelSchema, capable: modelSchema }).strict();
export const modelsSchema = canonicalModelsSchema;
export type CanonicalModels = z.infer<typeof canonicalModelsSchema>;
export type ModelSet = CanonicalModels;

export const policySchema = z.object({
  router: z.object({ min_confidence: z.number().min(0).max(1), allowed_risk_levels: z.array(z.enum(['low', 'medium', 'high', 'critical'])), confirmation_risk_levels: z.array(z.enum(['low', 'medium', 'high', 'critical'])), require_verified_candidates: z.boolean() }).strict(),
  permissions: z.array(z.enum(['inference', 'repository.read', 'repository.write', 'repository.shell', 'web.search', 'discord.play'])),
  disabledCapabilities: z.array(z.string()),
  budget: z.object({ requestUsd: money, dailyUsd: money, approvalThresholdUsd: money }).strict(),
  limits: z.object({ maxTurns: z.number().int().min(1).max(1000), maxToolCalls: z.number().int().min(1).max(300), attemptTimeoutMs: z.number().int().min(1000).max(3_600_000), requestTimeoutMs: z.number().int().min(1000).max(120_000), commandTimeoutSeconds: z.number().int().min(1).max(600), maxPromptChars: z.number().int().min(1).max(20_000),
    /** delegate_task messages one attempt may send to its juniors (agents/delegate.ts); 6 when unset. */
     maxJuniorTurns: z.number().int().min(0).max(30).optional(), planningToolCalls: z.number().int().min(1).max(300).optional(),
     instructorToolCalls: z.number().int().min(1).max(300).optional(), juniorToolCalls: z.number().int().min(1).max(300).optional(), maxContinuationBatches: z.number().int().min(0).max(10).optional() }).strict(),
  escalation: z.object({ maxEscalations: z.number().int().min(0).max(3), consecutiveFailures: z.number().int().min(1).max(10), repeatedToolCalls: z.number().int().min(2).max(10) }).strict(),
  execution: z.object({ trustedCommands: z.array(z.string().min(1)), largeOverwriteBytes: z.number().int().min(1) }).strict(),
  /** deepEffort: the reasoning level the deep tier runs (medium unless xhigh is opted into). */
  reasoning: z.object({ deepEffort: z.enum(['medium', 'xhigh']) }).strict().optional(),
}).strict();
export type Policy = z.infer<typeof policySchema>;

export interface Config {
  source?: { directory: string; reason: string; overrides: string[]; warnings?: string[] };
  routingMode?: 'hosted' | 'direct'; models: ModelSet; policy: Policy; stateDir: string;
  router: { provider: 'typesafe' | 'openrouter'; model?: string; apiKey?: string; endpoint?: string; maxCallUsd: number; usdPerMillionTokens?: number };
  searchUrl?: string;
  /** How web.search sessions read pages: WEB_READER and AGENT_BROWSER_BIN. */
  webReader?: ReaderSettings;
  teachat?: TeachatSettings;
  /** Sandboxed workspace commands: WORKSPACE_SANDBOX, WORKSPACE_ALLOWED_DOMAINS and WORKSPACE_DENIED_DOMAINS. */
  workspace?: WorkspaceSettings;
  /** Each session's scratchpad folder; TEAPILOT_SCRATCHPAD=off turns it off. */
  scratchpad?: { enabled: boolean };
  /** Summarising earlier context when it nears the model's limit (agents/compaction.ts); TEAPILOT_COMPACTION=off turns it off. */
  compaction?: { enabled: boolean };
  /** Handing parts of a large request to juniors (agents/delegate.ts); TEAPILOT_DELEGATION=off turns it off. */
  delegation?: { enabled: boolean };
  /** A line of guidance on the tool result that calls for it (agents/tips.ts); TEAPILOT_TIPS=off turns it off. */
  tips?: { enabled: boolean };
  /** Durable bounded working state and request-wide junior accounting; TEAPILOT_TASK_STATE=off disables it. */
  taskState?: { enabled: boolean };
  /** Repository-backed skill sets, with an optional offline local-directory replacement. */
  skills?: SkillSettings;
  /** Hooks for evaluating teapilot (see readTestHooks); each is off unless its variable is set. */
  test?: TestHooks;
  secrets: Record<PhysicalModel, string | undefined>;
}

const fixtureSchema = z.object({ name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), description: z.string().min(1).max(1000), file: z.string().min(1) }).strict();
/**
 * For benchmarks only. TEAPILOT_FIXTURE_TOOL registers a read-only tool returning a file's text; TEAPILOT_TEST_HISTORY_TOKENS
 * caps how much of earlier turns an attempt replays, and TEAPILOT_TEST_COMPACT_HISTORY=1 replays even the newest compacted; TEAPILOT_TEST_FORCE_RETRY ends the first attempt after that tool first
 * succeeds; TEAPILOT_TRACE_DIR records what each model call was sent.
 */
export interface TestHooks { fixture?: z.infer<typeof fixtureSchema>; historyTokens?: number; compactHistory?: boolean; forceRetry?: string; traceDir?: string }
function readTestHooks(env: NodeJS.ProcessEnv, root: string): TestHooks | undefined {
  const hooks: TestHooks = {
    ...(env.TEAPILOT_FIXTURE_TOOL ? { fixture: (fixture => ({ ...fixture, file: resolve(root, fixture.file) }))(fixtureSchema.parse(JSON.parse(env.TEAPILOT_FIXTURE_TOOL))) } : {}),
    ...(env.TEAPILOT_TEST_HISTORY_TOKENS ? { historyTokens: z.coerce.number().int().min(0).parse(env.TEAPILOT_TEST_HISTORY_TOKENS) } : {}),
    ...(env.TEAPILOT_TEST_COMPACT_HISTORY === '1' ? { compactHistory: true } : {}),
    ...(env.TEAPILOT_TEST_FORCE_RETRY ? { forceRetry: env.TEAPILOT_TEST_FORCE_RETRY } : {}),
    ...(env.TEAPILOT_TRACE_DIR ? { traceDir: resolve(root, env.TEAPILOT_TRACE_DIR) } : {}),
  };
  return Object.keys(hooks).length ? hooks : undefined;
}

async function readConfig(path: string): Promise<unknown> { return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')); }
export const templateDir = fileURLToPath(new URL('../config/', import.meta.url));
export const userConfigDir = (): string => resolve(homedir(), '.teapilot/config');
export async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
export async function configDirectory(explicit?: string, cwd = process.cwd(), personal = userConfigDir()): Promise<string> {
  if (explicit) return resolve(explicit);
  for (const marker of ['config/models.json', 'config/models.example.json']) if (await exists(resolve(cwd, marker))) return cwd;
  if (await exists(resolve(cwd, '.env')) && /^(?:TEAPILOT_|JEV_|TYPESAFE_API_KEY\s*=|LOCAL_MODEL\s*=|FAST_MODEL\s*=)/m.test(await readFile(resolve(cwd, '.env'), 'utf8'))) return cwd;
  return personal;
}

function legacyCloudEnabled(raw: Record<string, unknown>, env: NodeJS.ProcessEnv): boolean {
  const economy = (raw.economy ?? {}) as Record<string, unknown>; const strong = (raw.strong ?? {}) as Record<string, unknown>;
  return economy.enabled === true || strong.enabled === true || env.ECONOMY_ENABLED === 'true' || env.STRONG_ENABLED === 'true' || Boolean(env.ECONOMY_MODEL || env.STRONG_MODEL);
}
/** The reasoning request older Ollama configurations sent, keyed then by provider. */
export const ollamaReasoning: ReasoningProtocol = { type: 'reasoning_effort', values: { off: 'none', low: 'low', medium: 'medium', xhigh: 'xhigh' } };
// Configurations saved before models declared a reasoning protocol: Ollama models
// keep exactly the payload they sent, and other endpoints keep sending none.
function withReasoningProtocol(models: CanonicalModels): CanonicalModels {
  for (const model of Object.values(models)) if (!model.reasoning && model.provider === 'ollama') model.reasoning = structuredClone(ollamaReasoning);
  return models;
}
function canonicalize(raw: unknown, env: NodeJS.ProcessEnv): { models: CanonicalModels; warnings: string[] } {
  if (!raw || typeof raw !== 'object') throw new Error('Model configuration must be a JSON object.');
  const object = raw as Record<string, unknown>;
  if ('fast' in object || 'capable' in object) return { models: withReasoningProtocol(canonicalModelsSchema.parse(object)), warnings: [] };
  if (!('local' in object) || !('economy' in object) || !('strong' in object)) throw new Error('Model configuration must define fast and capable models. Run teapilot setup to migrate it.');
  if (legacyCloudEnabled(object, env)) throw new Error('Cloud execution settings from legacy economy/strong tiers are no longer supported. Disable them and run teapilot setup to configure local fast/capable models.');
  const local = modelSchema.parse(object.local);
  const capable: ModelConfig = { ...local, inputUsdPerMillion: 0, outputUsdPerMillion: 0, reasoningEfforts: ['off'], compatibility: true };
  const fast: ModelConfig = { ...capable, enabled: false, id: `${local.id}:fast-unavailable` };
  return { models: withReasoningProtocol(canonicalModelsSchema.parse({ fast, capable })), warnings: ['Loaded legacy local-only configuration as compatibility capable-only; setup must verify the target models before fast, medium, or xhigh execution is enabled.'] };
}
function applyOverride(model: ModelConfig, env: NodeJS.ProcessEnv, prefix: string): void {
  if (env[`${prefix}_MODEL`]) model.id = env[`${prefix}_MODEL`]!;
  if (env[`${prefix}_BASE_URL`]) model.baseUrl = env[`${prefix}_BASE_URL`]!;
  if (env[`${prefix}_ENABLED`]) model.enabled = z.enum(['true', 'false']).parse(env[`${prefix}_ENABLED`]) === 'true';
  if (env[`${prefix}_INPUT_USD_PER_MILLION`]) model.inputUsdPerMillion = money.parse(Number(env[`${prefix}_INPUT_USD_PER_MILLION`]));
  if (env[`${prefix}_OUTPUT_USD_PER_MILLION`]) model.outputUsdPerMillion = money.parse(Number(env[`${prefix}_OUTPUT_USD_PER_MILLION`]));
}

export async function loadConfig(root?: string, env = process.env): Promise<Config> {
  const explicit = Boolean(root); root = await configDirectory(root); dotenv({ path: resolve(root, '.env'), processEnv: env, quiet: true });
  const overrides = Object.keys(env).filter(key => /^(TEAPILOT_|JEV_|LOCAL_|ECONOMY_|STRONG_|FAST_|CAPABLE_|TEACHAT_|SEARCH_BASE_URL$|WEB_READER$|AGENT_BROWSER_BIN$|WORKSPACE_|REQUEST_BUDGET_USD$|DAILY_BUDGET_USD$|TYPESAFE_API_KEY$|OPENROUTER_API_KEY$)/.test(key) && env[key] !== undefined).sort();
  const select = async (override: string | undefined, name: string): Promise<string> => {
    if (override) return resolve(root!, override);
    for (const path of [`${name}.json`, `config/${name}.json`, `config/${name}.example.json`]) if (await exists(resolve(root!, path))) return resolve(root!, path);
    return resolve(templateDir, `${name}.example.json`);
  };
  const migrated = canonicalize(await readConfig(await select(env.TEAPILOT_MODELS_FILE, 'models')), env); const models = migrated.models;
  applyOverride(models.fast, env, 'FAST'); applyOverride(models.capable, env, 'CAPABLE');
  // LOCAL_* is a legacy execution override. It is deliberately ignored when
  // a canonical file is present so stale environment state cannot override the
  // target capable model.
  if (env.ECONOMY_MODEL || env.STRONG_MODEL || env.ECONOMY_ENABLED === 'true' || env.STRONG_ENABLED === 'true') throw new Error('Legacy cloud execution overrides are not supported. Remove ECONOMY_* and STRONG_* settings, then run teapilot setup.');
  for (const model of [models.fast, models.capable]) {
    modelSchema.parse(model);
    if (model.inputUsdPerMillion || model.outputUsdPerMillion) throw new Error(`Local model ${model.id} must have zero API cost.`);
  }
  const rawPolicy = await readConfig(await select(env.TEAPILOT_POLICY_FILE, 'policy')) as Record<string, unknown>;
  const budget = { ...(rawPolicy.budget as Record<string, unknown> ?? {}) };
  delete budget.strongRequiresApproval; delete budget.automaticEconomy;
  const policy = policySchema.parse({ ...rawPolicy, budget });
  if (env.REQUEST_BUDGET_USD) policy.budget.requestUsd = money.parse(Number(env.REQUEST_BUDGET_USD));
  if (env.DAILY_BUDGET_USD) policy.budget.dailyUsd = money.parse(Number(env.DAILY_BUDGET_USD));
  const provider = z.enum(['typesafe', 'openrouter']).parse(env.JEV_PROVIDER || 'typesafe');
  const secrets = Object.fromEntries(physicalModels.map(key => [key, env[models[key].apiKeyEnv] || undefined])) as Config['secrets'];
  const skillFile = await select(env.TEAPILOT_SKILLS_FILE, 'skills');
  const { refreshHours, ...skillPreferences } = await exists(skillFile) ? skillConfigSchema.parse(await readConfig(skillFile)) : {};
  const skills: SkillSettings = { ...skillPreferences, ...(refreshHours ? { refreshMs: refreshHours * 60 * 60_000 } : {}), ...(skillPreferences.sets ? { sets: normalizeSets(skillPreferences.sets) } : {}), enabled: z.enum(['on', 'off']).parse(env.TEAPILOT_SKILLS || 'on') === 'on',
    ...(env.TEAPILOT_SKILLS_OFFLINE ? { offline: z.enum(['on', 'off']).parse(env.TEAPILOT_SKILLS_OFFLINE) === 'on' } : {}),
    ...(env.TEAPILOT_SKILLS_DIR ? { directory: resolve(root, env.TEAPILOT_SKILLS_DIR) } : {}) };
  return { skills, source: { directory: root, reason: explicit ? '--config-dir / explicit selection' : root === process.cwd() ? 'launch directory contains teapilot configuration' : 'personal profile', overrides, warnings: migrated.warnings }, routingMode: z.enum(['hosted', 'direct']).parse(env.TEAPILOT_ROUTING_MODE || 'hosted'), models, policy, stateDir: resolve(root, env.TEAPILOT_STATE_DIR || resolve(homedir(), '.teapilot')), router: { provider, model: env.JEV_MODEL || undefined, apiKey: provider === 'typesafe' ? env.TYPESAFE_API_KEY || env.JEV_API_KEY : env.OPENROUTER_API_KEY, endpoint: env.JEV_API_URL ? endpoint.parse(env.JEV_API_URL) : undefined, maxCallUsd: money.positive().parse(Number(env.JEV_MAX_CALL_USD || '0.01')), usdPerMillionTokens: env.JEV_USD_PER_MILLION_TOKENS ? money.parse(Number(env.JEV_USD_PER_MILLION_TOKENS)) : undefined }, searchUrl: env.SEARCH_BASE_URL ? endpoint.parse(env.SEARCH_BASE_URL) : undefined, webReader: { mode: z.enum(readerModes).parse(env.WEB_READER || 'auto'), agentBrowserBin: env.AGENT_BROWSER_BIN || undefined }, teachat: readTeachatSettings(env, root), workspace: readWorkspaceSettings(env), scratchpad: { enabled: z.enum(['on', 'off']).parse(env.TEAPILOT_SCRATCHPAD || 'on') === 'on' }, compaction: { enabled: z.enum(['on', 'off']).parse(env.TEAPILOT_COMPACTION || 'on') === 'on' }, delegation: { enabled: z.enum(['on', 'off']).parse(env.TEAPILOT_DELEGATION || 'on') === 'on' }, tips: { enabled: z.enum(['on', 'off']).parse(env.TEAPILOT_TIPS || 'on') === 'on' }, taskState: { enabled: z.enum(['on', 'off']).parse(env.TEAPILOT_TASK_STATE || 'on') === 'on' }, test: readTestHooks(env, root), secrets };
}
const hosts = (value: string | undefined) => (value ?? '').split(',').map(host => host.trim().toLowerCase()).filter(Boolean);
function readWorkspaceSettings(env: NodeJS.ProcessEnv): WorkspaceSettings {
  return { sandbox: z.enum(['auto', 'off']).parse(env.WORKSPACE_SANDBOX || 'auto'), allowedDomains: hosts(env.WORKSPACE_ALLOWED_DOMAINS), deniedDomains: hosts(env.WORKSPACE_DENIED_DOMAINS) };
}
export { modelSchema };
