// opencode.ts — Job queue for opencode sessions: index_repo | enrich | answer | continue | correct_graph.
//
// Real runs spawn `opencode run --format json` so we can parse the sessionID from the
// emitted event stream and store it for session-per-chat continuity (G10).
// FLOW_FAKE_OPENCODE=1 → calls test/fake-opencode.ts instead.
//
// Env injected into every real opencode subprocess:
//   ORCHESTRATOR_URL   — allows the notify tool to POST back
//   FLOW_ADMIN_TOKEN   — bearer token for /v1/notify
//   FLOW_JOB_ID        — so the tool knows which job it belongs to

import { spawn, spawnSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import db, { DB_DIR } from "./db.js";
import { postSlackMessage } from "./actions/slack.js";
import { getSetting } from "./settings.js";
import { logLLM } from "./llmlog.js";
import { projectGraphName } from "./agents/runtime.js";
import {
  graphBuilderInstructions,
  indexerModel,
  mcpServerSpec,
  resolveBackendExecutable,
  resolveIndexerBackend,
} from "./indexer-runtime.js";
import { finishActivity, recordActivityLine, startActivity } from "./job-activity.js";
import { indexLog } from "./index-log.js";
import { resolveGithubDefaultBranch } from "./repo-branch.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const WORKSPACE_DIR =
  process.env.OPENCODE_WORKSPACE_DIR ?? resolve(__dirname, "../../index-workspace");

// The opencode runtime the graph builder + Ask shell out to. We bundle
// `opencode-ai` (its platform binary arrives via optionalDependencies, like
// esbuild), so users never install opencode themselves. Resolve the bundled
// binary; fall back to a system `opencode` on PATH if resolution ever fails.
const OPENCODE_BIN = ((): string => {
  try {
    const pkgPath = createRequire(import.meta.url).resolve("opencode-ai/package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { bin?: string | Record<string, string> };
    const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.opencode;
    if (binRel) {
      const binAbs = resolve(pkgPath, "..", binRel);
      if (existsSync(binAbs)) return binAbs;
    }
  } catch {
    /* opencode-ai not resolvable — fall back to PATH */
  }
  return "opencode";
})();

// Per-repo mutex: set of repos currently being indexed
const runningRepos = new Set<string>();

// Global index wait queue — FIFO across repos, at most one entry per repo.
// Index jobs are SEQUENTIAL across repos by default (concurrency 1): the
// whole point of a shared multi-repo graph is cross-repo connections, and a
// builder can only attach contracts to another repo's entities if that
// repo's subgraph is complete and stable when it looks. Two builders running
// at once each see the other's half-written graph, and find-before-create
// races into duplicate entities. A job that can't run yet (its repo is busy,
// or all slots are taken) waits here; a newer request for the SAME repo
// supersedes the waiting one in place (its row is failed) so exactly one
// job — carrying the latest input — runs per repo. In-memory;
// recoverStalledJobs re-enqueues waiting rows after a restart.
const indexWaitQueue: { id: string; opts: JobInput; repo: string }[] = [];

// Deliberate-tradeoff escape hatch: raising this trades cross-repo linking
// quality for wall-clock speed on big fleets.
function maxConcurrentIndexes(): number {
  const v = Number(process.env.FLOW_MAX_CONCURRENT_INDEXES ?? "1");
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 1;
}

const insertJob = db.prepare(`
  INSERT INTO jobs (id, type, input, status, repo)
  VALUES (@id, @type, @input, 'queued', @repo)
`);

const updateJob = db.prepare(`
  UPDATE jobs SET status = @status, result_json = @result_json, updated_at = unixepoch()
  WHERE id = @id
`);

const updateJobSession = db.prepare(`
  UPDATE jobs SET session_id = @session_id, updated_at = unixepoch()
  WHERE id = @id
`);

const selectJob = db.prepare(`SELECT * FROM jobs WHERE id = ?`);

const upsertThreadSession = db.prepare(`
  INSERT INTO thread_sessions (thread_key, session_id, job_id, status, last_activity)
  VALUES (@thread_key, @session_id, @job_id, 'active', unixepoch())
  ON CONFLICT(thread_key) DO UPDATE SET
    session_id    = @session_id,
    job_id        = @job_id,
    status        = 'active',
    last_activity = unixepoch()
`);

export interface JobInput {
  type: "index_repo" | "enrich" | "answer" | "continue" | "correct_graph";
  input: Record<string, unknown>;
  repo?: string;
}

export interface Job {
  id: string;
  type: string;
  input: Record<string, unknown>;
  status: "queued" | "running" | "done" | "failed";
  result_json?: string;
  repo?: string;
  notify_count: number;
  session_id?: string;
}

// ------------------------------------------------------------------
// Repo registry + clone management (workspace/repos.json + repos/)
// ------------------------------------------------------------------

export interface RepoEntry {
  name: string;
  url: string;
  branch: string;
  lastIndexedCommit?: string | null;
  lastIndexedAt?: string;
  addedAt?: string;
  // Sources front door. A source plays up to two roles: BRAIN (indexed) and
  // WORK (where coding-agent sessions run). `kind` distinguishes an indexed
  // CODE repo from a DOCS folder; absent = code (back-compat with old rows).
  kind?: "code" | "docs";
  // The user's OWN checkout — the WORK surface. For a GitHub repo the BRAIN is
  // still Flow's managed clone under repos/<name>; localPath is only where
  // sessions run in-place. For a local-only (no-remote) repo it is ALSO the
  // BRAIN we index from (the "local tier").
  localPath?: string;
  // Docs entries: the folder on disk + its ingestion state (the pipeline is a
  // later task, so freshly-added docs sit at "pending_ingestion").
  path?: string;
  status?: "pending_ingestion";
}

// A single source registration. Every field except `name` is optional so the
// one function can register a GitHub repo, a local-only repo, or a docs folder
// (and, on re-add, patch just the fields that changed).
export interface SourceRegistration {
  name: string;
  kind?: "code" | "docs";
  url?: string;
  branch?: string;
  localPath?: string;
  path?: string;
  status?: "pending_ingestion";
}

function reposJsonPath(): string {
  return resolve(WORKSPACE_DIR, "repos.json");
}

function readRepoRegistry(): { repos: RepoEntry[] } {
  try {
    return JSON.parse(readFileSync(reposJsonPath(), "utf8")) as { repos: RepoEntry[] };
  } catch {
    return { repos: [] };
  }
}

export function listWorkspaceRepos(): RepoEntry[] {
  return readRepoRegistry().repos;
}

export function registerRepo(url: string, branch: string): RepoEntry {
  const name = url.replace(/\/+$/, "").split("/").pop()!.replace(/\.git$/, "");
  const registry = readRepoRegistry();
  const existing = registry.repos.find((r) => r.name === name);
  if (existing) {
    existing.url = url;
    existing.branch = branch;
    writeFileSync(reposJsonPath(), JSON.stringify(registry, null, 2));
    return existing;
  }
  const entry: RepoEntry = { name, url, branch, lastIndexedCommit: null, addedAt: new Date().toISOString() };
  registry.repos.push(entry);
  writeFileSync(reposJsonPath(), JSON.stringify(registry, null, 2));
  return entry;
}

// Register any source shape (GitHub repo, local-only repo, docs folder) into
// repos.json. Dedupe by name; on re-add patch only the fields the caller
// supplied (mirrors registerRepo's update-in-place behaviour). Returns the
// stored entry.
export function registerSource(entry: SourceRegistration): RepoEntry {
  const registry = readRepoRegistry();
  const existing = registry.repos.find((r) => r.name === entry.name);
  if (existing) {
    if (entry.kind !== undefined) existing.kind = entry.kind;
    if (entry.url !== undefined) existing.url = entry.url;
    if (entry.branch !== undefined) existing.branch = entry.branch;
    if (entry.localPath !== undefined) existing.localPath = entry.localPath;
    if (entry.path !== undefined) existing.path = entry.path;
    if (entry.status !== undefined) existing.status = entry.status;
    writeFileSync(reposJsonPath(), JSON.stringify(registry, null, 2));
    return existing;
  }
  const created: RepoEntry = {
    name: entry.name,
    url: entry.url ?? "",
    branch: entry.branch ?? "main",
    lastIndexedCommit: null,
    addedAt: new Date().toISOString(),
    ...(entry.kind ? { kind: entry.kind } : {}),
    ...(entry.localPath ? { localPath: entry.localPath } : {}),
    ...(entry.path ? { path: entry.path } : {}),
    ...(entry.status ? { status: entry.status } : {}),
  };
  registry.repos.push(created);
  writeFileSync(reposJsonPath(), JSON.stringify(registry, null, 2));
  return created;
}

// Record the commit we just indexed so update.mjs and the orchestrator agree
// on state. Called after every successful index_repo job — lastIndexedAt is
// stamped even when no commit resolves (a non-git docs folder), so a
// successful index is never invisible to the status machine.
export function updateRepoIndexCommit(name: string, commit: string | null): void {
  const registry = readRepoRegistry();
  const existing = registry.repos.find((r) => r.name === name);
  if (existing) {
    if (commit) existing.lastIndexedCommit = commit;
    existing.lastIndexedAt = new Date().toISOString();
    writeFileSync(reposJsonPath(), JSON.stringify(registry, null, 2));
  }
}

// Full cleanup for a disconnected repo. Idempotent — the dashboard deletes
// the registry entry itself before posting repo_removed, so every step
// tolerates already-gone state. Steps: drop the registry entry (no-op if the
// dashboard got there first), stop the push poller, fail parked/queued index
// jobs, remove the managed clone (a symlink is unlinked, never followed —
// the target is the user's own checkout), and drop the repo:<name> node from
// the graph via the gateway's admin endpoint (best-effort: graph cleanup
// must not block filesystem cleanup if the gateway is down).
export async function removeRepo(name: string): Promise<Record<string, unknown>> {
  const summary: Record<string, unknown> = {};

  const registry = readRepoRegistry();
  const before = registry.repos.length;
  registry.repos = registry.repos.filter((r) => r.name !== name);
  if (registry.repos.length < before) {
    writeFileSync(reposJsonPath(), JSON.stringify(registry, null, 2));
    summary.registry = "removed";
  }

  const { unwatchRepo } = await import("./adapters/github.js");
  if (unwatchRepo(name)) summary.watch = "removed";

  // Waiting job dies with its repo; queued rows are failed so they never run.
  const waitingIdx = indexWaitQueue.findIndex((e) => e.repo === name);
  if (waitingIdx >= 0) {
    const [waiting] = indexWaitQueue.splice(waitingIdx, 1);
    updateJob.run({
      id: waiting.id,
      status: "failed",
      result_json: JSON.stringify({ error: "repo_removed" }),
    });
    summary.parked_job = waiting.id;
  }
  const queued = db
    .prepare(`SELECT id FROM jobs WHERE status = 'queued' AND type = 'index_repo' AND repo = ?`)
    .all(name) as { id: string }[];
  for (const row of queued) {
    updateJob.run({ id: row.id, status: "failed", result_json: JSON.stringify({ error: "repo_removed" }) });
  }
  if (queued.length > 0) summary.queued_jobs_cancelled = queued.length;
  // A running indexer for a removed repo must not keep writing to the graph.
  const killed = killJobsForRepo(name);
  if (killed.length > 0) summary.running_jobs_killed = killed;

  const dest = resolve(WORKSPACE_DIR, "repos", name);
  let isLink = false;
  try {
    isLink = lstatSync(dest).isSymbolicLink(); // lstat: a dangling symlink still counts
  } catch {
    /* nothing at dest */
  }
  if (isLink) {
    unlinkSync(dest);
    summary.checkout = "symlink removed";
  } else if (existsSync(dest)) {
    rmSync(dest, { recursive: true, force: true });
    summary.checkout = "clone removed";
  }

  try {
    const gatewayUrl = (process.env.GATEWAY_URL ?? "http://127.0.0.1:7433").replace(/\/+$/, "");
    const token = process.env.GATEWAY_TOKEN || process.env.FLOW_ADMIN_TOKEN || "";
    const res = await fetch(`${gatewayUrl}/v1/admin/delete-entity`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ graph: projectGraphName(), id: `repo:${name}`, actor: "orchestrator:repo_removed" }),
    });
    summary.graph_node = ((await res.json()) as { status?: string }).status ?? "unknown";
  } catch (err) {
    summary.graph_node = `unreachable: ${String(err).split("\n")[0]}`;
  }

  indexLog(name, "removed", undefined, summary);
  return summary;
}

// ------------------------------------------------------------------
// Repo state machine — the single answer to "what is the indexer doing
// with this repo right now, and when did it last succeed?" Derived from
// the registry (durable truth) + jobs table + in-memory queue, never from
// model-written graph props.
// ------------------------------------------------------------------

export interface RepoStatus {
  name: string;
  branch: string;
  status: "never_indexed" | "queued" | "indexing" | "indexed" | "failed";
  lastIndexedCommit: string | null;
  lastIndexedAt: string | null;
  lastError: string | null;
  runningJobId: string | null;
  queuedJobId: string | null;
}

export function repoStatuses(): RepoStatus[] {
  const lastFailed = db.prepare(
    `SELECT result_json FROM jobs
     WHERE type = 'index_repo' AND repo = ? AND status = 'failed'
     ORDER BY updated_at DESC LIMIT 1`,
  );
  const runningJob = db.prepare(
    `SELECT id FROM jobs WHERE type = 'index_repo' AND repo = ? AND status = 'running' LIMIT 1`,
  );
  return readRepoRegistry().repos.map((entry) => {
    const running = (runningJob.get(entry.name) as { id: string } | undefined)?.id ?? null;
    const parked = indexWaitQueue.find((e) => e.repo === entry.name)?.id ?? null;
    // Either field proves a successful index — local-tier repos may lack a
    // commit (see updateRepoIndexCommit) but always get lastIndexedAt.
    const indexed = Boolean(entry.lastIndexedCommit || entry.lastIndexedAt);
    let lastError: string | null = null;
    let status: RepoStatus["status"];
    if (running) status = "indexing";
    else if (parked) status = "queued";
    else if (indexed) status = "indexed";
    else {
      const failed = lastFailed.get(entry.name) as { result_json: string | null } | undefined;
      if (failed?.result_json) {
        lastError = (JSON.parse(failed.result_json) as { error?: string }).error ?? null;
        status = "failed";
      } else {
        status = "never_indexed";
      }
    }
    return {
      name: entry.name,
      branch: entry.branch,
      status,
      lastIndexedCommit: entry.lastIndexedCommit ?? null,
      lastIndexedAt: entry.lastIndexedAt ?? null,
      lastError,
      runningJobId: running,
      queuedJobId: parked,
    };
  });
}

// Stamp code-maintained freshness props onto the graph's Repository node
// after a successful index. These are OWNED by the orchestrator — the
// graph-builder agent is told not to touch them — so `get_entity repo:<x>`
// can never show a stale model-invented head_commit again. Best-effort:
// graph metadata must not fail the job that just succeeded.
async function stampRepoNode(name: string, branch: string, head: string | null): Promise<void> {
  try {
    const gatewayUrl = (process.env.GATEWAY_URL ?? "http://127.0.0.1:7433").replace(/\/+$/, "");
    const token = process.env.GATEWAY_TOKEN || process.env.FLOW_ADMIN_TOKEN || "";
    const res = await fetch(`${gatewayUrl}/v1/verbs/upsert_entity`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({
        graph: projectGraphName(),
        type: "Repository",
        id: `repo:${name}`,
        name,
        confirm: true,
        props: {
          default_branch: branch,
          ...(head ? { head_commit: head } : {}),
          indexed_at: new Date().toISOString(),
        },
        provenance: { actor: "orchestrator:index_done", evidence: `index_repo job on ${branch}`, confidence: "high" },
      }),
    });
    const body = (await res.json()) as { status?: string; error?: string };
    if (body.status === "error") console.warn(`[indexer] repo-node stamp failed for ${name}: ${body.error}`);
  } catch (err) {
    console.warn(`[indexer] repo-node stamp unreachable for ${name}: ${String(err).split("\n")[0]}`);
  }
}


// Full-pass vs incremental: after a push, if the last indexed commit is an
// ancestor of the refreshed HEAD (same branch, no history rewrite) and the
// diff is modest, the indexer only needs to read what changed. Returns null
// whenever a full pass is the safe answer: first index, branch changed,
// rewritten history, local/symlinked checkout, or a diff too big to trust
// an incremental read. Mirrors index-workspace/scripts/update.mjs, which
// pioneered this logic but was never wired into the event-driven pipeline.
const INCREMENTAL_MAX_FILES = 200;
export function incrementalContext(repo: string, branch: string): { from: string; to: string; stat: string } | null {
  const entry = readRepoRegistry().repos.find((r) => r.name === repo);
  const last = entry?.lastIndexedCommit;
  if (!last || entry?.branch !== branch) return null;
  const dest = resolve(WORKSPACE_DIR, "repos", repo);
  if (!existsSync(dest) || lstatSync(dest).isSymbolicLink()) return null;
  try {
    const ancestor = spawnSync("git", ["-C", dest, "merge-base", "--is-ancestor", last, "HEAD"], { timeout: 5000 });
    if (ancestor.status !== 0) return null;
    const head = spawnSync("git", ["-C", dest, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 5000 }).stdout?.trim();
    if (!head || head === last) return null;
    const stat = spawnSync("git", ["-C", dest, "diff", "--stat", `${last}..HEAD`], { encoding: "utf8", timeout: 10_000 }).stdout ?? "";
    const trimmed = stat.trim();
    if (!trimmed) return null;
    const changedFiles = trimmed.split("\n").length - 1; // last line is the summary
    if (changedFiles < 1 || changedFiles > INCREMENTAL_MAX_FILES) return null;
    return { from: last, to: head, stat: trimmed };
  } catch {
    return null;
  }
}

// Resolve the commit that was just indexed. Managed clones and the local
// tier both live at repos/<name>; for a symlink (the user's own checkout,
// indexed in place) HEAD is read through the link — the target is still a
// git repo, and it is exactly what the indexer read. Skipping symlinks here
// left local-only repos showing "never indexed" forever after successful
// runs. Null only when the folder is missing or not a git repo.
function repoHeadCommit(name: string): string | null {
  const dest = resolve(WORKSPACE_DIR, "repos", name);
  if (!existsSync(dest)) return null;
  try {
    const res = spawnSync("git", ["-C", dest, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 5000 });
    return res.status === 0 ? res.stdout.trim() : null;
  } catch {
    return null;
  }
}

// Shared GitHub-repo connection path: register in repos.json, (optionally)
// record the user's own checkout as the WORK surface, start watching the
// branch for PR/push events, and queue the index job. Factored out of the
// dashboard repo_added handler so the sources front door reuses the EXACT
// same path (no drift between the two entry points). Audit rows are the
// caller's concern — this returns the registry entry + job id.
export async function connectGithubRepo(
  url: string,
  branch?: string,
  localPath?: string,
): Promise<{ entry: RepoEntry; jobId: string }> {
  const name = url.replace(/\/+$/, "").split("/").pop()!.replace(/\.git$/, "");
  const existing = readRepoRegistry().repos.find((repo) => repo.name === name);
  // The registry is name-keyed and registerRepo updates-by-name, so adding
  // owner2/web after owner1/web would silently overwrite owner1's entry and
  // repoint its clone, jobs, and graph evidence. Refuse instead (mirrors
  // assertNameFree on the sources front door). Re-adding the same URL is a
  // harmless update.
  if (existing?.url && existing.url !== url) {
    throw new Error(
      `a repo named "${name}" is already connected (${existing.url}) — remove it first or connect this one under a different name`,
    );
  }
  const existingBranch = existing?.branch?.trim();
  const resolvedBranch = branch?.trim() || existingBranch || await resolveGithubDefaultBranch(url);
  const entry = registerRepo(url, resolvedBranch);
  if (localPath) registerSource({ name: entry.name, localPath });
  // registeredRepos is otherwise only seeded at boot — watch this branch now.
  const { watchRepo, watchKeyForUrl } = await import("./adapters/github.js");
  const watchKey = watchKeyForUrl(url);
  if (watchKey) watchRepo(watchKey, entry.branch);
  const job = await enqueueJob({
    type: "index_repo",
    input: { repo: entry.name, url: entry.url, branch: entry.branch },
    repo: entry.name,
  });
  return { entry, jobId: job.id };
}

// Clone into workspace/repos/<name> if the checkout is missing. Async — a
// multi-minute clone must never block the event loop. Private repos: the
// GITHUB_TOKEN (settings or env) is injected into the clone URL only; it is
// never written to disk, the registry, or error messages.
export async function ensureRepoClone(entry: { name: string; url?: string; branch?: string }): Promise<string> {
  // One tier, one mechanism: every indexable source is a git repo we CLONE
  // from — a remote URL or a local filesystem path (git treats a path as a
  // remote). The old local tier symlinked repos/<name> to the user's checkout,
  // which broke commit bookkeeping and read uncommitted state; a clone from
  // the path gives local repos the exact same fetch/reset/poll machinery.
  const dest = resolve(WORKSPACE_DIR, "repos", entry.name);

  // Legacy migration: a symlinked checkout from the old local tier is
  // replaced by a real clone on the next index.
  let isLink = false;
  try {
    isLink = lstatSync(dest).isSymbolicLink();
  } catch {
    /* nothing at dest */
  }
  if (isLink) unlinkSync(dest);
  else if (existsSync(dest)) return dest;

  // Clone source: the entry's url (remote or path). Legacy local-only entries
  // registered url:"" with only a localPath — use the path and self-heal the
  // registry so pollers and future jobs see it as the clone source.
  let cloneSrc = entry.url ?? "";
  if (!cloneSrc) {
    const registry = readRepoRegistry();
    const reg = registry.repos.find((r) => r.name === entry.name);
    if (reg?.localPath && existsSync(reg.localPath)) {
      cloneSrc = reg.localPath;
      reg.url = reg.localPath;
      writeFileSync(reposJsonPath(), JSON.stringify(registry, null, 2));
    }
  }
  if (!cloneSrc) throw new Error(`repo '${entry.name}' has no checkout and no url to clone from`);
  mkdirSync(resolve(WORKSPACE_DIR, "repos"), { recursive: true });

  const token = getSetting("GITHUB_TOKEN");
  let cloneUrl = cloneSrc;
  if (token && /^https:\/\/github\.com\//.test(cloneUrl)) {
    cloneUrl = cloneUrl.replace("https://github.com/", `https://x-access-token:${token}@github.com/`);
  }
  const args = ["clone", "--single-branch", ...(entry.branch ? ["--branch", entry.branch] : []), cloneUrl, dest];
  const res = await spawnAsync("git", args, process.env, 5 * 60 * 1000);
  if (res.status !== 0) {
    const detail = (res.stderr ?? res.error?.message ?? "unknown").split("\n")[0];
    throw new Error(`git clone failed for ${entry.name}: ${token ? detail.replaceAll(token, "***") : detail}`);
  }
  return dest;
}

// For managed GitHub clones: fetch origin and reset to the registered branch
// so index_repo runs against current base-branch HEAD. Local/symlinked checkouts
// (user's own work surface) are never touched.
export async function refreshRepoCheckout(name: string, branch: string): Promise<void> {
  const dest = resolve(WORKSPACE_DIR, "repos", name);
  if (!existsSync(dest)) return;
  if (lstatSync(dest).isSymbolicLink()) return; // local tier — user's own checkout
  const token = getSetting("GITHUB_TOKEN");
  const env = token
    ? { ...process.env, GIT_ASKPASS: "echo", GIT_USERNAME: "x-access-token", GIT_PASSWORD: token }
    : process.env;
  // Clones are made --single-branch, so the fetch refspec only covers the
  // branch registered at clone time. After a branch change the new branch
  // must be added to the refspec or `fetch origin <branch>` never creates
  // refs/remotes/origin/<branch> and the reset below fails forever.
  await spawnAsync("git", ["-C", dest, "remote", "set-branches", "--add", "origin", branch], env, 10_000);
  const fetch = await spawnAsync("git", ["-C", dest, "fetch", "origin", branch], env, 60_000);
  if (fetch.status !== 0) {
    throw new Error(`git fetch failed for ${name}: ${(fetch.stderr ?? fetch.error?.message ?? "unknown").split("\n")[0]}`);
  }
  const reset = await spawnAsync("git", ["-C", dest, "reset", "--hard", `origin/${branch}`], env, 30_000);
  if (reset.status !== 0) {
    throw new Error(`git reset failed for ${name}: ${(reset.stderr ?? reset.error?.message ?? "unknown").split("\n")[0]}`);
  }
}

// Stall recovery (S103): on boot, any job left 'running' by a crash/restart is
// marked failed. index_repo jobs are re-queued so indexing resumes.
export function recoverStalledJobs(): void {
  const stalled = db.prepare(`SELECT id, type, input, repo FROM jobs WHERE status = 'running'`).all() as
    { id: string; type: string; input: string; repo: string | null }[];
  for (const row of stalled) {
    db.prepare(`UPDATE jobs SET status = 'failed', result_json = ?, updated_at = unixepoch() WHERE id = ?`)
      .run(JSON.stringify({ error: "stalled:process_restart" }), row.id);
  }
  // Parked index jobs died with the process too — the coalescing queue is
  // in-memory, so their rows sit at 'queued' forever unless recovered here.
  const parked = db
    .prepare(`SELECT id, type, input, repo FROM jobs WHERE status = 'queued' AND type = 'index_repo'`)
    .all() as { id: string; type: string; input: string; repo: string | null }[];
  for (const row of parked) {
    db.prepare(`UPDATE jobs SET status = 'failed', result_json = ?, updated_at = unixepoch() WHERE id = ?`)
      .run(JSON.stringify({ error: "stalled:process_restart" }), row.id);
  }
  // One fresh job per repo — a repo with both a stalled-running and a parked
  // row gets a single reindex (the rerun indexes the checkout's latest HEAD
  // regardless of which input it carries; prefer the parked row's input since
  // it is the newer request).
  const reindexByRepo = new Map<string, { input: string; repo: string | null }>();
  for (const row of [...stalled.filter((r) => r.type === "index_repo"), ...parked]) {
    reindexByRepo.set(row.repo ?? row.id, row);
  }
  for (const [, row] of reindexByRepo) {
    if (row.repo) indexLog(row.repo, "recovered", undefined, { reason: "process_restart" });
    void enqueueJob({ type: "index_repo", input: JSON.parse(row.input) as Record<string, unknown>, repo: row.repo ?? undefined });
  }
  // Corrections whose verification job died with the process: mark the row
  // failed so it doesn't sit in 'verifying' forever (the inbox shows it).
  // Parse defensively — one corrupt input row must not abort the whole
  // recovery pass for the other stalled jobs.
  for (const row of stalled.filter((r) => r.type === "correct_graph")) {
    let correctionId: string | undefined;
    try {
      correctionId = (JSON.parse(row.input) as { correction_id?: string }).correction_id;
    } catch {
      continue;
    }
    if (correctionId) {
      const cid = correctionId;
      void import("./corrections.js").then(({ resolveFromJobResult }) =>
        resolveFromJobResult(cid, "stalled:process_restart", true)
      );
    }
  }
  if (stalled.length > 0 || parked.length > 0) {
    console.warn(
      `[opencode] recovered ${stalled.length} stalled + ${parked.length} parked job(s); re-queued ${reindexByRepo.size} index job(s)`,
    );
  }
}

// Enqueue a job and kick off execution in background (non-blocking enqueue)
export async function enqueueJob(opts: JobInput): Promise<{ id: string }> {
  const normalizedOpts = normalizeIndexJob(opts);
  const id = randomUUID();
  insertJob.run({
    id,
    type: normalizedOpts.type,
    input: JSON.stringify(normalizedOpts.input),
    repo: normalizedOpts.repo ?? null,
  });
  if (normalizedOpts.type === "index_repo" && normalizedOpts.repo) {
    indexLog(normalizedOpts.repo, "enqueued", id, {
      branch: (normalizedOpts.input as { branch?: string }).branch,
    });
  }

  // Execute async — don't await; callers get the job id and can poll
  setImmediate(() => void runJob(id, normalizedOpts));

  return { id };
}

// One normalization boundary for every index entry point. Explicit input wins;
// otherwise hydrate from the durable registry. This prevents a branchless
// reindex request from silently changing a repo registered on master/trunk to
// main, and it ensures the stored job records the branch it will actually use.
function normalizeIndexJob(opts: JobInput): JobInput {
  if (opts.type !== "index_repo") return opts;

  const inputRepo = typeof opts.input.repo === "string" ? opts.input.repo.trim() : "";
  const repo = inputRepo || opts.repo?.trim() || "";
  if (!repo) throw new Error("index_repo requires a repo");

  const entry = readRepoRegistry().repos.find((candidate) => candidate.name === repo);
  const inputBranch = typeof opts.input.branch === "string" ? opts.input.branch.trim() : "";
  const branch = inputBranch || entry?.branch?.trim() || "";
  if (!branch) {
    throw new Error(`index_repo requires a branch for '${repo}' (none supplied or registered)`);
  }

  const inputUrl = typeof opts.input.url === "string" ? opts.input.url.trim() : "";
  const url = inputUrl || entry?.url?.trim() || "";
  return {
    ...opts,
    repo,
    input: {
      ...opts.input,
      repo,
      ...(url ? { url } : {}),
      branch,
    },
  };
}

function requiredIndexBranch(input: Record<string, unknown>): string {
  const branch = typeof input.branch === "string" ? input.branch.trim() : "";
  if (!branch) throw new Error("normalized index_repo job is missing its branch");
  return branch;
}

export function getJob(id: string): Job | null {
  const row = selectJob.get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    ...row,
    input: JSON.parse(row.input as string) as Record<string, unknown>,
    notify_count: (row.notify_count as number) ?? 0,
  } as Job;
}

async function runJob(id: string, opts: JobInput): Promise<void> {
  const repo = opts.repo ?? "";

  // Admission for index_repo jobs. A job that can't run yet — its repo is
  // already indexing, or every concurrency slot is taken (default 1: repos
  // index one at a time so each builder sees the previous repos' complete
  // subgraphs and cross-repo links attach instead of duplicating) — waits in
  // the FIFO queue instead of failing. Per repo only the newest request is
  // kept: a waiting job carries stale input (old branch, old SHA) once a
  // newer request exists, so the older row is failed as superseded. Push
  // events that land during a long index are therefore indexed, not dropped.
  if (opts.type === "index_repo" && repo) {
    const repoBusy = runningRepos.has(repo);
    if (repoBusy || runningRepos.size >= maxConcurrentIndexes()) {
      const waitingIdx = indexWaitQueue.findIndex((e) => e.repo === repo);
      if (waitingIdx >= 0) {
        const prev = indexWaitQueue[waitingIdx];
        updateJob.run({
          id: prev.id,
          status: "failed",
          result_json: JSON.stringify({ error: `superseded:${id}` }),
        });
        indexLog(repo, "superseded", prev.id, { by: id });
        // Replace in place — the repo keeps its position in line.
        indexWaitQueue[waitingIdx] = { id, opts, repo };
      } else {
        indexWaitQueue.push({ id, opts, repo });
      }
      indexLog(repo, "parked", id, {
        branch: (opts.input as { branch?: string }).branch,
        reason: repoBusy ? "repo already indexing" : `waiting for slot (${runningRepos.size}/${maxConcurrentIndexes()} busy)`,
      });
      return; // row stays 'queued'; a finishing job kicks it off
    }
    runningRepos.add(repo);
  }

  updateJob.run({ id, status: "running", result_json: null });
  const startedAt = Date.now();
  if (opts.type === "index_repo" && repo) {
    indexLog(repo, "started", id, { branch: (opts.input as { branch?: string }).branch });
  }

  try {
    // Index jobs need the checkout on disk before the agent can read it.
    if (opts.type === "index_repo" && !process.env.FLOW_FAKE_OPENCODE) {
      const input = opts.input as { repo?: string; url?: string; branch?: string; trigger?: string };
      if (input.repo) {
        const branch = requiredIndexBranch(input);
        await ensureRepoClone({ name: input.repo, url: input.url, branch });
        await refreshRepoCheckout(input.repo, branch);
        // Push-triggered runs read only the diff when it's safe to; manual
        // reindexes and first indexes always do the full pass (a human asking
        // for a reindex means "re-derive it, don't trust the last run").
        if (input.trigger === "push") {
          const inc = incrementalContext(input.repo, branch);
          if (inc) (opts.input as Record<string, unknown>).incremental = inc;
        }
      }
    }

    let runResult: { result: unknown; sessionId: string };

    if (process.env.FLOW_FAKE_OPENCODE) {
      runResult = await runFakeOpencode(opts, id);
    } else {
      runResult = await runRealOpencode(opts, id);
    }

    const { result, sessionId } = runResult;

    // Entity writes come from short-lived MCP processes. They normally embed
    // each node through the gateway immediately; this final pass catches any
    // writes made while the local model was still loading.
    if (opts.type === "index_repo" && !process.env.FLOW_FAKE_OPENCODE) {
      await reconcileGraphEmbeddings();
    }

    // Persist session_id on the job row
    if (sessionId) {
      updateJobSession.run({ id, session_id: sessionId });
    }

    updateJob.run({ id, status: "done", result_json: JSON.stringify(result) });
    finishActivity(id, "done");

    // Record the commit we just indexed so update.mjs and the orchestrator agree.
    if (opts.type === "index_repo" && repo) {
      const head = repoHeadCommit(repo);
      updateRepoIndexCommit(repo, head);
      const inc = (opts.input as { incremental?: { from: string } }).incremental;
      indexLog(repo, "done", id, {
        ...(head ? { commit: head } : {}),
        mode: inc ? `incremental from ${inc.from.slice(0, 10)}` : "full",
        duration_ms: Date.now() - startedAt,
      });
      // Graph freshness props are code-maintained, not model-invented.
      const branch = (opts.input as { branch?: string }).branch;
      if (branch && !process.env.FLOW_FAKE_OPENCODE) void stampRepoNode(repo, branch, head);
    }

    // Resolve the corrections row from the agent's trailing verdict JSON.
    if (opts.type === "correct_graph") {
      const correctionId = (opts.input as { correction_id?: string }).correction_id;
      if (correctionId) {
        const { resolveFromJobResult } = await import("./corrections.js");
        resolveFromJobResult(correctionId, String((result as { raw?: string }).raw ?? ""), false);
      }
    }

    // Deliver answer/continuation to the originating thread via outbox
    const replyTo = (opts.input as { reply_to?: { channel: string; thread_ts?: string } }).reply_to;
    if ((opts.type === "answer" || opts.type === "continue") && replyTo?.channel) {
      const a = result as {
        answer_md?: string;
        citations?: { kind: string; ref: string }[];
        confidence?: number;
      };
      const cites = (a.citations ?? []).map((ci) => `• ${ci.kind}: ${ci.ref}`).join("\n");
      await postSlackMessage({
        channel: replyTo.channel,
        thread_ts: replyTo.thread_ts,
        text: `${a.answer_md ?? "(no answer)"}${cites ? `\n\n_Sources:_\n${cites}` : ""}`,
        event_id: (opts.input as { event_id?: string }).event_id,
      });

      // Bind thread_sessions for session-per-chat continuity (G10)
      if (sessionId && replyTo.channel) {
        const workspace = (opts.input as { workspace?: string }).workspace ?? "";
        const thread_ts = replyTo.thread_ts ?? "";
        const thread_key = `${workspace}:${replyTo.channel}:${thread_ts}`;
        upsertThreadSession.run({ thread_key, session_id: sessionId, job_id: id });
      }
    }
  } catch (err) {
    updateJob.run({
      id,
      status: "failed",
      result_json: JSON.stringify({ error: String(err) }),
    });
    finishActivity(id, "failed");
    if (opts.type === "index_repo" && repo) {
      indexLog(repo, "failed", id, { error: String(err), duration_ms: Date.now() - startedAt });
    }
    if (opts.type === "correct_graph") {
      const correctionId = (opts.input as { correction_id?: string }).correction_id;
      if (correctionId) {
        const { resolveFromJobResult } = await import("./corrections.js");
        resolveFromJobResult(correctionId, String(err), true);
      }
    }
  } finally {
    if (opts.type === "index_repo" && repo) {
      runningRepos.delete(repo);
      // Release-then-run: hand the freed slot to the first waiting job whose
      // repo isn't running (FIFO — with concurrency 1 that's simply the head
      // of the line).
      if (runningRepos.size < maxConcurrentIndexes()) {
        const nextIdx = indexWaitQueue.findIndex((e) => !runningRepos.has(e.repo));
        if (nextIdx >= 0) {
          const [next] = indexWaitQueue.splice(nextIdx, 1);
          setImmediate(() => void runJob(next.id, next.opts));
        }
      }
    }
  }
}

async function reconcileGraphEmbeddings(): Promise<void> {
  const gatewayUrl = (process.env.GATEWAY_URL ?? "http://127.0.0.1:7433").replace(/\/+$/, "");
  const token = process.env.GATEWAY_TOKEN || process.env.FLOW_ADMIN_TOKEN || "";
  try {
    const res = await fetch(`${gatewayUrl}/v1/reconcile/embeddings`, {
      method: "POST",
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      console.warn(`[embed] post-index reconcile returned HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
      return;
    }
    const result = (await res.json()) as { total?: number; embedded?: number; failed?: number };
    console.log(`[embed] post-index reconcile: embedded ${result.embedded ?? 0}/${result.total ?? 0}${result.failed ? `, failed ${result.failed}` : ""}`);
  } catch (err) {
    // Indexing remains useful in lexical-only mode; surface the degradation
    // without turning an otherwise successful graph build into a failed job.
    console.warn(`[embed] post-index reconcile failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ------------------------------------------------------------------
// Prompt construction
// ------------------------------------------------------------------

interface BuiltPrompt {
  agent: string;
  prompt: string;
  sessionId?: string; // for "continue" jobs
}

function buildPrompt(opts: JobInput): BuiltPrompt {
  switch (opts.type) {
    case "index_repo": {
      // Push-triggered runs with a known last-indexed ancestor read only the
      // diff (see incrementalContext); everything else is a full pass.
      const inc = (opts.input as { incremental?: { from: string; to: string; stat: string } }).incremental;
      if (inc) {
        return {
          agent: "graph-builder",
          prompt: `The repository repos/${opts.input.repo ?? "."} (branch ${requiredIndexBranch(opts.input)}) was updated from ${inc.from} to ${inc.to}. Changed files:

${inc.stat}

Read the actual diff with git (cd repos/${opts.input.repo ?? "."} && git diff ${inc.from}..${inc.to} -- <paths>) for anything that looks behavioral. Decide what changed in *behavior* terms — new/changed/removed capabilities, endpoints, resources, or usage-contract conditions. Refactors that move code without changing behavior need no graph writes.

Update the knowledge graph accordingly: enrich or correct existing entities, update contracts whose uses/sensitive_to conditions changed, add new entities for genuinely new behavior, and update evidence on anything you re-verified. Finish with a short summary of what changed in the graph and why, or state that no durable behavior changed.`,
        };
      }
      return {
        agent: "graph-builder",
        prompt: `Index the repository at repos/${opts.input.repo ?? "."} (branch ${requiredIndexBranch(opts.input)}) into the knowledge graph. The graph may already contain entities from other repositories — check what exists before creating (graph_find_entity), reuse and enrich existing entities, and pay special attention to cross-repo dependencies. Write incrementally as you learn, per your instructions. Finish with a summary of what you modeled and any open questions.`,
      };
    }
    case "enrich":
      return {
        agent: "graph-builder",
        prompt: `Enrich the knowledge graph with: ${JSON.stringify(opts.input)}`,
      };
    case "correct_graph": {
      // Advisory-flag verification. THE INVARIANT: verify only against the
      // checkouts under repos/ — single-branch clones of each repo's
      // registered base branch. The flagging agent may be working on some
      // other branch; its claim is evidence to consider, never a command.
      const c = opts.input as {
        target_ids?: string[];
        reason?: string;
        evidence?: string | null;
        repo?: string | null;
      };
      return {
        agent: "graph-builder",
        prompt: [
          `A coding agent flagged possible inaccuracies in the knowledge graph. The flag is ADVISORY — it may be wrong, or describe unmerged work on the agent's own branch.`,
          ``,
          `Flagged node(s): ${(c.target_ids ?? []).join(", ")}`,
          `Reason given: ${c.reason ?? "(none)"}`,
          `Evidence offered: ${c.evidence ?? "(none)"}`,
          c.repo ? `Repo hint: repos/${c.repo}` : `Repo hint: none — infer the repo from each node's evidence field.`,
          ``,
          `Verify the flag ONLY against the repository checkouts under repos/ — these are the registered base branches and the ground truth. For each flagged node: read it (graph_get_entity), read the code it claims to describe, and check its 1-hop neighborhood. If the flag is confirmed by the checkout, apply the MINIMAL correction via the graph_* tools with file:line evidence. If it cannot be confirmed from the checkout (branch-local work, or simply wrong), change nothing.`,
          ``,
          `Finish your answer with exactly one JSON object: {"verdict": "applied" | "rejected", "summary": "<one paragraph: what you changed, or why you rejected the flag>"}. Use "applied" only if you actually modified the graph.`,
        ].join("\n"),
      };
    }
    case "answer":
      return {
        agent: "answerer",
        prompt: opts.input.question as string,
      };
    case "continue":
      return {
        agent: "answerer",
        prompt: opts.input.message as string,
        sessionId: opts.input.session_id as string,
      };
    default:
      throw new Error(`Unknown job type: ${opts.type}`);
  }
}

// Serializes opencode process STARTS (not runs) with a 4s gap — see the
// comment at the call site. Each caller proceeds once the previous caller's
// start-plus-gap has elapsed; the runs themselves stay concurrent.
let spawnChain: Promise<void> = Promise.resolve();
function acquireSpawnSlot(): Promise<void> {
  const myTurn = spawnChain;
  spawnChain = myTurn.then(() => new Promise<void>((r) => setTimeout(r, 4000)));
  return myTurn;
}

// Job-scoped notify token: HMAC(admin, jobId). Verified by /v1/notify.
export function jobScopedToken(jobId: string): string {
  const secret = process.env.FLOW_ADMIN_TOKEN ?? "dev-token";
  return createHmac("sha256", secret).update(`notify:${jobId}`).digest("hex");
}

// Async spawn: collect stdout/stderr without blocking the event loop (P0-C —
// spawnSync froze the server for the whole job). Kills on timeout.
interface SpawnResult { status: number | null; stdout: string; stderr: string; error?: Error }
// Live CLI children by job id. Orchestrator shutdown kills these (and their
// process groups — the MCP gateway subprocess a claude/codex indexer spawns
// dies with its parent) so a restart can never leave an orphaned indexer
// writing to the graph while the recovery pass re-queues a duplicate job.
const jobChildren = new Map<string, ReturnType<typeof spawn>>();

// SIGKILL the whole process group when the child is a group leader (job
// spawns are detached); fall back to killing just the child.
function killTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals = "SIGKILL"): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

// Kill every live job child (shutdown path). Best-effort and synchronous —
// the process is about to exit.
export function killRunningJobChildren(): number {
  let killed = 0;
  for (const [jobId, child] of jobChildren) {
    killTree(child);
    jobChildren.delete(jobId);
    killed++;
  }
  return killed;
}

// Kill the running index job's child for one repo (repo_removed path).
// Returns the killed job ids; their rows are failed by runJob's catch when
// the CLI dies.
export function killJobsForRepo(repo: string): string[] {
  const rows = db
    .prepare(`SELECT id FROM jobs WHERE status = 'running' AND type = 'index_repo' AND repo = ?`)
    .all(repo) as { id: string }[];
  const killed: string[] = [];
  for (const row of rows) {
    const child = jobChildren.get(row.id);
    if (child) {
      killTree(child);
      jobChildren.delete(row.id);
      killed.push(row.id);
    }
  }
  return killed;
}

function spawnAsync(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number, cwd?: string, onLine?: (line: string) => void, jobId?: string): Promise<SpawnResult> {
  return new Promise((resolve) => {
    // stdin MUST be 'ignore': with the default 'pipe', opencode sees an open
    // stdin and waits on it forever, producing zero output (the runs hang at
    // startup). This is why orchestrator-spawned jobs hung while manual
    // `nohup opencode … </dev/null` runs worked.
    // Job spawns (jobId set) are detached into their own process group so a
    // kill reaches the CLI's own children (MCP subprocess, git, etc.).
    const child = spawn(cmd, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      ...(cwd ? { cwd } : {}),
      ...(jobId ? { detached: true } : {}),
    });
    if (jobId) jobChildren.set(jobId, child);
    let stdout = "";
    let stderr = "";
    let settled = false;
    // Incremental line splitter for the live activity feed — a failing
    // callback must never take the job down with it.
    let pending = "";
    const feedLines = (chunk: string) => {
      if (!onLine) return;
      pending += chunk;
      let nl;
      while ((nl = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        try { onLine(line); } catch { /* feed is best-effort */ }
      }
    };
    const cleanup = () => {
      if (jobId) jobChildren.delete(jobId);
    };
    const timer = setTimeout(() => {
      if (!settled) { settled = true; killTree(child); cleanup(); resolve({ status: null, stdout, stderr, error: new Error(`opencode timed out after ${timeoutMs}ms`) }); }
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => { const s = d.toString(); stdout += s; feedLines(s); });
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (error) => { if (!settled) { settled = true; clearTimeout(timer); cleanup(); resolve({ status: null, stdout, stderr, error }); } });
    child.on("close", (status) => { if (!settled) { settled = true; clearTimeout(timer); cleanup(); resolve({ status, stdout, stderr }); } });
  });
}

// ------------------------------------------------------------------
// Real indexer runner — dispatches index/enrich/correct jobs to the
// configured coding CLI (opencode | codex | claude). Chat jobs (answer,
// continue) always use opencode.
// ------------------------------------------------------------------

async function runRealOpencode(opts: JobInput, jobId: string): Promise<{ result: unknown; sessionId: string }> {
  // answer/continue rely on opencode session resume (--session <id>); multi-CLI
  // chat is future work, so these stay on the opencode path unconditionally.
  if (opts.type === "answer" || opts.type === "continue") {
    return runOpencodeBackend(opts, jobId);
  }

  const backend = await resolveIndexerBackend();
  switch (backend) {
    case "claude":
      return runClaudeBackend(opts, jobId);
    case "codex":
      return runCodexBackend(opts, jobId);
    case "opencode":
    default:
      return runOpencodeBackend(opts, jobId);
  }
}

// Index/enrich runs read whole repos — give them real time. Conversational
// jobs stay snappy.
function indexerTimeout(opts: JobInput): number {
  return opts.type === "index_repo" || opts.type === "enrich" ? 45 * 60 * 1000 : 15 * 60 * 1000;
}

// Env shared by every backend subprocess. The subprocess reads untrusted repo
// content (prompt-injection surface, S106/S107) so it gets a JOB-SCOPED notify
// token, NOT the root admin token: HMAC(admin, jobId). GRAPH_GATEWAY_* are
// used by opencode's workspace graph tools and are harmless for the others.
function indexerChildEnv(opts: JobInput, jobId: string, actor: string): NodeJS.ProcessEnv {
  const port = process.env.ORCHESTRATOR_PORT ?? "7500";
  const gatewayUrl = (process.env.GATEWAY_URL ?? "http://127.0.0.1:7433").replace(/\/+$/, "");
  const gatewayToken = process.env.GATEWAY_TOKEN || process.env.FLOW_ADMIN_TOKEN || "";
  const openrouterKey =
    getSetting("OPENROUTER_API_KEY") ?? process.env.OPENROUTER_API_KEY ?? "";
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ORCHESTRATOR_URL: process.env.ORCHESTRATOR_URL ?? `http://127.0.0.1:${port}`,
    // The session's graph tools read GRAPH_GATEWAY_URL — it MUST be this
    // project's gateway, or agents write into another project's graph.
    GRAPH_GATEWAY_URL: gatewayUrl,
    // The MCP subprocess uses the gateway-owned Gemma model for semantic
    // queries and embed-on-write. This avoids one model per CLI process.
    FLOW_EMBED_URL: `${gatewayUrl}/v1/embed`,
    FLOW_EMBED_TOKEN: gatewayToken,
    FLOW_JOB_TOKEN: jobScopedToken(jobId),
    FLOW_JOB_ID: jobId,
    // Stamped by the gateway MCP (builder mode) into every write's provenance,
    // overriding whatever the model supplies — writes trace to the job row and
    // its transcript in job-logs/, not to a model-chosen name. The MCP child
    // inherits this from the CLI's env, whichever backend spawned it.
    FLOW_ACTOR: actor,
    ...(openrouterKey ? { OPENROUTER_API_KEY: openrouterKey } : {}),
    // Graph tools authenticate to the (now bearer-authed) gateway. The
    // subprocess already had full gateway write access by construction; the
    // token gates OTHER local processes, not this one.
    GRAPH_GATEWAY_TOKEN: gatewayToken,
    // Correction verification writes are scoped to the flagged nodes — the
    // job's prompt embeds agent-authored text (prompt-injection surface), so
    // the graph tools refuse writes outside this set (S106-adjacent).
    ...(opts.type === "correct_graph"
      ? { FLOW_WRITE_SCOPE: correctionWriteScope(opts) }
      : {}),
  };
  delete env.FLOW_ADMIN_TOKEN; // never expose the root token to the session
  return env;
}

function correctionWriteScope(opts: JobInput): string {
  return ((opts.input as { target_ids?: string[] }).target_ids ?? []).join(",");
}

// Persist the full transcript BEFORE any error handling — failed runs are
// exactly the ones worth debugging. DB_DIR is null only for in-memory tests.
function persistJobTranscript(jobId: string, stdout: string, stderr: string): void {
  if (!DB_DIR) return;
  try {
    const logDir = resolve(DB_DIR, "job-logs");
    mkdirSync(logDir, { recursive: true });
    writeFileSync(resolve(logDir, `${jobId}.jsonl`), stdout ?? "");
    if (stderr) writeFileSync(resolve(logDir, `${jobId}.stderr.log`), stderr);
  } catch (err) {
    console.error(`[indexer] failed to persist job transcript: ${err}`);
  }
}

// Directory for per-job temp files (MCP config, codex last-message). Falls back
// to the OS temp dir when DB_DIR is null (in-memory tests never spawn a CLI).
function jobLogDir(): string {
  const dir = DB_DIR ? resolve(DB_DIR, "job-logs") : tmpdir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ------------------------------------------------------------------
// opencode backend — uses --format json to capture the session ID
// ------------------------------------------------------------------

async function runOpencodeBackend(opts: JobInput, jobId: string): Promise<{ result: unknown; sessionId: string }> {
  const { agent, prompt, sessionId: resumeSessionId } = buildPrompt(opts);
  const model = indexerModel("opencode");

  const args: string[] = ["run", "--format", "json", "-m", model, "--dir", WORKSPACE_DIR];
  if (agent) args.push("--agent", agent);
  if (resumeSessionId) args.push("--session", resumeSessionId);
  args.push(prompt);

  const env = indexerChildEnv(opts, jobId, `opencode:${agent ?? "opencode"}:${jobId}`);
  const timeoutMs = indexerTimeout(opts);

  // Stagger process starts: two opencode processes launched in the same
  // instant (e.g. boot-time stall recovery re-queueing several jobs) collide
  // on opencode's internal state DB ("database is locked"). Concurrent runs
  // are fine once initialized — only the starts need spacing. Other backends
  // have no such shared lock, so they don't stagger.
  await acquireSpawnSlot();

  startActivity(jobId, opts.repo ?? "", "opencode");
  const t0 = Date.now();
  const spawned = await spawnAsync(OPENCODE_BIN, args, env, timeoutMs, undefined, (line) =>
    recordActivityLine(jobId, "opencode", line), jobId
  );
  const latencyMs = Date.now() - t0;

  persistJobTranscript(jobId, spawned.stdout ?? "", spawned.stderr ?? "");

  if (spawned.error || spawned.status !== 0) {
    logLLM({
      kind: "opencode_job", ref: jobId, model, ok: false, latencyMs,
      error: spawned.error?.message ?? `opencode exited ${spawned.status}`,
      prompt,
      response: (spawned.stderr ?? "").slice(-4000),
    });
    if (spawned.error) throw spawned.error;
    throw new Error(spawned.stderr || `opencode exited ${spawned.status}`);
  }

  // Parse JSONL output: each line is a JSON event.
  // sessionID is present on every event; text parts accumulate the answer.
  const lines = (spawned.stdout ?? "").split("\n").filter((l) => l.trim());
  let sessionId = "";
  const textParts: string[] = [];

  for (const line of lines) {
    try {
      const evt = JSON.parse(line) as {
        type?: string;
        sessionID?: string;
        part?: { type?: string; text?: string };
      };
      if (!sessionId && evt.sessionID) {
        sessionId = evt.sessionID;
      }
      if (evt.type === "text" && evt.part?.text) {
        textParts.push(evt.part.text);
      }
    } catch {
      // ignore malformed lines
    }
  }

  const answerMd = textParts.join("") || "(no answer)";

  logLLM({
    kind: "opencode_job", ref: jobId, model, ok: true, latencyMs,
    prompt,
    response: answerMd,
  });

  // For answer/continue jobs, return a structured answer; for others return minimal ok
  if (opts.type === "answer" || opts.type === "continue") {
    return { result: parseAnswerPayload(answerMd), sessionId };
  }

  return { result: { status: "ok", raw: answerMd }, sessionId };
}

// ------------------------------------------------------------------
// claude backend — Claude Code CLI in headless (-p) mode with the flow-graph
// MCP spawned directly (it talks to FalkorDB and keeps write verbs).
// ------------------------------------------------------------------

async function runClaudeBackend(opts: JobInput, jobId: string): Promise<{ result: unknown; sessionId: string }> {
  const { prompt } = buildPrompt(opts);
  const model = indexerModel("claude");
  const executable = await resolveBackendExecutable("claude");
  const instructions = graphBuilderInstructions(WORKSPACE_DIR);

  // --mcp-config takes a file path; write a per-job config that points claude
  // at the flow-graph MCP (full write mode for indexing).
  const spec = mcpServerSpec({
    graphName: projectGraphName(),
    writeScope: opts.type === "correct_graph" ? correctionWriteScope(opts) : undefined,
    actor: `claude:graph-builder:${jobId}`,
    job: { id: jobId, token: jobScopedToken(jobId) },
  });
  const mcpConfigPath = resolve(jobLogDir(), `${jobId}.mcp.json`);
  writeFileSync(
    mcpConfigPath,
    JSON.stringify({ mcpServers: { "flow-graph": { command: spec.command, args: spec.args, env: spec.env } } })
  );

  // -p is a boolean (print mode); the prompt is positional and goes LAST so a
  // prompt that happens to start with "-" can't be parsed as a flag.
  // stream-json (which requires --verbose) instead of json: same final result,
  // but every assistant turn arrives as its own line — that stream feeds the
  // live activity ticker on the dashboard.
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--model", model,
    "--append-system-prompt", instructions,
    "--mcp-config", mcpConfigPath,
    "--strict-mcp-config",
    "--allowedTools", "mcp__flow-graph,Read,Grep,Glob,LS,Bash(git:*)",
    "--disallowedTools", "Write,Edit,NotebookEdit,WebFetch,WebSearch",
    "--", prompt,
  ];

  const env = indexerChildEnv(opts, jobId, `claude:graph-builder:${jobId}`);
  const timeoutMs = indexerTimeout(opts);

  startActivity(jobId, opts.repo ?? "", "claude");
  const t0 = Date.now();
  const spawned = await spawnAsync(executable, args, env, timeoutMs, WORKSPACE_DIR, (line) =>
    recordActivityLine(jobId, "claude", line), jobId
  );
  const latencyMs = Date.now() - t0;

  persistJobTranscript(jobId, spawned.stdout ?? "", spawned.stderr ?? "");

  if (spawned.error || spawned.status !== 0) {
    logLLM({
      kind: "opencode_job", ref: jobId, model, ok: false, latencyMs,
      error: spawned.error?.message ?? `claude exited ${spawned.status}`,
      prompt,
      response: (spawned.stderr ?? "").slice(-4000),
    });
    if (spawned.error) throw spawned.error;
    throw new Error(spawned.stderr || `claude exited ${spawned.status}`);
  }

  // stream-json emits JSONL; the last {"type":"result"} line carries the final
  // text and session id. On parse failure keep the raw stdout as the result.
  let answerMd = "";
  let sessionId = "";
  for (const line of (spawned.stdout ?? "").split("\n").filter((l) => l.trim())) {
    try {
      const evt = JSON.parse(line) as { type?: string; result?: string; session_id?: string };
      if (evt.type === "result") {
        if (typeof evt.result === "string") answerMd = evt.result;
        if (typeof evt.session_id === "string") sessionId = evt.session_id;
      }
    } catch {
      // ignore malformed lines
    }
  }
  // Fallback caps at the stream tail — the full transcript is on disk.
  answerMd = answerMd || (spawned.stdout ?? "").slice(-4000) || "(no answer)";

  logLLM({
    kind: "opencode_job", ref: jobId, model, ok: true, latencyMs,
    prompt,
    response: answerMd,
  });

  return { result: { status: "ok", raw: answerMd }, sessionId };
}

// ------------------------------------------------------------------
// codex backend — Codex CLI `exec`. Codex is NOT installed on this machine, so
// this path has not been live-tested; it needs live verification.
// ------------------------------------------------------------------

// Quote a string as a TOML basic string for `codex -c key=value` overrides.
function tomlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

async function runCodexBackend(opts: JobInput, jobId: string): Promise<{ result: unknown; sessionId: string }> {
  const { prompt } = buildPrompt(opts);
  const model = indexerModel("codex");
  const executable = await resolveBackendExecutable("codex");
  const instructions = graphBuilderInstructions(WORKSPACE_DIR);

  // codex exec has no system-prompt flag — prepend the graph-builder guidance.
  const fullPrompt = `${instructions}\n\n${prompt}`;

  const spec = mcpServerSpec({
    graphName: projectGraphName(),
    writeScope: opts.type === "correct_graph" ? correctionWriteScope(opts) : undefined,
    actor: `codex:graph-builder:${jobId}`,
    job: { id: jobId, token: jobScopedToken(jobId) },
  });
  const envInline = Object.entries(spec.env)
    .map(([k, v]) => `${k}=${tomlString(v)}`)
    .join(", ");
  const overrides = [
    `mcp_servers.flow-graph.command=${tomlString(spec.command)}`,
    `mcp_servers.flow-graph.args=[${tomlString(spec.args[0])}]`,
    `mcp_servers.flow-graph.env={${envInline}}`,
  ];

  const lastMessagePath = resolve(jobLogDir(), `${jobId}.last.md`);
  const args = [
    "exec",
    "--json",
    "-m", model,
    "--sandbox", "read-only",
    "--skip-git-repo-check",
    "--output-last-message", lastMessagePath,
  ];
  for (const o of overrides) args.push("-c", o);
  args.push(fullPrompt);

  const env = indexerChildEnv(opts, jobId, `codex:graph-builder:${jobId}`);
  const timeoutMs = indexerTimeout(opts);

  startActivity(jobId, opts.repo ?? "", "codex");
  const t0 = Date.now();
  const spawned = await spawnAsync(executable, args, env, timeoutMs, WORKSPACE_DIR, (line) =>
    recordActivityLine(jobId, "codex", line), jobId
  );
  const latencyMs = Date.now() - t0;

  persistJobTranscript(jobId, spawned.stdout ?? "", spawned.stderr ?? "");

  if (spawned.error || spawned.status !== 0) {
    logLLM({
      kind: "opencode_job", ref: jobId, model, ok: false, latencyMs,
      error: spawned.error?.message ?? `codex exited ${spawned.status}`,
      prompt,
      response: (spawned.stderr ?? "").slice(-4000),
    });
    if (spawned.error) throw spawned.error;
    throw new Error(spawned.stderr || `codex exited ${spawned.status}`);
  }

  // Final text is written to --output-last-message; fall back to stdout.
  let answerMd = "";
  try {
    answerMd = readFileSync(lastMessagePath, "utf8");
  } catch {
    answerMd = spawned.stdout ?? "";
  }
  answerMd = answerMd || "(no answer)";

  // Session id: scan the JSONL event stream for a thread/session identifier.
  let sessionId = "";
  for (const line of (spawned.stdout ?? "").split("\n").filter((l) => l.trim())) {
    try {
      const evt = JSON.parse(line) as { thread_id?: string; session_id?: string };
      if (evt.thread_id || evt.session_id) {
        sessionId = String(evt.thread_id ?? evt.session_id);
        break;
      }
    } catch {
      // ignore malformed lines
    }
  }

  logLLM({
    kind: "opencode_job", ref: jobId, model, ok: true, latencyMs,
    prompt,
    response: answerMd,
  });

  return { result: { status: "ok", raw: answerMd }, sessionId };
}

// The answerer agent is instructed to return {answer_md, citations, confidence,
// gaps} as JSON, usually inside a ```json fence with conversational preamble
// around it. Extract and use it; fall back to the raw text if absent, so a
// model that ignores the format still produces a readable answer.
export function parseAnswerPayload(raw: string): {
  answer_md: string;
  citations: { kind: string; ref: string }[];
  confidence: number;
  gaps: string[];
} {
  const fallback = { answer_md: raw, citations: [], confidence: 0.7, gaps: [] };

  // Try fenced json blocks first, then ALWAYS also the raw {...} span around
  // an "answer_md" key: when answer_md itself contains nested ``` fences, the
  // non-greedy fence regex truncates the JSON (unterminated string), while the
  // brace span still parses.
  const fenced = [...raw.matchAll(/```json\s*([\s\S]*?)```/g)].map((m) => m[1]);
  const candidates = [...fenced.reverse()];
  const key = raw.indexOf('"answer_md"');
  if (key >= 0) {
    const start = raw.lastIndexOf("{", key);
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) candidates.push(raw.slice(start, end + 1));
  }

  for (const cand of candidates) {
    try {
      const parsed = JSON.parse(cand.trim()) as Record<string, unknown>;
      if (typeof parsed.answer_md === "string" && parsed.answer_md.length > 0) {
        return {
          answer_md: parsed.answer_md,
          citations: Array.isArray(parsed.citations)
            ? (parsed.citations as { kind: string; ref: string }[]).filter((c) => c && c.ref)
            : [],
          confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.7,
          gaps: Array.isArray(parsed.gaps) ? (parsed.gaps as string[]) : [],
        };
      }
    } catch {
      // try next candidate
    }
  }
  return fallback;
}

// ------------------------------------------------------------------
// Fake opencode for tests (FLOW_FAKE_OPENCODE=1)
// ------------------------------------------------------------------

async function runFakeOpencode(
  opts: JobInput,
  jobId: string
): Promise<{ result: unknown; sessionId: string }> {
  const fakePath = resolve(__dirname, "../test/fake-opencode.js");
  try {
    const mod = (await import(fakePath)) as {
      run: (
        opts: JobInput,
        jobId: string
      ) => Promise<{ result: unknown; sessionId: string }>;
    };
    return mod.run(opts, jobId);
  } catch {
    // Fallback canned responses if fake file doesn't exist yet
    const sessionId = `fake-ses-${jobId}`;
    if (opts.type === "answer" || opts.type === "continue") {
      return {
        result: {
          answer_md: "This is a canned answer from fake-opencode.",
          citations: [{ kind: "node", ref: "fake-node-001" }],
          confidence: 0.85,
          gaps: [],
        },
        sessionId,
      };
    }
    return { result: { status: "ok", nodes_written: 0 }, sessionId };
  }
}
