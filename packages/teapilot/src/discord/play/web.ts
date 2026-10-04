import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, access } from 'node:fs/promises';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import type { User } from '@teapilot/discord-play';
import { publishPlay } from './funnel.js';
import type { PlayRuntime } from './runtime.js';
import { WorkspaceEditor } from './editor.js';
import type { WorkspaceStore } from '../../workspace/store.js';

interface Grant { id: string; user: User; until: number }
const nonce = () => randomBytes(32).toString('base64url');
const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.md': 'text/plain', '.txt': 'text/plain' };

/** A single local host; launch tickets carry only the identity established by Discord. */
export async function openPlayWeb(runtime: PlayRuntime, options: { funnel: boolean; log(text: string): void; port?: number; signal?: AbortSignal; assets?: string; workspace?: WorkspaceStore }) {
  const tickets = new Map<string, Grant>(), sessions = new Map<string, Grant>();
  const editor = options.workspace ? new WorkspaceEditor(options.workspace) : undefined;
  const root = options.assets ?? resolve(dirname(fileURLToPath(import.meta.resolve('@teapilot/discord-play'))), '../dist/web');
  await access(resolve(root, 'index.html'));
  let origin = `http://localhost:${options.port ?? 2048}`;
  const valid = (map: Map<string, Grant>, key: string | undefined) => {
    const grant = key ? map.get(key) : undefined;
    if (grant && grant.until > Date.now()) return grant;
    if (key) map.delete(key);
  };
  const cookie = (id: string, value = '') => value.split(/;\s*/).find(part => part.startsWith(`play_${id}=`))?.split('=')[1];
  const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, async (req, res) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: http: data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      const url = new URL(req.url ?? '/', origin);
      if (editor && await editor.handle(req, res, origin)) return;
      if (req.method === 'POST' && url.pathname === '/launch') {
        if (req.headers.origin !== origin) { res.writeHead(403).end(); return; }
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 512) { res.writeHead(413).end(); return; } }
        const { ticket, id } = JSON.parse(body);
        const grant = valid(tickets, ticket);
        if (!grant || grant.id !== id) { res.writeHead(401).end('this link expired. open the app from discord again.'); return; }
        tickets.delete(ticket);
        await runtime.browserView(grant.id, grant.user);
        if (sessions.size >= 1000) { res.writeHead(503).end('too many browser sessions. try again later.'); return; }
        const token = nonce(); sessions.set(token, { ...grant, until: Date.now() + 24 * 60 * 60_000 });
        res.setHeader('Set-Cookie', `play_${grant.id}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${origin.startsWith('https:') ? '; Secure' : ''}`);
        res.end(); return;
      }
      if (req.method !== 'GET') { res.writeHead(405).end(); return; }
      const route = /^\/(media|session)\/([a-z0-9]+)(?:\/(.+))?$/.exec(url.pathname);
      if (route) {
        const grant = valid(sessions, cookie(route[2]!, req.headers.cookie));
        if (!grant || grant.id !== route[2]) { res.writeHead(401).end(); return; }
        const view = await runtime.browserView(grant.id, grant.user);
        if (route[1] === 'session') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ user: grant.user.id })); return; }
        const name = decodeURIComponent(route[3] ?? '');
        const file = view.payload.files?.find(file => file.name === name);
        if (!file) { res.writeHead(404).end(); return; }
        res.setHeader('Content-Type', types[extname(name)] ?? 'application/octet-stream'); res.end(file.data); return;
      }
      const path = /^\/(?:play\/[a-z0-9]+|edit\/[a-f0-9]{24})$/.test(url.pathname) ? 'index.html' : url.pathname.slice(1);
      if (!path || path.startsWith('/') || path.includes('..') || !/^[\w/.-]+$/.test(path)) { res.writeHead(404).end(); return; }
      const data = await readFile(resolve(root, path));
      res.setHeader('Content-Type', types[extname(path)] ?? 'application/octet-stream'); res.end(data);
    } catch { res.writeHead(404).end('unavailable'); }
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const connections = new Map<WebSocket, Grant>();
  server.on('upgrade', (req, socket, head) => {
    const id = /^\/live\/([a-z0-9]+)$/.exec(req.url ?? '')?.[1];
    const grant = valid(sessions, cookie(id ?? '', req.headers.cookie));
    if (req.url !== `/live/${grant?.id}` || req.headers.origin !== origin || !grant) { socket.destroy(); return; }
    sockets.handleUpgrade(req, socket, head, ws => {
      if (sockets.clients.size > 100 || [...connections.values()].filter(value => value === grant).length >= 4) { ws.close(1013); return; }
      connections.set(ws, grant);
      const send = (value: unknown) => {
        if (grant.until <= Date.now() || ws.bufferedAmount > 1024 * 1024) { ws.close(1008); return; }
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
      };
      let busy = false, painting = false, dirty = false;
      const paint = async () => {
        if (painting) { dirty = true; return; }
        painting = true;
        try {
          do {
            dirty = false;
            const view = await runtime.browserView(grant.id, grant.user);
            const { files: _, ...payload } = view.payload;
            send({ type: 'view', ...view, payload });
          } while (dirty && ws.readyState === WebSocket.OPEN);
        } catch { send({ type: 'error', text: 'this app is unavailable.' }); }
        finally { painting = false; }
      };
      const unsubscribe = runtime.subscribe(id => { if (id === grant.id) void paint(); });
      ws.on('close', () => { unsubscribe(); connections.delete(ws); });
      ws.on('error', () => ws.close());
      let last = 0;
      ws.on('message', async raw => {
        if (grant.until <= Date.now()) { ws.close(); return; }
        try {
          const message = JSON.parse(raw.toString());
          if (message.type === 'ping') { send({ type: 'pong', at: message.at }); return; }
          if (message.type !== 'press' || typeof message.id !== 'string' || message.id.length > 64) return;
          if (busy || Date.now() - last < 100) { send({ type: 'ack', text: 'still processing…' }); return; }
          busy = true; last = Date.now();
          try { send({ type: 'ack', notes: await runtime.browserPress(grant.id, message.id, grant.user), text: '' }); }
          catch (error) { send({ type: 'ack', text: error instanceof Error ? error.message : 'that press did not work.' }); }
          finally { busy = false; }
        } catch { ws.close(1008); }
      });
      void paint();
    });
  });
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(options.port ?? 2048, '127.0.0.1', accept); });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port ?? 2048;
  origin = `http://localhost:${port}`;
  let stopFunnel: (() => Promise<void>) | undefined;
  if (options.funnel) {
    try {
      stopFunnel = await publishPlay({ port, signal: options.signal, log: options.log, changed: value => { origin = value ?? `http://localhost:${port}`; } });
    } catch (error) { options.log(`browser play: ${error instanceof Error ? error.message : error}. local access only.`); }
  }
  const sweep = setInterval(() => {
    for (const map of [tickets, sessions]) for (const [key, grant] of map) if (grant.until <= Date.now()) map.delete(key);
    for (const [ws, grant] of connections) if (grant.until <= Date.now()) ws.close(1008);
  }, 60_000);
  sweep.unref();
  return {
    launch(channelId: string, messageId: string, user: User): string | undefined {
      if (tickets.size >= 1000) return;
      const id = runtime.browserTarget(channelId, messageId, user);
      if (!id) return;
      const ticket = nonce(); tickets.set(ticket, { id, user, until: Date.now() + 5 * 60_000 });
      return `${origin}/play/${id}#${ticket}`;
    },
    editLink(conversation: string, path: string, user: User): string | undefined { return editor?.launch(origin, conversation, path, user.id); },
    bindFileReply(message: string, conversation: string, path: string, user: string): void { editor?.bindFileMessage(message, conversation, path, user); },
    editFileMessage(message: string, user: string): string | null | undefined {
      if (!editor?.hasFileMessage(message)) return undefined;
      return editor.launchForFileMessage(origin, message, user) ?? null;
    },
    get origin() { return origin; },
    async close() { clearInterval(sweep); await stopFunnel?.(); tickets.clear(); sessions.clear(); editor?.close(); for (const ws of sockets.clients) ws.terminate(); sockets.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); },
  };
}
