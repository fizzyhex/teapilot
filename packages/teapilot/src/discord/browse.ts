import { formatBytes, maxFileBytes, type WorkspaceStore } from '../workspace/store.js';
import { zipFile } from '../workspace/zip.js';
import { MESSAGE_LIMIT } from './render.js';

/** What the buttons under /workspace tree do: look inside a folder, or get a file sent over. */
export type BrowseAction = 'folder' | 'file';
export const browseButtons: Record<BrowseAction, { label: string; emoji: string }> = {
  folder: { label: 'open folder', emoji: '📂' },
  file: { label: 'open file', emoji: '📄' },
};
/** Each button's form: one text box. Discord caps titles and labels at 45 characters and placeholders at 100. */
export const browseForms: Record<BrowseAction, { title: string; field: string; label: string; placeholder: string; required: boolean; maxLength: number }> = {
  folder: { title: 'open a folder', field: 'path', label: 'folder', placeholder: 'project/assets - or leave empty for the top', required: false, maxLength: 200 },
  file: { title: 'open a file', field: 'path', label: 'file', placeholder: 'project/scripts/processor.py - or just the file name', required: true, maxLength: 200 },
};
/** Custom id prefixes: `teapilot-browse:<nonce>:<action>` for a button and `teapilot-browse-modal:<nonce>:<action>` for its form. */
export const browsePrefix = 'teapilot-browse:';
export const browseModalPrefix = 'teapilot-browse-modal:';

/** The buttons under a folder view, as Discord's API takes them. */
export const browseRows = (nonce: string) => [{ type: 1, components: (Object.keys(browseButtons) as BrowseAction[]).map(action => (
  { type: 2, style: 2, label: browseButtons[action].label, emoji: { name: browseButtons[action].emoji }, custom_id: `${browsePrefix}${nonce}:${action}` })) }];
/** The form behind a button; the folder form starts from the folder on show, so a small step is a small edit. */
export const browseModal = (action: BrowseAction, nonce: string, dir: string) => {
  const form = browseForms[action];
  return { custom_id: `${browseModalPrefix}${nonce}:${action}`, title: form.title, components: [{ type: 1, components: [
    { type: 4, custom_id: form.field, label: form.label, style: 1, required: form.required, max_length: form.maxLength, placeholder: form.placeholder, ...(action === 'folder' && dir ? { value: dir } : {}) }] }] };
};

/** A folder to show: where it is, and the message that shows it; or why there is nothing to show. */
export type FolderView = { dir: string; text: string } | { note: string };
/** A file to send, with the message that goes with it; or why nothing is sent. */
export type FileView = { note: string; file?: { name: string; data: Buffer } };
export interface WorkspaceBrowser {
  /** What typing `input` into the folder form does; an empty one is the top of the workspace. */
  folder(input: string): FolderView;
  file(input: string): Promise<FileView>;
  filePath?(input: string): string | undefined;
}
/** A view that is open under one message: the folder it shows follows every open folder. */
export interface BrowseSession { browser: WorkspaceBrowser; dir: string }
export type BrowseOutcome = { show: string } | FileView;

/** Applies a submitted form to the view it belongs to. `show` replaces the message; the rest is said privately. */
export async function browseSubmit(session: BrowseSession, action: BrowseAction, input: string): Promise<BrowseOutcome> {
  if (action === 'file') return session.browser.file(input);
  const view = session.browser.folder(input);
  if ('note' in view) return { note: view.note };
  session.dir = view.dir;
  return { show: view.text };
}
export const browseGone = 'this view is gone - run /workspace tree again.';

/** Only zip what could plausibly shrink under Discord's limit; beyond this deflating costs more than it can win. */
const zipCeilingBytes = 200 * 1024 * 1024;
const fence = '`'.repeat(3);
const code = (text: string) => `\`${text}\``;
const list = (names: string[]) => names.slice(0, 3).map(code).join(', ');

/** A path as people type it: slashes forward, no quotes, no leading ./ or /, and not starting from the tree's own "workspace/". */
const normal = (input: string) => input.trim().replace(/^(["'`])(.*)\1$/, '$2').replace(/\\/g, '/').replace(/^(\.?\/+)+/, '').replace(/\/+$/, '');

/** The workspace of one conversation, as /workspace tree's buttons see it. */
export function workspaceBrowser(store: WorkspaceStore, conversation: string): WorkspaceBrowser {
  const folders = () => store.folders(conversation);
  const files = () => store.list(conversation).map(file => file.name);
  /** The listed folder `path` names, ignoring case, or by its last part when only one has it. */
  const findFolder = (path: string): string | undefined => {
    const known = folders();
    const lower = path.toLowerCase();
    const exact = known.find(folder => folder.toLowerCase() === lower);
    if (exact) return exact;
    const ending = known.filter(folder => folder.toLowerCase().endsWith(`/${lower}`));
    return ending.length === 1 ? ending[0] : undefined;
  };
  /** The same, after taking the tree's "workspace/" off the front as the top of the workspace. */
  const resolveFolder = (input: string): string | undefined => {
    const path = normal(input);
    return findFolder(path) ?? (/^workspace(\/|$)/i.test(path) ? findFolder(path.replace(/^workspace\/?/i, '')) : undefined);
  };
  const resolveFile = (input: string) => {
    const path = normal(input);
    return store.get(conversation, path) ?? (/^workspace\//i.test(path) ? store.get(conversation, path.slice('workspace/'.length)) : undefined);
  };
  /** Names that contain what was typed, for "did you mean". */
  const near = (names: string[], input: string) => {
    const wanted = normal(input).toLowerCase();
    return wanted ? names.filter(name => name.toLowerCase().includes(wanted)) : [];
  };

  return {
    filePath(input) { return resolveFile(normal(input))?.name; },
    folder(input) {
      const path = normal(input);
      const top = !path || /^workspace\/?$/i.test(path);
      const dir = top ? '' : resolveFolder(path);
      if (dir === undefined) {
        if (resolveFile(path)) return { note: `${code(path)} is a file - use **open file** for that.` };
        const close = near(folders(), path);
        return { note: close.length ? `no folder called ${code(path)}. did you mean ${list(close)}?` : `no folder called ${code(path)}. ${folders().length ? `folders here: ${folders().slice(0, 5).map(code).join(', ')}.` : 'there are no folders yet.'}` };
      }
      const name = store.name(conversation);
      let text = '';
      // A view that outgrows a message loses lines from its end, which says how many.
      for (const limit of [40, 30, 20, 10]) {
        const tree = store.tree(conversation, dir, limit);
        if (!tree) return { note: top ? 'no files yet. attach one, or ask teapilot to make something.' : `${code(dir)} has no files.` };
        const hint = dir === '.scratch' ? "this is teapilot's scratchpad. it contains utilities, plans and session logs.\n" : '';
        text = `${name ? `${name}\n` : ''}${hint}${fence}py\n${tree}\n${fence}`;
        if (text.length <= MESSAGE_LIMIT) break;
      }
      return { dir, text };
    },

    async file(input) {
      const path = normal(input);
      const stored = resolveFile(path);
      if (!stored) {
        if (path && resolveFolder(path) !== undefined) return { note: `${code(path)} is a folder - use **open folder** to look inside.` };
        const close = near(files(), path);
        return { note: close.length ? `no file called ${code(path)}. did you mean ${list(close)}?` : `no file called ${code(path)}. use **open folder** to look around.` };
      }
      const label = code(stored.name);
      const base = stored.name.split('/').at(-1)!;
      if (stored.size <= maxFileBytes) {
        const read = store.read(conversation, stored.name);
        return read ? { note: `here's ${label} (${formatBytes(read.data.length)})`, file: { name: base, data: read.data } } : { note: `couldn't read ${label}.` };
      }
      const tooBig = (zipped?: number) => ({ note: `${label} is ${formatBytes(stored.size)}${zipped ? ` (${formatBytes(zipped)} zipped)` : ''}, and discord takes ${formatBytes(maxFileBytes)} at most - so i can't send it. ask teapilot to split or shrink it.` });
      if (stored.size > zipCeilingBytes) return tooBig();
      const read = store.read(conversation, stored.name);
      if (!read) return { note: `couldn't read ${label}.` };
      const zipped = await zipFile(base, read.data);
      if (zipped.length > maxFileBytes) return tooBig(zipped.length);
      return { note: `${label} is ${formatBytes(stored.size)}, so i zipped it (${formatBytes(zipped.length)})`, file: { name: `${base}.zip`, data: zipped } };
    },
  };
}
