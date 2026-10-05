import { existsSync, realpathSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Action, Participants, User } from '@teapilot/discord-play';
import { PlayError } from './render.js';
import type { AssetTexts } from './assets.js';

/** What an app sees as its context, before the harness adds random() and emoji(). */
export interface ContextData { now: number; invoker: User; participants: Participants; emojis: Record<string, string>; seed: number }
export type Method = 'meta' | 'init' | 'update' | 'view';
export interface CallInput { state?: unknown; action?: Action; ctx: ContextData }
/** `value` is untrusted: the caller validates it. `seed` carries random() forward. */
export interface CallResult { value: unknown; seed: number }
/** Runs one app's functions, in the sandbox or, for trusted apps, in a worker. */
export interface PlayEngine {
  call(method: Method, input: CallInput): Promise<CallResult>;
  dispose(): void;
}

export const maxSourceChars = 64_000;
export const maxOutputChars = 256_000;

/**
 * Runs inside the app's realm. `app` is the module the model wrote; `__play` is the only entry point.
 * random() is mulberry32 over a persisted seed, so it continues across calls and restarts. Math.random
 * is the same generator, so apps that reach for it stay reproducible too.
 */
export const harness = (awaitResult: boolean, assets: AssetTexts = {}) => `
const definition = app && typeof app === 'object' ? app : undefined;
const readAsset = (() => {
  const texts = JSON.parse(${JSON.stringify(JSON.stringify(assets))});
  return name => {
    if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(texts, name)) throw new Error('asset ' + JSON.stringify(name) + ' is not declared; select it with play_start/play_update assets.');
    return texts[name];
  };
})();
globalThis.__play = ${awaitResult ? 'async ' : ''}(method, input, discord) => {
  if (!definition || typeof definition.init !== 'function' || typeof definition.update !== 'function' || typeof definition.view !== 'function') throw new Error('The app module must "export default app({ init, update, view })".');
  const { state, action, ctx: data } = JSON.parse(input);
  let seed = data.seed >>> 0;
  const ctx = { now: data.now, invoker: data.invoker, participants: data.participants, emojis: data.emojis, readText: readAsset,
    random() { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; },
    emoji(name) {
      const text = String(name);
      if (/^<a?:\\w{2,32}:\\d{17,20}>$/.test(text)) return text;
      const key = text.replace(/^:|:$/g, '');
      return Object.prototype.hasOwnProperty.call(data.emojis, key) ? data.emojis[key] : ':' + key + ':';
    } };
  Math.random = ctx.random;
  if (discord) ctx.discord = discord;
  let value;
  if (method === 'meta') value = { participants: definition.participants === undefined ? null : definition.participants, keys: Object.keys(definition) };
  else if (method === 'init') value = definition.init(ctx);
  else if (method === 'update') value = definition.update(state, action, ctx);
  else value = definition.view(state, ctx);
  ${awaitResult ? 'value = await value;' : `if (value && typeof value.then === 'function') throw new Error(method + '() returned a promise; sandboxed apps must be synchronous.');`}
  return JSON.stringify({ value: value === undefined ? null : value, seed });
};`;

/** TypeScript to JavaScript. Node warns once that the stripper is experimental; that warning means nothing to an operator. */
export function toJavaScript(source: string, name = 'app.ts'): string {
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (String(typeof warning === 'string' ? warning : warning.message).includes('stripTypeScriptTypes')) return;
    (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try { return stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: name }); }
  catch (error) {
    // Node puts the line and a caret under the mistake at the top of the stack; without it a model rewrites blind.
    const where = error instanceof Error ? /^(\S+:\d+\n[\s\S]*?)\n\n\w*Error/.exec(error.stack ?? '')?.[1] : undefined;
    throw new PlayError(`Could not read the app's TypeScript: ${error instanceof Error ? error.message : String(error)}${where ? `\n${where.length > 600 ? `${where.slice(0, 599)}…` : where}` : ''}`);
  }
  finally { process.emitWarning = emit; }
}

let sdk: string | undefined;
/**
 * The SDK file, found the way Node finds packages. A workspace checkout has the TypeScript source,
 * which wins so a stale build is never used; the published package has only dist.
 */
export function sdkPath(): string {
  if (sdk) return sdk;
  for (let directory = dirname(fileURLToPath(import.meta.url)); ; directory = dirname(directory)) {
    for (const file of ['src/index.ts', 'dist/index.js']) {
      const path = join(directory, 'node_modules', '@teapilot', 'discord-play', file);
      if (existsSync(path)) return sdk = realpathSync(path);
    }
    if (dirname(directory) === directory) throw new Error('@teapilot/discord-play is not installed.');
  }
}

/** Validates a call's JSON result string from inside an app realm. */
export function parseResult(output: unknown): CallResult {
  if (typeof output !== 'string') throw new PlayError('The app returned something that is not JSON.');
  if (output.length > maxOutputChars) throw new PlayError(`The app returned ${output.length} characters of state or view; the limit is ${maxOutputChars}.`);
  const parsed = JSON.parse(output) as { value: unknown; seed: unknown };
  return { value: parsed.value, seed: typeof parsed.seed === 'number' ? parsed.seed >>> 0 : 0 };
}
