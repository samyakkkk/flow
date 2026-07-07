// opencode.ts — Job queue for opencode sessions: index_repo | enrich | answer | continue.
//
// Real runs spawn `opencode run --format json` so we can parse the sessionID from the
// emitted event stream and store it for session-per-chat continuity (G10).
// FLOW_FAKE_OPENCODE=1 → calls test/fake-opencode.ts instead.
//
// Env injected into every real opencode subprocess:
//   ORCHESTRATOR_URL   — allows the notify tool to POST back
//   FLOW_ADMIN_TOKEN   — bearer token for /v1/notify
//   FLOW_JOB_ID        — so the tool knows which job it belongs to

import { spawn } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  type: "index_repo" | "enrich" | "answer" | "continue";
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

// Clone into workspace/repos/<name> if the checkout is missing. Async — a
// multi-minute clone must never block the event loop. Private repos: the
// GITHUB_TOKEN (settings or env) is injected into the clone URL only; it is
// never written to disk, the registry, or error messages.
async function ensureRepoClone(entry: { name: string; url?: string; branch?: string }): Promise<string> {
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
