import type { Config } from './config.js';

export class SearchSetupError extends Error {}
export function searchRepair(config: Config): string {
  return `Configuration: ${config.source?.directory ?? 'provided settings'}. Run teapilot setup${config.source ? ` --config-dir "${config.source.directory}"` : ''} and configure search. See docs/02-commands.md#web-research.`;
}
type Results = Array<{ title: string; url: string; snippet: string }> & { unresponsive?: string[] };
/**
 * Engines SearXNG ships with that are asked when its defaults all fail: the defaults are the first to
 * rate-limit or CAPTCHA a local instance. Bing and Yahoo are left out because they answer scrapers with
 * unrelated pages, which is worse than no answer.
 */
export const fallbackEngines = 'google,duckduckgo web,yep,gmx';

export async function searchQuery(base: string, query: string, signal?: AbortSignal): Promise<Results> {
  try {
    const endpoint = new URL(base);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Invalid search URL');
    const first = await request(base, query, signal);
    if (first.length || !first.unresponsive?.length) return first;
    // Any fallback engine answering, even with nothing, makes this an empty result rather than an outage.
    const second = await request(base, query, signal, fallbackEngines).catch(() => undefined);
    return second && (second.length || (second.unresponsive?.length ?? 0) < fallbackEngines.split(',').length) ? Object.assign(second, { unresponsive: [] }) : first;
  } catch {
    signal?.throwIfAborted();
    throw new SearchSetupError('Search service unavailable or incompatible. Check its URL, connectivity, and SearXNG JSON output.');
  }
}

async function request(base: string, query: string, signal?: AbortSignal, engines?: string): Promise<Results> {
  const url = new URL(`${base.replace(/\/$/, '')}/search`);
  url.searchParams.set('q', query); url.searchParams.set('format', 'json');
  if (engines) url.searchParams.set('engines', engines);
  const response = await fetch(url, { signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(15000)]), redirect: 'error' });
  if (!response.ok || !response.body) throw new Error('Search HTTP failure');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.length;
      if (size > 1_000_000) throw new Error('Search response too large');
      chunks.push(next.value);
    }
  } finally { await reader.cancel(); }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { results?: unknown; unresponsive_engines?: unknown };
  if (!Array.isArray(data.results)) throw new Error('Search requires a JSON results array');
  const results = data.results.slice(0, 8).map(result => ({
    title: String(result?.title ?? '').slice(0, 300),
    url: typeof result?.url === 'string' && /^https?:\/\//.test(result.url) ? result.url.slice(0, 2000) : '',
    snippet: String(result?.content ?? '').slice(0, 1500),
  }));
  // SearXNG reports engines it could not query (rate limits, blocks) beside an empty result list.
  const unresponsive = Array.isArray(data.unresponsive_engines) ? data.unresponsive_engines.map(entry => Array.isArray(entry) ? entry.slice(0, 2).join(': ') : String(entry)).slice(0, 8) : [];
  return Object.assign(results, { unresponsive });
}

export async function checkSearch(config: Config, signal?: AbortSignal): Promise<void> {
  // Permissions are checked before any network request, including connectivity checks.
  if (!config.policy.permissions.includes('web.search')) throw new SearchSetupError(`Search is disallowed by the active policy. Enable web.search only if you intend to allow queries to your search service. ${searchRepair(config)}`);
  if (!config.searchUrl) throw new SearchSetupError(`No search endpoint configured (SEARCH_BASE_URL). ${searchRepair(config)}`);
  try { await searchQuery(config.searchUrl, 'teapilot connectivity check', signal); }
  catch (error) {
    if (!(error instanceof SearchSetupError)) throw error;
    // Loaded on failure only: it asks Docker, and setup/searxng.ts imports this module.
    const { followManagedSearch } = await import('./setup/searxng.js');
    if (await followManagedSearch(config, signal)) return;
    throw new SearchSetupError(`${error.message} ${searchRepair(config)}`);
  }
}
