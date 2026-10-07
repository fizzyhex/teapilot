import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHost, type CheckpointView } from '../src/host.js';
import { checkpointCard, continuation, latest, taskwriteTool, workflowTasks, Workflow, type CheckpointDecision } from '../src/agents/checkpoint.js';
import { completion, events, fixture, jev, mockServer, type Handler } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function folder(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'teapilot-checkpoint-'));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function setup(handler: Handler) {
  const f = await fixture(); cleanups.push(f.cleanup);
  const server = await mockServer(handler); cleanups.push(server.close);
  f.config.router.endpoint = `${server.url}/jev`;
  f.config.models.fast.baseUrl = `${server.url}/fast/v1`;
  f.config.models.capable.baseUrl = `${server.url}/capable/v1`;
  // A small window of 8: due with 3 calls left, so the orchestrator reads five times before it is asked to hand off.
  Object.assign(f.config.policy.limits, { maxToolCalls: 20, instructorToolCalls: 8 });
  for (let index = 0; index < 12; index++) await writeFile(join(f.cwd, `input-${index}.txt`), `part ${index}`);
  return { ...f, scratch: join(f.cwd, '.scratch') };
}

/** Each read is of a different file, so none of them looks like a loop. */
const read = (res: any, body: any) => completion(res, { tool: { name: 'read', arguments: { path: `input-${(sent(body).match(/"name":"read"|toolName":"read/g) ?? []).length % 12}.txt` } } });
const toolNames = (body: any): string[] => (body.tools ?? []).map((tool: any) => tool.function?.name);
const sent = (body: any) => JSON.stringify(body.messages);
const generation = (body: any) => /\[checkpoint (\d+)\] you are continuing/.exec(sent(body))?.[1];

describe('workflow state', () => {
  it('projects current task states and lets a repeated state refresh its note', async () => {
    const flow = new Workflow('r', 3);
    const task = flow.openTask('level data', 'junior-alfa');
    flow.move(task.id, 'blocked', 'needs research');
    task.result = { status: 'stuck', file: 'reports/turn-1.md', consumed: true };
    expect(workflowTasks(flow)).toContain('blocked - needs research; result stuck (reports/turn-1.md)');
    await taskwriteTool(flow).execute('x', { task: task.id, state: 'blocked', note: 'source unavailable; try another' });
    expect(workflowTasks(flow)).toContain('blocked - source unavailable; try another');
    flow.move(task.id, 'verified', 'checked partial output');
    expect(workflowTasks(flow)).toContain('verified - checked partial output');
    expect(workflowTasks(flow)).not.toContain('result stuck');
    expect(workflowTasks(new Workflow('empty', 3))).toBeUndefined();
  });
  it('enforces task transitions and lets taskwrite reach only verified, blocked or cancelled', async () => {
    const flow = new Workflow('r', 3);
    const task = flow.openTask('level data', 'junior-alfa');
    expect(task).toMatchObject({ id: 't1', state: 'open' });
    flow.move('t1', 'running');
    expect(() => flow.move('t1', 'verified')).toThrow(/running; it can become awaiting_verification, blocked, cancelled/);
    flow.move('t1', 'awaiting_verification');
    const tool = taskwriteTool(flow);
    const result = await tool.execute('x', { task: 't1', state: 'verified', note: 'checked the level file' });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('verified - checked the level file') });
    expect(() => flow.move('t1', 'running')).toThrow(/final/);
    expect(flow.taskOf('junior-alfa')).toBeUndefined();
    // A junior that reported itself stuck may still have finished: its orchestrator can verify it directly.
    const stuck = flow.openTask('controls', 'junior-bravo'); flow.move(stuck.id, 'running'); flow.move(stuck.id, 'blocked');
    expect(flow.move(stuck.id, 'verified').state).toBe('verified');
    await expect(tool.execute('y', { task: 't9', state: 'cancelled' })).rejects.toThrow(/no task t9/);
  });

  it('keeps unconfirmed side effects unknown rather than failed, and marks interrupted juniors', async () => {
    const flow = new Workflow('r', 3);
    flow.begin('a', 'bash', { command: 'npm publish' });
    flow.settle('a', 'bash', { command: 'npm publish' }, true, 'Command timed out after 120 seconds');
    flow.begin('b', 'edit', { path: 'x.js' });
    flow.settle('b', 'edit', { path: 'x.js' }, true, 'oldText not found');
    flow.begin('c', 'play_start', { path: 'game.js' });
    flow.begin('d', 'read', { path: 'x.js' });
    const task = flow.openTask('controls', 'junior-bravo'); flow.move(task.id, 'running');
    const record = await flow.checkpoint({ reason: 'time', forced: true, attempts: 0 });
    expect(record.host.unknown.map(item => item.call)).toEqual(['bash "npm publish"', 'delegate_task to junior-bravo (t1)', 'play_start "game.js"']);
    expect(record.host.failures).toEqual([{ tool: 'edit', call: 'edit "x.js"', error: 'oldText not found' }]);
    expect(record.host.tasks[0]).toMatchObject({ state: 'running', result: { status: 'interrupted', consumed: false } });
    expect(record.handoff).toBeUndefined();
    const text = continuation(record);
    expect(text).toContain('outcome unknown: bash "npm publish" (Command timed out after 120 seconds). check its effect before repeating it');
    expect(text).toContain('the previous agent left no handoff.');
    expect(checkpointCard(record)).toMatchObject({ title: 'checkpoint 1 · out of time (forced)', lines: expect.arrayContaining(['⚠ 3 operations with unknown outcome']) });
  });

  it('records each checkpoint\'s own commits and the working tree, from git itself', async () => {
    const root = await folder();
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root });
    git('init', '-q', '-b', 'main'); await writeFile(join(root, 'a.txt'), 'a'); git('add', '-A'); git('commit', '-qm', 'start');
    const flow = new Workflow('r', 3);
    await flow.useRoot(root);
    await writeFile(join(root, 'b.txt'), 'b'); git('add', '-A'); git('commit', '-qm', 'add level data');
    await writeFile(join(root, 'c.txt'), 'c');
    await mkdir(join(root, '.scratch'), { recursive: true }); await writeFile(join(root, '.scratch', 'notes.md'), 'mine');
    const record = await flow.checkpoint({ reason: 'tool_calls', forced: false, attempts: 1, handoff: { status: 'level data done', next: 'controls' } });
    expect(record.host.git).toMatchObject({ branch: 'main', dirty: ['?? c.txt'], dirtyCount: 1 });
    expect(record.host.git!.commits).toHaveLength(1);
    expect(record.host.git!.commits[0]).toContain('add level data');
    const text = continuation(record);
    // Host facts come before the agent's words, which are labelled as guidance.
    expect(text.indexOf('objective state (host-recorded)')).toBeLessThan(text.indexOf("previous agent's handoff (guidance, not fact)"));
    // A tool withdrawn since is named beside the handoff that may still suggest it.
    expect(text).not.toContain('withdrawn');
    expect(continuation(record, false, ['web_search'])).toContain("- next: controls\n- withdrawn for this request: web_search. skip any step that needs it.");
    // The next checkpoint shows only what was committed after this one, on its card too.
    git('add', '-A'); git('commit', '-qm', 'add controls');
    const second = await flow.checkpoint({ reason: 'tool_calls', forced: true, attempts: 0 });
    expect(second.host.git!.commits).toHaveLength(1);
    expect(second.host.git!.commits[0]).toContain('add controls');
    expect(second.host.git!.base).toBe(record.host.git!.head);
    expect(checkpointCard(second).lines).toContain(`commits: 1 new (${second.host.git!.head})`);
    const quiet = await flow.checkpoint({ reason: 'tool_calls', forced: true, attempts: 0 });
    expect(quiet.host.git!.commits).toEqual([]);
    expect(checkpointCard(quiet).lines).toContain(`commits: none new (${quiet.host.git!.head})`);
  });

  it('counts commits from where a parked checkpoint left off', async () => {
    const root = await folder(), scratch = await folder();
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root });
    git('init', '-q', '-b', 'main'); await writeFile(join(root, 'a.txt'), 'a'); git('add', '-A'); git('commit', '-qm', 'start');
    const flow = new Workflow('r1', Infinity, scratch);
    await flow.useRoot(root);
    await writeFile(join(root, 'b.txt'), 'b'); git('add', '-A'); git('commit', '-qm', 'before parking');
    const parked = await flow.checkpoint({ reason: 'time', forced: true, attempts: 0 });
    flow.save({ ...parked, status: 'parked' });
    await writeFile(join(root, 'c.txt'), 'c'); git('add', '-A'); git('commit', '-qm', 'after resuming');
    const resumed = Workflow.open('r2', Infinity, scratch);
    await resumed.useRoot(root);
    const record = await resumed.checkpoint({ reason: 'time', forced: true, attempts: 0 });
    expect(record.host.git!.commits).toEqual([expect.stringContaining('after resuming')]);
  });

  it('has no checkpoint cap unless one is configured, and reports every task change', async () => {
    const changes: string[] = [];
    const flow = new Workflow('r', Infinity);
    flow.onTask = task => changes.push(`${task.id}:${task.state}`);
    for (let index = 0; index < 25; index++) await flow.checkpoint({ reason: 'time', forced: true, attempts: 0 });
    expect(flow.canCheckpoint).toBe(true);
    const task = flow.openTask('level data', 'junior-alfa');
    flow.move(task.id, 'running'); flow.move(task.id, 'awaiting_verification'); flow.move(task.id, 'verified');
    expect(changes).toEqual(['t1:open', 't1:running', 't1:awaiting_verification', 't1:verified']);
  });

  it('writes each generation whole and restores a parked one with its tasks and juniors', async () => {
    const scratch = await folder();
    const flow = new Workflow('r1', 2, scratch);
    flow.openTask('research', 'junior-alfa');
    flow.juniors.set('junior-alfa', { name: 'junior-alfa', description: 'research', turns: [{ user: 'go', assistant: 'found it' }], scratch: join(scratch, 'juniors', 'junior-alfa'), turn: 1 });
    const record = await flow.checkpoint({ reason: 'tool_calls', forced: false, attempts: 1, handoff: { status: 's', next: 'n' } });
    expect(latest(scratch)).toMatchObject({ generation: 1, status: 'continued', handoff: { status: 's', next: 'n' } });
    flow.save({ ...record, status: 'parked' });
    const restored = Workflow.open('r2', 2, scratch);
    expect(restored.parked?.generation).toBe(1);
    expect(restored.tasks.get('t1')).toMatchObject({ label: 'research', junior: 'junior-alfa' });
    expect(restored.juniors.get('junior-alfa')?.turn).toBe(1);
    // Its limit counts this request's own checkpoints.
    expect(restored.canCheckpoint).toBe(true);
    await restored.checkpoint({ reason: 'time', forced: true, attempts: 0 });
    await restored.checkpoint({ reason: 'time', forced: true, attempts: 0 });
    expect(restored.canCheckpoint).toBe(false);
    expect(latest(scratch)).toMatchObject({ generation: 3, sequence: 3 });
    // A later request in the same conversation numbers its own checkpoints from 1, without overwriting these.
    const later = Workflow.open('r3', 2, scratch);
    expect(await later.checkpoint({ reason: 'time', forced: true, attempts: 0 })).toMatchObject({ generation: 1, sequence: 4 });
    expect(readdirSync(join(scratch, 'checkpoints'))).toEqual(['0001.json', '0002.json', '0003.json', '0004.json']);
  });
});

describe('checkpoints through the host', () => {
  it('offers a checkpoint when delegation is spent, even with instructor calls remaining', async () => {
    const bodies: any[] = [];
    const f = await setup((body, req, res) => {
      if (req.url === '/jev') return jev(res, 'coder.normal');
      if (req.url?.endsWith('/models')) { res.end('{}'); return; }
      bodies.push(body);
      if (toolNames(body).includes('report')) return completion(res, { tool: { name: 'report', arguments: { status: 'done', summary: 'first phase ready' } } });
      if (generation(body)) return completion(res, { text: 'continued with renewed delegation.' });
      if (toolNames(body).includes('checkpoint')) return completion(res, { tool: { name: 'checkpoint', arguments: { status: 'first phase ready', next: 'verify first phase and delegate next' } } });
      return completion(res, { tool: { name: 'delegate_task', arguments: { label: 'Inspect first phase', prompt: 'inspect first phase', agent_type: 'research', artifacts: [] } } });
    });
    f.config.policy.limits.maxJuniorTurns = 1;
    const views: CheckpointView[] = [];
    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Build app', scratch: f.scratch }, {
      approve: async () => true, onCheckpoint: async view => { views.push(view); return { action: 'continue' }; },
    });
    expect(result.success).toBe(true);
    expect(views).toHaveLength(1);
    expect(views[0]!.record.host.reason).toBe('junior_calls');
    const due = bodies.find(body => toolNames(body).includes('checkpoint'));
    expect(sent(due)).toContain('junior allowance for this window is spent');
    expect(toolNames(bodies.find(body => generation(body)))).toContain('delegate_task');
  });
  it.each([false, true])('gives missing tool calls one fresh-context recovery, without chaining (still broken: %s)', async broken => {
    const bodies: any[] = [];
    const f = await setup((body, req, res) => {
      if (req.url === '/jev') return jev(res, 'coder.normal');
      if (req.url?.endsWith('/models')) { res.end('{}'); return; }
      bodies.push(body);
      if (generation(body) && !broken) return completion(res, { text: 'finished with a simpler approach.' });
      res.setHeader('Content-Type', 'text/event-stream');
      const common = { id: 'missing-call', object: 'chat.completion.chunk', created: 1, model: 'mock-model' };
      res.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
    f.config.policy.escalation.maxEscalations = 0;
    const views: CheckpointView[] = [];
    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Build app', scratch: f.scratch }, {
      approve: async () => true, onCheckpoint: async view => { views.push(view); return { action: 'continue' }; },
    });
    expect(result.success).toBe(!broken);
    expect(result.attempts).toBe(2);
    expect(views).toHaveLength(1);
    expect(views[0]!.record.host.reason).toBe('missing_tool_call');
    expect(sent(bodies.find(body => generation(body)))).toContain('do not reconstruct or replay the missing call');
    expect(bodies).toHaveLength(4);
  });
  it('hands off to a fresh orchestrator with the host facts first, without spending the window on the checkpoint', async () => {
    const bodies: any[] = [];
    const f = await setup((body, req, res) => {
      if (req.url === '/jev') return jev(res, 'coder.normal');
      if (req.url?.endsWith('/models')) { res.end('{}'); return; }
      bodies.push(body);
      if (generation(body) === '1') return completion(res, { text: 'finished from the checkpoint.' });
      if (toolNames(body).includes('checkpoint')) return completion(res, { tool: { name: 'checkpoint', arguments: { status: 'read input twice', next: 'summarise input.txt' } } });
      read(res, body);
    });
    const views: CheckpointView[] = [];
    const shown: any[] = [];
    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Inspect code', scratch: f.scratch }, {
      approve: async () => true, onCheckpoint: async view => { views.push(view); return { action: 'continue' }; },
      // Surfaces see host events and telemetry alike; only the host's checkpoint event carries a card.
      onEvent: event => { shown.push(event); if (event.type === 'checkpoint') expect(event.lines).toEqual(expect.any(Array)); },
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(shown.find(event => event.type === 'tool_execution_end' && event.tool === 'checkpoint')).toMatchObject({ isError: false });
    expect(result.text).toContain('finished from the checkpoint.');
    expect(result.attempts).toBe(2);
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ title: 'checkpoint 1 · out of tool calls', record: { handoff: { next: 'summarise input.txt' }, host: { forced: false, last: { tool: 'read', ok: true } } } });
    // The notice arrives with the tool, and the fresh orchestrator starts without the old one's messages.
    const due = bodies.find(body => toolNames(body).includes('checkpoint'));
    expect(sent(due)).toContain('[checkpoint due] 3 tool calls left in this window');
    const fresh = bodies.find(body => generation(body) === '1');
    expect(sent(fresh)).not.toContain('[checkpoint due]');
    expect(sent(fresh)).toContain("previous agent's handoff (guidance, not fact)");
    expect(latest(f.scratch)).toMatchObject({ generation: 1, status: 'continued' });
    const tools = (await events(f.config)).filter(event => event.type === 'tool');
    expect(tools.map(event => event.name)).toEqual(['read', 'read', 'read', 'read', 'read']);
    expect((await events(f.config)).filter(event => event.type === 'checkpoint_decision')).toEqual([expect.objectContaining({ generation: 1, action: 'continue', forced: false })]);
  });

  it('forces a host checkpoint after three replies without one, and the next orchestrator still continues', async () => {
    let final = 0;
    const f = await setup((body, req, res) => {
      if (req.url === '/jev') return jev(res, 'coder.normal');
      if (req.url?.endsWith('/models')) { res.end('{}'); return; }
      if (generation(body) === '1') return completion(res, { text: 'carried on without notes.' });
      if (sent(body).includes('[checkpoint required]')) final++;
      // A model that never checkpoints: it keeps reaching for read, even once only checkpoint is left.
      read(res, body);
    });
    const views: CheckpointView[] = [];
    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Inspect code', scratch: f.scratch }, {
      approve: async () => true, onCheckpoint: async view => { views.push(view); return { action: 'continue' }; },
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(final).toBe(3);
    expect(views[0]?.record).toMatchObject({ host: { forced: true, attempts: 3, reason: 'tool_calls' } });
    expect(views[0]?.record.handoff).toBeUndefined();
    expect(views[0]?.lines).toContain('no handoff from the agent; the host wrote this one');
    expect((await events(f.config)).filter(event => event.type === 'tool' && event.name === 'read')).toHaveLength(8);
  });

  it('starts the next orchestrator with the skills the last one loaded', async () => {
    const bodies: any[] = [];
    const f = await setup((body, req, res) => {
      if (req.url === '/jev') return jev(res, 'coder.normal');
      if (req.url?.endsWith('/models')) { res.end('{}'); return; }
      bodies.push(body);
      if (generation(body)) return completion(res, { text: 'done.' });
      if (!sent(body).includes('fixture instructions')) return completion(res, { tool: { name: 'skill', arguments: { id: 'example' } } });
      if (toolNames(body).includes('checkpoint')) return completion(res, { tool: { name: 'checkpoint', arguments: { status: 's', next: 'n' } } });
      read(res, body);
    });
    const directory = join(f.cwd, 'skills'); await mkdir(join(directory, 'example'), { recursive: true });
    await writeFile(join(directory, 'example', 'SKILL.md'), '---\nname: example\ndescription: Read fixture evidence carefully.\n---\nfixture instructions\n');
    f.config.skills = { enabled: true, offline: true, directory };
    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Inspect code', scratch: f.scratch }, { approve: async () => true, onCheckpoint: async () => ({ action: 'continue' }) });
    expect(result.success, JSON.stringify(result)).toBe(true);
    const fresh = sent(bodies.find(body => generation(body)));
    expect(fresh).toContain('skills carried over: example');
    expect(fresh).toContain('fixture instructions');
  });

  it('passes a steer to the next orchestrator', async () => {
    const bodies: any[] = [];
    const f = await setup((body, req, res) => {
      if (req.url === '/jev') return jev(res, 'coder.normal');
      if (req.url?.endsWith('/models')) { res.end('{}'); return; }
      bodies.push(body);
      if (generation(body)) return completion(res, { text: 'done.' });
      if (toolNames(body).includes('checkpoint')) return completion(res, { tool: { name: 'checkpoint', arguments: { status: 's', next: 'n' } } });
      read(res, body);
    });
    const steer = async (): Promise<CheckpointDecision> => ({ action: 'steer', text: 'use tabs, not spaces' });
    await runHost(f.config, { cwd: f.cwd, prompt: 'Inspect code', scratch: f.scratch }, { approve: async () => true, onCheckpoint: steer });
    expect(sent(bodies.find(body => generation(body)))).toContain('the user steered at this checkpoint: use tabs, not spaces');
    expect(latest(f.scratch)?.steer).toBe('use tabs, not spaces');
  });

  it('parks on stop, and offers the parked workflow to the next request', async () => {
    const bodies: any[] = [];
    const f = await setup((body, req, res) => {
      if (req.url === '/jev') return jev(res, 'coder.normal');
      if (req.url?.endsWith('/models')) { res.end('{}'); return; }
      bodies.push(body);
      if (sent(body).includes('that was parked')) return completion(res, { text: 'picked it back up.' });
      if (toolNames(body).includes('checkpoint')) return completion(res, { tool: { name: 'checkpoint', arguments: { status: 'halfway', next: 'finish the summary' } } });
      read(res, body);
    });
    const parked = await runHost(f.config, { cwd: f.cwd, prompt: 'Inspect code', scratch: f.scratch }, { approve: async () => true, onCheckpoint: async () => ({ action: 'stop' }) });
    expect(parked).toMatchObject({ success: false, status: 'parked' });
    // One line under the card that already shows the rest; replaying its steps must not invite another checkpoint call.
    expect(parked.text).toBe("parked at checkpoint 1. ask to continue it whenever you're ready.");
    expect(parked.steps?.some(step => step.role === 'toolResult' ? step.toolName === 'checkpoint' : step.role === 'assistant' && step.content.some(part => part.type === 'toolCall' && part.name === 'checkpoint'))).toBe(false);
    expect(latest(f.scratch)?.status).toBe('parked');
    const resumed = await runHost(f.config, { cwd: f.cwd, prompt: 'continue', scratch: f.scratch }, { approve: async () => true });
    expect(resumed.text).toContain('picked it back up.');
    expect(sent(bodies.at(-1))).toContain('next: finish the summary');
    expect(latest(f.scratch)?.status).toBe('resumed');
  });

  it('keeps the old hard limit when checkpoints are off', async () => {
    const f = await setup((body, req, res) => {
      if (req.url === '/jev') return jev(res, 'coder.normal');
      if (req.url?.endsWith('/models')) { res.end('{}'); return; }
      expect(toolNames(body)).not.toContain('checkpoint');
      read(res, body);
    });
    f.config.policy.limits.maxCheckpoints = 0;
    const onCheckpoint = vi.fn();
    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Inspect code', scratch: f.scratch }, { approve: async () => true, onCheckpoint });
    expect(result.status).toBe('tool_limit');
    expect(onCheckpoint).not.toHaveBeenCalled();
  });
});
