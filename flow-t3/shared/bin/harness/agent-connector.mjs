#!/usr/bin/env node
import { agentHome } from './agent-home.mjs';
import { FLOW_ROUTING } from './routing.mjs';
import { readJson, request, flush } from "./capture-replay.mjs";
import { atomic, gitIdentity, resolveBinding, persistBinding, forgetBinding, eventFolder, repoLabel } from './resolve.mjs';
// Local-only bridge: credentials stay in the app's private endpoint descriptor.
import * as fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';

export { atomic, gitIdentity };
const home = agentHome;
const hash = value => createHash('sha256').update(value).digest('hex');

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /^(password|passwd|secret|api[_-]?key|access[_-]?token|auth(?:orization)?|token)$/i.test(key) ? '[redacted]' : redact(item)]));
  if (typeof value !== 'string') return value;
  return value.replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{16,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted]')
    .replace(/\b(password|secret|api[_-]?key|access[_-]?token)(["']?\s*[:=]\s*["']?)[^\s"'&]{6,}/gi, '$1$2[redacted]');
}
const nativeSession = event => event.session_id ?? event.sessionId ?? event.conversation_id ?? event.conversationId ?? event['thread-id'];

// With a project name (legacy per-repo files) the binding is looked up; without
// one (machine-level tools) it is resolved from the folder. Unbound is null.
async function bindingFor(project, cwd = process.cwd()) {
  if (!project) {
    const resolved = await resolveBinding(cwd);
    if (resolved.status !== 'bound') return null;
    return { ...resolved.entry, project: resolved.project, folder: resolved.folder, cwd: resolved.cwd, name: resolved.name };
  }
  const entry = (await readJson(join(home(), 'config.json'))).projects?.[project];
  if (!entry?.connector || !entry.instance || !entry.workspace) throw Error('This folder has no Flow agent binding. Run setup.');
  const identity = gitIdentity(cwd);
  const folder = entry.folders.find(item => item.common === identity.common);
  if (!folder) throw Error('This repository is not bound to this Brain. Run setup in the folder.');
  return { ...entry, project, folder, cwd: identity.root, name: entry.name };
}
function context(binding, session) {
  let branch = '';
  try { branch = execFileSync('git', ['-C', binding.cwd, 'branch', '--show-current'], { encoding: 'utf8' }).trim(); } catch {}
  return { session, workspaceRoot: binding.cwd, repo: binding.folder.repo, branch };
}
const spoolPath = project => join(home(), 'agent-capture', project);
/** Record a harness event. Returns `{ session, brain }`, or undefined when the folder is not bound. */
export async function capture(project, harness, event, cwd = eventFolder(event)) {
  if (process.env.FLOW_SESSION_ID) return;
  if (!project) {
    // A checkout still carrying per-repo hook files is captured by those; never twice.
    const manifest = await readJson(join(home(), 'integrations.json'), {});
    let root;
    try { root = gitIdentity(cwd).root; } catch { return; }
    if (manifest.repos?.[root]) return;
  }
  const binding = await bindingFor(project, cwd);
  if (!binding) return;
  project = binding.project;
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
  return { session, brain: binding.name ?? null };
}
function mcpFolder() {
  for (const candidate of [process.env.FLOW_WORKSPACE_ROOT, process.env.CLAUDE_PROJECT_DIR, process.env.CURSOR_PROJECT_DIR])
    if (candidate) return candidate;
  return process.cwd();
}
export async function mcp(project) {
  const cwd = mcpFolder();
  const binding = await bindingFor(project, cwd);
  const tools = binding ? await (async () => { await flush(binding.project, binding).catch(() => {}); return request(binding, 'tools'); })() : [];
  let session;
  const unbound = `mcp:${randomUUID()}`;
  // bind_session ties this stdio connection to the conversation the capture hook
  // announced; remember and the conversation’s notes attach to that session.
  const extra = binding ? [
    { name: 'bind_session', description: 'Bind this MCP connection to the exact Flow session handle emitted by the capture hook. Never guess a handle or use another conversation’s handle. The reply names this conversation’s notes document for read_document.', inputSchema: { type: 'object', properties: { session: { type: 'string' } }, required: ['session'], additionalProperties: false } },
  ] : [];
  const instructions = binding
    ? `Flow Brain ${JSON.stringify(binding.name ?? binding.workspace)} is connected to this folder.\n${FLOW_ROUTING}\nBind the exact Flow conversation handle from the startup hook using bind_session before remember. Never infer the latest conversation in a folder.`
    : 'No Flow Brain is bound to this folder, so no Flow tools are available here. Continue without Flow memory; bind the folder to a Brain in Flow to enable them.';
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    let input;
    try {
      input = JSON.parse(line);
      if (input.id === undefined) continue;
      let result;
      if (input.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'flow-graph', version: '1.0.0' }, instructions };
      else if (input.method === 'ping') result = {};
      else if (input.method === 'tools/list') result = { tools: [...tools, ...extra] };
      else if (input.method === 'tools/call') {
        if (!binding) throw Error('No Flow Brain is bound to this folder');
        const current = await bindingFor(project, cwd);
        if (!current || current.workspace !== binding.workspace || current.instance !== binding.instance) throw Error('The project’s Brain changed. Restart the coding agent.');
        const name = input.params?.name;
        const args = input.params?.arguments ?? {};
        if (name === 'bind_session') {
          if (typeof args.session !== 'string') throw Error('Missing session handle');
          if (session && session !== args.session) throw Error('This MCP connection is already bound to another conversation');
          const saved = await readJson(join(home(), 'agent-sessions', binding.project, hash(args.session) + '.json'), null);
          if (!saved || saved.common !== binding.folder.common) throw Error('No captured session matches this handle and repository');
          session = saved.session;
          result = { content: [{ type: 'text', text: `Bound Flow conversation ${session}. Its notes: read_document notes:t3-${session}` }] };
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

const connectorPath = () => fileURLToPath(import.meta.url);
const flowRoot = () => resolve(dirname(connectorPath()), '../../..');
const shimSource = () => join(dirname(connectorPath()), 'flow-hook.mjs');

async function brainOn(stateDir, workspace) {
  const state = await request({ stateDir, instance: 'agent-setup' }, 'state', { metadataOnly: true });
  const brain = state.workspaces.find(item => item.id === workspace);
  if (!brain) throw Error('Brain not found on this runtime');
  return brain;
}

/** Machine-level tools for every detected (or requested) coding agent; idempotent. */
export async function install({ stateDir, harness, materializer }) {
  materializer ??= await import('../lib/materialize.mjs');
  const config = await readJson(join(home(), 'config.json'), {});
  const requested = !harness || harness === 'detected' ? materializer.detectHarnesses() : harness === 'all' ? materializer.ALL_HARNESSES : harness.split(',');
  if (requested.some(h => !materializer.ALL_HARNESSES.includes(h))) throw Error(`Supported harnesses: ${materializer.ALL_HARNESSES.join(', ')}`);
  const harnesses = [...new Set([...(config.machine?.harnesses ?? []), ...requested])];
  materializer.materializeMachine({ flowRoot: flowRoot(), shimSource: shimSource() });
  const rendered = materializer.materializeGlobal({ harnesses });
  // Per-repo files from earlier setups now duplicate the machine-level tools:
  // keep their bindings, restore the repositories.
  const manifest = await readJson(join(home(), 'integrations.json'), {});
  const migrated = [];
  for (const [repoDir, item] of Object.entries(manifest.repos ?? {})) {
    if (item.share) continue;
    let identity;
    try { identity = gitIdentity(repoDir); } catch { continue; }
    const current = await readJson(join(home(), 'config.json'), {});
    const entry = current.projects?.[item.project];
    if (entry?.connector && entry.stateDir && entry.workspace && !(entry.folders ?? []).some(f => f.common === identity.common))
      await persistBinding({ stateDir: entry.stateDir, workspace: entry.workspace, name: entry.name }, { common: identity.common, repo: item.repo ?? repoLabel(identity.root) });
    materializer.removeRepo(repoDir);
    migrated.push(repoDir);
  }
  const latest = await readJson(join(home(), 'config.json'), {});
  latest.machine = {
    version: materializer.GLOBAL_VERSION,
    harnesses,
    stateDirs: [...new Set([...(latest.machine?.stateDirs ?? []), ...(stateDir ? [await fs.realpath(resolve(stateDir))] : [])])],
    files: rendered.files,
    at: new Date().toISOString(),
  };
  await atomic(join(home(), 'config.json'), latest);
  return { harnesses, detected: materializer.detectHarnesses(), migrated, status: 'installed' };
}

export async function uninstall({ materializer } = {}) {
  materializer ??= await import('../lib/materialize.mjs');
  const removed = materializer.removeGlobal();
  const config = await readJson(join(home(), 'config.json'), {});
  delete config.machine;
  await atomic(join(home(), 'config.json'), config);
  return { removed, status: 'uninstalled' };
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
  // Rendering lives with the checkout, not under ~/.flow; only rendering verbs load it.
  const materializer = () => import('../lib/materialize.mjs');
  const requestedFolder = resolve(options.folder ?? process.cwd());
  const folder = await fs.realpath(requestedFolder).catch(error => { if (['status', 'resolve'].includes(action) && error.code === 'ENOENT') return requestedFolder; throw error; });
  if (action === 'install' || (action === 'setup' && !options.brain)) {
    const result = await install({ stateDir: options['state-dir'], harness: options.harness, materializer: await materializer() });
    console.log(JSON.stringify({ ...result, next: 'Restart your coding agents and approve their hook or MCP trust prompts once. Folders whose repositories belong to a Flow Brain are connected automatically.' }, null, 2));
    return;
  }
  if (action === 'tools') {
    const config = await readJson(join(home(), 'config.json'), {});
    console.log(JSON.stringify({ installed: config.machine?.harnesses ?? [], detected: (await materializer()).detectHarnesses() }));
    return;
  }
  if (action === 'uninstall') { console.log(JSON.stringify(await uninstall({ materializer: await materializer() }), null, 2)); return; }
  if (action === 'resolve') { console.log(JSON.stringify(await resolveBinding(folder), null, 2)); return; }
  if (action === 'status') {
    const manifest = await readJson(join(home(), 'integrations.json'), {});
    const config = await readJson(join(home(), 'config.json'), {});
    const legacy = manifest.repos?.[folder];
    let resolved = { status: 'unbound', reason: 'This folder does not exist.' };
    try { resolved = await resolveBinding(folder, { config }); } catch (error) { resolved = { status: 'unbound', reason: error.message }; }
    const binding = resolved.status === 'bound' ? resolved.entry : config.projects?.[legacy?.project];
    const harnesses = config.machine?.harnesses ?? legacy?.harnesses ?? [];
    const configured = Boolean(binding?.connector) && (resolved.status === 'bound' || Boolean(legacy)) && harnesses.length > 0;
    const project = resolved.status === 'bound' ? resolved.project : legacy?.project;
    const pending = project && binding?.connector ? await fs.readdir(spoolPath(project)).catch(error => { if (error.code === 'ENOENT') return []; throw error; }) : [];
    const message = configured
      ? 'Configured. Restart the selected tools and approve their connection prompts. Capture is confirmed only after a conversation runs.'
      : !harnesses.length ? 'Install Flow’s coding-agent tools on this computer to use its Brains from other tools.'
        : resolved.reason ?? 'Use your agents in Flow chat, or connect their own tools to this project’s Brain.';
    console.log(JSON.stringify({ configured, harnesses, detected: (await materializer()).detectHarnesses(), brainName: binding?.name ?? null, workspaceId: binding?.workspace ?? null, pendingCaptures: pending.filter(name => name.endsWith('.json')).length, message }));
    return;
  }
  if (action === 'unbind' || action === 'remove') {
    const manifest = await readJson(join(home(), 'integrations.json'), {});
    if (manifest.repos?.[folder]) (await materializer()).removeRepo(folder);
    await forgetBinding(gitIdentity(folder).common);
    return;
  }
  if (action === 'doctor' || action === 'flush') {
    const config = await readJson(join(home(), 'config.json'), {});
    const manifest = await readJson(join(home(), 'integrations.json'), {});
    const legacy = manifest.repos?.[folder]?.project;
    const project = options.project ?? legacy;
    const binding = await bindingFor(project, folder);
    if (!binding) {
      const resolved = await resolveBinding(folder, { config });
      throw Error(resolved.reason ?? 'This folder is not bound to a Flow Brain.');
    }
    await flush(binding.project, binding, 30000);
    const brain = await brainOn(binding.stateDir, binding.workspace).catch(() => { throw Error('Bound Brain no longer exists'); });
    console.log(JSON.stringify({ brain: brain.name, workspace: brain.id, folder, runtime: 'connected', captureQueue: 'drained', conversationBinding: 'requires startup hook handle', curator: brain.cli, tools: config.machine?.harnesses ?? manifest.repos?.[folder]?.harnesses ?? [] }, null, 2));
    return;
  }
  if (action !== 'setup' && action !== 'bind') throw Error('Usage: flow setup [--brain ID --state-dir DIRECTORY --folder DIRECTORY] [--harness claude,codex,…|detected|all] [--scope repo]; flow agents install|uninstall|bind|unbind|resolve|status|doctor|flush|remove [--folder DIRECTORY]');
  if (!options.brain || !options['state-dir']) throw Error('Usage: flow setup --brain ID --state-dir DIRECTORY --folder DIRECTORY');
  const stateDir = await fs.realpath(resolve(options['state-dir']));
  const identity = gitIdentity(folder);
  const brain = await brainOn(stateDir, options.brain);
  if (options.local === 'true' && brain.remote) throw Error('The selected Brain is Cloud-connected. Choose a local Brain or omit --local.');
  let repo = options.repo;
  if (!repo) repo = identity.common.startsWith('folder:') ? folder : repoLabel(identity.root);
  if (action === 'setup' && options.scope === 'repo') {
    // Legacy per-repo files, for environments that cannot use user-scope tool configuration.
    if (!options.harness) throw Error('Choose --harness for per-repo setup.');
    const materializer = await import('../lib/materialize.mjs');
    const project = `agents-${hash(stateDir + ':' + options.brain).slice(0, 20)}`;
    const config = await readJson(join(home(), 'config.json'), {});
    const previous = config.projects?.[project];
    const harnesses = options.harness === 'detected' ? materializer.detectHarnesses() : options.harness.split(',');
    if (!harnesses.length) throw Error('No supported coding tools detected. Install a coding tool, then repeat setup.');
    if (harnesses.some(h => !materializer.ALL_HARNESSES.includes(h))) throw Error(`Supported harnesses: ${materializer.ALL_HARNESSES.join(', ')}`);
    const entry = { ...previous, connector: connectorPath(), stateDir, workspace: options.brain, instance: previous?.instance ?? `agents-${randomUUID()}`, name: brain.name };
    const manifest = await readJson(join(home(), 'integrations.json'), {});
    const current = manifest.repos?.[folder];
    if (current && current.project !== project && options.rebind !== 'true') throw Error('Folder already has a different Brain binding. Remove that integration before switching.');
    if (current && (current.project !== project || current.harnesses.some(h => !harnesses.includes(h)))) materializer.removeRepo(folder);
    entry.folders = [...(previous?.folders ?? []).filter(item => item.common !== identity.common), { common: identity.common, repo }];
    materializer.materializeMachine({ flowRoot: flowRoot(), projectName: project, projectEntry: entry, shimSource: shimSource() });
    materializer.materializeRepo({ repoDir: folder, project, repo, harnesses, share: false });
    console.log(JSON.stringify({ brain: brain.name, workspace: brain.id, folder, harnesses, scope: 'repo', status: 'configured', next: 'Restart the selected coding agents; approve their MCP and hook trust prompts, then run flow agents doctor in this folder.' }, null, 2));
    return;
  }
  const config = await readJson(join(home(), 'config.json'), {});
  const installed = await (config.machine && !options.harness
    ? Promise.resolve({ harnesses: config.machine.harnesses })
    : install({ stateDir, harness: options.harness, materializer: await materializer() }));
  const manifest = await readJson(join(home(), 'integrations.json'), {});
  if (manifest.repos?.[folder]) (await materializer()).removeRepo(folder);
  const saved = await persistBinding({ stateDir, workspace: brain.id, name: brain.name }, { common: identity.common, repo });
  const machine = await readJson(join(home(), 'config.json'), {});
  if (!machine.machine?.stateDirs?.includes(stateDir)) {
    machine.machine = { ...(machine.machine ?? {}), stateDirs: [...new Set([...(machine.machine?.stateDirs ?? []), stateDir])] };
    await atomic(join(home(), 'config.json'), machine);
  }
  console.log(JSON.stringify({ brain: brain.name, workspace: brain.id, folder, project: saved.project, harnesses: installed.harnesses, status: 'configured', next: 'Restart your coding agents in this folder; approve their MCP and hook trust prompts once per computer, then run flow agents doctor here.' }, null, 2));
}
if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
