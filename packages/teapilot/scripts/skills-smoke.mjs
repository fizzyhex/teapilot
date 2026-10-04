import { parseArgs } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig, userConfigDir } from '../dist/config.js';
import { runAttempt } from '../dist/agents/run.js';
import { skillCache } from '../dist/skills/cache.js';
import { SkillStore } from '../dist/skills/store.js';
import { TaskStore } from '../dist/workspace/task.js';
import { SpendGovernor } from '../dist/inference/budget.js';
import { Telemetry } from '../dist/telemetry/outcome.js';

// Live selection, not mocked tool calls. Prompts never name skills or ask the model to pick one.
const { values } = parseArgs({ options: {
  'config-dir': { type: 'string' }, tier: { type: 'string', default: 'normal' },
  repeat: { type: 'string', default: '1' }, output: { type: 'string' }, keep: { type: 'boolean', default: false },
} });
const repeat = Number(values.repeat), tier = values.tier;
if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 10 || !['fast', 'normal', 'reasoning', 'deep'].includes(tier)) throw new Error('use --repeat 1..10 and --tier fast|normal|reasoning|deep');
const profile = await loadConfig(values['config-dir'] ?? userConfigDir());
const settings = profile.skills ?? { enabled: true };
const catalog = await skillCache(profile.stateDir).catalog(settings, new SkillStore(profile.stateDir, settings).effective({ operator: true }));
if (!settings.enabled || !['discord-play', 'thoughtful-planner'].every(id => catalog.skills.some(skill => skill.id === id || skill.id === `gh:fizzyhex/tea-skills::${id}`))) throw new Error('smoke test needs enabled tea-skills with discord-play and thoughtful-planner');
const temporaryRoot = process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : tmpdir();
await mkdir(temporaryRoot, { recursive: true });
const scratch = await mkdtemp(join(temporaryRoot, 'teapilot-skills-smoke-'));
const cases = [
  { name: 'discord-game', expected: ['discord-play'], prompt: 'Outline a small rock-paper-scissors game that two friends can play using Discord message buttons. Explain the controls and display layout. Only give a proposal; do not build or run anything.' },
  { name: 'ambitious-engineering', expected: ['thoughtful-planner'], prompt: 'Plan a major migration of our application from a single tenant to a multi-tenant service, covering data isolation, authentication, schema migration, compatibility, staged rollout, and rollback. This spans several engineering teams. Only give a proposal; do not build or run anything.' },
  { name: 'complex-discord-project', expected: ['discord-play', 'thoughtful-planner'], prompt: 'Plan an ambitious persistent multiplayer strategy game played entirely inside Discord messages, with map rendering, turn timers, diplomacy, resource economies, save recovery, and a phased implementation across several contributors. Only give a proposal; do not build or run anything.' },
  { name: 'simple-question', expected: [], prompt: 'What is 17 plus 25? Answer briefly.' },
  { name: 'tiny-edit', expected: [], prompt: 'Read greeting.txt and tell me the one-character change needed to correct its spelling. Only describe the edit; do not write anything.' },
];
const results = [];
if (values.keep) console.log(`smoke evidence: ${scratch}`);
try {
  for (let iteration = 1; iteration <= repeat; iteration++) for (const scenario of cases) {
    const name = `${scenario.name}-${iteration}`, cwd = join(scratch, name), stateDir = join(cwd, 'state'), pad = join(cwd, '.scratch');
    await mkdir(cwd); await writeFile(join(cwd, 'greeting.txt'), 'helo\n');
    const config = structuredClone(profile);
    config.stateDir = stateDir;
    config.teachat = undefined; config.delegation = { enabled: false }; config.workspace = { sandbox: 'off' };
    config.policy.permissions = ['inference', 'repository.read'];
    config.policy.limits.maxTurns = 12; config.policy.limits.maxToolCalls = 12;
    config.policy.limits.attemptTimeoutMs = 600000;
    config.test = { traceDir: join(cwd, 'traces') };
    const task = TaskStore.open(stateDir, name, scenario.prompt, pad);
    task.startRequest(name, { calls: 12, modelCalls: 14, timeoutMs: 600000, readOnly: true });
    const result = await runAttempt({ config, skillCatalog: catalog, cwd, tier, workload: 'coder', prompt: scenario.prompt, web: false, scratch: pad, task, readOnly: true,
      signal: AbortSignal.timeout(600000), budget: new SpendGovernor(join(stateDir, 'spend.jsonl'), name, config.policy.budget),
      telemetry: new Telemetry(stateDir, name, [config.router.apiKey, ...Object.values(config.secrets)].filter(Boolean)), approve: async () => false });
    const events = (await readFile(join(stateDir, 'outcomes.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const selections = events.filter(event => event.type === 'skill_selected');
    const picked = [...new Set(selections.map(event => event.id.split('::').at(-1)))].sort();
    const missing = scenario.expected.filter(id => !picked.includes(id)), irrelevant = picked.filter(id => !scenario.expected.includes(id));
    const row = { case: scenario.name, iteration, model: (tier === 'fast' ? config.models.fast : config.models.capable).id, expected: scenario.expected, picked,
      missing, irrelevant, duplicateLoads: selections.length - new Set(selections.map(event => `${event.id}/${event.file}`)).size,
      shownChars: selections.map(event => event.shownChars), success: result.success, reason: result.reason ?? result.stopped,
      passed: result.success && missing.length === 0 && irrelevant.length === 0 };
    results.push(row);
    console.log(JSON.stringify(row));
  }
  const truePositives = results.reduce((sum, row) => sum + row.expected.length - row.missing.length, 0);
  const picked = results.reduce((sum, row) => sum + row.picked.length, 0), expected = results.reduce((sum, row) => sum + row.expected.length, 0);
  const report = { tier, repeat, catalogChars: JSON.stringify(catalog.skills).length, passed: results.filter(row => row.passed).length, total: results.length,
    precision: picked ? truePositives / picked : expected ? 0 : 1, recall: expected ? truePositives / expected : 1, results };
  console.log(JSON.stringify(report, null, 2));
  if (values.output) await writeFile(resolve(values.output), JSON.stringify(report, null, 2) + '\n');
  if (report.passed !== report.total) process.exitCode = 1;
} finally { if (!values.keep) await rm(scratch, { recursive: true, force: true }); }
