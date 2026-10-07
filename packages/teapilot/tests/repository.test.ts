import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { guardedMutation, inventory, sessionTools } from '../src/agents/tools.js';
import { RequestRecovery } from '../src/agents/recovery.js';
import { ExecutionPolicy } from '../src/execution/policy.js';
import { Evidence } from '../src/routing/escalation.js';
import { completion, fixture, mockServer } from './helpers.js';
import { runHost } from '../src/host.js';
import { WorkspaceStore } from '../src/workspace/store.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function setup() { const f = await fixture(); cleanup.push(f.cleanup); return f; }
const noApproval = async () => { throw new Error('Unexpected approval'); };

it('refuses an identical failed edit until its file changes, across tool instances', async () => {
  const f = await setup(), recovery = new RequestRecovery();
  const path = join(f.cwd, 'target.txt');
  await writeFile(path, 'original');
  const execute = vi.fn(async () => { throw new Error(`Could not find the exact text in ${path}.`); });
  const base = { name: 'edit', label: 'edit', description: '', parameters: {} as never, execute };
  const args = () => ({ path, edits: [{ oldText: 'missing', newText: 'replacement' }] });
  const first = guardedMutation(base, recovery);
  expect((await first.execute('1', args())).details).toMatchObject({ outcome: { code: 'invalid_edit', changed: false } });
  const resumed = guardedMutation(base, recovery);
  expect((await resumed.execute('2', args())).details).toMatchObject({ outcome: { code: 'repeat_refused' } });
  expect(execute).toHaveBeenCalledTimes(1);
  await writeFile(path, 'changed externally');
  await resumed.execute('3', args());
  expect(execute).toHaveBeenCalledTimes(2);
  await resumed.execute('4', { path, edits: [{ oldText: 'different', newText: 'replacement' }] });
  expect(execute).toHaveBeenCalledTimes(3);
});

it('does not run no-op mutations, but allows mixed edit batches that really change content', async () => {
  const f = await setup();
  const path = join(f.cwd, 'target.txt');
  await writeFile(path, 'original');
  const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'changed' }], details: {} }));
  const tool = guardedMutation({ name: 'edit', label: 'edit', description: '', parameters: {} as never, execute }, new RequestRecovery());
  await tool.execute('1', { path, edits: [{ oldText: 'same\r\n', newText: 'same\n' }] });
  expect(execute).not.toHaveBeenCalled();
  await tool.execute('2', { path, edits: [{ oldText: 'same', newText: 'same' }, { oldText: 'old', newText: 'new' }] });
  expect(execute).toHaveBeenCalledTimes(1);
});

it('keeps inspection-loop warnings across attempts and does not clear them for notes or no-op writes', () => {
  const recovery = new RequestRecovery();
  const thresholds = { repeatedToolCalls: 2, consecutiveFailures: 2, maxEscalations: 2 };
  const first = new Evidence(thresholds, [], path => path.startsWith('/s/'), recovery);
  first.observe('ls', {}, false, 'empty');
  first.observe('ls', {}, false, 'empty');
  expect(first.warning).toContain('Change approach');
  first.observe('write', { path: '/s/note.md' }, false);
  first.observe('write', { path: 'unchanged.txt' }, false, 'no change', undefined, false);
  const resumed = new Evidence(thresholds, [], undefined, recovery);
  resumed.observe('ls', {}, false, 'empty');
  expect(resumed.reason).toBe('ineffective_calls');
});

it('counts repeats per context: a fresh context may redo what an earlier one did, but not loop itself', () => {
  const recovery = new RequestRecovery();
  const thresholds = { repeatedToolCalls: 3, consecutiveFailures: 2, maxEscalations: 2 };
  const skill = { id: 'gh:fizzyhex/tea-skills::discord-play' };
  new Evidence(thresholds, [], undefined, recovery, false, 'instructor#0').observe('skill', skill, false, 'loaded');
  new Evidence(thresholds, [], undefined, recovery, false, 'junior-alfa#1').observe('skill', skill, false, 'loaded');
  const second = new Evidence(thresholds, [], undefined, recovery, false, 'junior-alfa#2');
  second.observe('skill', skill, false, 'loaded');
  expect(second.reason).toBeUndefined();
  second.observe('skill', skill, false, 'loaded');
  second.observe('skill', skill, false, 'loaded');
  expect(second.reason).toBe('ineffective_calls');
  // A checkpoint's successor starts its own count; an escalation in the same generation does not.
  const successor = new Evidence(thresholds, [], undefined, recovery, false, 'instructor#1');
  successor.observe('skill', skill, false, 'loaded');
  expect(successor.reason).toBeUndefined();
});

it('gives each attempt its own warning for a streak of refused calls', () => {
  const recovery = new RequestRecovery();
  const thresholds = { repeatedToolCalls: 2, consecutiveFailures: 2, maxEscalations: 2 };
  const first = new Evidence(thresholds, [], undefined, recovery);
  first.refuse(); first.refuse();
  expect(first).toMatchObject({ answerNow: true, reason: undefined });
  first.refuse(); first.refuse();
  expect(first.reason).toBe('ineffective_calls');
  // The next attempt may be offered other tools, such as search withdrawn: its first streak is warned, not ended.
  const next = new Evidence(thresholds, [], undefined, recovery);
  next.refuse(); next.refuse();
  expect(next).toMatchObject({ answerNow: true, reason: undefined });
});

it('keeps repeated failures request-wide, and lets an edit in one context clear stale reads in another', () => {
  const recovery = new RequestRecovery();
  const thresholds = { repeatedToolCalls: 2, consecutiveFailures: 5, maxEscalations: 2 };
  new Evidence(thresholds, [], undefined, recovery, false, 'instructor#0').observe('bash', { command: 'npm test' }, true, 'missing module');
  const junior = new Evidence(thresholds, [], undefined, recovery, false, 'junior-alfa#1');
  junior.observe('bash', { command: 'npm test' }, true, 'missing module');
  expect(junior.reason).toBe('tool_failures');

  const reader = new Evidence(thresholds, [], undefined, recovery, false, 'instructor#0');
  reader.observe('read', { path: 'a.ts' }, false, 'same');
  reader.observe('read', { path: 'a.ts' }, false, 'same');
  expect(reader.warning).toContain('Change approach');
  new Evidence(thresholds, [], undefined, recovery, false, 'junior-alfa#1').observe('edit', { path: 'a.ts' }, false);
  reader.observe('read', { path: 'a.ts' }, false, 'same');
  expect(reader.reason).toBeUndefined();
});

it('keeps command failure evidence for unrelated scratch notes and clears it for relevant script edits', () => {
  const evidence = new Evidence({ repeatedToolCalls: 2, consecutiveFailures: 2, maxEscalations: 2 }, [], path => path.startsWith('/s/'));
  evidence.observe('bash', { command: 'python /s/helper.py' }, true, 'missing dependency');
  evidence.observe('write', { path: '/s/notes.md' }, false);
  evidence.observe('bash', { command: 'python /s/helper.py' }, true, 'missing dependency');
  expect(evidence.reason).toBe('tool_failures');
  const relevant = new Evidence({ repeatedToolCalls: 2, consecutiveFailures: 2, maxEscalations: 2 }, [], path => path.startsWith('/s/'));
  relevant.observe('bash', { command: 'python /s/helper.py' }, true, 'missing dependency');
  relevant.observe('edit', { path: '/s/helper.py' }, false);
  relevant.observe('bash', { command: 'python /s/helper.py' }, true, 'missing dependency');
  expect(relevant.reason).toBeUndefined();
});

it('lists, finds and searches without approval, respecting ignore rules and file boundaries', async () => {
  const f = await setup(), outside = await setup();
  await mkdir(join(f.cwd, 'src'));
  await writeFile(join(f.cwd, '.gitignore'), '*.log\n');
  await writeFile(join(f.cwd, '.env'), 'needle secret');
  await writeFile(join(f.cwd, 'ignored.log'), 'needle ignored');
  await writeFile(join(f.cwd, 'src', 'index.ts'), 'first\nneedle here\nneedle twice\n');
  await symlink(outside.cwd, join(f.cwd, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const tools = sessionTools(new ExecutionPolicy(f.cwd, f.config, noApproval), { stateDir: f.config.stateDir });
  expect(tools.map(tool => tool.name)).toEqual(['read', 'write', 'edit', 'ls', 'find', 'grep']);
  const run = async (name: string, args: unknown) => (await tools.find(tool => tool.name === name)!.execute('id', args)).content.map(part => part.type === 'text' ? part.text : '').join('');
  const listing = await run('ls', {});
  expect(listing).toContain('src/');
  expect(listing).not.toMatch(/\.env|linked/);
  const found = await run('find', { pattern: '*' });
  expect(found).toContain('src/index.ts');
  expect(found).not.toMatch(/\.env|ignored\.log|linked/);
  expect(await run('find', { pattern: '*.ts', path: 'src' })).toBe('index.ts');
  // pi's grep runs rg --hidden: lines from protected files are dropped all the same.
  const matches = await run('grep', { pattern: 'needle', ignoreCase: true });
  expect(matches).toContain('src/index.ts:2: needle here');
  expect(matches).not.toMatch(/secret|ignored/);
  expect(await run('grep', { pattern: 'NEEDLE', path: 'src', ignoreCase: true, limit: 1 })).toMatch(/^index\.ts:2: needle here\n\n\[1 matches limit reached/);
  await expect(run('ls', { path: '..' })).rejects.toThrow();
  await expect(run('ls', { path: 'linked' })).rejects.toThrow('Linked');
  await expect(run('grep', { pattern: 'x', path: '.env' })).rejects.toThrow('protected');
  f.config.policy.permissions = [];
  await expect(run('ls', {})).rejects.toThrow('Missing repository.read');
});

it('opens a code session with each folder of the root and the files in it', async () => {
  const f = await setup();
  for (let i = 0; i < 15; i++) {
    const dir = join(f.cwd, `repo-${i}`);
    await mkdir(dir);
    for (let j = 0; j < 30; j++) await writeFile(join(dir, `file-${j}.ts`), 'x'.repeat(50));
  }
  await mkdir(join(f.cwd, 'self-contained-pong-v2'));
  await writeFile(join(f.cwd, 'readme.md'), 'hi');
  const listed = await inventory(new ExecutionPolicy(f.cwd, f.config, noApproval));
  expect(listed.length).toBeLessThan(4096);
  expect(listed.split('\n')).toHaveLength(17);
  expect(listed).toContain('repo-0/ (30 files)');
  expect(listed).toContain('self-contained-pong-v2/ (empty)');
  expect(listed).toContain('readme.md');
});

it('keeps the conversation workspace out of a repository: .workspace/ is only a folder there', async () => {
  const f = await setup();
  f.config.policy.permissions = ['repository.read', 'repository.write'];
  const tools = sessionTools(new ExecutionPolicy(f.cwd, f.config, noApproval), { stateDir: f.config.stateDir });
  const run = async (name: string, args: unknown) => (await tools.find(tool => tool.name === name)!.execute('id', args)).content.map(part => part.type === 'text' ? part.text : '').join('');
  await run('write', { path: '.workspace/apps/game.js', content: 'export default 1;\n' });
  expect(await readFile(join(f.cwd, '.workspace', 'apps', 'game.js'), 'utf8')).toBe('export default 1;\n');
});

it('rejects browser edits from an agent write until its workspace reconciliation finishes', async () => {
  const f = await setup();
  f.config.policy.permissions = ['repository.read', 'repository.write'];
  const store = WorkspaceStore.at(f.config.stateDir);
  const conversation = 'agent-editor-lease';
  const file = await store.saveAt(conversation, 'note.txt', Buffer.from('before'), 'alice');
  let entered!: () => void, resume!: () => void;
  const inReconcile = new Promise<void>(resolve => { entered = resolve; });
  const reconciliation = new Promise<void>(resolve => { resume = resolve; });
  const tools = sessionTools(new ExecutionPolicy(store.folder(conversation), f.config, noApproval, undefined, undefined, true), {
    stateDir: f.config.stateDir,
    beginMutation: () => store.beginCommand(conversation),
    changed: async () => { entered(); await reconciliation; await store.reconcile(conversation); },
  });
  const opened = store.readEditable(conversation, file.name)!;
  const writing = tools.find(tool => tool.name === 'write')!.execute('id', { path: file.name, content: 'agent version' });
  await inReconcile;
  expect(store.saveEditable(conversation, file.name, 'browser version', opened.revision, 'alice')).toBeUndefined();
  resume();
  await writing;
  const latest = store.readEditable(conversation, file.name)!;
  expect(latest.content).toBe('agent version');
  expect(store.saveEditable(conversation, file.name, 'browser version', latest.revision, 'alice')).not.toBeUndefined();
});

it('gives repeated equivalent inspection one recovery opportunity and invalidates checks on edits', () => {
  const evidence = new Evidence({ repeatedToolCalls: 2, consecutiveFailures: 2, maxEscalations: 2 });
  evidence.observe('ls', {}, false, 'empty');
  evidence.observe('ls', { path: '.' }, false, 'empty');
  expect(evidence.reason).toBeUndefined();
  expect(evidence.warning).toContain('Change approach');
  evidence.observe('ls', { limit: 200 }, false, 'empty');
  expect(evidence.reason).toBe('ineffective_calls');
  // discord.play calls carry their code in the reply, so the same arguments with new results are progress.
  const play = new Evidence({ repeatedToolCalls: 2, consecutiveFailures: 2, maxEscalations: 2 });
  play.observe('play_start', { title: 'Game' }, false, 'App problem: syntax');
  play.observe('play_start', { title: 'Game' }, false, 'App problem: duplicate id');
  expect(play.reason).toBeUndefined();
  play.observe('play_start', { title: 'Game' }, false, 'App problem: duplicate id');
  // A live app is worth answering about: tools are withdrawn first, and only a further repeat ends the attempt.
  expect(play.reason).toBeUndefined();
  expect(play.answerNow).toBe(true);
  play.observe('play_start', { title: 'Game' }, false, 'App problem: duplicate id');
  expect(play.reason).toBe('ineffective_calls');
  const check = new Evidence({ repeatedToolCalls: 2, consecutiveFailures: 2, maxEscalations: 2 });
  check.observe('bash', { command: 'npm test' }, false);
  expect(check.lastCheck).toBe('passed');
  check.observe('write', { path: 'index.js' }, false);
  expect(check.lastCheck).toBeUndefined();
  // Editing a scratchpad script between runs makes the next run a new experiment, though it changes nothing in the project.
  const scratch = new Evidence({ repeatedToolCalls: 2, consecutiveFailures: 2, maxEscalations: 2 }, [], path => path.startsWith('/s/'));
  scratch.observe('bash', { command: 'python .scratch/fit.py' }, false, 'error');
  scratch.observe('edit', { path: '/s/fit.py' }, false);
  scratch.observe('bash', { command: 'python .scratch/fit.py' }, false, 'error');
  expect(scratch.reason).toBeUndefined();
  expect(scratch.changedFiles.size).toBe(0);
  scratch.observe('bash', { command: 'python .scratch/fit.py' }, false, 'error');
  expect(scratch.reason).toBe('ineffective_calls');
});

it('stops on the same error repeating, whatever the arguments, until a project edit', () => {
  const evidence = new Evidence({ repeatedToolCalls: 3, consecutiveFailures: 2, maxEscalations: 2 });
  evidence.observe('bash', { command: 'npm tset' }, true, 'npm: command not found');
  evidence.observe('bash', { command: 'npm  tset' }, true, 'npm: command not found');
  expect(evidence.reason).toBeUndefined();
  evidence.observe('edit', { path: 'package.json' }, false);
  evidence.observe('bash', { command: 'npm tset ' }, true, 'npm: command not found');
  expect(evidence.reason).toBeUndefined();
  evidence.observe('bash', { command: 'npm tset --x' }, true, 'npm: command not found\nFull output saved to .scratch/a.log');
  evidence.observe('bash', { command: 'npm tset --y' }, true, 'npm: command not found\nFull output saved to .scratch/b.log');
  expect(evidence.reason).toBe('tool_failures');
  expect(evidence.failedCalls.map(item => item.error)).toEqual(Array(5).fill('npm: command not found'));
});

it('repeated searches warn, then refuse further searches instead of aborting', () => {
  const evidence = new Evidence({ repeatedToolCalls: 2, consecutiveFailures: 2, maxEscalations: 2 });
  evidence.observe('web_search', { query: 'a' }, false, 'same results');
  evidence.observe('web_search', { query: 'b' }, false, 'same results');
  expect(evidence.warning).toContain('Stop searching');
  expect(evidence.searchExhausted).toBe(false);
  evidence.observe('web_search', { query: 'c' }, false, 'same results');
  expect(evidence.reason).toBeUndefined();
  expect(evidence.searchExhausted).toBe(true);
});

it('keeps search-loop counts across checkpoints despite reordered hits and changed snippets', () => {
  const recovery = new RequestRecovery();
  const thresholds = { repeatedToolCalls: 2, consecutiveFailures: 2, maxEscalations: 2 };
  const hits = [{ url: 'https://example.com/map', snippet: 'map' }, { url: 'https://example.com/tiles', snippet: 'tiles' }];
  const first = new Evidence(thresholds, [], undefined, recovery, false, 'instructor#0');
  first.observe('web_search', { query: 'map' }, false, JSON.stringify(hits), undefined, undefined, 'hash-1');
  const next = new Evidence(thresholds, [], undefined, recovery, false, 'instructor#1');
  next.observe('web_search', { query: 'tile map' }, false, JSON.stringify(hits.toReversed().map(hit => ({ ...hit, snippet: 'updated' }))), undefined, undefined, 'hash-2');
  expect(next.warning).toContain('Stop searching');
  next.observe('web_search', { query: 'level map' }, false, JSON.stringify(hits));
  expect(next.searchExhausted).toBe(true);
  const fresh = new Evidence(thresholds, [], undefined, recovery, false, 'instructor#2');
  fresh.observe('web_search', { query: 'different source' }, false, JSON.stringify([{ url: 'https://example.org/new' }]));
  expect(fresh.warning).toBeUndefined();
});

it('withdraws identical search queries across checkpoints even when tail results change', () => {
  const recovery = new RequestRecovery();
  const thresholds = { repeatedToolCalls: 2, consecutiveFailures: 2, maxEscalations: 2 };
  for (let index = 0; index < 3; index++) {
    const evidence = new Evidence(thresholds, [], undefined, recovery, false, `instructor#${index}`);
    evidence.observe('web_search', { query: index ? ' LEVEL   map ' : 'level map' }, false, JSON.stringify([{ url: `https://example.com/${index}` }]));
    if (index === 1) expect(evidence.warning).toContain('Stop searching');
    if (index === 2) expect(evidence.searchExhausted).toBe(true);
  }
});

it('does not treat fresh saved-output pointers as new inspection evidence', () => {
  const evidence = new Evidence({ repeatedToolCalls: 2, consecutiveFailures: 2, maxEscalations: 2 });
  for (let index = 1; index <= 3; index++) evidence.observe('read', { path: 'source.txt' }, false, `same body\nFull output saved to .scratch/read-${index}.txt [artifact a-${index}]`);
  expect(evidence.reason).toBe('ineffective_calls');
});

it('uses full-result identity to distinguish changes hidden by an identical preview', () => {
  const evidence = new Evidence({ repeatedToolCalls: 2, consecutiveFailures: 2, maxEscalations: 2 });
  evidence.observe('read', { path: 'source.txt' }, false, 'same preview', undefined, undefined, 'first-content-hash');
  evidence.observe('read', { path: 'source.txt' }, false, 'same preview', undefined, undefined, 'different-content-hash');
  expect(evidence.warning).toBeUndefined(); expect(evidence.reason).toBeUndefined();
  evidence.observe('read', { path: 'source.txt' }, false, 'same preview', undefined, undefined, 'different-content-hash');
  expect(evidence.warning).toContain('Change approach');
});

it('refuses further searches at once when every search engine is unavailable', () => {
  const evidence = new Evidence({ repeatedToolCalls: 3, consecutiveFailures: 2, maxEscalations: 2 });
  evidence.observe('web_search', { query: 'a' }, false, 'No results: the search engines were unavailable (brave: Suspended). Retrying will not help.');
  expect(evidence.searchExhausted).toBe(true);
});

it('empty-repository coding can inspect and write without a shell approval', async () => {
  const f = await setup();
  let calls = 0, approvals = 0;
  const server = await mockServer((_body, req, res) => {
    if (req.url?.endsWith('/models')) { res.end('{}'); return; }
    calls++;
    if (calls === 1) completion(res, { tool: { name: 'ls', arguments: {} } });
    else if (calls === 2) completion(res, { tool: { name: 'write', arguments: { path: 'index.html', content: '<canvas id="pong"></canvas>' } } });
    else completion(res, { text: 'Created the canvas; gameplay is not implemented.' });
  }); cleanup.push(server.close);
  f.config.routingMode = 'direct'; f.config.models.capable.baseUrl = server.url;
  const result = await runHost(f.config, { cwd: f.cwd, workload: 'coder', prompt: 'Create a Pong canvas' }, { approve: async () => { approvals++; return false; } });
  expect(result.success).toBe(true);
  expect(approvals).toBe(0);
  expect(calls).toBe(3);
});

it('a local inspection loop preserves same-tier recovery and reports its final failure', async () => {
  const f = await setup();
  const server = await mockServer((_body, req, res) => {
    if (req.url?.endsWith('/models')) res.end('{}');
    else completion(res, { tool: { name: 'ls', arguments: {} } });
  }); cleanup.push(server.close);
  f.config.routingMode = 'direct'; f.config.models.capable.baseUrl = server.url;
  f.config.models.fast.enabled = false;
  const result = await runHost(f.config, { cwd: f.cwd, workload: 'coder', prompt: 'Create Pong' }, { approve: async () => false });
  // Escalation comes first; once none is left, one fresh agent gets a turn before the request ends.
  expect(result).toMatchObject({ success: false, status: 'ineffective_calls', attempts: 5 });
  expect(result.text).toContain('the calls weren’t making progress');
  expect(result.interruption?.detail).toContain('configured escalation limit reached');
  expect(result.text).not.toContain('checks');
  expect(result.text).toContain('ask for a smaller concrete change');
});

it('does not claim a denied shell command executed or changed files', async () => {
  const f = await setup();
  const server = await mockServer((_body, req, res) => {
    if (req.url?.endsWith('/models')) res.end('{}');
    else completion(res, { tool: { name: 'bash', arguments: { command: 'echo denied' } } });
  }); cleanup.push(server.close);
  f.config.routingMode = 'direct'; f.config.models.capable.baseUrl = server.url;
  const result = await runHost(f.config, { cwd: f.cwd, workload: 'coder', prompt: 'Run a command' }, { approve: async () => false });
  expect(result.status).toBe('approval_denied');
  expect(result.interruption).toMatchObject({ shellRan: false, edits: [] });
  expect(result.text).not.toContain('commands ran');
  expect(result.text).not.toContain('edits to');
});
