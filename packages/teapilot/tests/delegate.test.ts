import { afterEach, expect, it } from 'vitest';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { completion, events, fixture, mockServer } from './helpers.js';
import { runAttempt } from '../src/agents/run.js';
import { delegateTool, juniorAllowance, juniorName, juniorPrompt } from '../src/agents/delegate.js';
import { RequestAllowance } from '../src/agents/allowance.js';
import { TaskStore } from '../src/workspace/task.js';
import { Scratch } from '../src/workspace/scratch.js';
import { SpendGovernor } from '../src/inference/budget.js';
import { Telemetry } from '../src/telemetry/outcome.js';
import { describeTool } from '../src/presentation.js';

const cleanups: Array<() => Promise<unknown>> = [];
it('caps each junior at twenty calls while reserving four shared calls for the instructor', () => {
  expect(juniorAllowance(38, 40)).toBe(20);
  expect(juniorAllowance(38, 20)).toBe(20);
  expect(juniorAllowance(3, 40)).toBe(0);
  expect(juniorAllowance(4, 40)).toBe(0);
  expect(juniorAllowance(5, 40)).toBe(1);
  expect(juniorAllowance(6, 40)).toBe(2);
  expect(juniorAllowance(10, 40)).toBe(6);
  expect(juniorAllowance(38, 0)).toBe(0);
});
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup(handler: Parameters<typeof mockServer>[0]) {
  const f = await fixture(); cleanups.push(f.cleanup);
  const server = await mockServer(handler); cleanups.push(server.close);
  for (const model of [f.config.models.capable, f.config.models.fast]) Object.assign(model, { provider: 'ollama', baseUrl: server.url });
  const telemetry = new Telemetry(f.config.stateDir, 'delegate-test');
  await telemetry.event('start', {});
  const budget = new SpendGovernor(join(f.config.stateDir, 'spend.jsonl'), 'delegate-test', f.config.policy.budget);
  return { ...f, budget, telemetry, scratch: join(f.cwd, '.scratch') };
}
const junior = (body: any) => names(body).includes('report');
const names = (body: any): string[] => (body.tools ?? []).map((tool: any) => tool.function.name);
const run = (f: Awaited<ReturnType<typeof setup>>, extra: Partial<Parameters<typeof runAttempt>[0]> = {}) =>
  runAttempt({ ...f, tier: 'normal', workload: 'coder', web: false, approve: async () => true, prompt: 'Build the thing', ...extra });

it('hands a task to a junior in a clean context and sees only its report', async () => {
  const bodies: { instructor: any[]; junior: any[] } = { instructor: [], junior: [] };
  const manifestPath = 'context/manifest-only.txt', privatePayload = 'manifest-file-content-must-not-be-preloaded';
  const f = await setup((body, _req, res) => {
    if (junior(body)) {
      bodies.junior.push(body);
      completion(res, bodies.junior.length === 1 ? { tool: { name: 'write', arguments: { path: 'a.txt', content: 'hello' } } }
        : { tool: { name: 'report', arguments: { status: 'done', summary: 'Wrote a.txt and read it back.' } } });
    } else {
      bodies.instructor.push(body);
      completion(res, bodies.instructor.length === 1 ? { tool: { name: 'delegate_task', arguments: { label: 'Create hello file', prompt: 'Create a.txt containing hello.', agent_type: 'write', artifacts: [manifestPath] } } } : { text: 'All done.' });
    }
  });
  const seen: any[] = [];
  await mkdir(join(f.cwd, 'context'), { recursive: true });
  await writeFile(join(f.cwd, manifestPath), privatePayload);
  const result = await run(f, { scratch: f.scratch, onEvent: event => seen.push(event) });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(await readFile(join(f.cwd, 'a.txt'), 'utf8')).toBe('hello');

  expect(names(bodies.instructor[0])).toContain('delegate_task');
  expect(names(bodies.junior[0])).toContain('report');
  expect(names(bodies.junior[0])).not.toContain('delegate_task');
  expect(names(bodies.junior[0])).not.toContain('request_escalation');
  // The junior starts from its instruction alone.
  expect(JSON.stringify(bodies.junior[0].messages)).not.toContain('Build the thing');
  expect(JSON.stringify(bodies.junior[0].messages)).toContain('Create a.txt containing hello.');
  expect(JSON.stringify(bodies.junior[0].messages)).not.toContain('Current prompt:');
  expect(JSON.stringify(bodies.junior[0].messages)).toContain(manifestPath);
  expect(JSON.stringify(bodies.junior[0].messages)).not.toContain(privatePayload);

  const report = JSON.stringify(bodies.instructor[1].messages);
  expect(report).toContain('Junior junior-alfa, turn 1: done');
  expect(report).toContain('Files changed: a.txt');
  expect(report).toContain('Wrote a.txt and read it back.');
  expect(bodies.instructor[1].messages.some((message: any) => JSON.stringify(message.tool_calls ?? '').includes('"write"'))).toBe(false);

  // People see the junior's tools, named, and never its words.
  expect(seen.filter(event => event.junior === 'junior-alfa').map(event => `${event.type}:${event.tool}`)).toEqual(
    ['tool_execution_start:write', 'tool_execution_end:write', 'tool_execution_start:report', 'tool_execution_end:report']);
  expect(seen.some(event => event.type === 'text' && event.junior)).toBe(false);
  expect(seen.find(event => event.type === 'tool_execution_end' && event.tool === 'delegate_task')?.to).toBe('junior-alfa');

  // Its transcript is its own; the instructor's stays the one its conversation reopens.
  const own = await readdir(join(f.scratch, 'juniors', 'junior-alfa', 'sessions'));
  expect(own).toHaveLength(1);
  const [instructor] = await readdir(join(f.scratch, 'sessions'));
  expect(await readFile(join(f.scratch, 'sessions', instructor!), 'utf8')).toContain('delegate_task');
  expect((await events(f.config)).find(event => event.type === 'delegate')).toMatchObject({ junior: 'junior-alfa', turn: 1, status: 'done' });
});

it('continues the same junior with its history, and passes its questions back', async () => {
  const bodies: { instructor: any[]; junior: any[] } = { instructor: [], junior: [] };
  const f = await setup((body, _req, res) => {
    if (junior(body)) {
      bodies.junior.push(body);
      // No report the first time: its last words stand in for one.
      completion(res, bodies.junior.length === 1 ? { text: 'Found three bugs in parser.ts.' }
        : { tool: { name: 'report', arguments: { status: 'needs_input', summary: 'Two are fixed.', question: 'Should the third keep its old behaviour?' } } });
    } else {
      bodies.instructor.push(body);
      completion(res, bodies.instructor.length === 1 ? { tool: { name: 'delegate_task', arguments: { label: 'Find parser bugs', prompt: 'Find the bugs in parser.ts.', agent_type: 'write', artifacts: ['src/parser.ts'] } } }
        : bodies.instructor.length === 2 ? { tool: { name: 'delegate_task', arguments: { junior: 'junior-alfa', label: 'Fix identified bugs', prompt: 'Fix them.', agent_type: 'write', artifacts: ['src/fix-notes.txt'] } } }
        : { text: 'Asking the person.' });
    }
  });
  const result = await run(f, { scratch: f.scratch });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(JSON.stringify(bodies.instructor[1].messages)).toContain('Found three bugs in parser.ts.');
  const second = JSON.stringify(bodies.junior[1].messages);
  expect(second).toContain('Find the bugs in parser.ts.');
  expect(second).toContain('Found three bugs in parser.ts.');
  expect(second).toContain('Fix them.');
  expect(second).toContain('src/parser.ts');
  expect(second).toContain('src/fix-notes.txt');
  const reply = JSON.stringify(bodies.instructor[2].messages);
  expect(reply).toContain('Junior junior-alfa, turn 2: needs_input');
  expect(reply).toContain('Question: Should the third keep its old behaviour?');
});

it('withdraws delegation once the attempt has sent its limit', async () => {
  const bodies: any[] = [];
  const f = await setup((body, _req, res) => {
    if (junior(body)) return completion(res, { tool: { name: 'report', arguments: { status: 'done', summary: 'ok' } } });
    bodies.push(body);
    completion(res, bodies.length === 1 ? { tool: { name: 'delegate_task', arguments: { label: 'Research one item', prompt: 'One.', agent_type: 'research', artifacts: [] } } } : { text: 'Finished myself.' });
  });
  f.config.policy.limits.maxJuniorTurns = 1;
  const result = await run(f, { scratch: f.scratch });
  expect(result.success).toBe(true);
  expect(names(bodies[0])).toContain('delegate_task');
  expect(names(bodies[1])).not.toContain('delegate_task');
});

it('offers no delegation without a scratchpad, when turned off, or on a short context', async () => {
  const bodies: any[] = [];
  const f = await setup((body, _req, res) => { bodies.push(body); completion(res, { text: 'ok' }); });
  await run(f, { scratch: undefined });
  f.config.delegation = { enabled: false };
  await run(f, { scratch: f.scratch });
  f.config.delegation = { enabled: true };
  await run(f, { scratch: f.scratch, tier: 'fast', workload: 'ask' });
  expect(bodies).toHaveLength(3);
  expect(bodies.map(body => names(body).includes('delegate_task'))).toEqual([false, false, false]);
});

it('stops the instructor\'s clock while a junior works', async () => {
  let instructorCalls = 0;
  const f = await setup(async (body, _req, res) => {
    if (junior(body)) {
      await new Promise(resolve => setTimeout(resolve, 250));
      return completion(res, { tool: { name: 'report', arguments: { status: 'done', summary: 'ok' } } });
    }
    instructorCalls++;
    completion(res, instructorCalls <= 3 ? { tool: { name: 'delegate_task', arguments: { label: `Research part ${instructorCalls}`, prompt: `Part ${instructorCalls}.`, agent_type: 'research', artifacts: [] } } } : { text: 'All parts done.' });
  });
  // Three juniors of 250ms each outlast the instructor's own 500ms, which only counts its own time.
  f.config.policy.limits.attemptTimeoutMs = 500;
  const result = await run(f, { scratch: f.scratch });
  expect(result.stopped).toBeUndefined();
  expect(result.success, JSON.stringify(result)).toBe(true);
});

it('cancels the junior with the request', async () => {
  const controller = new AbortController();
  const f = await setup((body, _req, res) => {
    if (junior(body)) { controller.abort(); return completion(res, { text: 'late' }); }
    completion(res, { tool: { name: 'delegate_task', arguments: { label: 'Research long task', prompt: 'Long task.', agent_type: 'research', artifacts: [] } } });
  });
  const result = await run(f, { scratch: f.scratch, signal: controller.signal });
  expect(result.stopped).toBe('cancelled');
  expect(result.success).toBe(false);
});

it('names juniors after free teachat identities, then phonetically', () => {
  const identities = [{ username: 'juner', leased: true }, { username: 'daniel', leased: false }, { username: 'marlow', leased: false }];
  expect(juniorName(identities, new Set(), () => 0)).toBe('junior-daniel');
  expect(juniorName(identities, new Set(['junior-daniel']), () => 0)).toBe('junior-marlow');
  expect(juniorName(identities, new Set(['junior-daniel', 'junior-marlow']))).toBe('junior-alfa');
  expect(juniorName([], new Set(['junior-alfa']))).toBe('junior-bravo');
  const alphabet = ['alfa', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliett', 'kilo', 'lima', 'mike',
    'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey', 'xray', 'yankee', 'zulu'].map(word => `junior-${word}`);
  expect(juniorName([], new Set(alphabet))).toBe('junior-alfa-2');
});

it('labels a junior\'s calls with its name', () => {
  expect(describeTool({ type: 'tool_execution_end', tool: 'read', path: 'a.ts', junior: 'daniel' })).toBe('daniel: read a.ts');
  expect(describeTool({ type: 'tool_execution_end', tool: 'delegate_task', to: 'daniel' })).toBe('delegate_task → daniel');
});

it('works in its instructor\'s folder when neither has the repository', async () => {
  let instructorCalls = 0, juniorCalls = 0;
  const f = await setup((body, _req, res) => {
    if (junior(body)) return completion(res, ++juniorCalls === 1 ? { tool: { name: 'write', arguments: { path: 'notes.txt', content: 'from the junior' } } }
      : { tool: { name: 'report', arguments: { status: 'done', summary: 'Wrote notes.txt.' } } });
    completion(res, ++instructorCalls === 1 ? { tool: { name: 'delegate_task', arguments: { label: 'Write notes file', prompt: 'Write notes.txt.', agent_type: 'write', artifacts: [] } } }
      : instructorCalls === 2 ? { tool: { name: 'read', arguments: { path: 'notes.txt' } } } : { text: 'Read it.' });
  });
  const result = await run(f, { scratch: f.scratch, workload: 'ask' });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(await readFile(join(f.scratch, 'notes.txt'), 'utf8')).toBe('from the junior');
});

it('keeps report for a junior whose other tools are withdrawn', async () => {
  const bodies: any[] = [];
  let instructorCalls = 0;
  const f = await setup((body, _req, res) => {
    if (junior(body)) {
      bodies.push(body);
      // A tool it does not have is refused, until the host withdraws everything but report.
      return completion(res, names(body).length > 1 ? { tool: { name: 'bash', arguments: { command: 'npm test' } } }
        : { tool: { name: 'report', arguments: { status: 'stuck', summary: 'I could not run the tests.' } } });
    }
    completion(res, ++instructorCalls === 1 ? { tool: { name: 'delegate_task', arguments: { label: 'Run project tests', prompt: 'Run the tests.', agent_type: 'write', artifacts: [] } } } : { text: 'The junior could not run them.' });
  });
  await run(f, { scratch: f.scratch, workload: 'ask' });
  expect(names(bodies.at(-1))).toEqual(['report']);
  expect((await events(f.config)).find(event => event.type === 'delegate')).toMatchObject({ status: 'stuck' });
  expect((await events(f.config)).find(event => event.type === 'delegate')?.stopped).toBeUndefined();
});

it('tells a junior to report before the tool limit stops it', async () => {
  let instructorCalls = 0, juniorCalls = 0;
  const f = await setup((body, _req, res) => {
    if (junior(body)) {
      juniorCalls++;
      // It keeps working until the host says its calls are nearly spent.
      return completion(res, JSON.stringify(body.messages).includes('tool calls left: call report now')
        ? { tool: { name: 'report', arguments: { status: 'stuck', summary: 'Parsed half the table; rows are in notes.txt.' } } }
        : { tool: { name: 'write', arguments: { path: 'notes.txt', content: `row ${juniorCalls}` } } });
    }
    completion(res, ++instructorCalls === 1 ? { tool: { name: 'delegate_task', arguments: { label: 'Parse source table', prompt: 'Parse the table.', agent_type: 'write', artifacts: [] } } } : { text: 'Noted.' });
  });
  f.config.policy.limits.maxToolCalls = 10;
  await run(f, { scratch: f.scratch });
  const delegated = (await events(f.config)).find(event => event.type === 'delegate');
  expect(delegated).toMatchObject({ status: 'stuck' });
  expect(delegated?.stopped).toBeUndefined();
  expect(delegated?.allocation).toBe(5);
  expect(juniorCalls).toBe(3);
});

it('requires the complete schema on every call and retains a junior assignment across follow-ups', async () => {
  const f = await setup((_body, _req, res) => completion(res, { text: 'unused' }));
  const allowance = new RequestAllowance({ calls: 40, modelCalls: 50, timeoutMs: 10_000, delegations: 6 });
  const children: any[] = [];
  const parent = { ...f, tier: 'normal' as const, workload: 'coder' as const, web: false, prompt: 'parent', approve: async () => true };
  const delegated = delegateTool(parent, f.scratch, f.cwd, { pause() {}, resume() {} }, async child => {
    children.push(child);
    for (let index = 0; index < Math.min(4, child.config.policy.limits.maxToolCalls); index++) allowance.consumeTool(child.junior!.name);
    child.junior!.onReport({ status: 'done', summary: 'source-backed findings' });
    return { success: true, text: '', turns: 1, toolCalls: Math.min(4, child.config.policy.limits.maxToolCalls) };
  }, allowance);
  const text = (result: any) => result.content[0].text;
  expect(delegated.tool.parameters).toMatchObject({ required: expect.arrayContaining(['label', 'prompt', 'agent_type', 'artifacts']) });
  const schema = delegated.tool.parameters as any;
  expect(schema.properties).toHaveProperty('label');
  expect(schema.properties).toHaveProperty('prompt');
  expect(schema.properties).toHaveProperty('agent_type');
  expect(schema.properties).toHaveProperty('artifacts');
  expect(schema.properties).not.toHaveProperty('type');
  expect(schema.properties).not.toHaveProperty('message');
  expect(schema.properties).not.toHaveProperty('evidence');
  const initial = { label: 'Inspect source files', prompt: 'inspect sources', agent_type: 'research', artifacts: [] };
  await delegated.tool.execute('b', initial);
  await delegated.tool.execute('c', { junior: 'junior-alfa', label: 'Clarify source findings', prompt: 'clarify findings', agent_type: 'research', artifacts: [] });
  expect(children.map(child => child.config.policy.limits.maxToolCalls)).toEqual([20, 16]);
  expect(children.every(child => !child.readOnly && child.junior.agent_type === 'research')).toBe(true);
  expect(children[0].junior).toMatchObject({ description: 'Inspect source files', assignment: 'inspect sources' });
  expect(children[1].junior).toMatchObject({ description: 'Clarify source findings', assignment: 'inspect sources' });
  expect(text(await delegated.tool.execute('d', { junior: 'junior-alfa', label: 'Change source files', prompt: 'make changes', agent_type: 'write', artifacts: [] })).toLowerCase()).toContain('category: write');
  expect(children[2].junior).toMatchObject({ agent_type: 'write', assignment: 'inspect sources' });
  expect(children.map(child => child.config.policy.limits.maxToolCalls)).toEqual([20, 16, 12]);
  expect(children).toHaveLength(3);
});

it('inherits parent read-only safety for every agent_type and accepts legacy saved juniors', async () => {
  const f = await setup((_body, _req, res) => completion(res, { text: 'unused' }));
  const task = TaskStore.open(f.config.stateDir, 'typed-juniors', 'overall goal', f.scratch);
  task.startRequest('r', { calls: 24, modelCalls: 30, timeoutMs: 10_000 });
  task.saveJunior({ name: 'junior-old', scratch: f.scratch, turn: 1, turns: [] });
  task.saveJunior({ name: 'junior-reader', type: 'research', assignment: 'door mechanics only', artifacts: ['src/door.ts'], scratch: f.scratch, turn: 1, turns: [] });
  const longAssignment = 'complete prompt context '.repeat(600);
  task.saveJunior({ name: 'junior-long', assignment: longAssignment, scratch: f.scratch, turn: 1, turns: [] });
  task.consumeJunior('junior-reader');
  const restored = TaskStore.open(f.config.stateDir, 'typed-juniors', 'ignored', f.scratch);
  expect(restored.snapshot().juniors.find(junior => junior.name === 'junior-long')?.assignment).toBe(longAssignment);
  const allowance = new RequestAllowance({ calls: 24, modelCalls: 30, timeoutMs: 10_000, delegations: 6 }, restored);
  const children: any[] = [];
  const parent = { ...f, task: restored, tier: 'normal' as const, workload: 'coder' as const, web: false, readOnly: true, activePermissions: [...f.config.policy.permissions], prompt: 'parent', approve: async () => true };
  const delegated = delegateTool(parent, f.scratch, f.cwd, { pause() {}, resume() {} }, async child => { children.push(child); return { success: true, text: 'findings', turns: 1, toolCalls: 0 }; }, allowance);
  const text = (result: any) => result.content[0].text;
  await delegated.tool.execute('a', { junior: 'junior-old', label: 'Continue old assignment', prompt: 'continue', agent_type: 'test', artifacts: [] });
  for (const agent_type of ['research', 'write', 'test'] as const) {
    const result = await delegated.tool.execute(`ro-${agent_type}`, { label: 'Inspect application safely', prompt: 'inspect app', agent_type, artifacts: [] });
    expect(children.at(-1).readOnly).toBe(true);
    expect(children.at(-1).activePermissions).toBe(parent.activePermissions);
  }
  await delegated.tool.execute('c', { junior: 'junior-reader', label: 'Clarify door mechanics', prompt: 'clarify opening', agent_type: 'research', artifacts: [] });
  expect(children.at(-1).junior).toMatchObject({ agent_type: 'research', assignment: 'door mechanics only', artifacts: ['src/door.ts'] });
  expect(children[0].config.policy.limits.maxToolCalls).toBe(20);
});

it('allocates a uniform cumulative cap, capped by policy and shared request room with four calls reserved', async () => {
  const f = await setup((_body, _req, res) => completion(res, { text: 'unused' }));
  const children: any[] = [];
  const parent = { ...f, tier: 'normal' as const, workload: 'coder' as const, web: false, prompt: 'parent', approve: async () => true };
  for (const [policy, shared, expected] of [[40, 40, 20], [5, 40, 5], [40, 9, 5], [40, 5, undefined], [40, 6, 2]] as const) {
    f.config.policy.limits.maxToolCalls = policy;
    const allowance = new RequestAllowance({ calls: shared, modelCalls: 50, timeoutMs: 10_000, delegations: 6 });
    const delegated = delegateTool(parent, f.scratch, f.cwd, { pause() {}, resume() {} }, async child => {
      children.push(child);
      return { success: true, text: 'findings', turns: 1, toolCalls: 0 };
    }, allowance);
    children.length = 0;
    const result = await delegated.tool.execute('a', { label: 'Complete assigned checks', prompt: 'complete the assigned task', agent_type: 'research', artifacts: [] });
    if (expected === undefined) {
      expect(children).toHaveLength(0);
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining('too little room') });
    } else {
      expect(children).toHaveLength(1);
      expect(children[0].config.policy.limits.maxToolCalls).toBe(expected);
    }
  }
});

it('publishes bounded required arguments without imposing a description word-count rule', async () => {
  const f = await setup((_body, _req, res) => completion(res, { text: 'unused' }));
  const allowance = new RequestAllowance({ calls: 40, modelCalls: 50, timeoutMs: 10_000, delegations: 6 });
  const parent = { ...f, tier: 'normal' as const, workload: 'coder' as const, web: false, prompt: 'parent', approve: async () => true };
  const delegated = delegateTool(parent, f.scratch, f.cwd, { pause() {}, resume() {} }, async () => ({ success: true, text: '', turns: 1, toolCalls: 0 }), allowance);
  const schema = delegated.tool.parameters as any;
  expect(schema.required).toEqual(expect.arrayContaining(['label', 'prompt', 'agent_type', 'artifacts']));
  expect(schema.properties.label.minLength).toBeGreaterThanOrEqual(1);
  expect(schema.properties.label.maxLength).toBeGreaterThan(5);
  expect(schema.properties.label.description).toMatch(/3-5 word/i);
  expect(schema.properties.prompt.minLength).toBeGreaterThanOrEqual(1);
  expect(schema.properties.prompt.maxLength).toBeGreaterThanOrEqual(24_000);
  expect(schema.properties.agent_type).toBeDefined();
  expect(schema.properties.artifacts.items).toBeDefined();
  for (const old of ['type', 'message', 'evidence', 'done']) expect(schema.properties).not.toHaveProperty(old);
});

it('keeps agent_type from changing a junior prompt or available tools', async () => {
  const common = { name: 'junior-alfa', description: 'Check this assignment', assignment: 'Inspect the specified files.', artifacts: [] };
  const prompts = (['research', 'write', 'test'] as const).map(agent_type => juniorPrompt({ ...common, agent_type }));
  expect(new Set(prompts).size).toBe(1);
  expect(prompts[0]).not.toContain(common.assignment);
});

it('rejects missing, empty, and oversized delegation arguments before starting a junior', async () => {
  const f = await setup((_body, _req, res) => completion(res, { text: 'unused' }));
  const allowance = new RequestAllowance({ calls: 40, modelCalls: 50, timeoutMs: 10_000, delegations: 6 });
  let children = 0;
  const delegated = delegateTool({ ...f, tier: 'normal', workload: 'coder', web: false, prompt: 'parent', approve: async () => true }, f.scratch, f.cwd,
    { pause() {}, resume() {} }, async () => { children++; return { success: true, text: '', turns: 1, toolCalls: 0 }; }, allowance);
  const valid = { label: 'Inspect files', prompt: 'Inspect files and report findings.', agent_type: 'research', artifacts: [] };
  const invalid = [
    {},
    { ...valid, label: '' },
    { ...valid, label: 'x'.repeat(81) },
    { ...valid, prompt: '' },
    { ...valid, prompt: 'x'.repeat(24_001) },
    { ...valid, agent_type: 'review' },
    { ...valid, agent_type: 42 },
    { ...valid, prompt: null },
    { ...valid, artifacts: undefined },
    { ...valid, artifacts: {} },
  ];
  for (const args of invalid) {
    const result = await delegated.tool.execute('invalid', args);
    const first = result.content[0];
    expect(first && 'text' in first ? first.text : undefined).toMatch(/bounded|valid agent_type/);
  }
  expect(children).toBe(0);
  await delegated.tool.execute('short-label', { ...valid, label: 'Brief' });
  expect(children).toBe(1);
});

it('authorizes artifact references before spending request delegation allowance', async () => {
  const f = await setup((_body, _req, res) => completion(res, { text: 'unused' }));
  const task = TaskStore.open(f.config.stateDir, 'delegate-artifact-auth', 'goal', f.scratch);
  task.startRequest('auth', { calls: 30, modelCalls: 30, timeoutMs: 10_000 });
  const allowance = new RequestAllowance({ calls: 30, modelCalls: 30, timeoutMs: 10_000, delegations: 6 }, task);
  const delegated = delegateTool({ ...f, task, tier: 'normal', workload: 'coder', web: false, prompt: 'parent', approve: async () => true }, f.scratch, f.cwd,
    { pause() {}, resume() {} }, async () => ({ success: true, text: '', turns: 1, toolCalls: 0 }), allowance);
  await expect(delegated.tool.execute('bad-artifact', { label: 'Use task artifact', prompt: 'Read the referenced source.', agent_type: 'research', artifacts: ['a-00000000-0000-4000-8000-000000000000'] }))
    .rejects.toThrow('unknown or inaccessible delegation evidence');
  expect(task.snapshot().request?.delegations).toBe(0);
});

it('authorizes, retrieves, accumulates, and restores more than four artifact IDs across junior continuations', async () => {
  const f = await setup((_body, _req, res) => completion(res, { text: 'unused' }));
  const scope = 'delegate-cumulative-artifacts';
  const task = TaskStore.open(f.config.stateDir, scope, 'goal', f.scratch);
  task.startRequest('artifact-request', { calls: 100, modelCalls: 100, timeoutMs: 60_000 });
  let producerId = '';
  const pad = new Scratch(f.scratch, [], (saved, kind) => task.register({ name: 'instructor' }, producerId, saved, kind));
  const makeArtifact = async (index: number) => {
    producerId = task.begin({ name: 'instructor' }, 'diagnostic', {})!;
    const artifact = await pad.save('outputs', `delegation-reference-${index}`, `reference content ${index}`, '.txt');
    task.settle(producerId, false);
    return artifact.id;
  };
  const firstSix: string[] = [];
  for (let index = 0; index < 6; index++) firstSix.push(await makeArtifact(index));
  const seventh = await makeArtifact(6);
  const allowance = new RequestAllowance({ calls: 100, modelCalls: 100, timeoutMs: 60_000, delegations: 6 }, task);
  const retrieved: string[][] = [];
  const executeChild = async (child: any) => {
    const actor = child.taskActor;
    const contents = await Promise.all(actor.artifacts.map((id: string) => child.task.artifact(actor, id)));
    retrieved.push(contents);
    child.junior.onReport({ status: 'done', summary: 'retrieved all assigned references' });
    return { success: true, text: '', turns: 1, toolCalls: 0 };
  };
  const parent = { ...f, task, tier: 'normal' as const, workload: 'coder' as const, web: false, prompt: 'parent context stays private', approve: async () => true };
  let delegated = delegateTool(parent, f.scratch, f.cwd, { pause() {}, resume() {} }, executeChild, allowance);
  const assignment = { label: 'Inspect supplied references', prompt: 'Read the supplied evidence.', agent_type: 'research', artifacts: firstSix };
  await delegated.tool.execute('first', assignment);
  await delegated.tool.execute('second', { junior: 'junior-alfa', label: 'Inspect additional reference', prompt: 'Include the new evidence.', agent_type: 'research', artifacts: [seventh] });
  expect(retrieved[0]).toHaveLength(6);
  expect(retrieved[0]!.every((content, index) => content.includes(`reference content ${index}`))).toBe(true);
  expect(retrieved[1]).toHaveLength(7);
  expect(retrieved[1]![6]).toContain('reference content 6');

  const restored = TaskStore.open(f.config.stateDir, scope, 'ignored after restart', f.scratch);
  const restartedAllowance = new RequestAllowance({ calls: 100, modelCalls: 100, timeoutMs: 60_000, delegations: 6 }, restored);
  delegated = delegateTool({ ...parent, task: restored }, f.scratch, f.cwd, { pause() {}, resume() {} }, executeChild, restartedAllowance);
  await delegated.tool.execute('after-restart', { junior: 'junior-alfa', label: 'Recheck saved references', prompt: 'Continue with the original evidence.', agent_type: 'test', artifacts: [] });
  expect(retrieved[2]).toHaveLength(7);
  expect(retrieved[2]![0]).toContain('reference content 0');
  expect(retrieved[2]![6]).toContain('reference content 6');
});
