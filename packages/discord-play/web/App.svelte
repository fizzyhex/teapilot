<script lang="ts">
  import { onMount } from 'svelte';
  let EditorPage = $state<any>();
  const editMode = location.pathname.startsWith('/edit/');
  onMount(() => { if (editMode) void import('./Editor.svelte').then(module => EditorPage = module.default); });
  import teacup from '../art/teacup.png';
  import { skin } from './skin';
  import Text from './Text.svelte';
  import { collectPadInputs, DualSenseHid } from './gamepad';
  import type { HidApi } from './gamepad';
  type Control = { custom_id?: string; label?: string; style: number; disabled?: boolean; url?: string; emoji?: { id?: string; name: string; animated?: boolean } };
  type Embed = { title?: string; description?: string; color?: number; url?: string; image?: { url: string }; thumbnail?: { url: string }; footer?: { text: string }; fields?: { name: string; value: string; inline?: boolean }[] };
  type Binding = { key?: string; pad?: string };
  let view = $state<{ title: string; status: string; discordStale: boolean; unsupported: string[]; payload: { content: string; embeds: Embed[]; components: { components: Control[] }[] } }>();
  let connected = $state(false), pending = $state(false), note = $state(''), latency = $state<number>();
  let dark = $state(false), controls = $state(false), binding = $state<Control>(), conflict = $state<{ input: string; kind: 'key' | 'pad'; other: string }>();
  let bindings = $state<Record<string, Binding>>({});
  let privateNotes = $state<{ content: string; embeds?: Embed[] }[]>([]);
  let fatal = $state(false);
  let hidController: DualSenseHid | undefined;
  let hidAvailable = $state(false), hidPending = $state(false), controllerNote = $state('');
  async function connectController() {
    if (!hidController || hidPending) return;
    hidPending = true;
    try { await hidController.request(); } finally { hidPending = false; }
  }
  let dialog = $state<HTMLDialogElement>();
  $effect(() => {
    if (!binding || !dialog) return;
    dialog.showModal();
    dialog.querySelector<HTMLElement>(conflict ? 'button' : '[data-capture]')?.focus();
  });
  const game = location.pathname.split('/').at(-1)!;
  let storage = '', ws: WebSocket | undefined, ignored = new Set<string>(), held = new Set<string>();
  const id = (control: Control) => control.custom_id?.replace(/^play:[^:]+:/, '').replace(/~\d+$/, '') ?? '';
  const usable = (control: Control) => Boolean(control.custom_id && !control.disabled && !view?.unsupported.includes(id(control)) && view?.status === 'running');
  const media = (url?: string) => url?.startsWith('attachment://') ? `/media/${game}/${encodeURIComponent(url.slice(13))}` : url;
  const all = () => view?.payload.components.flatMap(row => row.components) ?? [];
  const persist = () => { try { localStorage.setItem(storage, JSON.stringify(bindings)); } catch {} };
  function press(control: Control) {
    if (!usable(control) || !connected || pending || binding) return;
    pending = true; note = ''; privateNotes = []; ws?.send(JSON.stringify({ type: 'press', id: id(control) }));
  }
  function rebind(control: Control) { if (!usable(control)) return; binding = control; conflict = undefined; ignored = new Set(held); }
  function assign(input: string, kind: 'key' | 'pad', replace = false) {
    if (!binding) return;
    const other = Object.keys(bindings).find(key => key !== id(binding!) && bindings[key][kind] === input);
    if (other && !replace) { conflict = { input, kind, other }; return; }
    if (other) delete bindings[other][kind];
    bindings[id(binding)] = { ...bindings[id(binding)], [kind]: input }; persist(); binding = undefined; conflict = undefined;
  }
  function toggleTheme() { dark = !dark; try { localStorage.setItem('play-theme', dark ? 'dark' : 'light'); } catch {} }
  onMount(() => {
    if (editMode) return;
    let stopped = false, retry: ReturnType<typeof setTimeout>, animation = 0, heardAt = 0;
    let previous = new Set<string>();
    const keys = new Set<string>();
    const hid = (navigator as Navigator & { hid?: HidApi }).hid;
    hidAvailable = Boolean(hid);
    if (hid) {
      hidController = new DualSenseHid(hid, text => { controllerNote = text; });
      void hidController.restore();
    }
    try { dark = (localStorage.getItem('play-theme') ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark'; } catch {}
    const connect = async () => {
      if (stopped) return;
      try {
        const response = await fetch(`/session/${game}`);
        if (!response.ok) { fatal = true; note = 'open this app from discord again to keep playing.'; return; }
        const data = await response.json(); storage = `play-bindings:${data.user}:${game}`;
        try {
          const saved = JSON.parse(localStorage.getItem(storage) ?? '{}');
          bindings = Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, Binding] => Boolean(entry[1] && typeof entry[1] === 'object' && Object.entries(entry[1]).every(([key, input]) => ['key', 'pad'].includes(key) && typeof input === 'string'))));
        } catch { bindings = {}; }
      } catch { retry = setTimeout(() => void connect(), 2500); return; }
      if (stopped) return;
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/live/${game}`);
      ws.onopen = () => { connected = true; pending = false; ignored = new Set(); heardAt = performance.now(); };
      ws.onclose = () => { connected = false; pending = false; if (!stopped) retry = setTimeout(() => void connect(), 2500); };
      ws.onmessage = event => {
        heardAt = performance.now();
        const data = JSON.parse(event.data);
        if (data.type === 'view') view = data;
        if (data.type === 'ack' || data.type === 'error') { pending = false; note = data.text; privateNotes = data.notes ?? []; }
        if (data.type === 'pong') latency = Math.round(performance.now() - data.at);
      };
    };
    void (async () => {
      if (location.hash) {
        const ticket = location.hash.slice(1); history.replaceState(null, '', location.pathname);
        const result = await fetch('/launch', { method: 'POST', body: JSON.stringify({ ticket, id: game }) });
        if (!result.ok) { fatal = true; note = await result.text(); return; }
      }
      await connect();
    })().catch(() => { fatal = true; note = 'could not connect. open the app from discord again.'; });
    const ping = setInterval(() => {
      if (ws?.readyState !== WebSocket.OPEN) return;
      if (performance.now() - heardAt > 12_000) { connected = false; pending = false; ws.close(); return; }
      ws.send(JSON.stringify({ type: 'ping', at: performance.now() }));
    }, 3000);
    const input = (value: string, kind: 'key' | 'pad') => {
      if (binding) { if (!conflict) assign(value, kind); return; }
      const key = Object.keys(bindings).find(key => bindings[key][kind] === value);
      const control = all().find(control => id(control) === key);
      if (control) press(control);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.code === 'Escape') { binding = undefined; conflict = undefined; return; }
      if (event.code === 'Tab' || event.code === 'ShiftLeft' || event.code === 'ShiftRight') return;
      if (event.ctrlKey || event.metaKey || event.altKey || !document.hasFocus()) return;
      if ((event.target as HTMLElement)?.closest('input,textarea,select,[contenteditable="true"]')) return;
      if (binding && (event.target as HTMLElement)?.closest('button') && ['Enter', 'Space'].includes(event.code)) return;
      const bound = binding || Object.values(bindings).some(value => value.key === event.code);
      if (bound) event.preventDefault();
      if (event.repeat || keys.has(event.code)) return;
      keys.add(event.code);
      if (bound) input(event.code, 'key');
    };
    const keyup = (event: KeyboardEvent) => keys.delete(event.code);
    const blur = () => { keys.clear(); };
    const poll = () => {
      const now = new Set<string>();
      for (const pad of navigator.getGamepads?.() ?? []) {
        if (!pad) continue;
        collectPadInputs({ buttons: pad.buttons.map(button => button.pressed), axes: pad.axes }, now, previous);
      }
      hidController?.collect(now, previous);
      for (const value of ignored) if (!now.has(value)) ignored.delete(value);
      if (document.hasFocus() && !document.hidden && !document.activeElement?.closest('input,textarea,select,[contenteditable="true"]')) {
        const capturing = Boolean(binding);
        for (const value of now) if (!previous.has(value) && !ignored.has(value)) {
          input(value, 'pad');
          if (capturing) { ignored = new Set(now); break; }
        }
      }
      held = previous = now; animation = requestAnimationFrame(poll);
    };
    window.addEventListener('keydown', keydown); window.addEventListener('keyup', keyup); window.addEventListener('blur', blur); document.addEventListener('visibilitychange', blur); poll();
    return () => { stopped = true; hidController?.stop(); clearTimeout(retry); clearInterval(ping); cancelAnimationFrame(animation); ws?.close(); window.removeEventListener('keydown', keydown); window.removeEventListener('keyup', keyup); window.removeEventListener('blur', blur); document.removeEventListener('visibilitychange', blur); };
  });
</script>

{#if editMode}
  {#if EditorPage}<EditorPage />{:else}<div class="editor-loading">opening editor…</div>{/if}
{:else}
<main class="play" class:dark>
  <section class="paper" aria-label="game">
    <header><span>{view?.title ?? 'discord.play'}</span><button onclick={toggleTheme} aria-label="switch theme">{dark ? 'light' : 'dark'}</button></header>
    <div class="frame">
      <discord-messages use:skin lightTheme={!dark}>
        <discord-message use:skin message-body-only lightTheme={!dark}>
          <Text text={view?.payload.content ?? (fatal ? 'app unavailable' : 'opening your app…')}/>
          {#each view?.payload.embeds ?? [] as embed}
            <discord-embed use:skin slot="embeds" embed-title={embed.title} url={embed.url} color={embed.color === undefined ? undefined : `#${embed.color.toString(16).padStart(6, '0')}`} image={media(embed.image?.url)} thumbnail={media(embed.thumbnail?.url)}>
              <span slot="description"><Text text={embed.description}/></span>
              {#if embed.fields?.length}<discord-embed-fields use:skin slot="fields">{#each embed.fields as field}<discord-embed-field use:skin field-title={field.name} inline={field.inline}><Text text={field.value}/></discord-embed-field>{/each}</discord-embed-fields>{/if}
              {#if embed.footer}<span slot="footer">{embed.footer.text}</span>{/if}
            </discord-embed>
          {/each}
        </discord-message>
      </discord-messages>
    </div>
    <discord-messages use:skin lightTheme={!dark} class="buttons">
      <discord-message use:skin message-body-only lightTheme={!dark}>
          <discord-attachments slot="components">
            {#each view?.payload.components ?? [] as row}
              <discord-action-row>
                {#each row.components as control}
                  {#if control.style}
                    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions (Skyra contains a native button; skin synchronizes its disabled state.) -->
                    <discord-button use:skin type={(['', 'primary', 'secondary', 'success', 'destructive', 'secondary'][control.style])} url={control.url} disabled={!control.url && (!usable(control) || !connected || pending)} aria-keyshortcuts={bindings[id(control)]?.key} onclick={() => press(control)} oncontextmenu={(event: MouseEvent) => { event.preventDefault(); rebind(control); }}>
                      {#if control.emoji?.id}<img class="emoji" alt={control.emoji.name} src={`https://cdn.discordapp.com/emojis/${control.emoji.id}.${control.emoji.animated ? 'gif' : 'png'}`}>{:else}{control.emoji?.name ?? ''}{/if}
                      {control.label ?? ''}
                      {#if bindings[id(control)]}<small>{[bindings[id(control)].key?.replace(/^Key|^Digit/, ''), bindings[id(control)].pad].filter(Boolean).join(' / ')}</small>{/if}
                    </discord-button>
                  {:else}<span class="unsupported">use this menu in discord</span>{/if}
                {/each}
              </discord-action-row>
            {/each}
          </discord-attachments>
        </discord-message>
      </discord-messages>
    <footer><button onclick={() => controls = !controls}>controls</button><span>right-click a button to rebind</span><span>{connected ? `connected${latency === undefined ? '' : ` · ${latency}ms`}` : fatal ? 'disconnected' : 'connecting…'}</span></footer>
    {#if controllerNote}<p role="status" class="notice">{controllerNote}</p>{/if}
    {#if controls && !hidAvailable}<p class="notice">WebHID needs chrome or edge over https or localhost.</p>{/if}
    {#if controls}<div class="control-list">{#if hidAvailable}<button class="controller-connect" onclick={connectController} disabled={hidPending} title="WebHID currently supports dualsense controllers">controller not working? click here</button>{/if}{#each all().filter(usable) as control}<button onclick={() => rebind(control)}>bind {control.label ?? control.emoji?.name ?? id(control)}</button>{/each}</div>{/if}
    {#if view?.unsupported.length}<p class="notice">some controls open in discord.</p>{/if}
    {#if view?.discordStale}<p class="notice">playing here · discord updates resume at the next click there.</p>{/if}
    {#if view && view.status !== 'running'}<p class="notice">this app has {view.status === 'paused' ? 'paused' : 'ended'}.</p>{/if}
    <p role="status" class="notice">{note}</p>
    {#each privateNotes as reply}<div class="notice private"><Text text={reply.content}/>{#each reply.embeds ?? [] as embed}<strong>{embed.title ?? ''}</strong><Text text={embed.description}/>{#each embed.fields ?? [] as field}<p><strong>{field.name}</strong> <Text text={field.value}/></p>{/each}{#if embed.image}<img src={embed.image.url} alt="private reply">{/if}{/each}</div>{/each}
    <img class="teacup" src={teacup} alt="">
  </section>
  <div class="credit">💖 rendered with <a href="https://github.com/skyra-project/discord-components">@skyra/discord-components-core</a></div>
  {#if binding}
    <dialog bind:this={dialog} oncancel={() => { binding = undefined; conflict = undefined; }} aria-label="bind button" class="binding">
      <h2>bind “{binding.label ?? id(binding)}”</h2>
      {#if conflict}<p>already bound to {all().find(control => id(control) === conflict?.other)?.label ?? conflict.other}. move it here?</p><button onclick={() => { if (conflict) assign(conflict.input, conflict.kind, true); }}>move binding</button>
      {:else}<p tabindex="-1" data-capture>press a key or controller input</p>{/if}
      <button onclick={() => { if (binding) delete bindings[id(binding)]; persist(); binding = undefined; }}>clear binding</button>
      <button onclick={() => { binding = undefined; conflict = undefined; }}>cancel</button>
    </dialog>
  {/if}
</main>
{/if}
