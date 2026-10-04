import { mkdtemp, rm, symlink, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { WorkspaceStore } from '../src/workspace/store.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

it('uses exact registered paths, rejects links and preserves file metadata without quota eviction', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workspace-editor-')); dirs.push(dir);
  const store = WorkspaceStore.at(dir);
  const one = await store.saveAt('conversation', 'src/main.js', Buffer.from('\uFEFFfirst\r\n'), 'alice');
  await store.saveAt('conversation', 'other.txt', Buffer.from('kept'), 'bob');
  expect(store.readEditable('conversation', 'MAIN.JS')).toBeUndefined();
  expect(store.readEditable('conversation', '../src/main.js')).toBeUndefined();
  const opened = store.readEditable('conversation', one.name)!;
  expect(opened.content).toBe('first\r\n');
  const saved = store.saveEditable('conversation', one.name, 'second\n', opened.revision, 'editor-user');
  expect(saved).toMatchObject({ file: { from: 'editor-user' }, content: 'second\r\n' });
  expect(saved && saved !== 'conflict' && saved.file.at).toBeGreaterThan(one.at);
  expect(store.read('conversation', 'other.txt')!.data.toString()).toBe('kept');

  const symlinkPath = join(store.folder('conversation'), 'linked.js');
  await symlink(join(store.folder('conversation'), 'src', 'main.js'), symlinkPath);
  await store.reconcile('conversation');
  expect(store.readEditable('conversation', 'linked.js')).toBeUndefined();
});

it('rejects concurrent stale revisions, invalid Unicode and active command mutations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workspace-editor-coordination-')); dirs.push(dir);
  const store = WorkspaceStore.at(dir);
  const file = await store.saveAt('conversation', 'a/main.txt', Buffer.from('old\n'), 'alice');
  const opened = store.readEditable('conversation', file.name)!;
  expect(store.saveEditable('conversation', file.name, 'bad\0text', opened.revision, 'alice')).toBeUndefined();
  expect(store.saveEditable('conversation', file.name, '\uD800', opened.revision, 'alice')).toBeUndefined();
  const release = store.beginCommand('conversation');
  expect(store.readEditable('conversation', file.name)).toBeUndefined();
  expect(store.saveEditable('conversation', file.name, 'busy', opened.revision, 'alice')).toBeUndefined();
  await expect(store.clearFiles('conversation')).rejects.toThrow('busy');
  await expect(store.copy('conversation', 'fork')).rejects.toThrow('busy');
  release();
  const first = store.saveEditable('conversation', file.name, 'one\n', opened.revision, 'alice');
  const second = store.saveEditable('conversation', file.name, 'two\n', opened.revision, 'bob');
  expect(first).not.toBeUndefined();
  expect(second).toBe('conflict');
  expect((await readFile(join(store.folder('conversation'), file.name), 'utf8'))).toBe('one\n');
});

it('sums nested quota files by full root-relative path and preserves clear/copy boundaries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workspace-editor-walk-')); dirs.push(dir);
  const store = new WorkspaceStore(join(dir, 'files'), join(dir, 'index'), undefined, { perMessage: 5, workspaceBytes: 20, listed: 40, walked: 20_000 });
  const file = await store.saveAt('conversation', 'a/main.txt', Buffer.from('12345'), 'alice');
  await mkdir(join(store.folder('conversation'), 'b'), { recursive: true });
  await writeFile(join(store.folder('conversation'), 'b/main.txt'), '12345');
  await store.reconcile('conversation');
  const opened = store.readEditable('conversation', file.name)!;
  expect(store.saveEditable('conversation', file.name, '1234567890123456', opened.revision, 'alice')).toBeUndefined();
  await expect(store.clearFiles('conversation')).resolves.toBeGreaterThan(0);
  expect(store.readEditable('conversation', file.name)).toBeUndefined();
});

it('rejects an editor save over workspace quota instead of deleting another file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workspace-editor-quota-')); dirs.push(dir);
  const store = new WorkspaceStore(join(dir, 'files'), join(dir, 'index'), undefined, { perMessage: 5, workspaceBytes: 10, listed: 40, walked: 20_000 });
  const file = await store.saveAt('conversation', 'one.txt', Buffer.from('12345'), 'alice');
  await writeFile(join(store.folder('conversation'), 'two.txt'), '12345');
  await store.reconcile('conversation');
  const opened = store.readEditable('conversation', file.name)!;
  expect(store.saveEditable('conversation', file.name, '123456', opened.revision, 'alice')).toBeUndefined();
  expect(store.list('conversation').map(item => item.name)).toEqual(['one.txt', 'two.txt']);
  expect((await store.read('conversation', 'one.txt'))!.data.toString()).toBe('12345');
});

it('bounds quota traversal by every directory entry, including empty folders and symbolic links', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workspace-editor-walk-limit-')); dirs.push(dir);
  const store = new WorkspaceStore(join(dir, 'files'), join(dir, 'index'), undefined, { perMessage: 5, workspaceBytes: 100, listed: 40, walked: 1 });
  const file = await store.saveAt('conversation', 'one.txt', Buffer.from('one'), 'alice');
  const folder = store.folder('conversation');
  await mkdir(join(folder, 'empty'));
  const opened = store.readEditable('conversation', file.name)!;
  expect(store.saveEditable('conversation', file.name, 'updated', opened.revision, 'alice')).toBeUndefined();
  await rm(join(folder, 'empty'), { recursive: true });
  await symlink(join(dir, 'outside'), join(folder, 'link'));
  expect(store.saveEditable('conversation', file.name, 'updated', opened.revision, 'alice')).toBeUndefined();
});
