#!/usr/bin/env node
import { agentHome } from './agent-home.mjs';
import { readJson, request, flush } from "./capture-replay.mjs";
// Local-only bridge: credentials stay in the app's private endpoint descriptor.
import * as fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const home = agentHome;
const hash = value => createHash('sha256').update(value).digest('hex');
export async function atomic(file, value) {
  await fs.mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await fs.rename(temporary, file);
}
export function gitIdentity(folder) {
  const git = args => execFileSync('git', ['-C', folder, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    return { common: resolve(folder, git(['rev-parse', '--git-common-dir'])), root: git(['rev-parse', '--show-toplevel']) };
  } catch (error) {
    // Plain folders can use a Brain too; do not create a Git repository merely to bind tools.
    // Other Git failures (permissions, unsafe ownership, missing Git) must remain visible.
    if (!String(error.stderr).includes('not a git repository')) throw error;
    const root = realpathSync(folder);
    return { common: `folder:${root}`, root };
  }
}

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /^(password|passwd|secret|api[_-]?key|access[_-]?token|auth(?:orization)?|token)$/i.test(key) ? '[redacted]' : redact(item)]));
  if (typeof value !== 'string') return value;
  return value.replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{16,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted]')
    .replace(/\b(password|secret|api[_-]?key|access[_-]?token)(["']?\s*[:=]\s*["']?)[^\s"'&]{6,}/gi, '$1$2[redacted]');
}
const nativeSession = event => event.session_id ?? event.sessionId ?? event.conversation_id ?? event.conversationId ?? event['thread-id'];
async function bindingFor(project, cwd = process.cwd()) {
  const entry = (await readJson(join(home(), 'config.json'))).projects?.[project];
  if (!entry?.connector || !entry.instance || !entry.workspace) throw Error('This folder has no Flow agent binding. Run setup.');
  const identity = gitIdentity(cwd);
  const registry = await readJson(join(home(), 'integrations.json'), {});
  const direct = registry.repos?.[identity.root];
  if (!direct) throw Error('This checkout has no Flow integration. Connect it in Flow.');
  if (direct.project !== project) throw Error('The project’s Brain changed. Restart the coding agent.');
  const folder = entry.folders.find(item => item.common === identity.common);
  if (!folder) throw Error('This repository is not bound to this Brain. Run setup in the folder.');
  return { ...entry, folder, cwd: identity.root };
}
function context(binding, session) {
  let branch = '';
  try { branch = execFileSync('git', ['-C', binding.cwd, 'branch', '--show-current'], { encoding: 'utf8' }).trim(); } catch {}
  return { session, workspaceRoot: binding.cwd, repo: binding.folder.repo, branch };
}
const spoolPath = project => join(home(), 'agent-capture', project);
export async function capture(project, harness, event, cwd = process.cwd()) {
  if (process.env.FLOW_SESSION_ID) return;
  const binding = await bindingFor(project, cwd);
  const id = nativeSession(event);
  if (typeof id !== 'string' || !id || id.length > 500) throw Error('Hook has no native conversation ID');
  const clean = redact(event);
  const session = `${harness}:${id}`;
  await atomic(join(home(), 'agent-sessions', project, hash(session) + '.json'), { session, common: binding.folder.common });
  const occurredAt = Date.now();
  // Native event IDs survive retries. Without one, each invocation is a distinct receipt.
  const receipt = String(event.event_id ?? event.eventId ?? randomUUID());
  await atomic(join(spoolPath(project), `${occurredAt}-${randomUUID()}.json`), {
    context: context(binding, session), hook: { harness, event: clean, receipt, occurredAt },
  });
  await flush(project, binding, 700).catch(() => {});
  return session;
}
export async function mcp(project) {
  const binding = await bindingFor(project);
  await flush(project, binding).catch(() => {});
  const tools = await request(binding, 'tools');
  let session;
  const unbound = `mcp:${randomUUID()}`;
  const extra = [
    { name: 'bind_session', description: 'Bind this MCP connection to the exact Flow session handle emitted by the capture hook. Never guess a handle or use another conversation’s handle.', inputSchema: { type: 'object', properties: { session: { type: 'string' } }, required: ['session'], additionalProperties: false } },
    { name: 'get_chat_memories', description: 'Read saved notes from this bound conversation. Requires bind_session first.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  ];
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    let input;
    try {
      input = JSON.parse(line);
      if (input.id === undefined) continue;
      let result;
      if (input.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'flow-graph', version: '1.0.0' }, instructions: 'Call orient first. Bind the exact Flow conversation handle from the startup hook using bind_session before remember or get_chat_memories. Never infer the latest conversation in a folder.' };
      else if (input.method === 'ping') result = {};
      else if (input.method === 'tools/list') result = { tools: [...tools, ...extra] };
      else if (input.method === 'tools/call') {
        const current = await bindingFor(project);
        if (current.workspace !== binding.workspace || current.instance !== binding.instance) throw Error('The project’s Brain changed. Restart the coding agent.');
        const name = input.params?.name;
        const args = input.params?.arguments ?? {};
        if (name === 'bind_session') {
          if (typeof args.session !== 'string') throw Error('Missing session handle');
          if (session && session !== args.session) throw Error('This MCP connection is already bound to another conversation');
          const saved = await readJson(join(home(), 'agent-sessions', project, hash(args.session) + '.json'), null);
          if (!saved || saved.common !== binding.folder.common) throw Error('No captured session matches this handle and repository');
          session = saved.session;
          result = { content: [{ type: 'text', text: `Bound Flow conversation ${session}` }] };
        } else if (name === 'get_chat_memories') {
          if (!session) throw Error('Call bind_session with this conversation’s hook handle first');
          result = { content: [{ type: 'text', text: JSON.stringify(await request(binding, 'memories', { context: context(binding, session) })) }] };
        } else {
          const tool = tools.find(tool => tool.name === name);
          if (!tool) throw Error('Unknown Flow tool');
          const defaults = context(binding, session ?? unbound);
          if ('repo' in (tool.inputSchema.properties ?? {}) && args.repo === undefined) args.repo = defaults.repo;
          if ('branch' in (tool.inputSchema.properties ?? {}) && args.branch === undefined) args.branch = defaults.branch;
          if (name === 'remember' && !session) throw Error('Call bind_session with this conversation’s hook handle before saving notes');
          result = await request(binding, 'call', { name, args, context: context(binding, session ?? unbound) });
        }
      } else {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: input.id, error: { code: -32601, message: 'Method not found' } }) + '\n');
        continue;
      }
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }) + '\n');
    } catch (error) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: input?.id ?? null, error: { code: -32603, message: error.message } }) + '\n');
    }
  }
}
export async function main(argv) {
  const [action, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i].startsWith('--') || !rest[i + 1]) throw Error('Expected --option value');
    options[rest[i].slice(2)] = rest[i + 1];
  }
  if (action === 'mcp') return mcp(options.project);
  if (action === 'setup' && options.cloud) {
    if (!options['state-dir']) throw Error('Start Flow first and supply its --state-dir.');
    const { connectCloud } = await import('./cloud-setup.mjs');
    options.brain = await connectCloud({ endpoint: options.cloud, tokenFile: options['token-file'], enrollmentFile: options['enrollment-file'], stateDir: options['state-dir'], brainId: options['cloud-brain'] });
  }
  const materializer = await import('../lib/materialize.mjs');
  const requestedFolder = resolve(options.folder ?? process.cwd());
  const folder = await fs.realpath(requestedFolder).catch(error => { if (action === 'status' && error.code === 'ENOENT') return requestedFolder; throw error; });
  if (action === 'status') {
    const manifest = await readJson(join(home(), 'integrations.json'), {});
    const config = await readJson(join(home(), 'config.json'), {});
    const integration = manifest.repos?.[folder];
    const binding = config.projects?.[integration?.project];
    const pending = binding?.connector ? await fs.readdir(spoolPath(integration.project)).catch(error => { if (error.code === 'ENOENT') return []; throw error; }) : [];
    console.log(JSON.stringify({ configured: Boolean(binding?.connector), harnesses: integration?.harnesses ?? [], detected: materializer.detectHarnesses(), brainName: binding?.name ?? null, workspaceId: binding?.workspace ?? null, pendingCaptures: pending.filter(name => name.endsWith('.json')).length, message: binding?.connector ? 'Configured. Restart the selected tools and approve their connection prompts. Capture is confirmed only after a conversation runs.' : 'Use your agents in Flow chat, or connect their own tools to this project’s Brain.' }));
    return;
  }
  if (action === 'remove') {
    const manifest = await readJson(join(home(), 'integrations.json'), {});
    const project = manifest.repos?.[folder]?.project;
    materializer.removeRepo(folder);
    if (project) {
      const config = await readJson(join(home(), 'config.json'), {});
      const entry = config.projects?.[project];
      if (entry?.connector) {
        const identity = gitIdentity(folder);
        const remaining = await readJson(join(home(), 'integrations.json'), {});
        const stillBound = Object.entries(remaining.repos ?? {}).some(([path, item]) => {
          try { return item.project === project && gitIdentity(path).common === identity.common; } catch { return false; }
        });
        if (!stillBound) entry.folders = entry.folders.filter(item => item.common !== identity.common);
        await atomic(join(home(), 'config.json'), config);
      }
    }
    return;
  }
  if (action === 'doctor' || action === 'flush') {
    const manifest = await readJson(join(home(), 'integrations.json'), {});
    const project = options.project ?? manifest.repos?.[folder]?.project;
    const binding = await bindingFor(project, folder);
    await flush(project, binding, 30000);
    const state = await request(binding, 'state', { metadataOnly: true });
    const brain = state.workspaces.find(item => item.id === binding.workspace);
    if (!brain) throw Error('Bound Brain no longer exists');
    console.log(JSON.stringify({ brain: brain.name, workspace: brain.id, folder, runtime: 'connected', captureQueue: 'drained', conversationBinding: 'requires startup hook handle', curator: brain.cli }, null, 2));
    return;
  }
  if (action !== 'setup' || !options.brain || !options['state-dir'] || !options.harness) throw Error('Usage: flow setup --brain ID --state-dir DIRECTORY --folder DIRECTORY --harness claude,codex,…; flow agents doctor|flush|remove --folder DIRECTORY');
  const identity = gitIdentity(folder);
  const stateDir = await fs.realpath(resolve(options['state-dir']));
  const project = `agents-${hash(stateDir + ':' + options.brain).slice(0, 20)}`;
  const config = await readJson(join(home(), 'config.json'), {});
  const previous = config.projects?.[project];
  const harnesses = options.harness === 'detected' ? materializer.detectHarnesses() : options.harness.split(',');
  if (!harnesses.length) throw Error('No supported coding tools detected. Install a coding tool, then repeat setup.');
  if (harnesses.some(h => !materializer.ALL_HARNESSES.includes(h))) throw Error(`Supported harnesses: ${materializer.ALL_HARNESSES.join(', ')}`);
  const connector = fileURLToPath(import.meta.url);
  const entry = { ...previous, connector, stateDir, workspace: options.brain, instance: previous?.instance ?? `agents-${randomUUID()}` };
  const state = await request(entry, 'state', { metadataOnly: true });
  const brain = state.workspaces.find(item => item.id === options.brain);
  if (!brain) throw Error('Brain not found on this runtime');
  if (options.local === 'true' && brain.remote) throw Error('The selected Brain is Cloud-connected. Choose a local Brain or omit --local.');
  entry.name = brain.name;
  const manifest = await readJson(join(home(), 'integrations.json'), {});
  const current = manifest.repos?.[folder];
  if (current && current.project !== project && options.rebind !== 'true') throw Error('Folder already has a different Brain binding. Remove that integration before switching.');
  if (current && (current.project !== project || current.harnesses.some(h => !harnesses.includes(h)))) materializer.removeRepo(folder);
  let repo = options.repo;
  if (!repo) {
    try { repo = execFileSync('git', ['-C', folder, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim().replace(/\.git$/, '').replace(/^.*github\.com[:/]/, ''); } catch { repo = folder; }
  }
  entry.folders = [...(previous?.folders ?? []).filter(item => item.common !== identity.common), { common: identity.common, repo }];
  materializer.materializeMachine({ flowRoot: resolve(dirname(connector), '../../..'), projectName: project, projectEntry: entry, shimSource: join(dirname(connector), 'flow-hook.mjs') });
  materializer.materializeRepo({ repoDir: folder, project, repo, harnesses, share: false });
  console.log(JSON.stringify({ brain: brain.name, workspace: brain.id, folder, harnesses, status: 'configured', next: 'Restart the selected coding agents; approve their MCP and hook trust prompts, then run flow agents doctor in this folder.' }, null, 2));
}
if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
