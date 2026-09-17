// resolve.mjs — which Flow Brain owns the folder a coding agent runs in?
//
// Machine-level hooks and MCP servers run in every folder, so the binding is
// resolved here at run time instead of being baked into per-repo files:
//
//   1. An explicit binding for this checkout or folder (recorded by the app,
//      `flow setup`, or an earlier inference) wins.
//   2. A git checkout resolves through its origin: the running Flow instance
//      reports which Brain has that repository as a source or project.
//   3. A plain folder resolves through its immediate child checkouts when
//      they all belong to one Brain (the "workspace of repos" layout).
//   4. Anything else is unbound. Two or more candidate Brains is ambiguous and
//      also unbound; guessing would leak one team's sessions into another's
//      Brain. The app can bind the folder explicitly to settle it.
//
// Unbound is a normal answer, never an error: hooks stay silent and the MCP
// server advertises no tools.
import { agentHome } from './agent-home.mjs';
import { readJson, request } from './capture-replay.mjs';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, realpathSync, existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

const home = agentHome;
const hash = value => createHash('sha256').update(value).digest('hex');
const MAX_CHILDREN = 200;
const NEGATIVE_CACHE_MS = 60_000;

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

/** Canonical `host/owner/repo` for a remote URL, matching the app's repository identity key. */
export function normalizeRemote(value) {
  const normalized = String(value ?? '').trim().replace(/\/+$/g, '').replace(/\.git$/i, '').toLowerCase();
  if (!normalized) return '';
  if (/^(?:ssh|https?|git):\/\//i.test(normalized)) {
    try {
      const url = new URL(normalized);
      const path = url.pathname.split('/').filter(Boolean).join('/');
      if (url.hostname && path.includes('/')) return `${url.hostname}/${path}`;
    } catch { return normalized; }
  }
  const scp = /^[a-zA-Z0-9._-]+@([^:/\s]+):([^/\s]+(?:\/[^/\s]+)+)$/i.exec(normalized);
  if (scp?.[1] && scp[2]) return `${scp[1]}/${scp[2]}`;
  return normalized;
}

export function gitOrigin(root) {
  try {
    const url = execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const canonical = normalizeRemote(url);
    const github = canonical.startsWith('github.com/') ? canonical.slice('github.com/'.length) : undefined;
    return { canonical, github };
  } catch { return { canonical: '', github: undefined }; }
}

/** The label sessions carry for a checkout: its GitHub name when known, else the folder name. */
export function repoLabel(root, origin = gitOrigin(root)) {
  return origin.github ?? basename(root);
}

export function projectKey(stateDir, workspace) {
  return `agents-${hash(stateDir + ':' + workspace).slice(0, 20)}`;
}

function bound(project, entry, folder, root, extra = {}) {
  return { status: 'bound', project, entry, folder, cwd: root, name: entry.name ?? null, ...extra };
}

export function findExplicit(config, common, root) {
  for (const [project, entry] of Object.entries(config.projects ?? {})) {
    if (!entry?.connector || !entry.instance || !entry.workspace) continue;
    const folder = (entry.folders ?? []).find(item => item.common === common);
    if (folder) return bound(project, entry, folder, root, { source: 'explicit' });
  }
  return null;
}

function stateDirs(config) {
  const dirs = new Set(config.machine?.stateDirs ?? []);
  for (const entry of Object.values(config.projects ?? {})) if (entry?.connector && entry.stateDir) dirs.add(entry.stateDir);
  return [...dirs];
}

const samePath = (a, b) => {
  try { return realpathSync(a) === realpathSync(b); } catch { return a === b; }
};

/** Every Brain a checkout could belong to, across the Flow instances this machine knows. */
export async function brainsFor(config, { root, origin }) {
  const found = new Map();
  const add = (stateDir, workspace, name) => {
    const key = `${stateDir}:${workspace}`;
    if (!found.has(key)) found.set(key, { stateDir, workspace, name: name ?? null });
    else if (name && !found.get(key).name) found.get(key).name = name;
  };
  let reachable = false;
  for (const stateDir of stateDirs(config)) {
    const choices = await readJson(join(stateDir, 'brain', 'project-brains.json'), {}).catch(() => ({}));
    const chosen = origin.canonical ? choices[`repository:${origin.canonical}`] : undefined;
    const state = await request({ stateDir, instance: 'agents-resolver' }, 'state', { metadataOnly: true }, 5000).catch(() => null);
    if (!state) continue;
    reachable = true;
    for (const workspace of state.workspaces ?? []) {
      if (chosen === workspace.id) add(stateDir, workspace.id, workspace.name);
      for (const source of workspace.sources ?? []) {
        const matches = source.localPath
          ? samePath(source.localPath, root)
          : Boolean(origin.github) && source.repository.toLowerCase() === origin.github.toLowerCase();
        if (matches) add(stateDir, workspace.id, workspace.name);
      }
    }
  }
  return { brains: [...found.values()], reachable };
}

async function negativeCache(root) {
  const file = join(home(), 'resolve-cache.json');
  const cache = await readJson(file, {}).catch(() => ({}));
  const at = cache[root];
  return { file, cache, fresh: typeof at === 'number' && Date.now() - at < NEGATIVE_CACHE_MS };
}

async function rememberNegative(root) {
  const { file, cache } = await negativeCache(root);
  const now = Date.now();
  const kept = Object.fromEntries(Object.entries(cache).filter(([, at]) => typeof at === 'number' && now - at < NEGATIVE_CACHE_MS));
  kept[root] = now;
  await atomic(file, kept).catch(() => {});
}

export async function persistBinding(brain, folder) {
  const file = join(home(), 'config.json');
  const config = await readJson(file, {});
  const project = projectKey(brain.stateDir, brain.workspace);
  const previous = config.projects?.[project];
  const entry = {
    ...previous,
    connector: previous?.connector ?? join(home(), 'bin', 'agent-connector.mjs'),
    stateDir: brain.stateDir,
    workspace: brain.workspace,
    instance: previous?.instance ?? `agents-${randomUUID()}`,
    name: brain.name ?? previous?.name ?? null,
    folders: [...(previous?.folders ?? []).filter(item => item.common !== folder.common), folder],
  };
  // A checkout belongs to one Brain: drop it from any other binding.
  for (const [key, other] of Object.entries(config.projects ?? {})) {
    if (key !== project && Array.isArray(other?.folders)) other.folders = other.folders.filter(item => item.common !== folder.common);
  }
  config.projects = { ...(config.projects ?? {}), [project]: entry };
  await atomic(file, config);
  return { project, entry, folder };
}

export async function forgetBinding(common) {
  const file = join(home(), 'config.json');
  const config = await readJson(file, {});
  let changed = false;
  for (const entry of Object.values(config.projects ?? {})) {
    if (!Array.isArray(entry?.folders)) continue;
    const kept = entry.folders.filter(item => item.common !== common);
    if (kept.length !== entry.folders.length) { entry.folders = kept; changed = true; }
  }
  if (changed) await atomic(file, config);
  return changed;
}

function unbound(reason, extra = {}) {
  return { status: 'unbound', reason, ...extra };
}

async function inferCheckout(config, identity, persist) {
  const origin = gitOrigin(identity.root);
  if ((await negativeCache(identity.root)).fresh) return unbound('No Flow Brain lists this repository.');
  const { brains, reachable } = await brainsFor(config, { root: identity.root, origin });
  if (brains.length === 1) {
    const brain = brains[0];
    const folder = { common: identity.common, repo: repoLabel(identity.root, origin) };
    if (!persist) return { status: 'bound', project: projectKey(brain.stateDir, brain.workspace), entry: { ...brain }, folder, cwd: identity.root, name: brain.name, source: 'inferred' };
    const saved = await persistBinding(brain, folder);
    return bound(saved.project, saved.entry, saved.folder, identity.root, { source: 'inferred' });
  }
  if (brains.length > 1)
    return { status: 'ambiguous', reason: 'This repository is listed by more than one Flow Brain. Bind the folder to one Brain in Flow.', brains: brains.map(b => ({ workspace: b.workspace, name: b.name })) };
  await rememberNegative(identity.root);
  return unbound(reachable ? 'No Flow Brain lists this repository.' : 'Flow is not running.');
}

export function childCheckouts(root) {
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const children = [];
  for (const entry of entries) {
    if (children.length >= MAX_CHILDREN) break;
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const path = join(root, entry.name);
    if (existsSync(join(path, '.git'))) children.push(path);
  }
  return children;
}

async function inferFolder(config, identity, persist) {
  const children = childCheckouts(identity.root);
  if (!children.length) return unbound('This folder is not a Git checkout and contains none.');
  const brains = new Map();
  const repos = [];
  for (const child of children) {
    let resolved;
    try { resolved = await resolveBinding(child, { persist, config }); } catch { continue; }
    if (resolved.status !== 'bound') continue;
    const key = `${resolved.entry.stateDir}:${resolved.entry.workspace}`;
    if (!brains.has(key)) brains.set(key, { stateDir: resolved.entry.stateDir, workspace: resolved.entry.workspace, name: resolved.name });
    repos.push(resolved.folder.repo);
  }
  if (brains.size === 1) {
    const brain = brains.values().next().value;
    const folder = { common: identity.common, repo: basename(identity.root), inferred: true, repos };
    if (!persist) return { status: 'bound', project: projectKey(brain.stateDir, brain.workspace), entry: { ...brain }, folder, cwd: identity.root, name: brain.name, source: 'children' };
    const saved = await persistBinding(brain, folder);
    return bound(saved.project, saved.entry, saved.folder, identity.root, { source: 'children' });
  }
  if (brains.size > 1)
    return { status: 'ambiguous', reason: 'The checkouts in this folder belong to different Flow Brains. Bind the folder to one Brain in Flow.', brains: [...brains.values()].map(b => ({ workspace: b.workspace, name: b.name })) };
  return unbound('None of the checkouts in this folder belong to a Flow Brain.');
}

/**
 * Resolve the Brain binding for a folder. Never throws for "not connected";
 * only Git or filesystem failures that must stay visible propagate.
 */
export async function resolveBinding(cwd, { persist = true, config } = {}) {
  config ??= await readJson(join(home(), 'config.json'), {});
  const identity = gitIdentity(cwd);
  const explicit = findExplicit(config, identity.common, identity.root);
  if (explicit) return explicit;
  if (!identity.common.startsWith('folder:')) return inferCheckout(config, identity, persist);
  return inferFolder(config, identity, persist);
}

/** The folder a harness event belongs to, preferring what the harness reported over our cwd. */
export function eventFolder(event, fallback = process.cwd()) {
  const candidates = [
    event?.cwd,
    event?.workspace_roots?.[0],
    event?.workspacePaths?.[0],
    process.env.CLAUDE_PROJECT_DIR,
    process.env.CURSOR_PROJECT_DIR,
  ];
  for (const candidate of candidates) if (typeof candidate === 'string' && candidate && existsSync(candidate)) return candidate;
  return fallback;
}
