import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'teapilot-package-'));
const home = join(scratch, 'home'), workspace = join(scratch, 'workspace');
await mkdir(home); await mkdir(workspace);
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(TEAPILOT_|TEACHAT_|LOCAL_|ECONOMY_|STRONG_|JEV_|TYPESAFE_|OPENROUTER_|REQUEST_BUDGET_USD|DAILY_BUDGET_USD)/.test(key)));
const env = { ...cleanEnv, HOME: home, USERPROFILE: home, TEAPILOT_STATE_DIR: join(home, '.teapilot'), TEAPILOT_SKILLS_OFFLINE: 'on', WORKSPACE_SANDBOX: 'off', npm_config_git: 'teapilot-git-must-not-run', NO_COLOR: '1' };
const npm = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
function run(args, cwd = workspace, runEnv = env, expectedCode = 0) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env: runEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill(), 180000);
    child.stdout.on('data', part => { stdout += part; }); child.stderr.on('data', part => { stderr += part; });
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); code === expectedCode ? resolve(stdout) : reject(new Error(`Command failed (${code}; expected ${expectedCode}): ${stdout}\n${stderr}`)); });
  });
}
function complete(response, { text, tool }) {
  response.setHeader('Content-Type', 'text/event-stream');
  const common = { id: 'package-smoke', object: 'chat.completion.chunk', created: 1, model: 'mock' };
  const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${Date.now()}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } : { role: 'assistant', content: text };
  response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\n`);
  response.end('data: [DONE]\n\n');
}
const server = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const part of request) raw += part;
    if (request.url === '/v1/models') { response.end(JSON.stringify({ data: [{ id: 'mock' }] })); return; }
    assert.equal(request.url, '/v1/chat/completions', 'No hosted API calls are allowed');
    const body = JSON.parse(raw);
    const prompt = JSON.stringify(body.messages.filter(message => message.role === 'user').map(message => message.content));
    const toolMessages = body.messages.filter(message => message.role === 'tool');
    if (prompt.includes('TEAPILOT_OK')) complete(response, { text: 'TEAPILOT_OK' });
    else if (prompt.includes('teapilot_probe')) {
      complete(response, toolMessages.length ? { text: String(toolMessages.at(-1).content) } : { tool: { name: 'teapilot_probe', args: {} } });
    } else if (prompt.includes('Read fixture.js')) {
      if (toolMessages.length === 0) complete(response, { tool: { name: 'read', args: { path: 'fixture.js' } } });
      else if (toolMessages.length === 1) {
        const nonce = String(toolMessages[0].content).match(/\/\/ ([\da-f-]+)/)?.[1];
        complete(response, { tool: { name: 'write', args: { path: 'fixture.js', content: `// ${nonce}\nexport const add = (a, b) => a + b;\n` } } });
      } else complete(response, { text: 'DONE' });
    } else if (prompt.includes('Create result.txt')) {
      if (!toolMessages.length && body.tools?.some(tool => tool.function.name === 'request_capabilities')) {
        complete(response, { tool: { name: 'request_capabilities', args: { permissions: ['repository.read', 'repository.write'] } } });
      } else {
        const writes = new Set(body.messages.flatMap(message => message.tool_calls ?? []).filter(call => call.function.name === 'write').map(call => call.id));
        complete(response, toolMessages.some(message => writes.has(message.tool_call_id)) ? { text: 'Created result.txt.' } : { tool: { name: 'write', args: { path: 'result.txt', content: 'verified\n' } } });
      }
    } else complete(response, { text: 'A local answer.' });
  } catch (error) { response.writeHead(500); response.end(String(error)); }
});
try {
  console.log('Packing and checking package contents...');
  const packed = JSON.parse(await run([join(root, 'scripts/pack.mjs'), '--json', '--pack-destination', scratch], root, process.env))[0];
  for (const name of ['typing', 'pawing', 'tea-break']) assert(packed.files.some(file => file.path === `dist/art/ascii-${name}.json`));
  assert(packed.files.some(entry => entry.path === 'dist/skills/cache.js'));
  assert(!packed.files.some(entry => /dist\/skills\/(?:.*SKILL\.md|snapshot\.json|LICENSE)$/.test(entry.path)));
  assert(packed.bundled.includes('jevrouter') && packed.bundled.includes('yaml') && packed.bundled.includes('teachat'));
  assert(packed.files.some(file => file.path === 'node_modules/teachat/dist/index.js') && !packed.files.some(file => file.path.startsWith('node_modules/teachat/src/')));
  assert(packed.bundled.includes('pretty-send'));
  assert(packed.files.some(file => file.path === 'node_modules/pretty-send/dist/index.js') && !packed.files.some(file => file.path.startsWith('node_modules/pretty-send/src/')));
  assert(packed.bundled.includes('@teapilot/discord-play'));
  assert(packed.files.some(file => file.path === 'node_modules/@teapilot/discord-play/dist/index.js') && !packed.files.some(file => file.path.startsWith('node_modules/@teapilot/discord-play/src/')));
  for (const file of ['index.html', 'licenses.md', 'font-notice.txt']) assert(packed.files.some(entry => entry.path === `node_modules/@teapilot/discord-play/dist/web/${file}`));
  assert(packed.files.some(file => /node_modules\/@teapilot\/discord-play\/dist\/web\/assets\/.*\.ttf$/.test(file.path)));
  assert(packed.files.some(file => file.path === 'node_modules/jevrouter/LICENSE'));
  assert(!packed.files.some(file => /(^|\/)\.env($|\.)/.test(file.path) || /^config\/(models|policy)\.json$/.test(file.path)));
  console.log('Installing packed artifact with Git disabled...');
  await run([npm, 'install', '--prefix', join(scratch, 'installed'), '--omit=dev', '--no-audit', '--no-fund', join(scratch, packed.filename)]);
  const cli = join(scratch, 'installed/node_modules/teapilot/dist/cli.js');
  assert.match(await run([cli, '--help']), /teapilot setup/);
  await run(['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { openPlayWeb } from ${JSON.stringify(pathToFileURL(join(dirname(cli), 'discord/play/web.js')).href)};
    import { SkillCache } from ${JSON.stringify(pathToFileURL(join(dirname(cli), 'skills/cache.js')).href)};
    const catalog = await new SkillCache(${JSON.stringify(env.TEAPILOT_STATE_DIR)}).catalog({ enabled: true, offline: true });
    assert.deepEqual(catalog.skills, []);
    assert.match(catalog.warnings[0], /unavailable offline/);
    const host = await openPlayWeb({}, { funnel: false, port: 0, log() {} });
    try {
      const response = await fetch(host.origin + '/play/test');
      assert.equal(response.status, 200);
      const html = await response.text();
      const asset = /src="([^"]+\\.js)"/.exec(html)[1];
      assert.equal((await fetch(host.origin + asset)).status, 200);
    } finally { await host.close(); }
  `]);
  if (process.platform !== 'win32') {
    // npm must create an executable bin link, not merely install a runnable file.
    const { access, constants } = await import('node:fs/promises');
    await access(join(scratch, 'installed/node_modules/.bin/teapilot'), constants.X_OK);
  } else assert.match(await readFile(join(scratch, 'installed/node_modules/.bin/teapilot.cmd'), 'utf8'), /cli\.js/);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  console.log('Checking setup, home config discovery, doctor, ask, and a real file edit...');
  // Code mode grants writes up front only within one repository; no Git executable is needed for the marker.
  await mkdir(join(workspace, '.git'));
  // Headless setup cannot consent to generation: it saves an unverified profile and exits 2.
  await run([cli, 'setup', '--non-interactive', '--endpoint', endpoint, '--model', 'mock', '--context-tokens', '32768'], workspace, env, 2);
  await run(['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { loadConfig } from ${JSON.stringify(pathToFileURL(join(dirname(cli), 'config.js')).href)};
    import { liveCheck } from ${JSON.stringify(pathToFileURL(join(dirname(cli), 'diagnostics.js')).href)};
    import { applyReports } from ${JSON.stringify(pathToFileURL(join(dirname(cli), 'setup/draft.js')).href)};
    import { saveConfiguration } from ${JSON.stringify(pathToFileURL(join(dirname(cli), 'setup/index.js')).href)};
    const directory = ${JSON.stringify(join(home, '.teapilot/config'))};
    const config = await loadConfig(directory);
    assert.equal(config.models.capable.baseUrl, ${JSON.stringify(endpoint)}, 'Only the localhost fixture may receive diagnostic calls');
    // Explicit test-only consent to the bounded production probe against our own mock server.
    config.models.capable.toolCalling = true;
    const report = await liveCheck(config, 'normal');
    assert(report.ask && report.tools && report.coding, JSON.stringify(report));
    applyReports(config, ['capable'], new Map([['capable', report]]));
    // Explicit fixture authority for the disposable repository's file-edit check.
    config.policy.permissions = [...new Set([...config.policy.permissions, 'repository.read', 'repository.write'])];
    await saveConfiguration(directory, config, {}, new AbortController().signal);
  `]);
  await run([cli, 'doctor']);
  const zeroBudget = { ...env, TEAPILOT_SKILLS_OFFLINE: 'on', REQUEST_BUDGET_USD: '0', DAILY_BUDGET_USD: '0' };
  const ask = JSON.parse(await run([cli, 'ask', '--json', 'Explain a topic'], workspace, zeroBudget));
  assert.equal(ask.success, true); assert.equal(ask.spentUsd, 0); assert.deepEqual(ask.receipts, []);
  const code = JSON.parse(await run([cli, 'code', '--json', '--cwd', workspace, 'Create result.txt containing verified'], workspace, zeroBudget));
  assert.equal(code.success, true); assert.equal(code.spentUsd, 0);
  assert.equal(await readFile(join(workspace, 'result.txt'), 'utf8').catch(error => { throw new Error(`File edit produced no result: ${JSON.stringify(code)}`, { cause: error }); }), 'verified\n');
  console.log('Packed installation passed without Git, build tools, or API credentials.');
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  assert(dirname(scratch) === tmpdir() && scratch.includes('teapilot-package-'));
  await rm(scratch, { recursive: true, force: true });
}
