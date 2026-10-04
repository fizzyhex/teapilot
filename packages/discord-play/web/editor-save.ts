export interface EditorFileState { name: string; content: string; revision: string }

/** Submit one captured draft; edits made while the request is pending remain in the editor. */
export async function saveEditorFile(options: {
  id: string;
  submitted: string;
  revision: string;
  current: () => string;
  fetcher: typeof fetch;
  apply: (saved: EditorFileState, unchanged: boolean) => void;
}): Promise<void> {
  const response = await options.fetcher(`/api/edit/${encodeURIComponent(options.id)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: options.submitted, revision: options.revision }),
  });
  if (response.status === 409) throw new Error('this file changed elsewhere. your draft is still here.');
  if (!response.ok) throw new Error(response.status === 401 ? 'your edit session expired. your draft is still here.' : 'save failed. your draft is still here.');
  const saved = await response.json() as EditorFileState;
  options.apply(saved, options.current() === options.submitted);
}
