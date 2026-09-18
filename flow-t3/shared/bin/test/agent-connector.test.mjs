import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { redact } from '../harness/agent-connector.mjs';
import { normalizeRemote } from '../harness/resolve.mjs';

const connector = fileURLToPath(new URL('../harness/agent-connector.mjs', import.meta.url));
const mcpRequests = [
  { id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
  { id: 2, method: 'tools/list', params: {} },
];
async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'flow-agent-test-'));
  const folder = join(root, "repo with 'quotes' and spaces");
  const state = join(root, 'state');
  await fs.mkdir(folder); await fs.mkdir(state);
  execFileSync('git', ['init', folder], { stdio: 'ignore' });
  const events = [];
  let unavailable = false;
  const workspaces = [{ id: 'brain-1', name: 'Team Brain', cli: 'claude', sources: [] }];
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer private-test-token');
    let text = ''; for await (const chunk of req) text += chunk;
    const input = JSON.parse(text);
    if (unavailable) { res.writeHead(503).end(JSON.stringify({ error: 'offline' })); return; }
    events.push(input);
    let result = null;
    if (input.method === 'state') result = { workspaces };
    if (input.method === 'tools') result = ['orient', 'remember', 'get_entity'].map(name => ({ name, inputSchema: { type: 'object', properties: {} } }));
    if (input.method === 'call') result = { content: [{ type: 'text', text: input.context.session }] };
    if (input.method === 'memories') result = { memories: [], session: input.context.session };
    res.end(JSON.stringify({ result }));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  await fs.writeFile(join(state, 'brain-endpoint.json'), JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, token: 'private-test-token' }));
  const children = [];
  const env = { ...process.env, HOME: root, FLOW_SESSION_ID: '', CODEX_HOME: join(root, '.codex'), COPILOT_HOME: join(root, '.copilot'), CLAUDE_PROJECT_DIR: '', CURSOR_PROJECT_DIR: '' };
  async function run(args, input, customEnv = {}, cwd = folder) {
    const child = spawn(process.execPath, args, { cwd, env: { ...env, ...customEnv }, stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
    const finished = new Promise(done => child.on('exit', code => done({ code, stdout, stderr })));
    child.stdin.end(input ?? '');
    return finished;
  }
  t.after(async () => { for (const child of children) if (child.exitCode === null) child.kill(); server.closeAllConnections(); await new Promise(done => server.close(done)); await fs.rm(root, { recursive: true, force: true }); });
  const setup = (extra = []) => run([connector, 'setup', '--brain', 'brain-1', '--state-dir', state, '--folder', folder, '--harness', 'claude,codex', ...extra]);
  const hooks = () => events.filter(event => event.method === 'hook');
  const hookLine = async () => JSON.parse(await fs.readFile(join(root, '.claude/settings.json'), 'utf8')).hooks.SessionStart[0].hooks[0].command;
  async function fire(line, payload, cwd = folder) {
    return new Promise(done => {
      const child = spawn('/bin/sh', ['-c', line], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child);
      let output = ''; child.stdout.on('data', chunk => output += chunk);
      child.on('exit', code => done({ code, output }));
      child.stdin.end(JSON.stringify(payload));
    });
  }
  return { root, folder, state, events, env, run, setup, children, hooks, hookLine, fire, workspaces, offline: value => unavailable = value };
}

test('machine-scope setup renders user configuration once, resolves the folder at run time, and uninstalls cleanly', async t => {
  const f = await fixture(t);
  await fs.mkdir(join(f.root, '.claude'));
  const settings = '{"permissions":{"allow":["Read"]},"hooks":{"Stop":[{"hooks":[{"type":"command","command":"my-notifier"}]}]}}\n';
  await fs.writeFile(join(f.root, '.claude/settings.json'), settings);
  await fs.writeFile(join(f.root, '.claude.json'), '{"numStartups":3,"mcpServers":{"mine":{"type":"http","url":"https://example.test"}}}\n');
  await fs.mkdir(join(f.root, '.codex'));
  await fs.writeFile(join(f.root, '.codex/config.toml'), '[features]\nhooks = false\nother = true\n');
  assert.equal((await f.setup()).code, 0);
  assert.equal((await f.setup()).code, 0);
  // No files land in the repository.
  for (const rel of ['.claude', '.mcp.json', 'CLAUDE.md', '.codex', 'AGENTS.md']) await assert.rejects(fs.stat(join(f.folder, rel)), { code: 'ENOENT' });
  const config = await fs.readFile(join(f.root, '.codex/config.toml'), 'utf8');
  assert.equal(config.match(/hooks\s*=/g).length, 1);
  assert.match(config, /hooks = true/); assert.match(config, /other = true/);
  assert.equal(config.match(/mcp_servers\.flow-graph/g).length, 1);
  assert.doesNotMatch(config, /trust_level/);
  const after = JSON.parse(await fs.readFile(join(f.root, '.claude/settings.json'), 'utf8'));
  assert.ok(after.permissions.allow.includes('Read'));
  assert.equal(after.hooks.Stop.length, 2);
  assert.equal(after.enableAllProjectMcpServers, undefined);
  const claudeJson = JSON.parse(await fs.readFile(join(f.root, '.claude.json'), 'utf8'));
  assert.equal(claudeJson.numStartups, 3);
  assert.ok(claudeJson.mcpServers.mine && claudeJson.mcpServers['flow-graph']);
  assert.deepEqual(claudeJson.mcpServers['flow-graph'].args, [join(f.root, '.flow/bin/flow-mcp')]);
  assert.match(await fs.readFile(join(f.root, '.claude/skills/flow/SKILL.md'), 'utf8'), /bind_session/);
  assert.match(await fs.readFile(join(f.root, '.claude/skills/flow/SKILL.md'), 'utf8'), /FIND WHAT WAS WRITTEN DOWN[\s\S]*get_entity \[id\][\s\S]*read_query/);
  assert.match(await fs.readFile(join(f.root, '.agents/skills/flow/SKILL.md'), 'utf8'), /flow-graph/);
  const line = await f.hookLine();
  assert.doesNotMatch(line, /--project/);
  const result = await f.fire(line, { session_id: 'chat-a', hook_event_name: 'SessionStart' });
  assert.equal(result.code, 0); assert.match(result.output, /claude:chat-a/); assert.match(result.output, /Team Brain/);
  assert.equal(f.hooks().length, 1);
  assert.equal(f.hooks()[0].context.repo, basename(f.folder));
  // An unrelated folder captures nothing and stays silent.
  const elsewhere = join(f.root, 'elsewhere'); await fs.mkdir(elsewhere);
  const quiet = await f.fire(line, { session_id: 'chat-x', hook_event_name: 'SessionStart' }, elsewhere);
  assert.equal(quiet.code, 0); assert.equal(quiet.output, ''); assert.equal(f.hooks().length, 1);
  const status = JSON.parse((await f.run([connector, 'status', '--folder', f.folder])).stdout);
  assert.equal(status.configured, true); assert.equal(status.brainName, 'Team Brain'); assert.deepEqual(status.harnesses, ['claude', 'codex']);
  const removal = await f.run([connector, 'remove', '--folder', f.folder]);
  assert.equal(removal.code, 0, removal.stderr);
  assert.equal(JSON.parse((await f.run([connector, 'status', '--folder', f.folder])).stdout).configured, false);
  const gone = await f.fire(line, { session_id: 'chat-b', hook_event_name: 'SessionStart' });
  assert.equal(gone.code, 0); assert.equal(gone.output, ''); assert.equal(f.hooks().length, 1);
  const uninstalled = await f.run([connector, 'uninstall']);
  assert.equal(uninstalled.code, 0, uninstalled.stderr);
  assert.deepEqual(JSON.parse(await fs.readFile(join(f.root, '.claude/settings.json'), 'utf8')), JSON.parse(settings));
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(join(f.root, '.claude.json'), 'utf8')).mcpServers), ['mine']);
  assert.equal(await fs.readFile(join(f.root, '.codex/config.toml'), 'utf8'), '[features]\nhooks = true\nother = true\n');
  await assert.rejects(fs.stat(join(f.root, '.claude/skills')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(join(f.root, '.codex/hooks.json')), { code: 'ENOENT' });
});

test('malformed user configuration is rejected without overwriting it', async t => {
  const f = await fixture(t);
  await fs.mkdir(join(f.root, '.claude'));
  await fs.writeFile(join(f.root, '.claude/settings.json'), '{invalid');
  const result = await f.setup();
  assert.equal(result.code, 1); assert.match(result.stderr, /Cannot read/);
  assert.equal(await fs.readFile(join(f.root, '.claude/settings.json'), 'utf8'), '{invalid');
});

test('a checkout listed by exactly one Brain binds itself from its origin', async t => {
  const f = await fixture(t);
  f.workspaces[0].sources.push({ repository: 'Acme/Widgets' });
  execFileSync('git', ['-C', f.folder, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { stdio: 'ignore' });
  assert.equal((await f.run([connector, 'install', '--state-dir', f.state, '--harness', 'claude'])).code, 0);
  const line = await f.hookLine();
  const result = await f.fire(line, { session_id: 'chat-a', hook_event_name: 'SessionStart', cwd: f.folder }, f.root);
  assert.equal(result.code, 0); assert.match(result.output, /Team Brain/);
  assert.equal(f.hooks().length, 1); assert.equal(f.hooks()[0].context.repo, 'acme/widgets');
  const config = JSON.parse(await fs.readFile(join(f.root, '.flow/config.json'), 'utf8'));
  const entry = Object.values(config.projects)[0];
  assert.equal(entry.workspace, 'brain-1'); assert.equal(entry.folders[0].repo, 'acme/widgets');
  // The app's own repository choice counts too, and a Brain that lists two folders is fine.
  f.workspaces.push({ id: 'brain-2', name: 'Other', cli: 'codex', sources: [] });
  const other = join(f.root, 'other'); await fs.mkdir(other);
  execFileSync('git', ['init', other], { stdio: 'ignore' });
  execFileSync('git', ['-C', other, 'remote', 'add', 'origin', 'https://github.com/Acme/Other.git'], { stdio: 'ignore' });
  await fs.mkdir(join(f.state, 'brain'), { recursive: true });
  await fs.writeFile(join(f.state, 'brain/project-brains.json'), JSON.stringify({ 'repository:github.com/acme/other': 'brain-2' }));
  const resolved = JSON.parse((await f.run([connector, 'resolve', '--folder', other])).stdout);
  assert.equal(resolved.status, 'bound'); assert.equal(resolved.entry.workspace, 'brain-2');
  // Listed by both Brains: ambiguous, nothing captured.
  f.workspaces[1].sources.push({ repository: 'acme/widgets' });
  const ambiguous = join(f.root, 'ambiguous'); await fs.mkdir(ambiguous);
  execFileSync('git', ['init', ambiguous], { stdio: 'ignore' });
  execFileSync('git', ['-C', ambiguous, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { stdio: 'ignore' });
  const conflict = JSON.parse((await f.run([connector, 'resolve', '--folder', ambiguous])).stdout);
  assert.equal(conflict.status, 'ambiguous'); assert.equal(conflict.brains.length, 2);
  const quiet = await f.fire(line, { session_id: 'chat-b', hook_event_name: 'SessionStart' }, ambiguous);
  assert.equal(quiet.output, ''); assert.equal(f.hooks().length, 1);
});

test('a folder of checkouts resolves through its children', async t => {
  const f = await fixture(t);
  f.workspaces[0].sources.push({ repository: 'acme/one' }, { repository: 'acme/two' });
  f.workspaces.push({ id: 'brain-2', name: 'Other', cli: 'codex', sources: [{ repository: 'acme/three' }] });
  assert.equal((await f.run([connector, 'install', '--state-dir', f.state, '--harness', 'claude'])).code, 0);
  const parent = join(f.root, 'workspace'); await fs.mkdir(parent);
  for (const name of ['one', 'two', 'unrelated']) {
    const dir = join(parent, name); await fs.mkdir(dir);
    execFileSync('git', ['init', dir], { stdio: 'ignore' });
    if (name !== 'unrelated') execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', `https://github.com/acme/${name}`], { stdio: 'ignore' });
  }
  const resolved = JSON.parse((await f.run([connector, 'resolve', '--folder', parent])).stdout);
  assert.equal(resolved.status, 'bound'); assert.equal(resolved.entry.workspace, 'brain-1');
  assert.deepEqual(resolved.folder.repos.sort(), ['acme/one', 'acme/two']);
  const line = await f.hookLine();
  const result = await f.fire(line, { session_id: 'chat-a', hook_event_name: 'SessionStart' }, parent);
  assert.match(result.output, /Team Brain/); assert.equal(f.hooks()[0].context.workspaceRoot, await fs.realpath(parent));
  const mixed = join(f.root, 'mixed'); await fs.mkdir(mixed);
  for (const name of ['one', 'three']) {
    const dir = join(mixed, name); await fs.mkdir(dir);
    execFileSync('git', ['init', dir], { stdio: 'ignore' });
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', `https://github.com/acme/${name}`], { stdio: 'ignore' });
  }
  assert.equal(JSON.parse((await f.run([connector, 'resolve', '--folder', mixed])).stdout).status, 'ambiguous');
});

test('the MCP server serves no tools in an unbound folder and the Brain tools once bound', async t => {
  const f = await fixture(t);
  assert.equal((await f.run([connector, 'install', '--state-dir', f.state, '--harness', 'claude'])).code, 0);
  const tools = JSON.parse((await f.run([connector, 'tools'])).stdout);
  assert.deepEqual(tools.installed, ['claude']); assert.ok(Array.isArray(tools.detected));
  const mcp = join(f.root, '.flow/bin/flow-mcp');
  const input = mcpRequests.map(x => JSON.stringify({ jsonrpc: '2.0', ...x })).join('\n') + '\n';
  const unbound = await f.run([mcp], input);
  assert.equal(unbound.code, 0, unbound.stderr);
  const quiet = unbound.stdout.trim().split('\n').map(JSON.parse);
  assert.match(quiet[0].result.instructions, /No Flow Brain is bound/); assert.deepEqual(quiet[1].result.tools, []);
  assert.equal((await f.setup()).code, 0);
  const bound = await f.run([mcp], input);
  const replies = bound.stdout.trim().split('\n').map(JSON.parse);
  assert.match(replies[0].result.instructions, /Team Brain/);
  assert.match(replies[0].result.instructions, /Every \[id\][\s\S]*opens with get_entity/);
  assert.deepEqual(replies[1].result.tools.map(tool => tool.name), ['orient', 'remember', 'get_entity', 'bind_session']);
  // A chat run by Flow has the same tools on its own t3-code server; never twice.
  const hosted = (await f.run([mcp], input, { FLOW_SESSION_ID: 't3-managed' })).stdout.trim().split('\n').map(JSON.parse);
  assert.match(hosted[0].result.instructions, /t3-code/); assert.deepEqual(hosted[1].result.tools, []);
});

test('offline captures persist redacted, replay with stable receipts, and skip T3-managed sessions', async t => {
  const f = await fixture(t); assert.equal((await f.setup()).code, 0);
  const project = Object.keys(JSON.parse(await fs.readFile(join(f.root, '.flow/config.json'), 'utf8')).projects)[0];
  const hook = [join(f.root, '.flow/bin/flow-hook'), '--harness', 'claude'];
  f.offline(true);
  assert.equal((await f.run(hook, JSON.stringify({ session_id: 'chat-a', hook_event_name: 'UserPromptSubmit', prompt: 'password=do-not-upload', event_id: 'receipt-a' }))).code, 0);
  const queue = join(f.root, '.flow/agent-capture', project);
  const pending = await fs.readdir(queue); assert.equal(pending.length, 1);
  const item = JSON.parse(await fs.readFile(join(queue, pending[0]), 'utf8'));
  assert.equal(item.hook.receipt, 'receipt-a'); assert.doesNotMatch(JSON.stringify(item), /do-not-upload/);
  f.offline(false);
  const doctor = await f.run([connector, 'doctor', '--folder', f.folder]); assert.equal(doctor.code, 0, doctor.stderr);
  assert.deepEqual(await fs.readdir(queue), []);
  assert.equal(f.hooks()[0].hook.receipt, 'receipt-a');
  const before = f.events.length;
  await f.run(hook, JSON.stringify({ session_id: 'managed', hook_event_name: 'SessionStart' }), { FLOW_SESSION_ID: 't3-managed' });
  assert.equal(f.events.length, before);
});

test('MCP binds exact native sessions and rejects cross-conversation rebinding', async t => {
  const f = await fixture(t); assert.equal((await f.setup()).code, 0);
  for (const session of ['chat-a', 'chat-b']) await f.run([join(f.root, '.flow/bin/flow-hook'), '--harness', 'claude'], JSON.stringify({ session_id: session, hook_event_name: 'SessionStart' }));
  async function conversation(session) {
    const requests = [
      { id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
      { id: 2, method: 'tools/call', params: { name: 'remember', arguments: { text: 'early' } } },
      { id: 3, method: 'tools/call', params: { name: 'bind_session', arguments: { session: `claude:${session}` } } },
      { id: 4, method: 'tools/call', params: { name: 'remember', arguments: { text: 'saved' } } },
      { id: 5, method: 'tools/call', params: { name: 'get_entity', arguments: { id: `notes:t3-claude:${session}` } } },
      { id: 6, method: 'tools/call', params: { name: 'bind_session', arguments: { session: session === 'chat-a' ? 'claude:chat-b' : 'claude:chat-a' } } },
    ];
    const result = await f.run([join(f.root, '.flow/bin/flow-mcp')], requests.map(x => JSON.stringify({ jsonrpc: '2.0', ...x })).join('\n') + '\n');
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

test('redacts structured credentials and normalizes remotes', () => {
  assert.deepEqual(redact({ Authorization: 'Bearer secret-value', nested: { api_key: 'secret-value' } }), { Authorization: '[redacted]', nested: { api_key: '[redacted]' } });
  assert.equal(normalizeRemote('git@github.com:Acme/Widgets.git'), 'github.com/acme/widgets');
  assert.equal(normalizeRemote('https://github.com/acme/widgets/'), 'github.com/acme/widgets');
  assert.equal(normalizeRemote('ssh://git@gitlab.example.com:2222/team/app.git'), 'gitlab.example.com/team/app');
});

test('per-repo scope still renders every harness into the checkout and removes it', async t => {
  const f = await fixture(t);
  const selected = ['claude','codex','cursor','gemini','opencode','copilot','antigravity'];
  const setup = await f.run([connector, 'setup', '--brain', 'brain-1', '--state-dir', f.state, '--folder', f.folder, '--harness', selected.join(','), '--scope', 'repo']);
  assert.equal(setup.code, 0, setup.stderr);
  const files = ['.mcp.json','.codex/config.toml','.cursor/mcp.json','.gemini/settings.json','opencode.json','.github/hooks/flow.json','.agents/mcp_config.json'];
  for (const file of files) assert.ok((await fs.readFile(join(f.folder,file),'utf8')).includes('flow'));
  assert.match(JSON.parse(await fs.readFile(join(f.folder, '.mcp.json'), 'utf8')).mcpServers['flow-graph'].args.join(' '), /--project/);
  // A later machine-scope install migrates the checkout: binding kept, files restored.
  const install = await f.run([connector, 'install', '--state-dir', f.state, '--harness', 'claude']);
  assert.equal(install.code, 0, install.stderr);
  assert.deepEqual(JSON.parse(install.stdout).migrated, [await fs.realpath(f.folder)]);
  for (const file of files) await assert.rejects(fs.stat(join(f.folder,file)), { code:'ENOENT' });
  assert.equal(JSON.parse((await f.run([connector, 'resolve', '--folder', f.folder])).stdout).source, 'explicit');
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
  assert.equal(Object.values(config.projects)[0].workspace, 'brain-1');
  const hook=await f.run([join(registry,'bin/flow-hook'),'--harness','claude'],JSON.stringify({session_id:'cloud-session',hook_event_name:'SessionStart'}),{FLOW_AGENT_HOME:''});
  assert.equal(hook.code,0,hook.stderr);
  assert.match(hook.stdout,/claude:cloud-session/);
  assert.equal(f.hooks().length,1);
});

test('Cloud setup without a folder installs the tools and binds nothing', async t => {
  const f = await fixture(t);
  f.workspaces.push({ id: 'cloud-1', name: 'Cloud Brain', cli: 'claude', sources: [], remote: { endpoint: 'https://brain.example', brainId: 'remote', status: 'ready' } });
  const setup = await f.run([connector, 'setup', '--cloud', 'https://brain.example', '--cloud-brain', 'remote', '--state-dir', f.state, '--harness', 'claude']);
  assert.equal(setup.code, 0, setup.stderr);
  const result = JSON.parse(setup.stdout);
  assert.equal(result.status, 'installed'); assert.deepEqual(result.harnesses, ['claude']);
  const config = JSON.parse(await fs.readFile(join(f.root, '.flow/config.json'), 'utf8'));
  assert.deepEqual(config.machine.stateDirs, [await fs.realpath(f.state)]);
  assert.deepEqual(Object.keys(config.projects ?? {}), []);
  // Naming a folder still binds it, as the dashboard's per-folder setup does.
  const bound = await f.run([connector, 'setup', '--cloud', 'https://brain.example', '--cloud-brain', 'remote', '--state-dir', f.state, '--folder', f.folder]);
  assert.equal(bound.code, 0, bound.stderr); assert.equal(JSON.parse(bound.stdout).workspace, 'cloud-1');
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
