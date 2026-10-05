import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import ignore from 'ignore';
import { runAttempt } from '../src/agents/run.js';
import { workspace, type ConversationWorkspace } from '../src/agents/workspace.js';
import { pictures } from '../src/discord/files.js';
import { canvasLibrary, imageInfo } from '../src/discord/images.js';
import type { MessagePayload } from '../src/discord/play/render.js';
import { PlayRuntime, type PlayInteraction, type PlaySurface } from '../src/discord/play/runtime.js';
import { PlayStore } from '../src/discord/play/store.js';
import { ExecutionPolicy, type Approval } from '../src/execution/policy.js';
import { SpendGovernor } from '../src/inference/budget.js';
import { Telemetry } from '../src/telemetry/outcome.js';
import type { RunOptions, WorkspaceSandbox } from '../src/workspace/sandbox.js';
import { receiveFiles } from '../src/workspace/attach.js';
import { ensureRepository } from '../src/workspace/git.js';
import { fileLimits, WorkspaceStore } from '../src/workspace/store.js';
import { TerminalWorkspace } from '../src/workspace/terminal.js';
import { pandocAsset, pythonAbi } from '../src/workspace/toolchain.js';
import { completion, fixture, mockServer } from './helpers.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const owner = { id: '111111111111111111', name: 'owner' };

async function directory(prefix: string) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
/** A small PNG: red on the left half, blue on the right. */
async function png(width = 40, height = 20): Promise<Buffer> {
  const { createCanvas } = await canvasLibrary();
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ff0000'; context.fillRect(0, 0, width / 2, height);
  context.fillStyle = '#0000ff'; context.fillRect(width / 2, 0, width / 2, height);
  return canvas.encode('png');
}
async function pixel(data: Buffer, x: number, y: number): Promise<number[]> {
  const { createCanvas, loadImage } = await canvasLibrary();
  const image = await loadImage(data);
  const canvas = createCanvas(image.width, image.height);
  canvas.getContext('2d').drawImage(image, 0, 0);
  return [...canvas.getContext('2d').getImageData(x, y, 1, 1).data];
}

/** A sandbox that runs nothing: `handler` plays the command's part against the workspace folder. */
function fakeSandbox(handler: (folder: string, command: string, options: RunOptions) => Promise<string | void> = async () => undefined, available = true): WorkspaceSandbox & { commands: string[] } {
  const commands: string[] = [];
  return {
    commands,
    status: async () => available ? { available, shell: 'bash', tools: [{ name: 'magick', kind: 'imagemagick', version: '7.1.2' }, { name: 'python3', kind: 'python', version: '3.12.3' }] } : { available, reason: 'the sandbox is not installed', shell: 'bash', tools: [] },
    run: async (folder, command, options) => {
      commands.push(command);
      // Output reaches the shell tool as it arrives, as the real sandbox sends it.
      const output = await handler(folder, command, options) ?? '';
      if (output) options.tee?.(output);
      return { exitCode: 0, output, timedOut: false, cancelled: false };
    },
  };
}

it('keeps files per conversation by safe names, with image sizes, replacing a file saved under the same name', async () => {
  const store = WorkspaceStore.at(await directory('teapilot-workspace-'));
  const saved = await store.save('dm:1', '../evil/tree photo.png', await png(), 'op', 'image/png');
  expect(saved).toMatchObject({ name: 'tree_photo.png', type: 'image/png', width: 40, height: 20, from: 'op' });
  await store.save('dm:1', 'notes.txt', Buffer.from('hello'), 'op');
  expect(store.list('dm:2')).toEqual([]);
  expect(store.list('dm:1').map(file => file.name)).toEqual(['tree_photo.png', 'notes.txt']);
  await store.save('dm:1', 'notes.txt', Buffer.from('hello again'), 'teapilot');
  expect(store.read('dm:1', 'notes.txt')?.data.toString()).toBe('hello again');
  expect(store.list('dm:1')).toHaveLength(2);
  expect(await imageInfo(Buffer.from('not an image'))).toBeUndefined();
});

it('keeps incoming files in the scratchpad without replacing workspace files or earlier attachments', async () => {
  const state = await directory('teapilot-workspace-');
  const store = WorkspaceStore.at(state);
  await store.save('dm:1', 'notes.txt', Buffer.from('workspace original'), 'teapilot');
  const incoming = (text: string) => ({ name: 'notes.txt', size: text.length, type: 'text/plain', data: async () => Buffer.from(text) });
  const first = await receiveFiles(store, 'dm:1', [incoming('first')], 'op', 5000);
  const second = await receiveFiles(store, 'dm:1', [incoming('second')], 'user', 5000);
  expect(first).toContain('Attached file .scratch/user-attachments/notes.txt');
  expect(second).toContain('Attached file .scratch/user-attachments/notes-1.txt');
  expect(store.read('dm:1', 'notes.txt')?.data.toString()).toBe('workspace original');
  expect(store.read('dm:1', '.scratch/user-attachments/notes.txt')?.data.toString()).toBe('first');
  expect(store.read('dm:1', '.scratch/user-attachments/notes-1.txt')?.data.toString()).toBe('second');
  await store.reconcile('dm:1');
  const restarted = WorkspaceStore.at(state);
  expect(restarted.get('dm:1', '.scratch/user-attachments/notes-1.txt')).toMatchObject({ from: 'user', type: 'text/plain', size: 6 });
  expect(restarted.tree('dm:1')).toContain('user-attachments/');
});

it('avoids sanitized, case-insensitive and unindexed attachment name clashes, including folders', async () => {
  const store = WorkspaceStore.at(await directory('teapilot-workspace-'));
  store.folder('dm:1');
  const attachments = join(store.scratch('dm:1'), 'user-attachments');
  await mkdir(attachments, { recursive: true });
  await writeFile(join(attachments, 'NOTES_file.txt'), 'unindexed');
  await mkdir(join(attachments, 'notes_file-1.txt'));
  const saved = await store.saveAttachment('dm:1', '../notes file.txt', Buffer.from('new'), 'op');
  const next = await store.saveAttachment('dm:1', 'notes?file.txt', Buffer.from('next'), 'op');
  expect(saved.name).toBe('.scratch/user-attachments/notes_file-2.txt');
  expect(next.name).toBe('.scratch/user-attachments/notes_file-3.txt');
  expect(await readFile(join(attachments, 'NOTES_file.txt'), 'utf8')).toBe('unindexed');
  expect(store.safePath('dm:1', saved.name)).toBe(join(attachments, 'notes_file-2.txt'));
});

it('keeps concurrent attachments under distinct names, including files without extensions', async () => {
  const store = WorkspaceStore.at(await directory('teapilot-workspace-'));
  const saved = await Promise.all(['first', 'second', 'third'].map(text => store.saveAttachment('dm:1', 'notes', Buffer.from(text), 'op')));
  expect(saved.map(file => file.name)).toEqual(['.scratch/user-attachments/notes', '.scratch/user-attachments/notes-1', '.scratch/user-attachments/notes-2']);
  expect(saved.map(file => store.read('dm:1', file.name)?.data.toString())).toEqual(['first', 'second', 'third']);
  expect(store.list('dm:1')).toHaveLength(3);
});

it.each(['.scratch', '.scratch/user-attachments'])('refuses an attachment folder linked outside the workspace at %s', async path => {
  const store = WorkspaceStore.at(await directory('teapilot-workspace-'));
  const outside = await directory('teapilot-outside-');
  await writeFile(join(outside, 'notes.txt'), 'host original');
  const folder = store.folder('dm:1');
  if (path.includes('/')) await mkdir(store.scratch('dm:1'));
  await symlink(outside, join(folder, path), 'junction');
  await expect(store.saveAttachment('dm:1', 'notes.txt', Buffer.from('new'), 'op')).rejects.toThrow('not a folder in the scratchpad');
  expect(await readFile(join(outside, 'notes.txt'), 'utf8')).toBe('host original');
  expect(store.list('dm:1')).toEqual([]);
});

it('keeps attachments when workspace files are cleared, and removes them with the scratchpad', async () => {
  const store = WorkspaceStore.at(await directory('teapilot-workspace-'));
  await store.save('dm:1', 'result.txt', Buffer.from('result'), 'teapilot');
  const attachment = await store.saveAttachment('dm:1', 'tree.png', await png(), 'op');
  store.arrive('dm:1', attachment.name);
  expect(await store.clearFiles('dm:1')).toBe(1);
  expect(store.list('dm:1')).toEqual([expect.objectContaining({ name: attachment.name })]);
  expect(store.read('dm:1', attachment.name)?.file.width).toBe(40);
  await store.clearScratch('dm:1');
  expect(store.list('dm:1')).toEqual([]);
  expect(store.takeImages('dm:1')).toEqual([]);
  expect(existsSync(store.scratch('dm:1'))).toBe(false);
});

it('records what a command made, changed and removed, leaving packages and caches unlisted', async () => {
  const store = WorkspaceStore.at(await directory('teapilot-workspace-'));
  await store.save('dm:1', 'tree.png', await png(), 'op');
  await store.save('dm:1', 'old.txt', Buffer.from('old'), 'op');
  const folder = store.folder('dm:1');
  const before = await store.snapshot('dm:1');
  await writeFile(join(folder, 'turned.png'), await png(20, 40));
  await mkdir(join(folder, 'frames'), { recursive: true });
  await writeFile(join(folder, 'frames', 'one.txt'), 'frame');
  await mkdir(join(folder, '.packages', 'lib'), { recursive: true });
  await writeFile(join(folder, '.packages', 'lib', 'six.py'), '# six');
  await mkdir(join(folder, 'node_modules', 'left-pad'), { recursive: true });
  await writeFile(join(folder, 'node_modules', 'left-pad', 'index.js'), '');
  await writeFile(join(folder, 'tree.png'), await png(10, 10));
  await rm(join(folder, 'old.txt'));
  const changes = await store.reconcile('dm:1', before);
  expect(changes.added.map(file => file.name).sort()).toEqual(['frames/one.txt', 'turned.png']);
  expect(changes.added.find(file => file.name === 'turned.png')).toMatchObject({ from: 'teapilot', width: 20, height: 40 });
  expect(changes.changed).toEqual([expect.objectContaining({ name: 'tree.png', width: 10, from: 'teapilot' })]);
  expect(changes.removed).toEqual(['old.txt']);
  expect(store.list('dm:1').map(file => file.name).sort()).toEqual(['frames/one.txt', 'tree.png', 'turned.png']);
  // A bare name reaches a file in a subfolder when it is the only one.
  expect(store.read('dm:1', 'one.txt')?.data.toString()).toBe('frame');
});

it('never reads through a link a command planted, and removes what an oversized command made', async () => {
  const root = await directory('teapilot-workspace-');
  const store = new WorkspaceStore(join(root, 'workspaces'), join(root, 'index'), undefined, { ...fileLimits, workspaceBytes: 4096 });
  const secret = join(root, 'secret.txt');
  await writeFile(secret, 'host secret');
  const folder = store.folder('dm:1');
  await link(secret, join(folder, 'linked.txt'));
  await store.reconcile('dm:1');
  expect(store.list('dm:1')).toEqual([]);
  expect(store.safePath('dm:1', 'linked.txt')).toBeUndefined();
  await rm(join(folder, 'linked.txt'));

  await store.save('dm:1', 'small.txt', Buffer.from('kept'), 'op');
  const before = await store.snapshot('dm:1');
  await writeFile(join(folder, 'huge.bin'), Buffer.alloc(8192));
  const changes = await store.reconcile('dm:1', before);
  expect(changes.overQuota?.dropped).toEqual(['huge.bin']);
  expect(existsSync(join(folder, 'huge.bin'))).toBe(false);
  expect(store.list('dm:1').map(file => file.name)).toEqual(['small.txt']);
});

it('moves a conversation\'s files from before workspaces into its workspace, keeping who shared them', async () => {
  const state = await directory('teapilot-workspace-');
  const old = join(state, 'discord-files', createHash('sha256').update('thread:9').digest('hex').slice(0, 24));
  await mkdir(old, { recursive: true });
  await writeFile(join(old, 'cat.png'), await png());
  await writeFile(join(old, 'index.json'), JSON.stringify([{ name: 'cat.png', size: 10, type: 'image/png', width: 40, height: 20, from: 'op', at: 1 }]));
  const store = WorkspaceStore.at(state);
  expect(store.list('thread:9')).toEqual([expect.objectContaining({ name: 'cat.png', from: 'op' })]);
  expect(existsSync(join(store.folder('thread:9'), 'cat.png'))).toBe(true);
  expect(existsSync(old)).toBe(false);
  expect(existsSync(join(store.folder('thread:9'), 'index.json'))).toBe(false);
  expect(store.list('thread:9')).toEqual([expect.objectContaining({ name: 'cat.png', from: 'op' })]);
});

const rotator = `
import { app, button, row, embed, picture } from '@teapilot/discord-play';
export default app({
  init: () => ({ angle: 0, grey: false }),
  update: (state, action) => action.id === 'turn' ? { ...state, angle: (state.angle + 90) % 360 } : action.id === 'grey' ? { ...state, grey: !state.grey } : state,
  view: state => ({ embeds: [embed({ title: 'Tree', image: picture('tree.png', { rotate: state.angle, greyscale: state.grey }) })], rows: [row(button('turn', 'Turn'), button('grey', 'Grey'))] }),
});`;

async function playSetup(files: WorkspaceStore) {
  const posts: MessagePayload[] = [];
  const surface: PlaySurface = { post: vi.fn(async (_channel, payload) => { posts.push(payload); return 'm1'; }), edit: vi.fn(), request: vi.fn() };
  const runtime = new PlayRuntime({ store: new PlayStore(await directory('teapilot-play-')), surface, log: vi.fn(), pictures: pictures(files), discordEditMs: 0 });
  cleanups.push(() => runtime.close());
  return { runtime, posts };
}

it('shows picture() as an attachment the embed refers to, rendered again as the app changes', async () => {
  const files = WorkspaceStore.at(await directory('teapilot-workspace-'));
  await files.save('dm:1', 'tree.png', await png(), 'op');
  const { runtime, posts } = await playSetup(files);
  const { record, preview } = await runtime.start({ title: 'Tree', channelId: 'c1', conversation: 'dm:1', owner, source: { kind: 'sandbox', code: rotator } });
  expect(preview).toContain('image: tree.png {"rotate":0,"greyscale":false}');
  const first = posts[0]!;
  expect(first.pictures).toBeUndefined();
  expect(first.files).toHaveLength(1);
  expect((first.embeds[0] as { image: { url: string } }).image.url).toBe(`attachment://${first.files![0]!.name}`);
  expect(await pixel(first.files![0]!.data, 0, 0)).toEqual([255, 0, 0, 255]);

  const updates: MessagePayload[] = [];
  const click = (id: string): PlayInteraction => ({ playId: record.id, controlId: id, kind: 'button', user: owner, messageId: 'm1',
    openModal: vi.fn(), reply: vi.fn(), defer: vi.fn(async () => undefined), update: vi.fn(async payload => { updates.push(payload); }), followUp: vi.fn() });
  await runtime.interact(click('turn'));
  await vi.waitFor(() => expect(updates).toHaveLength(1));
  await runtime.interact(click('grey'));
  await vi.waitFor(() => expect(updates).toHaveLength(2));
  const turned = updates[0]!.files![0]!, grey = updates[1]!.files![0]!;
  expect(turned.name).not.toBe(first.files![0]!.name);
  const { loadImage } = await canvasLibrary();
  expect((await loadImage(turned.data)).width).toBe(20);
  const [r, g, b] = await pixel(grey.data, 5, 5);
  expect(r).toBe(g); expect(g).toBe(b);
});

it('rejects an app whose picture() names no image here, listing the images there are', async () => {
  const files = WorkspaceStore.at(await directory('teapilot-workspace-'));
  await files.save('dm:1', 'cat.png', await png(), 'op');
  const { runtime } = await playSetup(files);
  await expect(runtime.start({ title: 'Tree', channelId: 'c1', conversation: 'dm:1', owner, source: { kind: 'sandbox', code: rotator } }))
    .rejects.toThrow(/picture\("tree.png"\): no file by that name here\. Images here: cat\.png/);
  await expect(runtime.start({ title: 'Tree', channelId: 'c1', conversation: 'dm:1', owner, source: { kind: 'sandbox', code: rotator.replace("rotate: state.angle", "rotate: state.angle, filter: 'rm -rf'") } }))
    .rejects.toThrow(/CSS filter functions/);
});

async function agentSetup(handler: Parameters<typeof mockServer>[0], sandbox: WorkspaceSandbox = fakeSandbox()) {
  const f = await fixture(); cleanups.push(f.cleanup);
  const server = await mockServer(handler); cleanups.push(server.close);
  Object.assign(f.config.models.capable, { provider: 'ollama', baseUrl: server.url });
  const telemetry = new Telemetry(f.config.stateDir, 'files-test');
  await telemetry.event('start', {});
  const budget = new SpendGovernor(join(f.config.stateDir, 'spend.jsonl'), 'files-test', f.config.policy.budget);
  const store = WorkspaceStore.at(await directory('teapilot-workspace-'));
  const sent: Array<{ text: string; files: Array<{ name: string; data: Buffer }> }> = [];
  const shared: ConversationWorkspace = { store, conversation: 'dm:1', sandbox, delivery: 'post', send: async (text, uploads) => { sent.push({ text, files: uploads }); } };
  const { runtime, posts } = await playSetup(store);
  const play = { runtime, channelId: 'c1', conversation: 'dm:1', owner, files: shared };
  const approvals: Approval[] = [];
  return { ...f, budget, telemetry, store, sent, runtime, posts, play, workspace: shared, approvals,
    base: { tier: 'normal' as const, workload: 'ask' as const, web: false, approve: async (approval: Approval) => { approvals.push(approval); return true; } } };
}

it('writes a script, runs it with the sandboxed shell, then posts what it made', async () => {
  const bodies: any[] = [];
  const script = 'from PIL import Image\nImage.open("leaves.png").transpose(Image.FLIP_LEFT_RIGHT).rotate(90, expand=True).save("leaves-turned.png")\n';
  const steps = [
    { tool: { name: 'write', arguments: { path: 'turn.py', content: script } } },
    { tool: { name: 'bash', arguments: { command: 'python3 turn.py' } } },
    { tool: { name: 'file_send', arguments: { file: 'leaves-turned.png' } } },
    { text: 'Here you go.' },
  ];
  const sandbox = fakeSandbox(async folder => { await copyFile(join(folder, 'leaves.png'), join(folder, 'leaves-turned.png')); return 'turned'; });
  const f = await agentSetup((body, _req, res) => { bodies.push(body); completion(res, steps[bodies.length - 1]!); }, sandbox);
  await f.store.save('dm:1', 'leaves.png', await png(), 'op');
  const result = await runAttempt({ ...f, ...f.base, prompt: 'flip it and turn it 90 degrees', activePermissions: ['inference'], play: f.play, workspace: f.workspace });
  expect(result.success, JSON.stringify(result)).toBe(true);
  const names = (bodies[0].tools ?? []).map((tool: any) => tool.function.name);
  expect(names).toEqual(expect.arrayContaining(['read', 'write', 'edit', 'ls', 'find', 'grep', 'bash', 'file_send']));
  expect(names).not.toContain('workspace_run');
  const instructions = JSON.stringify(bodies[0].messages);
  expect(instructions).toContain('leaves.png (PNG image 40×20');
  expect(instructions).toContain('Installed: magick 7.1.2, python3 3.12.3');
  expect(instructions).toContain('Use write only for new files or complete rewrites.');
  expect(sandbox.commands).toEqual(['python3 turn.py']);
  expect(f.store.read('dm:1', 'turn.py')?.data.toString()).toContain('FLIP_LEFT_RIGHT');
  const ran = JSON.stringify(bodies[2].messages);
  expect(ran).toContain('turned');
  expect(ran).toContain('New files: leaves-turned.png (PNG image 40×20');
  expect(f.sent.map(entry => entry.files.map(file => file.name))).toEqual([['leaves-turned.png']]);
});

it('gives every tool the workspace as its root, so an edited script is the one that runs next', async () => {
  const bodies: any[] = [];
  const steps = [
    { tool: { name: 'write', arguments: { path: 'scene.py', content: 'print("old")\n' } } },
    { tool: { name: 'bash', arguments: { command: 'python3 scene.py' } } },
    { tool: { name: 'edit', arguments: { path: 'scene.py', edits: [{ oldText: 'print("old")', newText: 'print("new")' }] } } },
    { tool: { name: 'bash', arguments: { command: 'python3 scene.py' } } },
    { tool: { name: 'write', arguments: { path: '.scratch/notes.md', content: 'the scene works' } } },
    { tool: { name: 'write', arguments: { path: 'credits.txt', content: 'made by teapilot' } } },
    { tool: { name: 'ls', arguments: {} } },
    { tool: { name: 'file_send', arguments: { files: ['credits.txt'] } } },
    { text: 'Done.' },
  ];
  const sandbox = fakeSandbox(async folder => `ran ${(await readFile(join(folder, 'scene.py'), 'utf8')).trim()}`);
  const f = await agentSetup((body, _req, res) => { bodies.push(body); completion(res, steps[bodies.length - 1]!); }, sandbox);
  // As in Discord: the workspace is under teapilot's state folder, and the scratchpad is its .scratch folder.
  const store = WorkspaceStore.at(f.config.stateDir);
  const workspace = { ...f.workspace, store };
  const shown: unknown[] = [];
  const result = await runAttempt({ ...f, ...f.base, prompt: 'make a scene', activePermissions: ['inference'], workspace, scratch: store.scratch('dm:1'),
    onEvent: event => { if (event.type === 'tool_execution_end') shown.push(event.path); } });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(JSON.stringify(bodies[0].messages)).toContain('read, write, edit, ls, find and grep take workspace file names');
  expect(JSON.stringify(bodies[4].messages)).toContain('ran print(\\"new\\")');
  expect(await readFile(join(store.scratch('dm:1'), 'notes.md'), 'utf8')).toBe('the scene works');
  // Workspace and scratchpad files can be browsed and sent.
  expect(store.list('dm:1').map(file => file.name)).toEqual(expect.arrayContaining(['scene.py', 'credits.txt', '.scratch/notes.md']));
  expect(f.sent.map(entry => entry.files.map(file => file.name))).toEqual([['credits.txt']]);
  expect(JSON.stringify(bodies[7].messages.at(-1))).toContain('scene.py');
  // Nothing asked anyone, and changed files read as workspace names (scratchpad writes are shown without one).
  expect(f.approvals).toEqual([]);
  expect(shown.filter(Boolean)).toEqual(['scene.py', 'scene.py', 'credits.txt']);
  expect(result.changedFiles).toEqual(['scene.py', 'credits.txt']);
});

it('asks once before a command reaches a package registry, and remembers the answer for the conversation', async () => {
  const hosts: boolean[] = [];
  const sandbox = fakeSandbox(async (_folder, _command, options) => {
    hosts.push(await options.network('pypi.org'), await options.network('files.pythonhosted.org'));
    return 'Successfully installed six';
  });
  const f = await agentSetup(() => undefined, sandbox);
  const run = (await workspace(f.workspace, f.base.approve, true)).shell!;
  await run.execute('one', { command: 'pip install six' });
  expect(hosts).toEqual([true, true]);
  expect(f.approvals).toEqual([expect.objectContaining({ kind: 'network', details: 'pip install six', summary: expect.stringContaining('pypi.org and files.pythonhosted.org') })]);
  expect(f.store.domains('dm:1')).toEqual(['pypi.org', 'files.pythonhosted.org']);
  await run.execute('two', { command: 'pip install six' });
  expect(f.approvals).toHaveLength(1);

  // A refusal is reported, so the model does not retry.
  const refusing = await workspace({ ...f.workspace, conversation: 'dm:2' }, async () => false, true);
  const refused = await refusing.shell!.execute('three', { command: 'pip install six' });
  expect(JSON.stringify(refused.content)).toContain('pypi.org and files.pythonhosted.org was not approved');
});

it('asks once for a YouTube download, whichever video servers it reaches', async () => {
  const hosts: boolean[] = [];
  let later = false;
  const sandbox = fakeSandbox(async (_folder, _command, options) => {
    if (later) { hosts.push(await options.network('rr5---sn-abc.googlevideo.com'), await options.network('googlevideo.com.evil.example')); return ''; }
    await options.network('www.youtube.com');
    await options.network('rr3---sn-4g5e6nsz.googlevideo.com');
    return 'Downloaded';
  });
  const f = await agentSetup(() => undefined, sandbox);
  await (await workspace(f.workspace, f.base.approve, true)).shell!.execute('one', { command: 'yt-dlp -x URL' });
  expect(f.approvals).toHaveLength(1);
  expect(f.store.domains('dm:1')).toContain('*.googlevideo.com');
  // Another server under an approved name needs no new question; an unrelated look-alike does.
  later = true;
  const again = await workspace(f.workspace, async approval => { f.approvals.push(approval); return false; }, true);
  await again.shell!.execute('two', { command: 'yt-dlp URL' });
  expect(hosts).toEqual([true, false]);
  expect(f.approvals).toHaveLength(2);
});

it('reports a failing command with its output and what it changed, and a long one with how to give it more time', async () => {
  let exitCode = 2;
  const sandbox: WorkspaceSandbox = {
    status: async () => ({ available: true, shell: 'bash', tools: [] }),
    run: async (folder, _command, options) => {
      options.tee?.('Traceback: boom\n');
      await writeFile(join(folder, 'half.png'), 'x');
      return { exitCode, output: '', timedOut: exitCode === 124, cancelled: false };
    },
  };
  const f = await agentSetup(() => undefined, sandbox);
  const shell = (await workspace(f.workspace, f.base.approve, true)).shell!;
  await expect(shell.execute('one', { command: 'python3 x.py' })).rejects.toThrow(/Traceback: boom[\s\S]*exited with code 2[\s\S]*New files: half\.png/);
  exitCode = 124;
  await expect(shell.execute('two', { command: 'python3 x.py', timeout: 5 })).rejects.toThrow(/timed out after 5 seconds\. Pass a longer timeout \(up to 300\)/);
});

it('without a sandbox, keeps and sends files but says commands cannot run', async () => {
  const f = await agentSetup(() => undefined, fakeSandbox(undefined, false));
  const setup = await workspace(f.workspace, f.base.approve, true);
  expect(setup.tools.map(tool => tool.name)).toEqual(['file_send']);
  expect(setup.shell).toBeUndefined();
  expect(setup.systemPrompt).toContain('Commands cannot run here (the sandbox is not installed)');
});

it('makes a workspace a git repository once, committing as the orchestrator or a junior', async () => {
  const runs: Array<{ command: string; author?: string }> = [];
  const base = fakeSandbox(async (folder, command, options) => {
    runs.push({ command, author: options.env?.GIT_AUTHOR_NAME });
    if (command.startsWith('git init')) await mkdir(join(folder, '.git'));
  });
  const sandbox = { ...base, status: async () => ({ available: true, shell: 'bash' as const, tools: [{ name: 'git', kind: 'git', version: '2.45.1' }] }) };
  const f = await agentSetup(() => undefined, sandbox);
  await f.store.save('dm:1', 'README.md', Buffer.from('mine'), 'op');
  const setup = await workspace(f.workspace, f.base.approve, true);
  const folder = f.store.folder('dm:1');
  expect(runs).toEqual([{ command: expect.stringMatching(/^git init/), author: 'teapilot' }]);
  // A README someone shared stays theirs; the session's transcripts are never committed.
  expect(await readFile(join(folder, 'README.md'), 'utf8')).toBe('mine');
  expect(await readFile(join(folder, 'AGENTS.md'), 'utf8')).toBe(await readFile(new URL('../src/workspace/template/AGENTS.txt', import.meta.url), 'utf8'));
  const rules = (await readFile(join(folder, '.gitignore'), 'utf8')).split('\n');
  expect(rules).toContain('/.scratch/sessions/');
  expect(rules).toContain('/.scratch/juniors/*/sessions/');
  expect(rules).not.toContain('.scratch/');
  const matcher = ignore().add(rules);
  for (const name of ['.scratch/sessions/main.jsonl', '.scratch/juniors/junior-alfa/sessions/turn.jsonl']) expect(matcher.ignores(name)).toBe(true);
  for (const name of ['.scratch/utilities/tool.py', '.scratch/plans/plan.md', '.scratch/juniors/junior-alfa/notes.md']) expect(matcher.ignores(name)).toBe(false);
  await writeFile(join(folder, '.gitignore'), '.scratch/\ncustom/\n');
  expect(setup.systemPrompt).toContain('git repo, committing as teapilot-orchestrator');
  expect(setup.systemPrompt).toContain('read and follow AGENTS.md');
  expect(setup.systemPrompt).not.toMatch(/not after every task|commit regularly|untidy|read git log/);
  await setup.shell!.execute('one', { command: 'git commit -am x' });
  const junior = await workspace(f.workspace, f.base.approve, true, undefined, false, 'tea-junior-alfa');
  await junior.shell!.execute('two', { command: 'git log' });
  expect(runs.slice(1)).toEqual([{ command: 'git commit -am x', author: 'teapilot-orchestrator' }, { command: 'git log', author: 'tea-junior-alfa' }]);
  expect(junior.systemPrompt).toContain('committing as tea-junior-alfa');
  expect(await readFile(join(folder, '.gitignore'), 'utf8')).toBe('.scratch/\ncustom/\n');
});

it.each([false, true])('seeds concise workspace docs without resetting them (existing repository: %s)', async existing => {
  const folder = await directory('teapilot-workspace-docs-');
  if (existing) await mkdir(join(folder, '.git'));
  const sandbox = fakeSandbox(async folder => { await mkdir(join(folder, '.git'), { recursive: true }); });
  const status = { available: true, shell: 'bash' as const, tools: [{ name: 'git', kind: 'git', version: '2.45.1' }] };
  expect(await ensureRepository(folder, sandbox, status)).toBe(true);
  const readme = await readFile(join(folder, 'README.md'), 'utf8');
  const agents = await readFile(join(folder, 'AGENTS.md'), 'utf8');
  expect(readme).toBe(await readFile(new URL('../src/workspace/template/README.txt', import.meta.url), 'utf8'));
  expect(agents).toBe(await readFile(new URL('../src/workspace/template/AGENTS.txt', import.meta.url), 'utf8'));
  expect(sandbox.commands).toHaveLength(existing ? 0 : 1);
  await writeFile(join(folder, 'README.md'), 'custom workspace overview\n');
  await writeFile(join(folder, 'AGENTS.md'), 'custom workspace instructions\n');
  expect(await ensureRepository(folder, sandbox, status)).toBe(true);
  expect(await readFile(join(folder, 'README.md'), 'utf8')).toBe('custom workspace overview\n');
  expect(await readFile(join(folder, 'AGENTS.md'), 'utf8')).toBe('custom workspace instructions\n');
  expect(sandbox.commands).toHaveLength(existing ? 0 : 1);
});

it.each([false, true])('preserves existing instructions on first initialization (custom README: %s)', async customReadme => {
  const folder = await directory('teapilot-workspace-docs-');
  await writeFile(join(folder, 'AGENTS.md'), 'my rules\n');
  if (customReadme) await writeFile(join(folder, 'README.md'), 'my overview\n');
  const sandbox = fakeSandbox(async folder => { await mkdir(join(folder, '.git')); });
  const status = { available: true, shell: 'bash' as const, tools: [{ name: 'git', kind: 'git', version: '2.45.1' }] };
  expect(await ensureRepository(folder, sandbox, status)).toBe(true);
  expect(await readFile(join(folder, 'AGENTS.md'), 'utf8')).toBe('my rules\n');
  if (customReadme) expect(await readFile(join(folder, 'README.md'), 'utf8')).toBe('my overview\n');
});

it.each(['stock', 'customized', 'existing instructions'])('migrates only the untouched legacy workspace README (%s)', async variant => {
  const folder = await directory('teapilot-workspace-docs-');
  await mkdir(join(folder, '.git'));
  const legacy = `# workspace

this folder is a git repo and you (teapilot) own it. files people attach land here too.

- commit after each meaningful step - small commits are easy to roll back
- messages: a short imperative subject, plus a line of why when it isn't obvious
- tag milestones people may want back (\`git tag first-draft\`)
- \`git log --oneline\` and \`git diff\` show what was done before - check them when picking work back up
- juniors commit under their own names (tea-junior-*) - read their commits before building on them
`;
  const original = legacy + (variant === 'customized' ? '\nmy notes\n' : '');
  await writeFile(join(folder, 'README.md'), original);
  if (variant === 'existing instructions') await writeFile(join(folder, 'AGENTS.md'), 'my rules\n');
  const sandbox = fakeSandbox();
  const status = await sandbox.status();
  expect(await ensureRepository(folder, sandbox, status)).toBe(true);
  const readme = await readFile(join(folder, 'README.md'), 'utf8');
  if (variant === 'customized') expect(readme).toBe(original);
  else {
    expect(readme).toBe(await readFile(new URL('../src/workspace/template/README.txt', import.meta.url), 'utf8'));
  }
  const agents = await readFile(join(folder, 'AGENTS.md'), 'utf8');
  if (variant === 'existing instructions') expect(agents).toBe('my rules\n');
  else expect(agents).toBe(await readFile(new URL('../src/workspace/template/AGENTS.txt', import.meta.url), 'utf8'));
  expect(await ensureRepository(folder, sandbox, status)).toBe(true);
  expect(await readFile(join(folder, 'README.md'), 'utf8')).toBe(readme);
  expect(await readFile(join(folder, 'AGENTS.md'), 'utf8')).toBe(agents);
  expect(sandbox.commands).toHaveLength(0);
});

it('leaves a workspace without git as it is', async () => {
  const f = await agentSetup(() => undefined);
  const setup = await workspace(f.workspace, f.base.approve, true);
  expect(existsSync(join(f.store.folder('dm:1'), '.gitignore'))).toBe(false);
  expect(existsSync(join(f.store.folder('dm:1'), 'README.md'))).toBe(false);
  expect(existsSync(join(f.store.folder('dm:1'), 'AGENTS.md'))).toBe(false);
  expect(setup.systemPrompt).not.toContain('git repo');
});

it('in a repository keeps only file_send, sending repository files by path with none of the workspace around it', async () => {
  const f = await agentSetup(() => undefined);
  const repo = await directory('teapilot-repo-');
  await writeFile(join(repo, 'notes.txt'), 'hello');
  await f.store.save('dm:1', 'elsewhere.txt', Buffer.from('workspace file'), 'op');
  f.config.policy.permissions = ['inference', 'repository.read'];
  const setup = await workspace(f.workspace, f.base.approve, false, new ExecutionPolicy(repo, f.config, f.base.approve));
  expect(setup.tools.map(tool => tool.name)).toEqual(['file_send']);
  expect(setup.shell).toBeUndefined();
  expect(setup.systemPrompt).not.toMatch(/workspace|elsewhere\.txt/);
  const send = setup.tools[0]!;
  await send.execute('one', { files: ['notes.txt'], caption: 'here' });
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]!.files.map(file => [file.name, file.data.toString()])).toEqual([['notes.txt', 'hello']]);
  // The workspace is not reachable from here, and neither is anything the repository's tools cannot read.
  for (const files of [['elsewhere.txt'], ['../notes.txt'], ['.workspace/elsewhere.txt']]) {
    expect(JSON.stringify(await send.execute('two', { files }))).toContain('Cannot send');
  }
  expect(f.sent).toHaveLength(1);
});

it('runs an app from its workspace file, and changes it with an edit to that file rather than a new copy', async () => {
  const bodies: any[] = [];
  const game = `// chairs 🪑 block you
import { app, button, row } from '@teapilot/discord-play';
export default app({ init: () => 0, update: n => n + 1, view: n => ({ content: '🪑 ' + n, rows: [row(button('go', 'Go'))] }) });`;
  const steps = [
    { tool: { name: 'play_start', arguments: { file: 'apps/game.js', title: 'Game' } } },
    { tool: { name: 'write', arguments: { path: 'apps/game.js', content: game } } },
    { tool: { name: 'play_start', arguments: { file: 'apps/game.js', title: 'Game' } } },
    { tool: { name: 'play_start', arguments: { file: 'apps/game.js', title: 'Game' } } },
    { tool: { name: 'play_update', arguments: {} } },
    { tool: { name: 'edit', arguments: { path: 'apps/game.js', edits: [{ oldText: '// chairs 🪑', newText: '// chairs 🐖' }, { oldText: "'🪑 '", newText: "'🐖 '" }] } } },
    { tool: { name: 'play_update', arguments: {} } },
    { tool: { name: 'file_send', arguments: { files: ['apps/game.js'] } } },
    { text: 'Done.' },
  ];
  const f = await agentSetup((body, _req, res) => { bodies.push(body); completion(res, steps[bodies.length - 1]!); });
  const result = await runAttempt({ ...f, ...f.base, prompt: 'make a game', activePermissions: ['inference', 'discord.play'], play: f.play, workspace: f.workspace });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(JSON.stringify(bodies[0].messages)).toContain('workspace entry file: play_start({ file, title })');
  const startTool = bodies[0].tools.find((tool: any) => tool.function.name === 'play_start').function;
  expect(startTool.description).toContain('optional declared text assets');
  expect(JSON.stringify(startTool.parameters.properties.assets)).toContain('ctx.readText(name)');
  // Starting before writing is one wasted call, not a paused turn.
  expect(JSON.stringify(bodies[1].messages.at(-1))).toContain('No file named \\"apps/game.js\\" in the workspace: write the app to it first');
  expect(f.posts[0]!.content).toBe('🪑 0');
  expect(JSON.stringify(bodies[4].messages)).toContain('is already live from this turn');
  expect(f.posts).toHaveLength(1);
  expect(JSON.stringify(bodies[5].messages.at(-1))).toContain('Nothing to change: apps/game.js and its assets are the same as the running snapshot');
  const [app] = f.runtime.list('dm:1');
  expect(app).toMatchObject({ file: 'apps/game.js' });
  const source = f.runtime.source(app!.id, 'dm:1');
  expect(source.kind === 'sandbox' && source.code).toBe(game.replaceAll('🪑', '🐖'));
  const sent = f.sent[0]!.files[0]!;
  expect(sent.name).toBe('game.js');
  expect(sent.data.toString()).toBe(game.replaceAll('🪑', '🐖'));
});

it('rejects an app naming what to fix in its file, and will not run the same file again unchanged', async () => {
  const bodies: any[] = [];
  const broken = "import { app, button, row } from '@teapilot/discord-play';\nexport default app({ init: () => 0, update: n => n + 1, view: n => { throw new Error('nope'); } });";
  const steps = [
    { tool: { name: 'write', arguments: { path: 'apps/x.js', content: broken } } },
    { tool: { name: 'play_start', arguments: { file: 'apps/x.js', title: 'X' } } },
    { tool: { name: 'play_start', arguments: { file: 'apps/x.js', title: 'X' } } },
    { tool: { name: 'edit', arguments: { path: 'apps/x.js', edits: [{ oldText: "{ throw new Error('nope'); }", newText: "({ content: 'n ' + n, rows: [row(button('go', 'Go'))] })" }] } } },
    { tool: { name: 'play_start', arguments: { file: 'apps/x.js', title: 'X' } } },
    { text: 'Live.' },
  ];
  const f = await agentSetup((body, _req, res) => { bodies.push(body); completion(res, steps[bodies.length - 1]!); });
  const result = await runAttempt({ ...f, ...f.base, prompt: 'make x', activePermissions: ['inference', 'discord.play'], play: f.play, workspace: f.workspace });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(JSON.stringify(bodies[2].messages.at(-1))).toContain('Fix it with edit on apps/x.js');
  expect(JSON.stringify(bodies[3].messages.at(-1))).toContain('apps/x.js is unchanged since it was rejected');
  expect(f.posts.map(post => post.content)).toEqual(['n 0']);
});

it('holds a model to a change it claims without calling a play tool, once', async () => {
  const bodies: any[] = [];
  const f = await agentSetup((body, _req, res) => {
    bodies.push(body);
    const file = `apps/${f.runtime.list('dm:1')[0]!.id}.js`;
    const steps = [
      { text: 'Done — chairs are now pigs 🐷.' },
      { tool: { name: 'play_inspect', arguments: {} } },
      { tool: { name: 'edit', arguments: { path: file, edits: [{ oldText: "'🪑 '", newText: "'🐷 '" }] } } },
      { tool: { name: 'play_update', arguments: {} } },
      { text: 'Swapped the chairs for pigs.' },
    ];
    completion(res, steps[bodies.length - 1]!);
  });
  const code = `import { app, button, row } from '@teapilot/discord-play';
export default app({ init: () => 0, update: n => n + 1, view: n => ({ content: '🪑 ' + n, rows: [row(button('go', 'Go'))] }) });`;
  // Started before apps were files: its code is only inline, until a play tool writes it to one.
  const { record } = await f.runtime.start({ title: 'Game', channelId: 'c1', conversation: 'dm:1', owner, source: { kind: 'sandbox', code } });
  const result = await runAttempt({ ...f, ...f.base, prompt: 'replace the chairs with pigs', activePermissions: ['inference', 'discord.play'], play: f.play, workspace: f.workspace });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(JSON.stringify(bodies[1].messages)).toContain('no play_start or play_update succeeded in this turn');
  expect(JSON.stringify(bodies[2].messages.at(-1))).toContain(`Code: the workspace file apps/${record.id}.js`);
  expect(JSON.stringify(bodies[2].messages.at(-1))).not.toContain('export default');
  expect(result.text).toBe('Swapped the chairs for pigs.');
  const source = f.runtime.source(record.id, 'dm:1');
  expect(source.kind === 'sandbox' && source.code).toContain('🐷');
  expect(f.runtime.file(record.id, 'dm:1')).toBe(`apps/${record.id}.js`);
});

it('keeps a questioned answer when the turn limit leaves no room to answer again', async () => {
  const bodies: any[] = [];
  const f = await agentSetup((body, _req, res) => { bodies.push(body); completion(res, { text: 'Fixed the last two images; the TTS is still blocked.' }); });
  f.config.policy.limits.maxTurns = 1;
  const code = `import { app, button, row } from '@teapilot/discord-play';
export default app({ init: () => 0, update: n => n + 1, view: n => ({ content: 'n ' + n, rows: [row(button('go', 'Go'))] }) });`;
  await f.runtime.start({ title: 'Game', channelId: 'c1', conversation: 'dm:1', owner, source: { kind: 'sandbox', code } });
  const result = await runAttempt({ ...f, ...f.base, prompt: 'carry on with the video', activePermissions: ['inference', 'discord.play'], play: f.play, workspace: f.workspace });
  expect(bodies).toHaveLength(1);
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(result.text).toBe('Fixed the last two images; the TTS is still blocked.');
  expect(result.stopped).toBeUndefined();
});

it('answers about a running app without changing it', async () => {
  const bodies: any[] = [];
  const f = await agentSetup((body, _req, res) => { bodies.push(body); completion(res, { text: 'Press Go to count up.' }); });
  const code = `import { app, button, row } from '@teapilot/discord-play';
export default app({ init: () => 0, update: n => n + 1, view: n => ({ content: '🪑 ' + n, rows: [row(button('go', 'Go'))] }) });`;
  await f.runtime.start({ title: 'Game', channelId: 'c1', conversation: 'dm:1', owner, source: { kind: 'sandbox', code } });
  const answer = await runAttempt({ ...f, ...f.base, prompt: 'how do I play?', activePermissions: ['inference', 'discord.play'], play: f.play, workspace: f.workspace });
  expect(answer.text).toBe('Press Go to count up.');
  expect(bodies).toHaveLength(1);
});

it('reports a failed upload as not sent, rather than as Discord\'s own error', async () => {
  const store = WorkspaceStore.at(await directory('teapilot-workspace-'));
  await store.save('dm:1', 'helo.txt', Buffer.from('olleh'), 'teapilot');
  const context: ConversationWorkspace = { store, conversation: 'dm:1', send: async () => { throw new Error('This operation was aborted'); } };
  const send = (await workspace(context, async () => true, true)).tools.find(tool => tool.name === 'file_send')!;
  await expect(send.execute('call', { files: ['helo.txt'] })).rejects.toThrow(/nothing was sent.*This operation was aborted.*Do not send it again/);
});

it('sends only files that exist, so new content is written first', async () => {
  const bodies: any[] = [];
  const steps = [
    { tool: { name: 'file_send', arguments: { files: ['helo.txt'] } } },
    { tool: { name: 'write', arguments: { path: 'helo.txt', content: 'olleh' } } },
    { tool: { name: 'file_send', arguments: { files: ['helo.txt'] } } },
    { text: 'sent.' },
  ];
  const f = await agentSetup((body, _req, res) => { bodies.push(body); completion(res, steps[bodies.length - 1]!); });
  const result = await runAttempt({ ...f, ...f.base, prompt: 'reverse helo and send it back', activePermissions: ['inference'], workspace: f.workspace });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(JSON.stringify(bodies[1].messages.at(-1))).toContain('No file named \\"helo.txt\\" in the workspace. Write it first');
  expect(f.sent.map(entry => entry.files.map(file => [file.name, file.data.toString()]))).toEqual([[['helo.txt', 'olleh']]]);
});

it('copies @mentioned files into a terminal session\'s workspace and saves sent files beside the user, never over one unasked', async () => {
  const state = await directory('teapilot-workspace-');
  const cwd = await directory('teapilot-cwd-');
  await writeFile(join(cwd, 'tree.png'), await png());
  await writeFile(join(cwd, 'notes.txt'), 'buy tea');
  const store = WorkspaceStore.at(state);
  const approvals: Approval[] = [];
  const session = new TerminalWorkspace(store, fakeSandbox(), async approval => { approvals.push(approval); return false; });
  const prompt = await session.attach('turn @tree.png and read @notes.txt, but not @missing.png or @../escape.txt', cwd, 5000);
  expect(prompt).toContain('[Attached file .scratch/user-attachments/tree.png (PNG image 40×20');
  expect(prompt).toContain('buy tea');
  const context = session.context(cwd);
  expect(context.store.list(context.conversation).map(file => file.name)).toEqual(['.scratch/user-attachments/tree.png', '.scratch/user-attachments/notes.txt']);

  const told = await context.send!('', [{ name: 'tree.png', data: Buffer.from('turned') }, { name: 'new.txt', data: Buffer.from('new') }]);
  expect(approvals).toEqual([expect.objectContaining({ kind: 'overwrite' })]);
  expect(await readFile(join(cwd, 'tree-1.png'), 'utf8')).toBe('turned');
  expect(await readFile(join(cwd, 'new.txt'), 'utf8')).toBe('new');
  expect(told).toContain(join(cwd, 'tree-1.png'));

  const folder = store.folder(context.conversation);
  await session.close();
  expect(existsSync(folder)).toBe(false);
});

it('retains terminal checkpoint evidence on close and can reopen that workspace after restart', async () => {
  const state = await directory('teapilot-checkpoint-workspace-');
  const cwd = await directory('teapilot-checkpoint-cwd-');
  await writeFile(join(cwd, 'evidence.txt'), 'keep this partial evidence');
  const store = WorkspaceStore.at(state);
  const original = new TerminalWorkspace(store, fakeSandbox(), async () => false);
  await original.attach('@evidence.txt', cwd, 5000);
  const id = original.context(cwd).conversation;
  const folder = store.folder(id);
  original.retain(); await original.close();
  const restarted = new TerminalWorkspace(store, fakeSandbox(), async () => false);
  restarted.reopen(id);
  expect(restarted.context(cwd).conversation).toBe(id);
  expect(store.read(id, '.scratch/user-attachments/evidence.txt')?.data.toString()).toBe('keep this partial evidence');
  await restarted.close();
  expect(existsSync(folder)).toBe(true);
  await restarted.reset();
  expect(existsSync(folder)).toBe(false);
});

it('keeps distinct @mentioned files with the same basename and deduplicates repeated paths', async () => {
  const store = WorkspaceStore.at(await directory('teapilot-workspace-'));
  const cwd = await directory('teapilot-cwd-');
  await mkdir(join(cwd, 'other'));
  await writeFile(join(cwd, 'notes.txt'), 'first');
  await writeFile(join(cwd, 'other', 'notes.txt'), 'second');
  const session = new TerminalWorkspace(store, fakeSandbox(), async () => false);
  await session.attach('@notes.txt @other/notes.txt @notes.txt', cwd, 5000);
  const { conversation } = session.context(cwd);
  expect(store.list(conversation).map(file => file.name)).toEqual(['.scratch/user-attachments/notes.txt', '.scratch/user-attachments/notes-1.txt']);
  expect(store.read(conversation, '.scratch/user-attachments/notes.txt')?.data.toString()).toBe('first');
  expect(store.read(conversation, '.scratch/user-attachments/notes-1.txt')?.data.toString()).toBe('second');
  await session.close();
});

it('keeps teapilot\'s Python packages apart per interpreter ABI, and has a pinned pandoc for each desktop platform', () => {
  expect(pythonAbi('.cp314-win_amd64.pyd')).toBe('cp314-win_amd64');
  expect(pythonAbi('.cpython-312-x86_64-linux-gnu.so')).toBe('cpython-312-x86_64-linux-gnu');
  expect(pythonAbi('')).toBeUndefined();
  for (const [platform, arch] of [['win32', 'x64'], ['linux', 'x64'], ['linux', 'arm64'], ['darwin', 'x64'], ['darwin', 'arm64']] as const) {
    expect(pandocAsset(platform, arch)?.sha256).toMatch(/^[0-9a-f]{64}$/);
  }
  expect(pandocAsset('win32', 'arm64')).toBeUndefined();
});

it('clears a workspace\'s files but not its scratchpad or name, copies it for a fork, and lists it as a tree', async () => {
  const store = WorkspaceStore.at(await directory('teapilot-workspace-'));
  await store.saveAt('a', 'notes.txt', Buffer.from('tea'), 'op');
  await store.saveAt('a', 'src/app.js', Buffer.from('x'), 'op');
  await mkdir(store.scratch('a'), { recursive: true });
  await writeFile(join(store.scratch('a'), 'plan.md'), 'plan');
  store.rename('a', '  tea notes ');
  expect(store.name('a')).toBe('tea notes');
  expect(store.tree('a')).toBe('📂 workspace/\n├── 📝 notes.txt   3 B\n│\n└── 📂 src/\n    └── 📜 app.js  1 B');
  expect(store.tree('a', 'src')).toBe('📂 src/\n└── 📜 app.js  1 B');
  expect(store.tree('a', 'nope')).toBeUndefined();
  expect(store.folders('a')).toEqual(['src']);

  await store.copy('a', 'b');
  expect(store.list('b').map(file => file.name)).toEqual(store.list('a').map(file => file.name));
  expect(await readFile(join(store.scratch('b'), 'plan.md'), 'utf8')).toBe('plan');
  expect(store.name('b')).toBe('tea notes');

  expect(await store.clearFiles('a')).toBe(2);
  expect(store.list('a')).toEqual([]);
  expect(existsSync(join(store.folder('a'), 'src'))).toBe(false);
  expect(await readFile(join(store.scratch('a'), 'plan.md'), 'utf8')).toBe('plan');
  expect(store.name('a')).toBe('tea notes');
  expect(store.list('b')).toHaveLength(2);
});
