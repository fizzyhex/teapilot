#!/usr/bin/env node
// Drives teapilot's Discord service against a simulated Discord, for agents whose shell tool runs
// one command at a time. A detached daemon (discord-sim/daemon.ts) owns teapilot and the fake
// Discord; every other command is a short client call that returns plain text. Development tooling only.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = join(tmpdir(), 'teapilot-discord');
const files = name => {
  const directory = join(base, name);
  return { directory, meta: join(directory, 'session.json'), log: join(directory, 'daemon.log'), state: join(directory, 'state'), root: join(directory, 'repo'),
    socket: process.platform === 'win32' ? `\\\\.\\pipe\\teapilot-discord-${name}` : join(directory, 'socket') };
};
const readMeta = name => { try { return JSON.parse(readFileSync(files(name).meta, 'utf8')); } catch { return undefined; } };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

const usage = `Usage: node scripts/agent-discord.mjs <command>

  start [--name N] [--root DIR] [--mode ask|chat] [--config-dir DIR] [--ttl S] [--teachat] [--frozen]
                                     --root is teapilot's repository (default: an empty scratch directory)
                                     --frozen stops the clock: timers fire only when advance reaches them
        [--scratchpad on|off] [--fixture FILE [--fixture-name N] [--fixture-description T]]
        [--history-tokens N] [--compact-history] [--force-retry TOOL] [--trace]
                                     for benchmarks: --scratchpad off is the clipping-only baseline;
                                     --fixture adds a tool (default run_import_diagnostic) returning
                                     FILE's text; --history-tokens caps how much of earlier turns is
                                     replayed; --compact-history cuts down every earlier turn's tool
                                     results, the newest too; --force-retry ends the first attempt after TOOL first
                                     succeeds; --trace records what each model call was sent
  say <name> <text> [--as P] [--in C] [--attach FILE]...
                                     send a message; @op, @user, @stranger and @teapilot become mentions
  slash <name> <command> [--as P] [--in C] [--choose N] [--one-shot]
                                     a slash command as its session text, e.g. "/convo clear",
                                     "/workspace tree src", "/collab join"; --choose N presses button N on
                                     a note that offers some; --one-shot acts as a channel teapilot cannot
                                     post in, where /collab applies
  complete <name> <command> [<typed>] [--as P] [--in C]
                                     what Discord offers while typing an option, e.g. complete d "/workspace tree" sr
  click <name> <message> <control> [--as P]
  repost <name> <message> [--as P]     use Apps → repost this! on a card or game
  share <name> <message> [--as P]      use Apps → Share on an answer or game; slash "/paste" posts it
  select <name> <message> <control> <value...> [--as P]
  submit <name> [--field id=value ...] [--as P]      the form P has open
  approve <name> [--deny] [--as P]   answer the newest waiting approval
  wait <name> --for REGEX | --idle MS [--timeout S]
  screen <name> [--in C] [--last N]  a channel's latest messages (default: the most recently active)
  apps <name> [--json]               every discord.play app (--json writes the records)
  app <name> <id> [--json]           one app: state, view, timers, recent actions and its source
  dump <name> [--out FILE]           the whole simulated Discord as JSON: every message with the
                                     payload Discord received, its controls' ids, warnings, forms,
                                     and every app record. --out writes it to a file and prints
                                     only the path; omit it to print to stdout.
  warnings <name>                    the ⚠ lines as {kind, what, message}, not as text
  advance <name> <duration>          move the clock ahead, e.g. 30s, 5m, 25h
  restart <name>                     restart teapilot; apps and conversation history are recovered
                                     (say "/convo clear" to start a conversation over)
  log <name> [--last N]              teapilot's operator log
  scratch <name> [--last N]          each conversation's scratchpad files, and the scratchpad,
                                     fixture, history and retry events since the session started
  status <name>
  stop <name>
  list

People (--as, default op): op is an operator, user is whitelisted, stranger is neither.
Channels (--in): dm-<person> (the default), channel (teapilot's channel; messages mention it),
and thread-N once teapilot opens one. Messages are m1, m2, ...; controls use their app ids.
Attachments teapilot sends, app pictures included, show as 📎 lines with a path you can open;
they are deleted with the session, so look at them before stop.
wait exit codes: 0 matched, 3 teapilot stopped, 124 timed out. --for matches output since the last
say, click, select, submit, approve, advance or restart; the regex uses the m flag.`;

class UsageError extends Error {}

function request(name, body) {
  return new Promise((done, reject) => {
    const socket = connect(files(name).socket);
    let data = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify(body) + '\n'));
    socket.on('data', chunk => { data += chunk; });
    socket.on('end', () => {
      try {
        const reply = JSON.parse(data);
        if (reply.error) reject(reply.usage ? new UsageError(reply.error) : new Error(reply.error)); else done(reply);
      } catch { reject(new Error('The session daemon closed unexpectedly.')); }
    });
    socket.on('error', reject);
  });
}

async function session(name, body) {
  const meta = readMeta(name);
  if (!meta) throw new UsageError(`No session named ${name}. Use list, or start one.`);
  try { return await request(name, body); }
  catch (error) {
    if (error instanceof UsageError || alive(meta.pid)) throw error;
    return { gone: true, text: 'The session daemon has gone.' };
  }
}

function duration(text) {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(text ?? '');
  if (!match) throw new UsageError('Give a duration like 1500ms, 30s, 5m, 2h or 1d.');
  return Math.round(Number(match[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] ?? 'ms']);
}

async function client(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === 'help') { console.log(usage); return 0; }
  if (command === 'start') {
    const { values } = parseArgs({ args: rest, options: {
      name: { type: 'string', default: 'default' }, root: { type: 'string' }, mode: { type: 'string', default: 'ask' },
      'config-dir': { type: 'string' }, ttl: { type: 'string', default: '1800' }, teachat: { type: 'boolean', default: false }, frozen: { type: 'boolean', default: false },
      scratchpad: { type: 'string', default: 'on' }, fixture: { type: 'string' }, 'fixture-name': { type: 'string', default: 'run_import_diagnostic' },
      'fixture-description': { type: 'string', default: 'Run the import diagnostic and return its snapshot.' },
      'history-tokens': { type: 'string' }, 'compact-history': { type: 'boolean', default: false }, 'force-retry': { type: 'string' }, trace: { type: 'boolean', default: false },
    } });
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(values.name)) throw new UsageError('--name may contain letters, digits, _ and - (at most 40).');
    if (!['ask', 'chat'].includes(values.mode)) throw new UsageError('--mode is ask or chat.');
    if (!['on', 'off'].includes(values.scratchpad)) throw new UsageError('--scratchpad is on or off.');
    if (values['history-tokens'] !== undefined && !/^\d+$/.test(values['history-tokens'])) throw new UsageError('--history-tokens must be a whole number.');
    if (values.fixture && !existsSync(values.fixture)) throw new UsageError(`No fixture file at ${values.fixture}.`);
    const ttl = Number(values.ttl);
    if (!Number.isInteger(ttl) || ttl <= 0) throw new UsageError('--ttl must be a positive integer.');
    const previous = readMeta(values.name);
    if (previous && alive(previous.pid)) throw new UsageError(`Session ${values.name} is already running. Stop it or choose another --name.`);
    const paths = files(values.name);
    rmSync(paths.directory, { recursive: true, force: true });
    mkdirSync(paths.state, { recursive: true });
    if (!values.root) mkdirSync(paths.root, { recursive: true });
    const spec = { name: values.name, directory: paths.directory, socket: paths.socket, meta: paths.meta, log: paths.log, state: paths.state,
      root: values.root ? resolve(values.root) : paths.root, mode: values.mode, configDir: values['config-dir'] && resolve(values['config-dir']), ttl, teachat: values.teachat, frozen: values.frozen,
      bench: { scratchpad: values.scratchpad, historyTokens: values['history-tokens'], compactHistory: values['compact-history'], forceRetry: values['force-retry'], trace: values.trace,
        fixture: values.fixture && { file: resolve(values.fixture), name: values['fixture-name'], description: values['fixture-description'] } } };
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), '--conditions=teapilot-source', join(root, 'scripts', 'discord-sim', 'daemon.ts'), Buffer.from(JSON.stringify(spec)).toString('base64url')],
      { cwd: homedir(), detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    for (const started = Date.now(); ; await new Promise(done => setTimeout(done, 200))) {
      if (existsSync(paths.meta)) {
        try { console.log((await request(values.name, { op: 'hello' })).text); break; } catch { /* not listening yet */ }
      }
      if (Date.now() - started > 60_000 || !alive(child.pid)) {
        const log = existsSync(paths.log) ? readFileSync(paths.log, 'utf8').trim() : '';
        try { process.kill(child.pid); } catch { /* already gone */ }
        rmSync(paths.directory, { recursive: true, force: true });
        throw new Error(`The session daemon did not start.${log ? `\n${log}` : ''}`);
      }
    }
    console.error(`Session ${values.name} started.`);
    return 0;
  }
  if (command === 'list') {
    if (!existsSync(base)) return 0;
    for (const name of readdirSync(base)) {
      const meta = readMeta(name);
      if (meta) console.log(`${meta.name}\t${alive(meta.pid) ? 'running' : 'daemon gone'}\t${meta.mode}\t${meta.root}`);
    }
    return 0;
  }
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
    as: { type: 'string', default: 'op' }, in: { type: 'string' }, for: { type: 'string' }, idle: { type: 'string' }, timeout: { type: 'string', default: '120' },
    last: { type: 'string' }, field: { type: 'string', multiple: true, default: [] }, deny: { type: 'boolean', default: false },
    attach: { type: 'string', multiple: true, default: [] }, choose: { type: 'string' }, 'one-shot': { type: 'boolean', default: false },
    json: { type: 'boolean', default: false }, out: { type: 'string' },
  } });
  const [name, ...args] = positionals;
  if (!name) throw new UsageError(`${command} needs a session name.\n\n${usage}`);
  const need = (count, shape) => { if (args.length < count) throw new UsageError(`Use ${command} <name> ${shape}.`); };
  let body;
  if (command === 'say') {
    if (!args.length && !values.attach.length) throw new UsageError('Use say <name> <text> [--attach FILE]...');
    if (args.length > 1) throw new UsageError('say takes one text argument; quote it.');
    const attach = values.attach.map(path => resolve(path));
    for (const path of attach) if (!existsSync(path)) throw new UsageError(`No file ${path} to attach.`);
    body = { op: 'say', as: values.as, in: values.in, text: args[0] ?? '', attach };
  }
  else if (command === 'slash') {
    need(1, '<command>');
    if (values.choose !== undefined && !/^\d+$/.test(values.choose)) throw new UsageError('--choose takes a button number, from 0.');
    body = { op: 'slash', as: values.as, in: values.in, text: args[0], choose: values.choose === undefined ? undefined : Number(values.choose), oneShot: values['one-shot'] };
  }
  else if (command === 'complete') { need(1, '<command> [<typed>]'); body = { op: 'complete', as: values.as, in: values.in, text: args[0], typed: args[1] ?? '' }; }
  else if (command === 'click') { need(2, '<message> <control>'); body = { op: 'click', as: values.as, message: args[0], control: args[1] }; }
  else if (command === 'repost') { need(1, '<message>'); body = { op: 'repost', as: values.as, message: args[0] }; }
  else if (command === 'share') { need(1, '<message>'); body = { op: 'share', as: values.as, message: args[0] }; }
  else if (command === 'select') { need(3, '<message> <control> <value...>'); body = { op: 'select', as: values.as, message: args[0], control: args[1], values: args.slice(2) }; }
  else if (command === 'submit') {
    const fields = Object.fromEntries(values.field.map(entry => {
      const at = entry.indexOf('=');
      if (at < 1) throw new UsageError('Give fields as --field id=value.');
      return [entry.slice(0, at), entry.slice(at + 1)];
    }));
    body = { op: 'submit', as: values.as, fields };
  }
  else if (command === 'approve') body = { op: 'approve', as: values.as, deny: values.deny };
  else if (command === 'wait') {
    if (values.for === undefined && values.idle === undefined) throw new UsageError('wait needs --for REGEX or --idle MS.');
    if (values.for !== undefined) new RegExp(values.for, 'm');
    const timeout = Number(values.timeout), idle = values.idle === undefined ? undefined : Number(values.idle);
    if (!(timeout > 0) || (idle !== undefined && !(idle > 0))) throw new UsageError('--timeout and --idle must be positive numbers.');
    const reply = await session(name, { op: 'wait', pattern: values.for, idle, timeout });
    console.log(reply.screen ?? reply.text);
    return reply.gone ? 3 : reply.code;
  }
  else if (command === 'screen') body = { op: 'screen', in: values.in, last: values.last };
  else if (command === 'apps') body = { op: 'apps' };
  else if (command === 'app') { need(1, '<id>'); body = { op: 'app', id: args[0] }; }
  else if (command === 'dump') body = { op: 'dump' };
  else if (command === 'warnings') body = { op: 'warnings' };
  else if (command === 'advance') { need(1, '<duration>'); body = { op: 'advance', ms: duration(args[0]) }; }
  else if (command === 'log') body = { op: 'log', last: values.last };
  else if (command === 'scratch') body = { op: 'scratch', last: values.last };
  else if (['restart', 'status', 'stop'].includes(command)) body = { op: command };
  else throw new UsageError(`Unknown command ${command}.\n\n${usage}`);
  const reply = await session(name, body);
  // --json and --out prefer the structured payload over the rendered text, and --out prints the path only.
  if (command === 'dump' && reply.snapshot) {
    const payload = { snapshot: reply.snapshot, apps: reply.apps ?? [] };
    if (values.out) {
      const path = resolve(values.out);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      console.log(path);
    } else console.log(JSON.stringify(payload));
  } else if (values.json) console.log(JSON.stringify(reply[command === 'app' ? 'app' : command === 'apps' ? 'apps' : 'warnings'] ?? null, null, 2));
  else console.log(reply.text);
  if (command === 'stop') rmSync(files(name).directory, { recursive: true, force: true });
  return reply.gone && command !== 'stop' ? 3 : 0;
}

client(process.argv.slice(2)).then(code => { if (code !== undefined) process.exitCode = code; }, error => {
  console.error(error instanceof UsageError ? error.message : `agent-discord: ${error.message}`);
  process.exitCode = 1;
});
