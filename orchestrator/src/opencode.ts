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
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import db, { DB_DIR } from "./db.js";
import { postSlackMessage } from "./actions/slack.js";
import { getSetting } from "./settings.js";
import { logLLM } from "./llmlog.js";

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

// Read at call time via getSetting so DB/env changes take effect immediately.
// The const below is only used as a fallback; runRealOpencode reads dynamically.
const _DEFAULT_MODEL = "openrouter/minimax/minimax-m3";

// Per-repo mutex: set of repos currently being indexed
const runningRepos = new Set<string>();

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
// on state. Called after a successful index_repo job.
export function updateRepoIndexCommit(name: string, commit: string): void {
  const registry = readRepoRegistry();
  const existing = registry.repos.find((r) => r.name === name);
  if (existing) {
    existing.lastIndexedCommit = commit;
    existing.lastIndexedAt = new Date().toISOString();
    writeFileSync(reposJsonPath(), JSON.stringify(registry, null, 2));
  }
}

// Resolve the current HEAD of a managed checkout; null if missing/local.
function repoHeadCommit(name: string): string | null {
  const dest = resolve(WORKSPACE_DIR, "repos", name);
  if (!existsSync(dest) || lstatSync(dest).isSymbolicLink()) return null;
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
  branch: string,
  localPath?: string,
): Promise<{ entry: RepoEntry; jobId: string }> {
  const entry = registerRepo(url, branch);
  if (localPath) registerSource({ name: entry.name, localPath });
  // registeredRepos is otherwise only seeded at boot — watch this branch now.
  const { watchRepo, ownerRepoFromUrl } = await import("./adapters/github.js");
  const ownerRepo = ownerRepoFromUrl(url);
  if (ownerRepo) watchRepo(ownerRepo, entry.branch);
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
async function ensureRepoClone(entry: { name: string; url?: string; branch?: string }): Promise<string> {
  // Local tier: an entry with no url but a localPath is the user's own checkout
  // — index in place from that folder (there is nothing to clone). Materialize
  // repos/<name> as a symlink to it, because downstream consumers (the index
  // prompt, the corrections verifier) address checkouts as repos/<name>
  // relative paths and must not care which tier a repo is.
  if (!entry.url) {
    const reg = readRepoRegistry().repos.find((r) => r.name === entry.name);
    if (reg?.localPath && existsSync(reg.localPath)) {
      const dest = resolve(WORKSPACE_DIR, "repos", entry.name);
      if (!existsSync(dest)) {
        mkdirSync(resolve(WORKSPACE_DIR, "repos"), { recursive: true });
        try {
          symlinkSync(reg.localPath, dest);
        } catch (err) {
          // A dangling symlink at dest fails existsSync yet blocks creation —
          // anything other than "already there" is a real error.
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        }
      }
      return dest;
    }
  }
  const dest = resolve(WORKSPACE_DIR, "repos", entry.name);
  if (existsSync(dest)) return dest;
  if (!entry.url) throw new Error(`repo '${entry.name}' has no checkout and no url to clone from`);
  mkdirSync(resolve(WORKSPACE_DIR, "repos"), { recursive: true });

  const token = getSetting("GITHUB_TOKEN");
  let cloneUrl = entry.url;
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
async function refreshRepoCheckout(name: string, branch: string): Promise<void> {
  const dest = resolve(WORKSPACE_DIR, "repos", name);
  if (!existsSync(dest)) return;
  if (lstatSync(dest).isSymbolicLink()) return; // local tier — user's own checkout
  const token = getSetting("GITHUB_TOKEN");
  const env = token
    ? { ...process.env, GIT_ASKPASS: "echo", GIT_USERNAME: "x-access-token", GIT_PASSWORD: token }
    : process.env;
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
  const reindex = stalled.filter((r) => r.type === "index_repo");
  for (const row of reindex) {
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
  if (stalled.length > 0) {
    console.warn(`[opencode] recovered ${stalled.length} stalled job(s); re-queued ${reindex.length} index job(s)`);
  }
}

// Enqueue a job and kick off execution in background (non-blocking enqueue)
export async function enqueueJob(opts: JobInput): Promise<{ id: string }> {
  const id = randomUUID();
  insertJob.run({
    id,
    type: opts.type,
    input: JSON.stringify(opts.input),
    repo: opts.repo ?? null,
  });

  // Execute async — don't await; callers get the job id and can poll
  setImmediate(() => void runJob(id, opts));

  return { id };
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

  // Per-repo mutex for index_repo jobs
  if (opts.type === "index_repo" && repo) {
    if (runningRepos.has(repo)) {
      updateJob.run({
        id,
        status: "failed",
        result_json: JSON.stringify({ error: "mutex: repo already indexing" }),
      });
      return;
    }
    runningRepos.add(repo);
  }

  updateJob.run({ id, status: "running", result_json: null });

  try {
    // Index jobs need the checkout on disk before the agent can read it.
    if (opts.type === "index_repo" && !process.env.FLOW_FAKE_OPENCODE) {
      const input = opts.input as { repo?: string; url?: string; branch?: string };
      if (input.repo) {
        await ensureRepoClone({ name: input.repo, url: input.url, branch: input.branch });
        await refreshRepoCheckout(input.repo, input.branch ?? "main");
      }
    }

    let runResult: { result: unknown; sessionId: string };

    if (process.env.FLOW_FAKE_OPENCODE) {
      runResult = await runFakeOpencode(opts, id);
    } else {
      runResult = await runRealOpencode(opts, id);
    }

    const { result, sessionId } = runResult;

    // Persist session_id on the job row
    if (sessionId) {
      updateJobSession.run({ id, session_id: sessionId });
    }

    updateJob.run({ id, status: "done", result_json: JSON.stringify(result) });

    // Record the commit we just indexed so update.mjs and the orchestrator agree.
    if (opts.type === "index_repo" && repo) {
      const head = repoHeadCommit(repo);
      if (head) updateRepoIndexCommit(repo, head);
    }

    // Base branch reindexed → the entities notes anchor to now exist: run the
    // branch-notes promotion pass. Merge-commit subjects from the checkout
    // tell us which feature branches landed. Best-effort, never fails the job.
    if (opts.type === "index_repo" && repo) {
      void (async () => {
        try {
          const input = opts.input as { branch?: string };
          const base = input.branch ?? "main";
          const dest = resolve(WORKSPACE_DIR, "repos", repo);
          const merges = await spawnAsync(
            "git",
            ["-C", dest, "log", "--merges", "--since=60 days ago", "--format=%s"],
            process.env,
            10_000,
          );
          const { promoteNotesForRepo } = await import("./notes.js");
          await promoteNotesForRepo(repo, base, merges.stdout ?? "");
        } catch (err) {
          console.warn(`[notes] promotion pass failed for ${repo}: ${err}`);
        }
      })();
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
    }
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
    case "index_repo":
      return {
        agent: "graph-builder",
        prompt: `Index the repository at repos/${opts.input.repo ?? "."} (branch ${opts.input.branch ?? "main"}) into the knowledge graph. The graph may already contain entities from other repositories — check what exists before creating (graph_find), reuse and enrich existing entities, and pay special attention to cross-repo dependencies. Write incrementally as you learn, per your instructions. Finish with a summary of what you modeled and any open questions.`,
      };
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
          `Verify the flag ONLY against the repository checkouts under repos/ — these are the registered base branches and the ground truth. For each flagged node: read it (graph_get), read the code it claims to describe, and check its 1-hop neighborhood. If the flag is confirmed by the checkout, apply the MINIMAL correction via the graph_* tools with file:line evidence. If it cannot be confirmed from the checkout (branch-local work, or simply wrong), change nothing.`,
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
function spawnAsync(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<SpawnResult> {
  return new Promise((resolve) => {
    // stdin MUST be 'ignore': with the default 'pipe', opencode sees an open
    // stdin and waits on it forever, producing zero output (the runs hang at
    // startup). This is why orchestrator-spawned jobs hung while manual
    // `nohup opencode … </dev/null` runs worked.
    const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; child.kill("SIGKILL"); resolve({ status: null, stdout, stderr, error: new Error(`opencode timed out after ${timeoutMs}ms`) }); }
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (error) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ status: null, stdout, stderr, error }); } });
    child.on("close", (status) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ status, stdout, stderr }); } });
  });
}

// ------------------------------------------------------------------
// Real opencode runner — uses --format json to capture session ID
// ------------------------------------------------------------------

async function runRealOpencode(opts: JobInput, jobId: string): Promise<{ result: unknown; sessionId: string }> {
  const { agent, prompt, sessionId: resumeSessionId } = buildPrompt(opts);

  // Read model at call time so DB/env changes take effect without restart
  const model =
    getSetting("GRAPH_BUILDER_MODEL") ??
    process.env.GRAPH_BUILDER_MODEL ??
    _DEFAULT_MODEL;

  const args: string[] = ["run", "--format", "json", "-m", model, "--dir", WORKSPACE_DIR];
  if (agent) args.push("--agent", agent);
  if (resumeSessionId) args.push("--session", resumeSessionId);
  args.push(prompt);

  // Inject env so the notify tool can reach back to the orchestrator. The
  // subprocess (which reads untrusted repo content — prompt-injection surface,
  // S106/S107) gets a JOB-SCOPED token, NOT the root admin token: HMAC(admin,
  // jobId). /v1/notify accepts either the admin token or the matching scoped
  // token, so a leaked job token only authorizes notify for that one job.
  const port = process.env.ORCHESTRATOR_PORT ?? "7500";
  // Inject OPENROUTER_API_KEY from DB/env so opencode workers have it even when
  // it was set via the settings UI rather than the .env file.
  const openrouterKey =
    getSetting("OPENROUTER_API_KEY") ?? process.env.OPENROUTER_API_KEY ?? "";
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ORCHESTRATOR_URL: process.env.ORCHESTRATOR_URL ?? `http://127.0.0.1:${port}`,
    // The session's graph tools read GRAPH_GATEWAY_URL — it MUST be this
    // project's gateway, or agents write into another project's graph.
    GRAPH_GATEWAY_URL: process.env.GATEWAY_URL ?? "http://127.0.0.1:7433",
    FLOW_JOB_TOKEN: jobScopedToken(jobId),
    FLOW_JOB_ID: jobId,
    ...(openrouterKey ? { OPENROUTER_API_KEY: openrouterKey } : {}),
    // Graph tools authenticate to the (now bearer-authed) gateway. The
    // subprocess already had full gateway write access by construction; the
    // token gates OTHER local processes, not this one.
    GRAPH_GATEWAY_TOKEN: process.env.GATEWAY_TOKEN || process.env.FLOW_ADMIN_TOKEN || "",
    // Correction verification writes are scoped to the flagged nodes — the
    // job's prompt embeds agent-authored text (prompt-injection surface), so
    // the graph tools refuse writes outside this set (S106-adjacent).
    ...(opts.type === "correct_graph"
      ? { FLOW_WRITE_SCOPE: ((opts.input as { target_ids?: string[] }).target_ids ?? []).join(",") }
      : {}),
  };
  delete env.FLOW_ADMIN_TOKEN; // never expose the root token to the session

  // Index/enrich runs read whole repos — give them real time. Conversational
  // jobs stay snappy.
  const timeoutMs =
    opts.type === "index_repo" || opts.type === "enrich" ? 45 * 60 * 1000 : 15 * 60 * 1000;

  // Stagger process starts: two opencode processes launched in the same
  // instant (e.g. boot-time stall recovery re-queueing several jobs) collide
  // on opencode's internal state DB ("database is locked"). Concurrent runs
  // are fine once initialized — only the starts need spacing.
  await acquireSpawnSlot();

  const t0 = Date.now();
  const spawned = await spawnAsync(OPENCODE_BIN, args, env, timeoutMs);
  const latencyMs = Date.now() - t0;

  // Persist the full transcript BEFORE any error handling — failed runs are
  // exactly the ones worth debugging. DB_DIR is null only for in-memory tests.
  if (DB_DIR) {
    try {
      const logDir = resolve(DB_DIR, "job-logs");
      mkdirSync(logDir, { recursive: true });
      writeFileSync(resolve(logDir, `${jobId}.jsonl`), spawned.stdout ?? "");
      if (spawned.stderr) writeFileSync(resolve(logDir, `${jobId}.stderr.log`), spawned.stderr);
    } catch (err) {
      console.error(`[opencode] failed to persist job transcript: ${err}`);
    }
  }

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
