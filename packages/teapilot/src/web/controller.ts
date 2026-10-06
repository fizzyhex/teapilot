import type { Config } from '../config.js';
import { READS_SPENT } from '../routing/escalation.js';
import { searchQuery } from '../search.js';
import { agentBrowserRead, findAgentBrowser, withMirror, type Runner } from './agent-browser.js';
import { guardedGet, type FetchLimits } from './fetch.js';
import { bound, decode, extractHtml, extractText, htmlTypes, textTypes, type Extracted } from './extract.js';
import { checkUrl, type AddressPolicy } from './policy.js';
import type { ReaderSettings } from './settings.js';

/** Reads a request may make over the network; cached pages are free. */
export const MAX_READS = 8;

interface Document extends Extracted { url: string; via: 'agent-browser' | 'built-in' }
// Pages read recently, shared across requests so a research turn and the turn that uses it read once.
const cache = new Map<string, { document: Document; at: number }>();
const CACHE_ENTRIES = 32, CACHE_MS = 10 * 60 * 1000;
// Whether agent-browser was found, per state directory and setting, so it is looked up once per process.
const located = new Map<string, Promise<string | undefined>>();

/** Scheme, fragment, a trailing slash and percent-encoding don't make a different page for the seen-URL rule. */
const key = (url: URL) => `${url.host}${unescaped(url.pathname).replace(/(.)\/$/, '$1')}${url.search}`;
const unescaped = (path: string) => { try { return decodeURI(path); } catch { return path; } };
// Balanced parentheses belong to a URL (wiki titles such as World_1-1_(Super_Mario_Bros.)); an unmatched one ends it.
const urlsIn = (text: string) => [...text.matchAll(/https?:\/\/(?:[^\s<>()\[\]{}"'`|\\^]|\([^\s<>()\[\]{}"'`|\\^]*\))+/g)].map(match => match[0].replace(/[.,;:!?*_~]+$/, ''));

export interface WebControllerOptions extends AddressPolicy {
  event?: (type: string, fields: Record<string, unknown>) => Promise<void>;
  run?: Runner; limits?: Partial<FetchLimits>;
}

/**
 * Every web request the agent makes goes through here: search results and pages are recorded, and a page is
 * read only if its URL already appeared in the conversation. The model therefore cannot compose a URL of its
 * own, such as one that carries conversation text to another host.
 */
export class WebController {
  private readonly seen = new Set<string>();
  private reads = 0;
  constructor(private readonly config: Config, private readonly options: WebControllerOptions = {}) {}
  get settings(): ReaderSettings { return this.config.webReader ?? { mode: 'auto' }; }
  get reading(): boolean { return this.settings.mode !== 'off'; }

  /** Records URLs found in text the user wrote or a tool returned, so they may be read. */
  remember(text: string): void {
    for (const found of urlsIn(text)) this.rememberUrl(found);
  }
  /** Records one URL as given, such as a search result's, with no surrounding text to cut it short. */
  private rememberUrl(url: string): void { try { this.seen.add(key(new URL(url))); } catch { /* not a URL */ } }

  async search(base: string, query: string, signal?: AbortSignal): ReturnType<typeof searchQuery> {
    const results = await searchQuery(base, query, signal);
    for (const result of results) this.rememberUrl(result.url);
    return results;
  }

  /** The page as tool output, at most maxChars of its text. Refusals and failures are text, never thrown. */
  async read(raw: string, maxChars: number, signal?: AbortSignal): Promise<{ text: string; chars: number; full?: { url: string; title: string; text: string; truncated: boolean } }> {
    const refuse = (reason: string, fields: Record<string, unknown> = {}) => {
      void this.options.event?.('web_read', { refused: reason.slice(0, 120), ...fields });
      return { text: reason.startsWith('Not read') ? reason : `Not read: ${reason}`, chars: 0 };
    };
    let url: URL;
    try { url = checkUrl(raw, this.options.allowPort); } catch (error) { return refuse(error instanceof Error ? error.message : 'Invalid URL.'); }
    const host = url.host;
    if (!this.seen.has(key(url))) return refuse('that URL has not appeared in this conversation. Open URLs from the user, from search results or from pages already read; search for the page first, or ask the user for the link.', { host });
    let document = cached(url);
    const via = document ? 'cache' : undefined;
    if (!document) {
      if (this.reads >= MAX_READS) return refuse(`${READS_SPENT}. Answer from what you already have.`, { host });
      this.reads++;
      let fetched: Document | string;
      try { fetched = await this.fetch(url, signal); }
      catch (error) {
        if (signal?.aborted) throw signal.reason;
        return refuse(error instanceof Error ? error.message : 'The page could not be read.', { host });
      }
      if (typeof fetched === 'string') return refuse(fetched, { host });
      store(url, document = fetched);
    }
    this.rememberUrl(document.url);
    for (const link of document.links) this.rememberUrl(link);
    const body = bound(document.text, maxChars);
    // agent-browser's text drops link targets; list the page's own links so the model can follow them.
    const links = document.via === 'agent-browser' && document.links.length ? `\nLinks on the page:\n${document.links.slice(0, 20).join('\n')}` : '';
    await this.options.event?.('web_read', { host, via: via ?? document.via, chars: body.text.length, truncated: body.truncated });
    const header = [`Source: ${document.url}`, document.title && `Title: ${document.title}`,
      body.truncated && `Showing the first ${body.text.length} of ${document.text.length} characters.`].filter(Boolean).join('\n');
    const text = `${header}\n<<<untrusted page content>>>\n${body.text || '(no readable text)'}\n<<<end of page>>>${links}`;
    // The whole page, so the reader can keep it where it can be searched after later turns cut this result down.
    return { text, chars: body.text.length, full: { url: document.url, title: document.title, text: document.text, truncated: body.truncated } };
  }

  private async fetch(url: URL, signal?: AbortSignal): Promise<Document | string> {
    const page = await guardedGet(url.href, { ...this.options, signal, types: [...htmlTypes, ...textTypes] });
    if (page.status < 200 || page.status >= 300) return `${url.host} answered HTTP ${page.status}.`;
    this.rememberUrl(page.url);
    if (!htmlTypes.includes(page.contentType)) return { ...extractText(decode(page.body, page.charset)), url: page.url, via: 'built-in' };
    const html = decode(page.body, page.charset, true);
    const builtin = extractHtml(html, page.url);
    const bin = this.settings.mode === 'builtin' ? undefined : await this.agentBrowser();
    if (!bin) return { ...builtin, url: page.url, via: 'built-in' };
    try {
      const markdown = async () => {
        const variant = new URL(page.url);
        if (variant.search || variant.pathname.endsWith('/')) return undefined;
        variant.pathname += '.md';
        const found = await guardedGet(variant.href, { ...this.options, signal, types: ['text/markdown', 'text/x-markdown'], limits: { deadlineMs: 8000 } });
        return found.status === 200 ? { contentType: 'text/markdown', text: decode(found.body, found.charset) } : undefined;
      };
      const result = await withMirror({ contentType: page.contentType, text: html }, markdown,
        mirror => agentBrowserRead(bin, mirror, this.config.stateDir, { signal, run: this.options.run }));
      if (result.content.trim()) return { title: builtin.title, text: result.content.trim(), links: builtin.links, url: page.url, via: 'agent-browser' };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      await this.options.event?.('web_reader_fallback', { reason: error instanceof Error ? error.message.slice(0, 200) : 'unknown' });
    }
    return { ...builtin, url: page.url, via: 'built-in' };
  }

  private agentBrowser(): Promise<string | undefined> {
    const id = `${this.config.stateDir}\n${this.settings.agentBrowserBin ?? ''}`;
    if (!located.has(id)) located.set(id, findAgentBrowser(this.config.stateDir, this.settings.agentBrowserBin).catch(() => undefined));
    return located.get(id)!;
  }
}

function cached(url: URL): Document | undefined {
  const entry = cache.get(key(url));
  if (!entry || Date.now() - entry.at > CACHE_MS) { cache.delete(key(url)); return undefined; }
  return entry.document;
}
function store(url: URL, document: Document): void {
  cache.delete(key(url)); cache.set(key(url), { document, at: Date.now() });
  while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
}
/** For tests: forget cached pages and located binaries. */
export function resetWebCaches(): void { cache.clear(); located.clear(); }
