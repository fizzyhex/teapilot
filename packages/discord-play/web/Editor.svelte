<script lang="ts">
  import { onMount } from 'svelte';
  import { saveEditorFile } from './editor-save.js';
  import teacup from '../art/teacup.png';
  import { editorTheme } from './editor-theme.js';
  import './editor.css';
  type FileState = { name: string; content: string; revision: string };
  let file = $state<FileState>();
  let value = $state('');
  let dark = $state(true), busy = $state(true), saving = $state(false);
  let shortcut = $state('Ctrl+S');
  const theme = $derived(editorTheme(dark));
  const lineCount = $derived(value.split('\n').length);
  let error = $state('');
  let conflict = $state(false), Editor = $state<any>();
  let language = $state<any>();
  const dirty = $derived(Boolean(file && value !== file.content));
  const id = location.pathname.split('/').at(-1) ?? '';
  function toggleTheme() {
    dark = !dark;
    try { localStorage.setItem('play-theme', dark ? 'dark' : 'light'); } catch {}
  }
  async function load() {
    busy = true; error = '';
    try {
      const response = await fetch(`/api/edit/${encodeURIComponent(id)}`);
      if (!response.ok) throw new Error(response.status === 401 ? 'this edit link has expired. request a new one in discord.' : 'could not open this file.');
      file = await response.json(); value = file!.content; conflict = false;
    } catch (e) { error = e instanceof Error ? e.message : 'could not open this file.'; }
    finally { busy = false; }
  }
  async function reloadLatest() {
    if (!window.confirm('discard your draft and load the latest version?')) return;
    await load();
  }
  async function save() {
    if (!file || !dirty || saving) return;
    const submitted = value;
    const revision = file.revision;
    saving = true; error = '';
    try {
      await saveEditorFile({ id, submitted, revision, current: () => value, fetcher: (...args) => fetch(...args), apply: (saved, unchanged) => {
        file = saved;
        // Keep keystrokes made while the request was in flight; only advance the baseline.
        if (unchanged) value = saved.content;
      } });
      conflict = false;
    } catch (e) { if (e instanceof Error && e.message === 'this file changed elsewhere. your draft is still here.') conflict = true; error = e instanceof Error ? e.message : 'save failed. your draft is still here.'; }
    finally { saving = false; }
  }
  function downloadDraft() {
    const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([value], { type: 'text/plain;charset=utf-8' }));
    link.download = `${file?.name.split('/').at(-1) ?? 'draft'}.draft`; link.click(); URL.revokeObjectURL(link.href);
  }
  onMount(() => {
    try { dark = (localStorage.getItem('play-theme') ?? 'dark') === 'dark'; } catch {}
    shortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘S' : 'Ctrl+S';
    void (async () => {
      // Load/authenticate before optional editor chunks; fallback remains usable if imports fail.
      if (location.hash) {
        const ticket = location.hash.slice(1); history.replaceState(null, '', location.pathname);
        const launched = await fetch('/edit/launch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket, id }) });
        if (!launched.ok) throw new Error('this edit link expired or was already used. request a new one in discord.');
      }
      await load();
      if (!file) return;
      const ext = file.name.split('.').at(-1)?.toLowerCase();
      const loaders: Record<string, () => Promise<any>> = {
        js: () => import('@codemirror/lang-javascript').then(m => m.javascript()), ts: () => import('@codemirror/lang-javascript').then(m => m.javascript({ typescript: true })),
        json: () => import('@codemirror/lang-json').then(m => m.json()), html: () => import('@codemirror/lang-html').then(m => m.html()),
        css: () => import('@codemirror/lang-css').then(m => m.css()), py: () => import('@codemirror/lang-python').then(m => m.python()),
        md: () => import('@codemirror/lang-markdown').then(m => m.markdown()), xml: () => import('@codemirror/lang-xml').then(m => m.xml()),
        sql: () => import('@codemirror/lang-sql').then(m => m.sql()), yaml: () => import('@codemirror/lang-yaml').then(m => m.yaml()),
      };
      try { if (ext && loaders[ext]) language = await loaders[ext]!(); else language = undefined; } catch { language = undefined; }
      try { const { default: component } = await import('svelte-codemirror-editor'); Editor = component; } catch { Editor = undefined; }
    })().catch(e => { error = e instanceof Error ? e.message : 'could not open this file.'; busy = false; });
    const key = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); } };
    const leave = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('keydown', key); window.addEventListener('beforeunload', leave);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('beforeunload', leave); };
  });
</script>

<svelte:head><title>{file?.name ?? 'edit file'} · teapilot</title><meta name="viewport" content="width=device-width, initial-scale=1"></svelte:head>
<main class="workspace-editor" class:dark>
  <section class="workspace-paper" aria-label="workspace file editor">
    <header class="workspace-header">
      <span class="workspace-brand">teapilot</span>
      <span class="workspace-crumb" title={file?.name}>workspace <span aria-hidden="true">/</span> {file?.name ?? 'opening file…'}</span>
      <div class="workspace-head-actions">
        <span class="workspace-state" class:unsaved={dirty} role="status">{saving ? 'saving…' : busy ? 'opening file…' : error ? 'needs attention' : dirty ? 'unsaved changes' : file ? 'all changes saved' : 'file unavailable'}</span>
        <button class="workspace-theme" onclick={toggleTheme} aria-label="switch theme">{dark ? 'light' : 'dark'}</button>
        <button class="workspace-button workspace-save header-save" onclick={save} disabled={!dirty || saving}>save changes <kbd>{shortcut}</kbd></button>
      </div>
    </header>
    <div class="workspace-canvas">
      {#if error}
        <div class="workspace-alert" role="alert">
          <strong>something needs attention</strong><span>{error}</span>
          {#if conflict}<div class="workspace-recovery"><button class="workspace-button" onclick={downloadDraft}>download my draft</button><button class="workspace-button" onclick={reloadLatest}>reload latest version</button></div>{/if}
        </div>
      {/if}
      <div class="workspace-frame" aria-busy={busy}>
        <div class="workspace-editor-inner">
          <div class="workspace-editor-bar">
            <span class="workspace-file-dot" class:unsaved={dirty} aria-hidden="true"></span>
            <h1 title={file?.name}>{file?.name.split('/').at(-1) ?? 'file'}</h1>
            <span class="workspace-encoding">UTF-8 <span aria-hidden="true">·</span> {file ? lineCount : 0} {lineCount === 1 ? 'line' : 'lines'}</span>
          </div>
          {#if busy}
            <div class="workspace-empty" role="status">opening your file…</div>
          {:else if Editor && file}
            <Editor bind:value lang={language} {theme} lineWrapping={false} tabSize={2} nodebounce />
          {:else if file}
            <textarea bind:value aria-label="file contents" spellcheck="false"></textarea>
          {:else}
            <div class="workspace-empty">open a new edit link from discord to try again.</div>
          {/if}
        </div>
      </div>
      <div class="workspace-toolbar">
        <button class="workspace-button workspace-save" onclick={save} disabled={!dirty || saving}><span class="workspace-button-icon" aria-hidden="true">◀</span>{saving ? 'saving…' : 'save changes'} <kbd>{shortcut}</kbd></button>
        <span class="workspace-hint">changes only apply when you save.</span>
      </div>
    </div>
    <img class="workspace-teacup" src={teacup} alt="" aria-hidden="true">
  </section>
  <p class="workspace-credit">💖 rendered with <a href="https://github.com/touchifyapp/svelte-codemirror-editor">@touchifyapp/svelte-codemirror-editor</a></p>
</main>

