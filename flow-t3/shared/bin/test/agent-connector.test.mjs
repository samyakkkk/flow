import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { redact } from '../harness/agent-connector.mjs';

const connector = fileURLToPath(new URL('../harness/agent-connector.mjs', import.meta.url));
async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'flow-agent-test-'));
  const folder = join(root, "repo with 'quotes' and spaces");
  const state = join(root, 'state');
  await fs.mkdir(folder); await fs.mkdir(state);
  execFileSync('git', ['init', folder], { stdio: 'ignore' });
  const events = [];
  let unavailable = false;
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer private-test-token');
    let text = ''; for await (const chunk of req) text += chunk;
    const input = JSON.parse(text);
    if (unavailable) { res.writeHead(503).end(JSON.stringify({ error: 'offline' })); return; }
    events.push(input);
    let result = null;
    if (input.method === 'state') result = { workspaces: [{ id: 'brain-1', name: 'Team Brain', cli: 'claude' }] };
    if (input.method === 'tools') result = ['orient', 'remember', 'read_document'].map(name => ({ name, inputSchema: { type: 'object', properties: {} } }));
    if (input.method === 'call') result = { content: [{ type: 'text', text: input.context.session }] };
    if (input.method === 'memories') result = { memories: [], session: input.context.session };
    res.end(JSON.stringify({ result }));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  await fs.writeFile(join(state, 'brain-endpoint.json'), JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, token: 'private-test-token' }));
  const children = [];
  const env = { ...process.env, HOME: root, FLOW_SESSION_ID: '', CODEX_HOME: join(root, '.codex') };
  async function run(args, input, customEnv = {}) {
    const child = spawn(process.execPath, args, { cwd: folder, env: { ...env, ...customEnv }, stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
    const finished = new Promise(done => child.on('exit', code => done({ code, stdout, stderr })));
    child.stdin.end(input ?? '');
    return finished;
  }
  t.after(async () => { for (const child of children) if (child.exitCode === null) child.kill(); server.closeAllConnections(); await new Promise(done => server.close(done)); await fs.rm(root, { recursive: true, force: true }); });
  const setup = () => run([connector, 'setup', '--brain', 'brain-1', '--state-dir', state, '--folder', folder, '--harness', 'claude,codex']);
  return { root, folder, state, events, env, run, setup, children, offline: value => unavailable = value };
}

test('setup preserves user settings, quotes paths, repairs idempotently, and removes its own entries', async t => {
  const f = await fixture(t);
  await fs.mkdir(join(f.folder, '.claude'));
  const settings = '{"permissions":{"allow":["Read"]}}\n';
  await fs.writeFile(join(f.folder, '.claude/settings.json'), settings);
  await fs.mkdir(join(f.root, '.codex'));
  await fs.writeFile(join(f.root, '.codex/config.toml'), '[features]\nhooks = false\nother = true\n');
  assert.equal((await f.setup()).code, 0);
  assert.equal((await f.setup()).code, 0);
  const config = await fs.readFile(join(f.root, '.codex/config.toml'), 'utf8');
  assert.equal(config.match(/hooks\s*=/g).length, 1);
  assert.match(config, /hooks = true/);
  assert.match(config, /other = true/);
  const settingsAfter = JSON.parse(await fs.readFile(join(f.folder, '.claude/settings.json'), 'utf8'));
  assert.ok(settingsAfter.permissions.allow.includes('Read'));
  assert.equal(settingsAfter.permissions.allow.filter(value => value === 'Read').length, 1);
  const line = settingsAfter.hooks.SessionStart[0].hooks[0].command;
  const result = await new Promise(done => {
    const child = spawn('/bin/sh', ['-c', line], { cwd: f.folder, env: f.env, stdio: ['pipe', 'pipe', 'pipe'] }); f.children.push(child);
    let output = ''; child.stdout.on('data', chunk => output += chunk);
    child.on('exit', code => done({ code, output }));
    child.stdin.end(JSON.stringify({ session_id: 'chat-a', hook_event_name: 'SessionStart' }));
  });
  assert.equal(result.code, 0); assert.match(result.output, /claude:chat-a/);
  assert.equal(f.events.filter(event => event.method === 'hook').length, 1);
  const removal = await f.run([connector, 'remove', '--folder', f.folder]);
  assert.equal(removal.code, 0, removal.stderr);
  assert.equal(await fs.readFile(join(f.folder, '.claude/settings.json'), 'utf8'), settings);
});

test('malformed configuration is rejected without overwriting it', async t => {
  const f = await fixture(t);
  await fs.mkdir(join(f.folder, '.claude'));
  await fs.writeFile(join(f.folder, '.claude/settings.json'), '{invalid');
  const result = await f.setup();
  assert.equal(result.code, 1); assert.match(result.stderr, /Cannot read/);
  assert.equal(await fs.readFile(join(f.folder, '.claude/settings.json'), 'utf8'), '{invalid');
});

test('offline captures persist redacted, replay with stable receipts, and skip T3-managed sessions', async t => {
  const f = await fixture(t); assert.equal((await f.setup()).code, 0);
  const project = Object.keys(JSON.parse(await fs.readFile(join(f.root, '.flow/config.json'), 'utf8')).projects)[0];
  const hook = [join(f.root, '.flow/bin/flow-hook'), '--project', project, '--harness', 'claude'];
  f.offline(true);
  assert.equal((await f.run(hook, JSON.stringify({ session_id: 'chat-a', hook_event_name: 'UserPromptSubmit', prompt: 'password=do-not-upload', event_id: 'receipt-a' }))).code, 0);
  const queue = join(f.root, '.flow/agent-capture', project);
  const pending = await fs.readdir(queue); assert.equal(pending.length, 1);
  const item = JSON.parse(await fs.readFile(join(queue, pending[0]), 'utf8'));
  assert.equal(item.hook.receipt, 'receipt-a'); assert.doesNotMatch(JSON.stringify(item), /do-not-upload/);
  f.offline(false);
  const doctor = await f.run([connector, 'doctor', '--folder', f.folder]); assert.equal(doctor.code, 0, doctor.stderr);
  assert.deepEqual(await fs.readdir(queue), []);
  assert.equal(f.events.find(event => event.method === 'hook').hook.receipt, 'receipt-a');
  const before = f.events.length;
  await f.run(hook, JSON.stringify({ session_id: 'managed', hook_event_name: 'SessionStart' }), { FLOW_SESSION_ID: 't3-managed' });
  assert.equal(f.events.length, before);
});

test('MCP binds exact native sessions and rejects cross-conversation rebinding', async t => {
  const f = await fixture(t); assert.equal((await f.setup()).code, 0);
  const project = Object.keys(JSON.parse(await fs.readFile(join(f.root, '.flow/config.json'), 'utf8')).projects)[0];
  for (const session of ['chat-a', 'chat-b']) await f.run([join(f.root, '.flow/bin/flow-hook'), '--project', project, '--harness', 'claude'], JSON.stringify({ session_id: session, hook_event_name: 'SessionStart' }));
  async function conversation(session) {
    const requests = [
      { id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
      { id: 2, method: 'tools/call', params: { name: 'remember', arguments: { text: 'early' } } },
      { id: 3, method: 'tools/call', params: { name: 'bind_session', arguments: { session: `claude:${session}` } } },
      { id: 4, method: 'tools/call', params: { name: 'remember', arguments: { text: 'saved' } } },
      { id: 5, method: 'tools/call', params: { name: 'read_document', arguments: { id: `notes:t3-claude:${session}` } } },
      { id: 6, method: 'tools/call', params: { name: 'bind_session', arguments: { session: session === 'chat-a' ? 'claude:chat-b' : 'claude:chat-a' } } },
    ];
    const result = await f.run([join(f.root, '.flow/bin/flow-mcp'), '--project', project], requests.map(x => JSON.stringify({ jsonrpc: '2.0', ...x })).join('\n') + '\n');
    assert.equal(result.code, 0, result.stderr);
    const replies = result.stdout.trim().split('\n').map(JSON.parse);
    assert.match(replies[1].error.message, /bind_session/);
    assert.match(replies[2].result.content[0].text, new RegExp(`notes:t3-claude:${session}`));
    assert.match(replies[3].result.content[0].text, new RegExp(session));
    assert.match(replies[4].result.content[0].text, new RegExp(session));
    assert.match(replies[5].error.message, /already bound/);
  }
  await Promise.all([conversation('chat-a'), conversation('chat-b')]);
});

test('redacts structured credentials before persistence', () => {
  assert.deepEqual(redact({ Authorization: 'Bearer secret-value', nested: { api_key: 'secret-value' } }), { Authorization: '[redacted]', nested: { api_key: '[redacted]' } });
});

test('UI operations report status, remove deselected tools, and revoke removed bindings', async t => {
  const f = await fixture(t); assert.equal((await f.setup()).code, 0);
  const result = await f.run([connector, 'status', '--folder', f.folder]);
  const status = JSON.parse(result.stdout);
  assert.equal(status.configured, true); assert.equal(status.brainName, 'Team Brain');
  assert.deepEqual(status.harnesses, ['claude', 'codex']);
  const saved = await f.run([connector, 'setup', '--brain', 'brain-1', '--state-dir', f.state, '--folder', f.folder, '--harness', 'claude']);
  assert.equal(saved.code, 0, saved.stderr);
  const updated = JSON.parse((await f.run([connector, 'status', '--folder', f.folder])).stdout);
  assert.deepEqual(updated.harnesses, ['claude']);
  await assert.rejects(fs.stat(join(f.folder, '.codex/hooks.json')), { code: 'ENOENT' });
  await f.run([connector, 'remove', '--folder', f.folder]);
  assert.equal(JSON.parse((await f.run([connector, 'status', '--folder', f.folder])).stdout).configured, false);
  const config = JSON.parse(await fs.readFile(join(f.root, '.flow/config.json'), 'utf8'));
  assert.equal(Object.values(config.projects)[0].folders.length, 0);
});

test('configures every supported harness and removes the generated project files', async t => {
  const f = await fixture(t);
  const selected = ['claude','codex','cursor','gemini','opencode','copilot','antigravity'];
  const setup = await f.run([connector, 'setup', '--brain', 'brain-1', '--state-dir', f.state, '--folder', f.folder, '--harness', selected.join(',')]);
  assert.equal(setup.code, 0, setup.stderr);
  const files = ['.mcp.json','.codex/config.toml','.cursor/mcp.json','.gemini/settings.json','opencode.json','.github/hooks/flow.json','.agents/mcp_config.json'];
  for (const file of files) assert.ok((await fs.readFile(join(f.folder,file),'utf8')).includes('flow'));
  const removed = await f.run([connector, 'remove', '--folder', f.folder]);
  assert.equal(removed.code, 0, removed.stderr);
  for (const file of files) await assert.rejects(fs.stat(join(f.folder,file)), { code:'ENOENT' });
});

test('Cloud registry preserves the Mac registry and installed hooks work without inherited environment', async t => {
  const f = await fixture(t);
  const registry = join(f.root, 'cloud-private', 'agents');
  await fs.mkdir(join(f.root, '.flow'), {recursive:true});
  const original = '{"macInstallation":"preserve"}';
  await fs.writeFile(join(f.root, '.flow/config.json'), original);
  const setup = await f.run([connector, 'setup', '--brain','brain-1','--state-dir',f.state,'--folder',f.folder,'--harness','claude'], '', {FLOW_AGENT_HOME:registry});
  assert.equal(setup.code,0,setup.stderr);
  assert.equal(await fs.readFile(join(f.root,'.flow/config.json'),'utf8'),original);
  const config=JSON.parse(await fs.readFile(join(registry,'config.json'),'utf8'));
  const project=Object.keys(config.projects)[0];
  const hook=await f.run([join(registry,'bin/flow-hook'),'--project',project,'--harness','claude'],JSON.stringify({session_id:'cloud-session',hook_event_name:'SessionStart'}),{FLOW_AGENT_HOME:''});
  assert.equal(hook.code,0,hook.stderr);
  assert.match(hook.stdout,/claude:cloud-session/);
  assert.equal(f.events.filter(e=>e.method==='hook').length,1);
});


test('plain folder setup and doctor work without initializing Git', async t => {
  const f = await fixture(t);
  await fs.rm(join(f.folder, '.git'), { recursive: true });
  const setup = await f.setup();
  assert.equal(setup.code, 0, setup.stderr);
  const doctor = await f.run([connector, 'doctor', '--folder', f.folder]);
  assert.equal(doctor.code, 0, doctor.stderr);
  await assert.rejects(fs.stat(join(f.folder, '.git')), { code: 'ENOENT' });
  assert.equal((await f.setup()).code, 0);
});
