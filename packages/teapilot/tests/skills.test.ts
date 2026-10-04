import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { link, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { discoverSkills, skillPage } from '../src/workspace/skills.js';
import { skillQuery, skillSource, skillTools } from '../src/agents/skills.js';
import { Scratch, scratchLimits } from '../src/workspace/scratch.js';
import { instructor, TaskStore } from '../src/workspace/task.js';
import { fitRecentResults, turnForms } from '../src/agents/history.js';
import { runAttempt } from '../src/agents/run.js';
import { SpendGovernor } from '../src/inference/budget.js';
import { Telemetry } from '../src/telemetry/outcome.js';
import { completion, events, fixture, mockServer } from './helpers.js';
import { loadConfig } from '../src/config.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const textOf = (result: { content: Array<{ type: string; text?: string }> }) => result.content.map(part => part.text ?? '').join('\n');
async function setup() {
  const f = await fixture(); cleanups.push(f.cleanup);
  const root = join(f.cwd, 'skills');
  await mkdir(join(root, 'example'), { recursive: true });
  const body = `---\nname: Example Skill\ndescription: >-\n  Inspect large evidence\n  without losing detail.\nmetadata:\n  author: fixture\n---\n\n${Array.from({ length: 300 }, (_, index) => `instruction ${index}: ${'careful evidence '.repeat(8)}`).join('\n')}\nLATE-MARKER\n`;
  await writeFile(join(root, 'example', 'SKILL.md'), body);
  const catalog = await discoverSkills(root);
  return { ...f, root, body, catalog };
}

it('enables hosted skills by default and accepts local profile overrides and an off switch', async () => {
  const f = await setup();
  expect((await loadConfig(f.cwd, {})).skills).toEqual({ enabled: true });
  expect((await loadConfig(f.cwd, { TEAPILOT_SKILLS: 'off', TEAPILOT_SKILLS_DIR: 'skills' })).skills).toEqual({ enabled: false, directory: f.root });
});

it('parses YAML metadata, skips malformed and non-model-invocable skills, and advertises no bodies', async () => {
  const f = await setup();
  for (const [id, text] of [['broken', '---\nname: broken\ndescription: [\n---\nbody'], ['missing', '---\nname: no-description\n---\nbody'], ['manual', '---\nname: Manual\ndescription: Manual only\ndisable-model-invocation: true\n---\nbody']]) {
    await mkdir(join(f.root, id!)); await writeFile(join(f.root, id!, 'SKILL.md'), text!);
  }
  const catalog = await discoverSkills(f.root);
  expect(catalog.skills).toEqual([{ id: 'example', name: 'Example Skill', description: 'Inspect large evidence without losing detail.' }]);
  expect(catalog.warnings).toHaveLength(2);
  const skills = skillTools(catalog);
  expect(skills.prompt).toContain('Inspect large evidence');
  expect(skills.prompt).not.toContain('instruction 0');
  expect(skills.prompt).not.toContain('LATE-MARKER');
  expect(skills.references()).toBe('');
  const big = { ...catalog, skills: Array.from({ length: 100 }, (_, index) => ({ id: `s-${index}`, name: 'skill', description: 'd'.repeat(1000) })) };
  const page = JSON.parse(skillPage(big));
  expect(skillPage(big).length).toBeLessThan(scratchLimits.retrievalChars);
  expect(page.next).toBeGreaterThan(0);
  expect(JSON.parse(skillPage(big, page.next)).skills[0].id).toBe(`s-${page.next}`);
  const escaped = { ...catalog, skills: [{ id: 'escaped', name: 'escaped', description: '\u0001'.repeat(2000) }] };
  expect(JSON.parse(skillPage(escaped)).next).toBeNull();
  expect(JSON.parse(skillPage(escaped)).skills).toHaveLength(1);
  expect(skillPage(escaped).length).toBeLessThan(scratchLimits.retrievalChars);
});

it('bounds instruction loading, saves the complete source once, and supports targeted retrieval', async () => {
  const f = await setup(), scratch = new Scratch(join(f.cwd, '.scratch'));
  const skills = skillTools(f.catalog, scratch), tool = skills.tools[0]!;
  const result = await tool.execute('a', { id: 'example' });
  expect(textOf(result).length).toBeLessThanOrEqual(scratchLimits.retrievalChars);
  expect(textOf(result)).not.toContain('LATE-MARKER');
  expect(textOf(result)).toContain('excerpt only');
  const files = await readdir(join(scratch.folder, 'outputs'));
  expect(files).toHaveLength(1);
  expect(await readFile(join(scratch.folder, 'outputs', files[0]!), 'utf8')).toBe(f.body);
  expect(textOf(await tool.execute('b', { id: 'example', search: 'LATE-MARKER' }))).toContain('LATE-MARKER');
  expect(textOf(await tool.execute('c', { id: 'example', offset: 309, limit: 4 }))).toContain('instruction 299');
  expect(await readdir(join(scratch.folder, 'outputs'))).toHaveLength(1);
  expect(skills.references()).toContain('example');
  expect(skills.references()).not.toContain('instruction 0');
});

it('retrieves supporting text without executing it and still works without scratch storage', async () => {
  const f = await setup();
  await mkdir(join(f.root, 'example', 'utils'));
  await writeFile(join(f.root, 'example', 'utils', 'helper.py'), 'raise RuntimeError("must not run")\n');
  const skills = skillTools(f.catalog), tool = skills.tools[0]!;
  expect(textOf(await tool.execute('a', { id: 'example', file: 'utils/helper.py' }))).toContain('must not run');
  expect(textOf(await tool.execute('b', { id: 'example', search: 'LATE-MARKER' }))).toContain('LATE-MARKER');
  expect(textOf(await tool.execute('c', { id: 'example' }))).not.toContain('Full output saved');
  expect(textOf(await tool.execute('d', {}))).toContain('Example Skill');
  const result: any = { role: 'toolResult', toolCallId: 'a', toolName: 'skill', content: (await tool.execute('e', { id: 'example' })).content, timestamp: 0, isError: false };
  expect(textOf(fitRecentResults([result], 0)[0] as any)).toContain('skill reference:');
  const compacted = turnForms({ user: 'inspect', assistant: 'done', steps: [result] }, { provider: 'mock', id: 'mock' })[1];
  expect(JSON.stringify(compacted)).toContain('skill reference:');
});

it('keeps long source-qualified IDs bounded and marks instructions clipped by their retrieval handles', async () => {
  const f = await setup();
  const file = `${'h'.repeat(230)}.md`;
  await writeFile(join(f.root, 'example', file), 'x'.repeat(2200));
  const id = `gh:${'o'.repeat(39)}/${'r'.repeat(100)}#${'b'.repeat(100)}?path=${'d'.repeat(230)}::${'f'.repeat(230)}`;
  const catalog = { ...f.catalog, skills: [{ ...f.catalog.skills[0]!, id }], locations: { [id]: { root: f.root, folder: 'example' } } };
  const result = textOf(await skillTools(catalog).tools[0]!.execute('a', { id, file }));
  expect(result.length).toBeLessThanOrEqual(scratchLimits.retrievalChars);
  expect(result).toContain('excerpt only');
});

it('refuses traversal, unknown IDs, invalid ranges, binary data and linked files', async () => {
  const f = await setup(), tool = skillTools(f.catalog).tools[0]!;
  for (const args of [{ id: '../example' }, { id: 'unknown' }, { id: 'example', file: '../secret' }, { id: 'example', file: '/secret' }, { id: 'example', file: 'C:\\secret' }, { id: 'example', offset: 0 }, { id: 'example', limit: 101 }, { id: 'example', search: '' }, { file: 'SKILL.md' }]) await expect(tool.execute('a', args)).rejects.toThrow();
  await writeFile(join(f.root, 'example', 'binary'), Buffer.from([255, 0]));
  await expect(tool.execute('b', { id: 'example', file: 'binary' })).rejects.toThrow();
  await link(join(f.root, 'example', 'SKILL.md'), join(f.root, 'example', 'linked'));
  await expect(tool.execute('c', { id: 'example', file: 'linked' })).rejects.toThrow('linked');
  await mkdir(join(f.cwd, 'outside'));
  await writeFile(join(f.cwd, 'outside', 'secret'), 'secret');
  await symlink(join(f.cwd, 'outside'), join(f.root, 'example', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(tool.execute('d', { id: 'example', file: 'escape/secret' })).rejects.toThrow('linked');
});

it('reuses indexed artifacts after task reload and respects junior artifact authorization', async () => {
  const f = await setup(), folder = join(f.cwd, '.scratch');
  let task = TaskStore.open(f.config.stateDir, 'skill-reload', 'inspect', folder);
  task.startRequest('r', { calls: 50, modelCalls: 50, timeoutMs: 60000 });
  let receipt = task.begin(instructor, 'skill', { id: 'example' })!;
  const scratch = new Scratch(folder, [], (saved, kind) => task.register(instructor, receipt, saved, kind));
  let skills = skillTools(f.catalog, scratch, task);
  const first = await skills.tools[0]!.execute('a', { id: 'example' });
  const source = skillSource('example', 'SKILL.md');
  task.settle(receipt, false, textOf(first), 'saved-output', { skill: { id: 'example', file: 'SKILL.md' }, query: skillQuery(source) });
  const artifact = task.snapshot().artifacts[0]!.id;
  task = TaskStore.open(f.config.stateDir, 'skill-reload', 'inspect', folder);
  skills = skillTools(f.catalog, scratch, task);
  expect(skills.references()).toContain(artifact);
  receipt = task.begin(instructor, 'skill', { id: 'example' })!;
  expect((await skills.tools[0]!.execute('b', { id: 'example' })).details).toMatchObject({ skill: { artifact } });
  task.settle(receipt, false, 'reused');
  expect(task.snapshot().artifacts).toHaveLength(1);
  const disabled = skillTools({ ...f.catalog, skills: [] }, undefined, task);
  expect(disabled.references()).toBe('');
  expect(disabled.tools).toEqual([]);
  expect(disabled.prompt).toContain('historical evidence, not active guidance');
  expect(skillTools(f.catalog, undefined, task, { name: 'junior-reader' }).references()).toBe('');
  expect(skillTools(f.catalog, undefined, task, { name: 'junior-reader', artifacts: [artifact] }).references()).toContain(artifact);
  expect(await task.artifact({ name: 'junior-reader', artifacts: [artifact] }, artifact, { search: 'LATE-MARKER' })).toContain('LATE-MARKER');
});

it('does not reuse a changed artifact and degrades gracefully when storage fails', async () => {
  const f = await setup(), folder = join(f.cwd, '.scratch');
  const task = TaskStore.open(f.config.stateDir, 'skill-tamper', 'inspect', folder);
  task.startRequest('r', { calls: 20, modelCalls: 20, timeoutMs: 60000 });
  let receipt = task.begin(instructor, 'skill', {})!;
  const scratch = new Scratch(folder, [], (saved, kind) => task.register(instructor, receipt, saved, kind));
  const skills = skillTools(f.catalog, scratch, task), tool = skills.tools[0]!;
  await tool.execute('a', { id: 'example' });
  task.settle(receipt, false, 'loaded');
  await writeFile(task.snapshot().artifacts[0]!.path, 'tampered');
  receipt = task.begin(instructor, 'skill', {})!;
  await tool.execute('b', { id: 'example' });
  expect(task.snapshot().artifacts).toHaveLength(2);
  const broken = new Scratch(join(f.cwd, 'blocked'));
  await writeFile(broken.folder, 'not a directory');
  expect(textOf(await skillTools(f.catalog, broken).tools[0]!.execute('c', { id: 'example' }))).toContain('was not saved');
});

it.each(['normal', 'planning', 'side', 'junior', 'disabled', 'casual'] as const)('integrates skill declarations with %s attempts without preloading instructions', async scope => {
  const f = await setup(), bodies: any[] = [];
  const server = await mockServer((body, _request, response) => { bodies.push(body); completion(response, { text: 'done' }); }); cleanups.push(server.close);
  Object.assign(f.config.models.capable, { provider: 'ollama', baseUrl: server.url });
  f.config.skills = { enabled: scope !== 'disabled', directory: f.root };
  await runAttempt({ config: f.config, cwd: f.cwd, tier: 'normal', workload: 'ask', prompt: 'inspect', web: false,
    budget: new SpendGovernor(join(f.config.stateDir, 'spend.jsonl'), scope, f.config.policy.budget), telemetry: new Telemetry(f.config.stateDir, scope), approve: async () => false,
    readOnly: scope === 'planning', side: scope === 'side', casual: scope === 'casual',
    ...(scope === 'junior' ? { junior: { name: 'junior-test', description: 'Inspect', agent_type: 'research' as const, assignment: 'inspect', artifacts: [], turn: 1, onReport() {} } } : {}) });
  expect(bodies[0].tools?.some((tool: any) => tool.function.name === 'skill') ?? false).toBe(!['disabled', 'casual'].includes(scope));
  expect(JSON.stringify(bodies[0].messages)).not.toContain('instruction 0');
});

it('loads and retrieves skills within an 8k model context without requiring artifact storage', async () => {
  const f = await setup(), bodies: any[] = [];
  const server = await mockServer((body, _request, response) => {
    bodies.push(body);
    completion(response, bodies.length === 1 ? { tool: { name: 'skill', arguments: { id: 'example', search: 'LATE-MARKER' } } } : { text: 'done' });
  }); cleanups.push(server.close);
  Object.assign(f.config.models.capable, { provider: 'ollama', baseUrl: server.url, contextTokens: 8192, maxOutputTokens: 1024 });
  f.config.skills = { enabled: true, directory: f.root };
  f.config.scratchpad = { enabled: false };
  const result = await runAttempt({ config: f.config, cwd: f.cwd, tier: 'normal', workload: 'ask', prompt: 'inspect the relevant detail', web: false,
    budget: new SpendGovernor(join(f.config.stateDir, 'spend.jsonl'), 'small', f.config.policy.budget), telemetry: new Telemetry(f.config.stateDir, 'small'), approve: async () => false });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(bodies).toHaveLength(2);
  expect(JSON.stringify(bodies[1].messages)).toContain('LATE-MARKER');
  expect(JSON.stringify(bodies[1].messages)).toContain('[loaded skill references:');
});

it('keeps skill handles through actual compaction, retrieves the omitted body, and emits selection telemetry', async () => {
  const f = await setup(), bodies: any[] = [], folder = join(f.cwd, '.scratch');
  let turn = 0, compacted = false, retrieved = false;
  const server = await mockServer((body, _request, response) => {
    bodies.push(body);
    if (JSON.stringify(body.messages[0]).includes('context summarization assistant')) { compacted = true; return completion(response, { text: '## Goal\ninspect evidence; no skill instructions preserved here' }); }
    if (++turn === 1) return completion(response, { tool: { name: 'skill', arguments: { id: 'example' } } });
    if (compacted) {
      if (retrieved) return completion(response, { text: 'done' });
      retrieved = true;
      return completion(response, { tool: { name: 'skill', arguments: { id: 'example', search: 'LATE-MARKER' } } });
    }
    completion(response, { text: `Retained conversational note ${turn}: ${'reasoning about the current evidence. '.repeat(180)}`, tool: { name: 'skill', arguments: { id: 'example', offset: turn * 10 } } });
  }); cleanups.push(server.close);
  Object.assign(f.config.models.capable, { provider: 'ollama', baseUrl: server.url, contextTokens: 16384, maxOutputTokens: 1024 });
  f.config.skills = { enabled: true, directory: f.root };
  const task = TaskStore.open(f.config.stateDir, 'skill-compaction', 'inspect', folder);
  task.startRequest('r', { calls: 50, modelCalls: 50, timeoutMs: 60000 });
  const result = await runAttempt({ config: f.config, cwd: f.cwd, tier: 'normal', workload: 'ask', prompt: 'inspect', web: false, scratch: folder, task,
    budget: new SpendGovernor(join(f.config.stateDir, 'spend.jsonl'), 'compaction', f.config.policy.budget), telemetry: new Telemetry(f.config.stateDir, 'compaction'), approve: async () => false });
  expect(result.success, JSON.stringify(result)).toBe(true);
  const summaries = bodies.filter(body => JSON.stringify(body.messages[0]).includes('context summarization assistant'));
  expect(summaries).toHaveLength(1);
  const after = bodies[bodies.indexOf(summaries[0]) + 1];
  expect(JSON.stringify(after.messages)).toContain('[loaded skill references:');
  expect(JSON.stringify(after.messages)).toContain(task.snapshot().artifacts[0]!.id);
  expect(task.snapshot().artifacts).toHaveLength(1);
  expect((await events(f.config)).filter(event => event.type === 'skill_selected').length).toBeGreaterThan(1);
});
