import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { browseButtons, browseSubmit, workspaceBrowser } from '../src/discord/browse.js';
import { WorkspaceStore } from '../src/workspace/store.js';
import { zipFile } from '../src/workspace/zip.js';

const setup = async () => {
  const store = WorkspaceStore.at(await mkdtemp(join(tmpdir(), 'teapilot-browse-')));
  for (const [name, text] of <Array<[string, string]>>[['notes.txt', 'tea'], ['project/assets/a.png', 'png'], ['project/scripts/tea.py', 'print(1)'], ['project/scripts/other.py', 'x']]) await store.saveAt('a', name, Buffer.from(text), 'op');
  return { store, browser: workspaceBrowser(store, 'a') };
};

describe('open folder', () => {
  it('shows the top, or a folder however it is typed', async () => {
    const { browser } = await setup();
    const top = browser.folder('');
    expect(top).toMatchObject({ dir: '' });
    expect('text' in top && top.text).toMatch(/^```py\n📂 workspace\/\n├── 📝 notes\.txt/);
    for (const input of ['project/scripts', 'Project\\Scripts\\', '/project/scripts/', '"project/scripts"', 'scripts', 'workspace/project/scripts']) {
      const view = browser.folder(input);
      expect(view, input).toMatchObject({ dir: 'project/scripts' });
      expect('text' in view && view.text).toContain('📂 project/scripts/');
    }
    expect(browser.folder('workspace')).toMatchObject({ dir: '' });
  });

  it('says what went wrong, and what might have been meant', async () => {
    const { browser } = await setup();
    expect(browser.folder('notes.txt')).toEqual({ note: '`notes.txt` is a file - use **open file** for that.' });
    expect(browser.folder('asset')).toEqual({ note: 'no folder called `asset`. did you mean `project/assets`?' });
    expect(browser.folder('nope')).toEqual({ note: 'no folder called `nope`. folders here: `project`, `project/assets`, `project/scripts`.' });
  });

  it('has nothing to show in an empty workspace, and names the workspace when it has a name', async () => {
    const store = WorkspaceStore.at(await mkdtemp(join(tmpdir(), 'teapilot-browse-')));
    expect(workspaceBrowser(store, 'b').folder('')).toEqual({ note: 'no files yet. attach one, or ask teapilot to make something.' });
    await store.saveAt('b', 'a.txt', Buffer.from('x'), 'op');
    store.rename('b', 'tea notes');
    expect(workspaceBrowser(store, 'b').folder('')).toMatchObject({ text: expect.stringMatching(/^tea notes\n```py\n/) });
  });

  it('keeps the view within a message, however long the names are', async () => {
    const store = WorkspaceStore.at(await mkdtemp(join(tmpdir(), 'teapilot-browse-')));
    for (let index = 0; index < 60; index++) await store.saveAt('c', `${'long'.repeat(20)}-${index}.txt`, Buffer.from('x'), 'op');
    const view = workspaceBrowser(store, 'c').folder('');
    expect('text' in view && view.text.length).toBeLessThanOrEqual(2000);
    expect('text' in view && view.text).toMatch(/```$/);
  });

  it('remembers the folder on show, for the form to start from', async () => {
    const { browser } = await setup();
    const session = { browser, dir: '' };
    expect(await browseSubmit(session, 'folder', 'project')).toMatchObject({ show: expect.stringContaining('📂 project/') });
    expect(session.dir).toBe('project');
    expect(await browseSubmit(session, 'folder', 'nope')).toMatchObject({ note: expect.stringContaining('no folder') });
    expect(session.dir).toBe('project');
  });
});

describe('open file', () => {
  it('sends a file by path, or by its name when only one has it', async () => {
    const { browser } = await setup();
    for (const input of ['project/scripts/tea.py', 'tea.py', 'Project/Scripts/TEA.PY', 'workspace/project/scripts/tea.py']) {
      const view = await browser.file(input);
      expect(view, input).toEqual({ note: "here's `project/scripts/tea.py` (8 B)", file: { name: 'tea.py', data: Buffer.from('print(1)') } });
    }
  });

  it('keeps file opening as a reply target for the browser context menu, without a third tree form', async () => {
    const store = WorkspaceStore.at(await mkdtemp(join(tmpdir(), 'teapilot-browse-')));
    await store.saveAt('a', 'project/scripts/tea.py', Buffer.from('print(1)'), 'op');
    const browser = workspaceBrowser(store, 'a');
    expect(Object.keys(browseButtons)).toEqual(['folder', 'file']);
    expect(browser.filePath?.('tea.py')).toBe('project/scripts/tea.py');
    expect(browser.filePath?.('../secret')).toBeUndefined();
  });

  it('says what went wrong, and what might have been meant', async () => {
    const { browser } = await setup();
    expect(await browser.file('project/scripts')).toEqual({ note: '`project/scripts` is a folder - use **open folder** to look inside.' });
    expect(await browser.file('scripts')).toEqual({ note: '`scripts` is a folder - use **open folder** to look inside.' });
    expect(await browser.file('tea')).toEqual({ note: 'no file called `tea`. did you mean `project/scripts/tea.py`?' });
    expect(await browser.file('nope.txt')).toEqual({ note: 'no file called `nope.txt`. use **open folder** to look around.' });
  });

  it('zips a file that is too big, and says so when even that is too big', async () => {
    const { store, browser } = await setup();
    // Commands make files that saving would refuse, so these come in the way commands' files do.
    await mkdir(join(store.folder('a'), 'big'), { recursive: true });
    await writeFile(join(store.folder('a'), 'big', 'zeros.bin'), Buffer.alloc(12 * 1024 * 1024));
    await writeFile(join(store.folder('a'), 'big', 'noise.bin'), randomBytes(11 * 1024 * 1024));
    await store.reconcile('a');
    const zipped = await browser.file('zeros.bin');
    expect(zipped.note).toMatch(/^`big\/zeros\.bin` is 12\.0 MB, so i zipped it \(\d+(\.\d)? [KM]B\)$/);
    expect(zipped.file?.name).toBe('zeros.bin.zip');
    expect(zipped.file!.data.length).toBeLessThan(10 * 1024 * 1024);

    const heavy = await browser.file('big/noise.bin');
    expect(heavy.file).toBeUndefined();
    expect(heavy.note).toMatch(/^`big\/noise\.bin` is 11\.0 MB \(11\.0 MB zipped\), and discord takes 10\.0 MB at most - so i can't send it\. ask teapilot to split or shrink it\.$/);
  });
});

describe('zipFile', () => {
  it('writes a zip whose one entry holds the file', async () => {
    const data = Buffer.from('tea '.repeat(500));
    const zip = await zipFile('café.txt', data, new Date(2026, 8, 30, 12, 0, 0));
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    const name = zip.readUInt16LE(26), size = zip.readUInt32LE(18);
    expect(zip.subarray(30, 30 + name).toString('utf8')).toBe('café.txt');
    expect(inflateRawSync(zip.subarray(30 + name, 30 + name + size))).toEqual(data);
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
  });

  it('stores what deflating cannot shrink', async () => {
    const data = randomBytes(64);
    const zip = await zipFile('r.bin', data);
    expect(zip.readUInt16LE(8)).toBe(0);
    expect(zip.subarray(30 + 5, 30 + 5 + 64)).toEqual(data);
  });
});


it('browses scratch files and gitignore, with a hint only inside the scratchpad', async () => {
  const { store, browser } = await setup();
  const visible = ['.gitignore', '.scratch/utilities/tool.py', '.scratch/plans/plan.md', '.scratch/sessions/main.jsonl', '.scratch/juniors/junior-alfa/sessions/turn.jsonl'];
  const hidden = ['.env', '.git/config', '.scratch/.secret', '.scratch/node_modules/lib.js', 'project/.gitignore'];
  for (const name of [...visible, ...hidden]) {
    const parts = name.split('/');
    await mkdir(join(store.folder('a'), ...parts.slice(0, -1)), { recursive: true });
    await writeFile(join(store.folder('a'), ...parts), name);
  }
  await store.reconcile('a');
  const names = store.list('a').map(file => file.name);
  expect(names).toEqual(expect.arrayContaining(visible));
  for (const name of hidden) expect(names).not.toContain(name);
  expect(store.folders('a')).toEqual(expect.arrayContaining(['.scratch', '.scratch/sessions', '.scratch/juniors/junior-alfa/sessions']));
  expect(store.tree('a')).toContain('.gitignore');
  const hint = "this is teapilot's scratchpad. it contains utilities, plans and session logs.";
  expect(browser.folder('.scratch')).toMatchObject({ dir: '.scratch', text: expect.stringContaining(hint) });
  for (const dir of ['', 'project', '.scratch/sessions']) {
    const view = browser.folder(dir);
    expect('text' in view && view.text).not.toContain(hint);
  }
  for (const name of visible) expect((await browser.file(name)).file?.data.toString()).toBe(name);
});
