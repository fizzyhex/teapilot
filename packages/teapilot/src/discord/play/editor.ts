import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WorkspaceStore } from '../../workspace/store.js';

type Grant = { id: string; user: string; conversation: string; path: string; until: number };
const token = () => randomBytes(32).toString('base64url');
const json = (res: ServerResponse, status: number, value?: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(value === undefined ? '' : JSON.stringify(value)); };

/** Independent, exact-file browser editor authorization for the shared play HTTP host. */
export class WorkspaceEditor {
  private readonly key = randomBytes(32);
  private readonly tickets = new Map<string, Grant>();
  private readonly sessions = new Map<string, Grant>();
  private readonly fileMessages = new Map<string, Grant>();
  constructor(private readonly store: WorkspaceStore) {}

  launch(origin: string, conversation: string, path: string, user: string): string | undefined {
    for (const [ticket, grant] of this.tickets) if (grant.until <= Date.now()) this.tickets.delete(ticket);
    if (this.tickets.size >= 1000) return;
    const file = this.store.readEditable(conversation, path);
    if (!file) return;
    const id = randomBytes(12).toString('hex');
    const grant = { id, user, conversation, path, until: Date.now() + 5 * 60_000 };
    const ticket = token(), signature = createHmac('sha256', this.key).update(ticket).digest('base64url');
    this.tickets.set(`${ticket}.${signature}`, grant);
    return `${origin}/edit/${id}#${ticket}.${signature}`;
  }

  /** Bind a Discord file reply to its exact workspace identity; menu invocations must still be by that user. */
  bindFileMessage(message: string, conversation: string, path: string, user: string): void {
    const registered = this.store.readEditable(conversation, path);
    if (!registered) return;
    this.fileMessages.set(message, { id: message, user, conversation, path, until: Date.now() + 14 * 60_000 });
    while (this.fileMessages.size > 1000) this.fileMessages.delete(this.fileMessages.keys().next().value!);
  }
  launchForFileMessage(origin: string, message: string, user: string): string | undefined {
    const grant = this.fileMessages.get(message);
    if (!grant || grant.until <= Date.now() || !this.store.readEditable(grant.conversation, grant.path)) { this.fileMessages.delete(message); return; }
    if (grant.user !== user) return;
    return this.launch(origin, grant.conversation, grant.path, user);
  }
  hasFileMessage(message: string): boolean { return this.fileMessages.has(message); }

  async handle(req: IncomingMessage, res: ServerResponse, origin: string): Promise<boolean> {
    const url = new URL(req.url ?? '/', origin);
    if (url.pathname === '/edit/launch' && req.method === 'POST') {
      if (req.headers.origin !== origin) { res.writeHead(403).end(); return true; }
      const body = await this.body(req, res, 2048);
      if (!body) return true;
      try {
        const { ticket, id } = JSON.parse(body) as { ticket?: string; id?: string };
        const parts = typeof ticket === 'string' ? ticket.split('.') : [];
        const supplied = parts[1] ?? '', expected = parts[0] ? createHmac('sha256', this.key).update(parts[0]).digest('base64url') : '';
        const validSignature = supplied.length === expected.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
        const grant = validSignature && typeof ticket === 'string' ? this.tickets.get(ticket) : undefined;
        if (!grant || grant.id !== id || grant.until <= Date.now()) { res.writeHead(401).end(); return true; }
        this.tickets.delete(ticket!);
        if (!this.store.readEditable(grant.conversation, grant.path)) { res.writeHead(404).end(); return true; }
        for (const [sessionId, session] of this.sessions) if (session.until <= Date.now()) this.sessions.delete(sessionId);
        if (this.sessions.size >= 1000) { res.writeHead(503).end(); return true; }
        const session = token(); this.sessions.set(session, { ...grant, until: Date.now() + 60 * 60_000 });
        res.setHeader('Set-Cookie', `workspace_edit=${session}; HttpOnly; SameSite=Strict; Path=/api/edit/${grant.id}; Max-Age=3600${origin.startsWith('https:') ? '; Secure' : ''}`);
        res.writeHead(204).end();
      } catch { res.writeHead(400).end(); }
      return true;
    }
    const route = /^\/api\/edit\/([a-f0-9]{24})$/.exec(url.pathname);
    if (!route) return false;
    if ((req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') { res.writeHead(403).end(); return true; }
    const id = route[1]!;
    const sessionId = req.headers.cookie?.split(/;\s*/).find(part => part.startsWith('workspace_edit='))?.slice('workspace_edit='.length);
    const grant = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!grant || grant.id !== id || grant.until <= Date.now()) { if (sessionId) this.sessions.delete(sessionId); res.writeHead(401).end(); return true; }
    if (req.method === 'GET') {
      const result = this.store.readEditable(grant.conversation, grant.path);
      if (!result) { res.writeHead(404).end(); return true; }
      json(res, 200, { name: result.file.name, content: result.content, revision: result.revision }); return true;
    }
    if (req.method !== 'PUT') { res.writeHead(405).end(); return true; }
    if (req.headers.origin !== origin) { res.writeHead(403).end(); return true; }
    // JSON may represent each UTF-8 byte as six ASCII characters (`\\u00xx`): reserve safely for escapes,
    // while saveEditable still enforces the actual decoded content byte limit.
    const body = await this.body(req, res, 6_300_000);
    if (!body) return true;
    try {
      const data = JSON.parse(body);
      if (typeof data.content !== 'string' || data.content.includes('\0') || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(data.content)
        || typeof data.revision !== 'string' || !/^[a-f0-9]{64}$/.test(data.revision)) { res.writeHead(400).end(); return true; }
      const result = this.store.saveEditable(grant.conversation, grant.path, data.content, data.revision, grant.user);
      if (result === 'conflict') { res.writeHead(409).end(); return true; }
      if (!result) { res.writeHead(413).end(); return true; }
      json(res, 200, { name: result.file.name, content: result.content, revision: result.revision });
    } catch { res.writeHead(400).end(); }
    return true;
  }

  private async body(req: IncomingMessage, res: ServerResponse, limit: number): Promise<string | undefined> {
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of req) { const data = Buffer.from(chunk); bytes += data.length; if (bytes > limit) { res.writeHead(413).end(); return; } chunks.push(data); }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
    catch { res.writeHead(400).end(); return; }
  }
  close(): void { this.tickets.clear(); this.sessions.clear(); this.fileMessages.clear(); this.key.fill(0); }
}
