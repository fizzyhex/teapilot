import { expect, it, vi } from 'vitest';
import { saveEditorFile } from '../web/editor-save.js';

it('submits the captured draft immediately and retains edits made while the save is pending', async () => {
  let resolve!: (response: Response) => void;
  const pending = new Promise<Response>(done => { resolve = done; });
  const fetcher = vi.fn(() => pending);
  let draft = 'submitted';
  let baseline = 'old';
  const apply = vi.fn((saved: { content: string }, unchanged: boolean) => {
    baseline = saved.content;
    if (unchanged) draft = saved.content;
  });
  const saving = saveEditorFile({ id: 'abc', submitted: draft, revision: 'r1', current: () => draft, fetcher: fetcher as typeof fetch, apply });
  expect(fetcher).toHaveBeenCalledWith('/api/edit/abc', expect.objectContaining({
    method: 'PUT', body: JSON.stringify({ content: 'submitted', revision: 'r1' }),
  }));
  draft = 'typed during save';
  resolve(new Response(JSON.stringify({ name: 'a.js', content: 'submitted', revision: 'r2' }), { status: 200 }));
  await saving;
  expect(baseline).toBe('submitted');
  expect(draft).toBe('typed during save');
  expect(apply).toHaveBeenCalledWith(expect.objectContaining({ revision: 'r2' }), false);
});

it('does not apply a failed or conflicting save response', async () => {
  const apply = vi.fn();
  const fetcher = vi.fn(async () => new Response('', { status: 409 }));
  await expect(saveEditorFile({ id: 'abc', submitted: 'draft', revision: 'r1', current: () => 'draft', fetcher: fetcher as typeof fetch, apply }))
    .rejects.toThrow('this file changed elsewhere');
  expect(apply).not.toHaveBeenCalled();
});
