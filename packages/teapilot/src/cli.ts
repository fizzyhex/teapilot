#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { configDirectory, isTierPreference, loadConfig, tierPreferences, type Workload } from './config.js';
import { runHost, type HostRequest } from './host.js';
import { casualLines, paceLines } from './casual.js';
import { runSession } from './chat.js';
import { doctor } from './diagnostics.js';
import { setup } from './setup/index.js';
import { ManagedSearch } from './setup/searxng.js';
import { terminalUI } from './setup/terminal.js';
import type { Approve } from './execution/policy.js';
import { serve } from './integration/service.js';
import { SearchSetupError } from './search.js';
import { TerminalPresentation } from './presentation.js';
import { isMode, SessionGrants } from './execution/grants.js';
import { randomUUID } from 'node:crypto';
import { SkillStore } from './skills/store.js';
import { skillCache } from './skills/cache.js';

const help = `teapilot!

teapilot setup
teapilot ask ["Explain dependency injection"]
teapilot chat ["Help me think through an idea"]
teapilot code --cwd <repository> ["Fix the failing tests"]
teapilot --prompt "Summarise this idea"   (one-shot, no session)
teapilot doctor [--live]
teapilot search status|start|stop|remove
teapilot runtime status|start|stop   (the model server TeaPilot installed, e.g. after a restart)
teapilot skills list|enable|disable|add|remove|update|offline|reset [set[::skill]]
teapilot discord setup|start|status|remove   (start: --no-funnel for local-only browser play)
teapilot teachat   (browse the agents' chatroom)
teapilot bridge host [port] [--ts] [--token]   (share this computer's teapilot over your tailnet)
teapilot bridge connect [port|host]
teapilot serve --stdio

  Options: --cwd PATH  --config-dir PATH  --prompt TEXT  --web  --json  --once  --tier auto|fast|normal|reasoning|deep
         --correction TEXT  --no-motion  --verbose (setup progress)  --help
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    cwd: { type: 'string', default: process.cwd() }, 'config-dir': { type: 'string' },
    prompt: { type: 'string' }, correction: { type: 'string' }, web: { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    live: { type: 'boolean' }, 'non-interactive': { type: 'boolean' }, endpoint: { type: 'string' }, model: { type: 'string' }, 'context-tokens': { type: 'string' },
    stdio: { type: 'boolean' }, tier: { type: 'string' }, once: { type: 'boolean' },
    'no-motion': { type: 'boolean' },
    verbose: { type: 'boolean' },
    'no-funnel': { type: 'boolean' },
    ts: { type: 'boolean' }, token: { type: 'boolean' }, 'rotate-token': { type: 'boolean' },
  } });
  if (values.help) { console.log(help); return; }
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 19)) throw new Error('TeaPilot requires Node >=22.19.0.');
  const command = ['setup', 'doctor', 'ask', 'chat', 'code', 'serve', 'search', 'runtime', 'discord', 'bridge', 'teachat', 'skills'].includes(positionals[0] ?? '') ? positionals.shift() : undefined;
  if (command === 'serve') { if (!values.stdio) throw new Error('serve requires --stdio'); await serve(); return; }
  if (command === 'teachat') {
    if (positionals.length) throw new Error('Use teapilot teachat.');
    // The viewer reads keys itself, so it opens before the line-based terminal does.
    const { viewTeachat } = await import('./teachat/viewer.js');
    const controller = new AbortController();
    const onInterrupt = () => controller.abort();
    process.once('SIGINT', onInterrupt);
    try { process.exitCode = await viewTeachat(values['config-dir'], controller.signal) ? 0 : 1; }
    finally { process.removeListener('SIGINT', onInterrupt); }
    return;
  }
  if (values.stdio) throw new Error('--stdio requires serve');
  if (command !== 'setup' && [values['non-interactive'], values.endpoint, values.model, values['context-tokens']].some(value => value !== undefined)) throw new Error('Endpoint/model and unattended setup options require the setup command.');
  if (values.live && command !== 'doctor') throw new Error('--live requires the doctor command.');
  if (values['no-funnel'] && (command !== 'discord' || positionals[0] !== 'start')) throw new Error('--no-funnel requires teapilot discord start.');
  if ((values.ts || values.token || values['rotate-token']) && command !== 'bridge') throw new Error('--ts, --token and --rotate-token require teapilot bridge host.');
  const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY);
  const controller = new AbortController();
  const presentation = new TerminalPresentation(Boolean(values.json), Boolean(values['no-motion'] || values['non-interactive']));
  const ui = interactive ? terminalUI(controller.signal, presentation) : undefined;
  const onInterrupt = () => { presentation.close(); controller.abort(); ui?.close(); };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onInterrupt);
  let skillStateDir: string | undefined;
  try {
    if (command === 'setup') {
      if (!interactive && !values['non-interactive']) throw new Error('Setup needs an interactive terminal, or --non-interactive with an existing endpoint.');
      const headless = {
        log: (text: string) => console.error(text),
        input: async (): Promise<string> => { throw new Error('Unattended setup requires --endpoint, --model, and --context-tokens.'); },
        choose: async (): Promise<number> => { throw new Error('This setup choice requires an interactive terminal.'); },
        confirm: async () => false,
      };
      const ready = await setup({ directory: values['config-dir'], verbose: values.verbose, nonInteractive: values['non-interactive'], endpoint: values.endpoint, model: values.model, contextTokens: values['context-tokens'] === undefined ? undefined : Number(values['context-tokens']) }, ui ?? headless, controller.signal);
      process.exitCode = ready ? 0 : 2;
      return;
    }
    const directory = await configDirectory(values['config-dir']);
    if (command === 'search') {
      const action = positionals.shift() ?? 'status';
      if (positionals.length) throw new Error('Use teapilot search status|start|stop|remove.');
      const serviceUI = ui ?? { log: (text: string) => console.error(text), confirm: async () => { throw new Error('Starting or removing search requires an interactive terminal.'); }, input: async () => '', choose: async () => 0 };
      process.exitCode = await new ManagedSearch(directory, controller.signal).manage(action, serviceUI) ? 0 : 2;
      return;
    }
    if (command === 'discord') {
      const action = positionals.shift() ?? 'status';
      if (positionals.length) throw new Error('Use teapilot discord setup|start|status|remove.');
      if (!ui && ['setup', 'remove'].includes(action)) throw new Error(`teapilot discord ${action} requires an interactive terminal.`);
      const { discord } = await import('./discord/index.js');
      const discordUI = ui ?? { log: (text: string) => console.error(text), confirm: async () => false, input: async () => '', choose: async () => 0 };
      process.exitCode = await discord(action, { directory, cwd: resolve(values.cwd), ui: discordUI, signal: controller.signal, funnel: !values['no-funnel'] }) ? 0 : 2;
      return;
    }
    if (command === 'bridge') {
      const action = positionals.shift() ?? '';
      const target = positionals.shift();
      if (positionals.length || !['host', 'connect'].includes(action)) throw new Error('Use teapilot bridge host [port] or teapilot bridge connect [port|host].');
      if (action === 'connect' && (values.ts || values.token || values['rotate-token'])) throw new Error('--ts, --token and --rotate-token apply to teapilot bridge host.');
      const { bridge } = await import('./bridge/index.js');
      const bridgeUI = ui ?? { log: (text: string) => console.error(text), confirm: async () => false, input: async () => '', choose: async () => 0 };
      process.exitCode = await bridge(action, target, { directory, cwd: resolve(values.cwd), ui: bridgeUI, presentation, signal: controller.signal, tailscale: values.ts, requireToken: values.token, rotateToken: values['rotate-token'] }) ? 0 : 2;
      return;
    }
    let config;
    try { config = await loadConfig(values['config-dir'], { ...process.env }); }
    catch (error) {
      console.error(`Configuration: ${directory} (${values['config-dir'] ? 'explicit --config-dir' : directory === process.cwd() ? 'launch directory' : 'personal profile'}). Repair: teapilot setup --config-dir "${directory}"`);
      throw error;
    }
    const secrets = [config.router.apiKey, ...Object.values(config.secrets)].filter((value): value is string => Boolean(value));
    skillStateDir = config.stateDir;
    const redact = (message: string) => secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), message);
    const approve: Approve = async approval => {
      if (!ui || controller.signal.aborted || approval.signal?.aborted) return false;
      presentation.approval(redact(`${approval.summary}\n${approval.details ?? ''}`));
      return await ui.confirm('Approve this action?', approval.signal);
    };
    const skillStore = new SkillStore(config.stateDir, config.skills ?? { enabled: true });
    if (command === 'skills') {
      console.log(redact(await skillStore.command(positionals.join(' '), { operator: true }, controller.signal)));
      return;
    }
    if (command === 'runtime') {
      const action = positionals.shift() ?? 'status';
      if (positionals.length) throw new Error('Use teapilot runtime status|start|stop.');
      const { manageRuntimes } = await import('./runtime/manage.js');
      const runtimeUI = ui ?? { log: (text: string) => console.error(text), confirm: async () => false, input: async () => '', choose: async () => 0 };
      process.exitCode = await manageRuntimes(action, config, runtimeUI, controller.signal) ? 0 : 2;
      return;
    }
    if (command === 'doctor') {
      process.exitCode = await doctor(config, values.cwd, { live: values.live, signal: controller.signal, consent: async message => ui ? ui.confirm(redact(message)) : false, activity: presentation.activity, log: text => presentation.write(redact(text) + '\n', 'stdout') }) ? 0 : 1;
      return;
    }
    // ask, chat and code share one session interface; only their starting mode differs.
    const mode = isMode(command) ? command : undefined;
    let workload: Workload | undefined;
    if (config.routingMode === 'direct' && !mode) {
      if (!ui) throw new Error('Direct routing requires teapilot ask or teapilot code.');
      workload = await ui.choose('What would you like to do?', ['Ask a question (no repository tools)', 'Work on code in the selected repository']) === 0 ? 'ask' : 'coder';
    }
    const prompt = values.prompt ?? (positionals.length ? positionals.join(' ') : ui && !mode ? await ui.prompt('teapilot', resolve(values.cwd)) : '');
    if (!prompt.trim() && !interactive) throw new Error('Supply a prompt; use teapilot setup for first use or --help for examples.');
    if (values.tier !== undefined && !isTierPreference(values.tier)) throw new Error(`--tier must be ${tierPreferences.join(', ')}.`);
    const tier = values.tier;
    const request: HostRequest = { prompt, workload, cwd: resolve(values.cwd), web: values.web, correction: values.correction, tier, signal: controller.signal };
    const dependencies = { approve, onActivity: presentation.setActivity, onProgress: (message: string) => presentation.log(redact(message)), onEvent: (event: import('./integration/events.js').HostEvent) => presentation.event(event) };
    const execute = async (request: HostRequest) => {
      let result;
      presentation.start();
      try { result = await runHost(config, request, dependencies); }
      catch (error) {
        if (!(error instanceof SearchSetupError) || !ui || values.json) throw error;
        presentation.pause();
        presentation.log(error.message);
        if (!await ui.confirm('Continue without web search? The answer will be unverified against current sources.')) throw error;
        presentation.start();
        result = await runHost(config, { ...request, web: false }, dependencies);
        result.text = `Web search was unavailable. This answer is unverified against current sources.\n\n${result.text}`;
      }
      // A conversational reply is shown a line at a time, like messages arriving, and without a result line.
      const lines = result.casual && result.success && !values.json ? casualLines(result.text) : undefined;
      if (values.json) console.log(JSON.stringify(result, null, 2));
      else if (lines) await paceLines(lines, line => presentation.answer(line), { signal: controller.signal });
      else presentation.answer(result.text);
      if (!values.json && request.side) presentation.log('\nSide answer; not kept in this conversation.');
      if (!values.json && !lines) presentation.log(`\nResult: ${result.status}; accounted $${result.spentUsd.toFixed(6)}; request ${result.requestId}${result.receipts.length ? `\nReceipts: ${result.receipts.join(', ')}` : ''}`);
      return result;
    };
    if (mode) {
      const authorization = await SessionGrants.create(request.cwd, config, mode, Boolean(values.web));
      const once = Boolean(values.once || values.json || !interactive);
      if (interactive && !values.json && !values.once) presentation.log(`${mode[0]!.toUpperCase()}${mode.slice(1)} session started. Type /exit or /quit to leave.`);
      // Teachat only runs where someone can see it and press a key to stop it.
      const teachat = ui && !once ? await openTeachat(config, ui, presentation) : undefined;
      const [{ SrtSandbox }, { WorkspaceStore }, { TerminalWorkspace }] = await Promise.all([import('./workspace/sandbox.js'), import('./workspace/store.js'), import('./workspace/terminal.js')]);
      const sandbox = new SrtSandbox(config.stateDir, config.workspace, config.source?.directory);
      const workspace = new TerminalWorkspace(WorkspaceStore.at(config.stateDir), sandbox, approve);
      const skillSession = `terminal:${randomUUID()}`;
      const skillCaller = { operator: true, conversation: skillSession };
      try {
        process.exitCode = await runSession({ request: { ...request, authorization, mode }, maxPromptChars: config.policy.limits.maxPromptChars,
          input: state => ui ? ui.prompt('>', state.cwd ?? resolve(values.cwd), { ...state, routingMode: config.routingMode ?? 'hosted', idle: teachat?.composerIdle() }) : Promise.reject(Object.assign(new Error('closed'), { name: 'TerminalClosedError' })),
           run: execute, once, approve, log: message => presentation.log(message), onEvent: dependencies.onEvent, extension: teachat, workspace,
           skills: { preferences: () => skillStore.effective(skillCaller), command: args => skillStore.command(args, skillCaller, controller.signal) } });
       } finally {
         try { if (config.skills?.enabled !== false && !config.skills?.directory) skillStore.forget(skillSession); } catch (error) { presentation.log(error instanceof Error ? error.message : String(error)); }
         await workspace.close().catch(() => undefined); await sandbox.close().catch(() => undefined);
       }
      await teachat?.close(controller.signal);
    } else {
      const result = await execute(request);
      process.exitCode = result.success ? 0 : 2;
    }
  } finally { if (skillStateDir) await skillCache(skillStateDir).close(); presentation.close(); ui?.close(); process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onInterrupt); }
}

async function openTeachat(config: Awaited<ReturnType<typeof loadConfig>>, ui: NonNullable<ReturnType<typeof terminalUI>>, presentation: TerminalPresentation) {
  const [{ TeachatService }, { terminalTeachat }] = await Promise.all([import('./teachat/service.js'), import('./teachat/session.js')]);
  let service;
  try { service = await TeachatService.open(config); }
  catch (error) { presentation.log(`Teachat is unavailable this session: ${error instanceof Error ? error.message : String(error)}`); }
  return terminalTeachat(config, service, { view: () => presentation.gossip(), log: message => presentation.log(message) });
}

main().catch(error => {
  if (error && typeof error === 'object' && 'issues' in error) console.error('Invalid configuration. Check model rates, endpoint URLs, context sizes, and policy field types. Run teapilot setup.');
  else if (error?.name === 'AbortError') console.error('Cancelled.');
  else console.error(error instanceof Error ? error.message : 'teapilot failed');
  process.exitCode = 1;
});
