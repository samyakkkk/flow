// Agents v1 — ACP runtime. The orchestrator is the ACP client for every
// coding agent on this machine (Claude Code, Codex, OpenCode): it spawns the
// agent's ACP adapter as a subprocess, creates sessions in connected-repo
// checkouts, injects Flow's graph MCP into each session (read verbs plus
// correct_graph — an advisory flag, never a direct write — and remember,
// which feeds the distiller intake), streams every session update to
// subscribers (SSE), and relays steering (follow-up prompts, cancel,
// permission replies, mode changes).
//
// Cloud shape: nothing in here is reachable except through the orchestrator's
// HTTP API — the dashboard never spawns agents itself. Later, "cloud mode" is
// the same API in front of containers instead of local processes.

import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import db from "../db.js";
import { onSessionClosed, setTranscriptReader, startIdleSweep } from "../memory/trigger.js";
import {
  createSessionWorktree,
  listWorktrees,
  pruneWorktrees,
  inspectWorktree,
  isManagedWorktree,
  managedRepoOf,
  managedWorktreesRoot,
  realpathOrSelf,
  removeWorktree,
  applyWorktree,
  pushWorktree,
  openPullRequestWorktree,
} from "./worktrees.js";

// ---------------------------------------------------------------------------
// Backends

export type AgentBackend = "claude" | "codex" | "opencode";

// A file the user attached to a prompt. Images ride inline as ACP `image`
// blocks (every adapter renders those); everything else is written to disk in
// the agent's checkout and referenced by path, because the ACP adapters drop
// or mangle non-image binary blobs sent inline (Claude ignores them outright).
export interface PromptAttachment {
  name: string;
  mimeType: string;
  data: string; // base64-encoded bytes
}

const IMAGE_MIME = /^image\//;

export const FLOW_ROOT = fileURLToPath(new URL("../../..", import.meta.url)); // flow/
export const GATEWAY_MCP = path.join(FLOW_ROOT, "graph-gateway", "src", "mcp.ts");

// npm workspaces hoist bins to the root node_modules; fall back to the
// orchestrator's own node_modules for non-workspace installs.
//
// Resolved PER CALL, not at module load: a long-running orchestrator that
// captured this path once kept serving a location that a later reinstall
// removed — every new agent session then injected an MCP server with a dead
// command, which failed SILENTLY (the agent just had no flow-graph tools).
export function binPath(name: string): string {
  const hoisted = path.join(FLOW_ROOT, "node_modules", ".bin", name);
  if (existsSync(hoisted)) return hoisted;
  const local = path.join(FLOW_ROOT, "orchestrator", "node_modules", ".bin", name);
  if (existsSync(local)) return local;
  // A session without the graph is Flow failing its core promise — refuse to
  // create one silently degraded. This error surfaces in the session API.
  throw new Error(
    `"${name}" not found in node_modules — run npm install in the flow directory, then restart this project (flow down <name> && flow up <name>).`
  );
}

interface BackendDescriptor {
  id: AgentBackend;
  name: string;
  executable: string; // the agent CLI users install/authenticate
  spawn: { command: string; args: string[]; bundled?: boolean };
  localCli?:
    | { mode: "env"; envVar: string } // run the bundled ACP adapter, pointing it at the local CLI
    | { mode: "command" }; // run the local CLI itself as the ACP adapter
  installHint: string;
}

export const BACKENDS: Record<AgentBackend, BackendDescriptor> = {
  claude: {
    id: "claude",
    name: "Claude Code",
    executable: "claude",
    // Bundled adapters (installed as orchestrator deps) — no npx cold start.
    spawn: { command: "claude-agent-acp", args: [], bundled: true },
    localCli: { mode: "env", envVar: "CLAUDE_CODE_EXECUTABLE" },
    installHint: "npm i -g @anthropic-ai/claude-code",
  },
  codex: {
    id: "codex",
    name: "Codex",
    executable: "codex",
    spawn: { command: "codex-acp", args: [], bundled: true },
    localCli: { mode: "env", envVar: "CODEX_PATH" },
    installHint: "npm i -g @openai/codex",
  },
  opencode: {
    id: "opencode",
    name: "OpenCode",
    executable: "opencode",
    spawn: { command: "opencode", args: ["acp"] },
    localCli: { mode: "command" },
    installHint: "curl -fsSL https://opencode.ai/install | bash",
  },
};

export type RuntimeSource = "explicit" | "local" | "bundled";

interface SpawnAttempt {
  source: RuntimeSource;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  localPath?: string;
  envVar?: string;
}

const FLOW_MANAGED_DIRS = [path.join(FLOW_ROOT, "node_modules"), path.join(FLOW_ROOT, "orchestrator", "node_modules")];

function isUnder(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function isExecutable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function commandNames(command: string): string[] {
  if (process.platform !== "win32" || path.extname(command)) return [command];
  const exts = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean);
  return [command, ...exts.map((ext) => `${command}${ext}`)];
}

function executableCandidates(command: string): string[] {
  if (path.isAbsolute(command) || command.includes(path.sep) || command.includes(path.win32.sep)) {
    return [command];
  }
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    for (const name of commandNames(command)) {
      const candidate = path.join(dir, name);
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      out.push(candidate);
    }
  }
  return out;
}

function isFlowManagedExecutable(file: string): boolean {
  let realFile: string;
  try {
    realFile = realpathSync(file);
  } catch {
    return false;
  }
  for (const dir of FLOW_MANAGED_DIRS) {
    try {
      if (existsSync(dir) && isUnder(realpathSync(dir), realFile)) return true;
    } catch {
      /* try next managed dir */
    }
  }
  return false;
}

function localExecutableCandidates(command: string): string[] {
  const out: string[] = [];
  for (const candidate of executableCandidates(command)) {
    if (isExecutable(candidate) && !isFlowManagedExecutable(candidate)) {
      out.push(candidate);
    }
  }
  return out;
}

function parseVersionText(version: string | null): number[] | null {
  const match = version?.match(/(\d+)\.(\d+)\.(\d+)(?:[.-](\d+))?/);
  return match ? match.slice(1).filter(Boolean).map(Number) : null;
}

function compareVersionParts(a: number[] | null, b: number[] | null): number {
  if (!a && !b) return 0;
  if (a && !b) return 1;
  if (!a && b) return -1;
  for (let i = 0; i < Math.max(a!.length, b!.length); i++) {
    const diff = (a![i] ?? 0) - (b![i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export async function resolveLocalExecutable(command: string): Promise<string | null> {
  const candidates = localExecutableCandidates(command);
  if (candidates.length <= 1) return candidates[0] ?? null;

  const scored = await Promise.all(
    candidates.map(async (candidate, index) => ({
      candidate,
      index,
      version: parseVersionText(await execVersion(candidate)),
    }))
  );
  scored.sort((a, b) => compareVersionParts(b.version, a.version) || a.index - b.index);
  return scored[0]?.candidate ?? null;
}

function bundledSpawn(desc: BackendDescriptor): Omit<SpawnAttempt, "source" | "env"> | null {
  if (!desc.spawn.bundled) return null;
  try {
    return {
      command: binPath(desc.spawn.command),
      args: desc.spawn.args,
    };
  } catch {
    return null;
  }
}

function requireBundledSpawn(desc: BackendDescriptor): SpawnAttempt {
  const spawnConfig = bundledSpawn(desc);
  if (!spawnConfig) {
    throw new Error(`${desc.name} is not installed. Install it with: ${desc.installHint}`);
  }
  return { source: "bundled", ...spawnConfig, env: { ...process.env } };
}

async function spawnAttempts(desc: BackendDescriptor): Promise<SpawnAttempt[]> {
  const local = desc.localCli;
  if (!local) return [requireBundledSpawn(desc)];

  if (local.mode === "env") {
    const explicit = process.env[local.envVar]?.trim();
    if (explicit) {
      const bundled = requireBundledSpawn(desc);
      return [{ ...bundled, source: "explicit", envVar: local.envVar }];
    }

    const localPath = await resolveLocalExecutable(desc.executable);
    if (!localPath) return [requireBundledSpawn(desc)];
    return [
      {
        ...requireBundledSpawn(desc),
        source: "local",
        env: { ...process.env, [local.envVar]: localPath },
        localPath,
        envVar: local.envVar,
      },
      requireBundledSpawn(desc),
    ];
  }

  const localPath = await resolveLocalExecutable(desc.executable);
  if (localPath) {
    return [
      {
        source: "local",
        command: localPath,
        args: desc.spawn.args,
        env: { ...process.env },
        localPath,
      },
    ];
  }
  const bundled = bundledSpawn(desc);
  if (bundled) return [{ source: "bundled", ...bundled, env: { ...process.env } }];
  throw new Error(`${desc.name} is not installed. Install it with: ${desc.installHint}`);
}

// ---------------------------------------------------------------------------
// Detection — which agents are installed on this machine

export interface DetectedAgent {
  id: AgentBackend;
  name: string;
  installed: boolean;
  version?: string;
  source?: RuntimeSource;
  installHint: string;
}

let detectCache: { at: number; agents: DetectedAgent[] } | null = null;

function execVersion(cmd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, ["--version"], { timeout: 5000 }, (err, stdout) => {
      resolve(err ? null : stdout.trim().split("\n")[0] ?? null);
    });
  });
}

export async function detectAgents(): Promise<DetectedAgent[]> {
  if (detectCache && Date.now() - detectCache.at < 60_000) return detectCache.agents;
  const agents = await Promise.all(
    Object.values(BACKENDS).map(async (b) => {
      const explicitEnv = b.localCli?.mode === "env" ? process.env[b.localCli.envVar]?.trim() : undefined;
      const localPath = explicitEnv || (await resolveLocalExecutable(b.executable));
      const version = localPath ? await execVersion(localPath) : null;
      const bundled = bundledSpawn(b) !== null;
      const installed = explicitEnv ? version !== null : version !== null || bundled;
      const source: RuntimeSource | undefined = explicitEnv ? "explicit" : version !== null ? "local" : bundled ? "bundled" : undefined;
      return {
        id: b.id,
        name: b.name,
        installed,
        version: version ?? (bundled && !explicitEnv ? "Bundled fallback" : undefined),
        source,
        installHint: b.installHint,
      };
    })
  );
  detectCache = { at: Date.now(), agents };
  return agents;
}

// ---------------------------------------------------------------------------
// Capability probe — what a backend offers (model selector, thought/reasoning
// toggles, modes) BEFORE any task session exists. ACP only advertises these
// on session/new, so we open a scratch session on the shared per-backend
// adapter connection, read the advertised options, and close it. Cached.

interface ProbeCacheEntry {
  at: number;
  modes: unknown;
  configOptions: unknown;
}
const probeCache = new Map<AgentBackend, ProbeCacheEntry>();
const PROBE_TTL_MS = 10 * 60_000;

export async function probeAgentOptions(
  backend: AgentBackend
): Promise<{ modes: unknown; configOptions: unknown } | { error: string }> {
  const cached = probeCache.get(backend);
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) {
    return { modes: cached.modes, configOptions: cached.configOptions };
  }
  try {
    const c = await ensureConnection(backend);
    const resp = await c.conn.newSession({ cwd: FLOW_ROOT, mcpServers: [] });
    const entry: ProbeCacheEntry = {
      at: Date.now(),
      modes: resp.modes ?? null,
      configOptions: resp.configOptions ?? null,
    };
    probeCache.set(backend, entry);
    // Best-effort cleanup — closeSession is an optional agent capability; the
    // scratch session is prompt-less and inert either way.
    try {
      await c.conn.closeSession({ sessionId: resp.sessionId });
    } catch {
      /* leave it */
    }
    return { modes: entry.modes, configOptions: entry.configOptions };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Project context (graph name, repos, session storage dir)

const PROJECT_DIR = path.dirname(process.env.DB_PATH ?? path.join(FLOW_ROOT, "data", "flow.db"));
const SESSIONS_DIR = path.join(PROJECT_DIR, "agent-sessions");

export function projectGraphName(): string {
  try {
    const pj = JSON.parse(readFileSync(path.join(PROJECT_DIR, "project.json"), "utf8"));
    if (typeof pj.graph === "string" && pj.graph) return pj.graph;
  } catch {
    /* fall through */
  }
  return process.env.GRAPH_NAME ?? "memory";
}

export interface RepoOption {
  name: string;
  path: string;
  cloned: boolean;
  // The repo's registered base branch (repos.json `branch`) — the BASE-scope
  // diff resolves against this. Undefined for entries that never recorded one.
  branch?: string;
  // Whether sessions may run at `path`. "folder" = the user connected their
  // own checkout, so it doubles as the WORK surface. "managed" = GitHub-added:
  // `path` is Flow's BRAIN clone, kept for indexing and git metadata (branch
  // lists) only — sessions never run there and never browse its files; they
  // need an explicit per-user work folder.
  surface: "folder" | "managed";
}

export function listRepoOptions(): RepoOption[] {
  const reposJson = process.env.REPOS_JSON_PATH;
  const out: RepoOption[] = [];
  if (reposJson && existsSync(reposJson)) {
    try {
      const parsed = JSON.parse(readFileSync(reposJson, "utf8")) as {
        repos?: Array<{ name: string; kind?: string; localPath?: string; branch?: string }>;
      };
      const reposDir = path.join(path.dirname(reposJson), "repos");
      for (const r of parsed.repos ?? []) {
        // Docs sources are not session targets — sessions run in code repos.
        if (r.kind === "docs") continue;
        const branch = typeof r.branch === "string" && r.branch ? r.branch : undefined;
        // WORK surface: when the user connected their own checkout, sessions
        // run in-place there (the in-place default) rather than in Flow's
        // managed clone.
        if (r.localPath && existsSync(r.localPath)) {
          out.push({ name: r.name, path: r.localPath, cloned: true, branch, surface: "folder" });
          continue;
        }
        const p = path.join(reposDir, r.name);
        out.push({ name: r.name, path: p, cloned: existsSync(p), branch, surface: "managed" });
      }
    } catch {
      /* empty list */
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Session store — SQLite metadata + JSONL event transcript + live subscribers

// Baseline shape for FRESH DBs (fresh DBs skip migrations, so the new
// session-diff columns must be born here). Existing DBs get the same columns
// via migration 7 (see migrations.ts) — which also creates this table first,
// because it's created here at runtime-module load, not in db.ts's baseline.
//   start_sha       — working-tree snapshot at session start (git stash create
//                     commit, or HEAD when clean); NULL in an empty repo.
//   start_untracked — JSON array of untracked paths that pre-existed the
//                     session (excluded from the SESSION-scope diff).
//   worktree_id     — reserved for Phase B (isolated worktrees); unused today.
db.exec(`
  CREATE TABLE IF NOT EXISTS agent_sessions (
    id TEXT PRIMARY KEY,
    backend TEXT NOT NULL,
    repo TEXT NOT NULL,
    cwd TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    acp_session_id TEXT,
    stop_reason TEXT,
    error TEXT,
    start_sha TEXT,
    start_untracked TEXT,
    worktree_id TEXT,
    last_distilled_seq INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`);

export type SessionStatus =
  | "starting"
  | "running"
  | "waiting" // waiting on a permission reply
  | "idle" // turn ended; ready for steering
  | "error"
  | "closed";

export interface SessionEvent {
  seq: number;
  ts: number;
  kind:
    | "created"
    | "status"
    | "update" // raw ACP session update (message/thought/tool_call/plan chunks)
    | "user_prompt"
    | "permission_request"
    | "permission_result"
    | "graph" // Flow graph MCP activity → live brain highlighting
    | "error";
  data: unknown;
}

interface PendingPermission {
  requestId: string;
  params: acp.RequestPermissionRequest;
  resolve: (r: acp.RequestPermissionResponse) => void;
}

export interface LiveSession {
  id: string;
  backend: AgentBackend;
  repo: string;
  branch?: string; // git branch of the checkout at session create (remember-verb default + distiller context)
  cwd: string;
  // Working-tree snapshot captured at session start, for the SESSION-scope
  // diff. startSha is a git commit object (stash-create or HEAD); null in an
  // empty repo. startUntracked is the pre-existing untracked file list, which
  // the session diff excludes so it shows only what the agent added.
  startSha?: string | null;
  startUntracked?: string[];
  // Set when this session runs in a "separate copy" (git worktree) rather than
  // in the user's checkout directly. The worktree PATH is the id — it's stable
  // and derivable, so no extra bookkeeping is needed to find the tree again.
  worktreeId?: string;
  title: string;
  status: SessionStatus;
  acpSessionId?: string;
  modes?: unknown; // SessionModeState from newSession, passed to UI verbatim
  configOptions?: unknown; // SessionConfigOption[] — model/thought selectors, verbatim
  stopReason?: string;
  error?: string;
  seq: number;
  turnActive: boolean;
  queue: Array<{ text: string; attachments?: PromptAttachment[] }>; // queued steering prompts
  pendingPermissions: Map<string, PendingPermission>;
  subscribers: Set<(ev: SessionEvent) => void>;
  createdAt: number;
  updatedAt: number;
}

const sessions = new Map<string, LiveSession>();

// COLLISION predicate — a new session collides when a still-active session
// already holds the SAME resolved cwd. "Active" = starting/running/waiting/idle;
// closed and errored (and, transitively, archived/reload-only) sessions never
// collide. Pure and generic over the entry shape so it's unit-testable with
// fake entries — no live ACP backend required.
const ACTIVE_FOR_COLLISION: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  "starting",
  "running",
  "waiting",
  "idle",
]);

export function collidingSession<T extends { id: string; cwd: string; status: SessionStatus }>(
  candidates: Iterable<T>,
  cwd: string
): T | undefined {
  for (const s of candidates) {
    if (s.cwd === cwd && ACTIVE_FOR_COLLISION.has(s.status)) return s;
  }
  return undefined;
}

// Live-map collision lookup: is any currently-live session already working in
// this folder? (Only the in-memory map matters — a session the orchestrator
// lost on restart rehydrates as "error", which is not active.)
function findCollision(cwd: string): LiveSession | undefined {
  return collidingSession(sessions.values(), cwd);
}

const insertSession = db.prepare(
  `INSERT INTO agent_sessions (id, backend, repo, cwd, title, status, worktree_id, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const updateSessionRow = db.prepare(
  `UPDATE agent_sessions SET status=?, acp_session_id=?, stop_reason=?, error=?, updated_at=? WHERE id=?`
);
// Persist the working-tree snapshot taken at session start (see createSession).
const updateSessionStart = db.prepare(
  `UPDATE agent_sessions SET start_sha=?, start_untracked=?, updated_at=? WHERE id=?`
);

function transcriptPath(id: string): string {
  return path.join(SESSIONS_DIR, `${id}.jsonl`);
}

export function emit(s: LiveSession, kind: SessionEvent["kind"], data: unknown): void {
  const ev: SessionEvent = { seq: ++s.seq, ts: Date.now(), kind, data };
  try {
    mkdirSync(SESSIONS_DIR, { recursive: true });
    appendFileSync(transcriptPath(s.id), JSON.stringify(ev) + "\n");
  } catch {
    /* transcript best-effort; live stream still works */
  }
  for (const sub of s.subscribers) {
    try {
      sub(ev);
    } catch {
      /* subscriber errors never break the session */
    }
  }
}

function setStatus(s: LiveSession, status: SessionStatus, extra?: { stopReason?: string; error?: string }): void {
  const wasClosed = s.status === "closed";
  s.status = status;
  if (extra?.stopReason) s.stopReason = extra.stopReason;
  if (extra?.error) s.error = extra.error;
  s.updatedAt = Date.now();
  updateSessionRow.run(status, s.acpSessionId ?? null, s.stopReason ?? null, s.error ?? null, s.updatedAt, s.id);
  emit(s, "status", { status, stopReason: s.stopReason, error: s.error });
  // Memory v1 write path: a session going closed is distilled (non-blocking,
  // off the hot path). The idle sweep (trigger.ts) covers sessions that end by
  // going quiet rather than by an explicit close.
  if (status === "closed" && !wasClosed) onSessionClosed(s.id, s.branch ?? null);
}

const rehydrateRow = db.prepare(`SELECT * FROM agent_sessions WHERE id = ?`);

// Recreate a session's in-memory bookkeeping after an orchestrator restart —
// the `sessions` map starts empty every process boot, but `acp_session_id`
// is durable in SQLite. Without this, a restart permanently dead-ends every
// prior session (SSE sends "eof", the dashboard locks it as "archived")
// even though resumeConnection()/session-load could bring it right back.
function rehydrate(id: string): LiveSession | undefined {
  const row = rehydrateRow.get(id) as
    | {
        id: string;
        backend: AgentBackend;
        repo: string;
        cwd: string;
        title: string;
        stop_reason: string | null;
        acp_session_id: string | null;
        start_sha: string | null;
        start_untracked: string | null;
        worktree_id: string | null;
        created_at: number;
        updated_at: number;
      }
    | undefined;
  if (!row || !row.acp_session_id) return undefined; // nothing a session/load could reattach to

  const transcript = readTranscript(id);
  const s: LiveSession = {
    id: row.id,
    backend: row.backend,
    repo: row.repo,
    cwd: row.cwd,
    startSha: row.start_sha ?? null,
    startUntracked: parseUntracked(row.start_untracked),
    worktreeId: row.worktree_id ?? undefined,
    title: row.title,
    status: "error",
    acpSessionId: row.acp_session_id,
    stopReason: row.stop_reason ?? undefined,
    error: "Orchestrator restarted — send a message to reconnect.",
    seq: transcript.length ? transcript[transcript.length - 1].seq : 0,
    turnActive: false,
    queue: [],
    pendingPermissions: new Map(),
    subscribers: new Set(),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  sessions.set(id, s);
  return s;
}

function liveSession(id: string): LiveSession | undefined {
  return sessions.get(id) ?? rehydrate(id);
}

export function getSession(id: string): LiveSession | undefined {
  return liveSession(id);
}

export function listSessions(): Array<Record<string, unknown>> {
  const rows = db
    .prepare(`SELECT * FROM agent_sessions ORDER BY created_at DESC LIMIT 100`)
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => {
    const live = sessions.get(String(r.id));
    return { ...r, live: Boolean(live), status: live?.status ?? r.status };
  });
}

// The UI renders tool calls as title+status rows — the full tool payloads
// (file bodies, terminal output) stay in the JSONL transcript but are
// stripped from the wire, where they only slow the browser down.
export function slimEvent(ev: SessionEvent): SessionEvent {
  if (ev.kind !== "update") return ev;
  const d = ev.data as Record<string, unknown> | null;
  if (!d || typeof d !== "object") return ev;
  const su = d.sessionUpdate;
  if (su !== "tool_call" && su !== "tool_call_update") return ev;
  const { content, rawInput, rawOutput, locations, ...rest } = d;
  void content;
  void rawOutput;
  void locations;
  // Keep a small rawInput hint (commands are useful context), drop the rest.
  const rawInputStr = rawInput !== undefined ? JSON.stringify(rawInput) : undefined;
  return {
    ...ev,
    data: {
      ...rest,
      ...(rawInputStr !== undefined && rawInputStr.length < 400 ? { rawInput } : {}),
    },
  };
}

export function readTranscript(id: string, sinceSeq = 0): SessionEvent[] {
  const p = transcriptPath(id);
  if (!existsSync(p)) return [];
  const out: SessionEvent[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as SessionEvent;
      if (ev.seq > sinceSeq) out.push(ev);
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

// Wire the memory distiller's triggers: give it the transcript reader (avoids an
// import cycle) and start the idle sweep. Guarded so tests that never touch
// sessions don't spin up a timer; FLOW_DISTILLER=0 disables both.
setTranscriptReader((id) => readTranscript(id).map((e) => ({ seq: e.seq, kind: e.kind, data: e.data })));
startIdleSweep();

// ---------------------------------------------------------------------------
// ACP connections — one adapter process per backend, shared across sessions

interface Connection {
  backend: AgentBackend;
  process: ChildProcessWithoutNullStreams;
  conn: acp.ClientSideConnection;
  init: acp.InitializeResponse;
  source: RuntimeSource;
  command: string;
  localPath?: string;
  sessionsByAcpId: Map<string, string>; // acp session id → flow session id
}

const connections = new Map<AgentBackend, Connection>();

function adapterLog(backend: AgentBackend, message: string): void {
  try {
    mkdirSync(SESSIONS_DIR, { recursive: true });
    appendFileSync(path.join(SESSIONS_DIR, `adapter-${backend}.stderr.log`), `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    /* best-effort */
  }
}

function runtimeInfo(c: Connection): Record<string, unknown> {
  return {
    source: c.source,
    command: c.command,
    ...(c.localPath ? { localPath: c.localPath } : {}),
  };
}

function makeClientHandler(backend: AgentBackend): acp.Client {
  return {
    async requestPermission(params) {
      const flowId = connections.get(backend)?.sessionsByAcpId.get(String(params.sessionId));
      const s = flowId ? sessions.get(flowId) : undefined;
      if (!s) {
        // Unknown session — pick the first non-reject option to avoid deadlock.
        const opt = params.options.find((o) => o.kind !== "reject_once" && o.kind !== "reject_always") ?? params.options[0];
        return { outcome: { outcome: "selected", optionId: opt.optionId } };
      }
      // Flow's graph verbs are auto-approved so consulting the brain never
      // stalls a session. That includes the proposal verbs: filing a
      // proposal is harmless by construction (invisible until blessed,
      // journaled, one-click discard) and the user's real accept/reject
      // moment is the dashboard's proposal dialog, which pops immediately —
      // they're on the session page when it happens. External MCP consumers
      // (Claude Code CLI etc.) gate these calls through their own
      // permission prompts instead. Exact-match on the MCP tool title — a
      // bash command whose free-text title mentions "flow-graph" must not
      // slip through this gate.
      const title = String(params.toolCall?.title ?? "");
      // Title formats vary by adapter: "flow-graph_<verb>" (older) vs
      // "mcp__flow-graph__<verb>" (current claude-agent-acp). Match both.
      if (/^(?:mcp__)?flow-graph_{1,2}(orient|find_entity|get_entity|read_query|list_schema|correct_graph|remember|search_knowledge)$/.test(title)) {
        const opt =
          params.options.find((o) => o.kind === "allow_always") ??
          params.options.find((o) => o.kind === "allow_once");
        if (opt) {
          emit(s, "permission_result", { requestId: "auto", optionId: opt.optionId, auto: true, title });
          return { outcome: { outcome: "selected", optionId: opt.optionId } };
        }
      }

      const requestId = `perm-${s.seq + 1}-${Date.now()}`;
      return new Promise<acp.RequestPermissionResponse>((resolve) => {
        s.pendingPermissions.set(requestId, { requestId, params, resolve });
        setStatus(s, "waiting");
        emit(s, "permission_request", {
          requestId,
          toolCall: params.toolCall,
          options: params.options,
        });
      });
    },
    async sessionUpdate(params) {
      const flowId = connections.get(backend)?.sessionsByAcpId.get(String(params.sessionId));
      const s = flowId ? sessions.get(flowId) : undefined;
      if (!s) return;
      // Keep the cached config in sync when the agent reports a change (e.g.
      // after the user picks a model), so a reload/replay reflects it.
      const u = params.update as { sessionUpdate?: string; configOptions?: unknown; content?: { type?: string; text?: string } };
      if (u.sessionUpdate === "config_option_update" && u.configOptions) {
        s.configOptions = u.configOptions;
      }
      emit(s, "update", params.update);
    },
  };
}

async function startConnectionAttempt(backend: AgentBackend, attempt: SpawnAttempt): Promise<Connection> {
  const desc = BACKENDS[backend];
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const via =
    attempt.source === "local" && attempt.envVar
      ? `${attempt.envVar}=${attempt.localPath}`
      : attempt.source === "local"
        ? attempt.localPath
        : attempt.source === "explicit" && attempt.envVar
          ? `${attempt.envVar}=<env>`
          : "bundled";
  adapterLog(backend, `starting ${desc.name} ACP adapter via ${attempt.source}: ${attempt.command} ${attempt.args.join(" ")} (${via})`);

  const proc = spawn(attempt.command, attempt.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: attempt.env,
  });
  proc.stderr.on("data", (chunk: Buffer) => {
    try {
      appendFileSync(path.join(SESSIONS_DIR, `adapter-${backend}.stderr.log`), chunk);
    } catch {
      /* best-effort */
    }
  });

  const stream = acp.ndJsonStream(
    Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>
  );
  const conn = new acp.ClientSideConnection(() => makeClientHandler(backend), stream);

  const initializePromise = conn.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    // Advertise session config-option support so agents send their model
    // selector (and thought-level toggles) as configOptions we can drive.
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
      session: { configOptions: { boolean: {} } },
    },
  });
  initializePromise.catch(() => {
    /* handled by the race below */
  });

  let onProcError: ((err: Error) => void) | undefined;
  let onEarlyExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  const procError = new Promise<never>((_, reject) => {
    onProcError = reject;
    onEarlyExit = (code, signal) => {
      reject(new Error(`${backend} adapter exited before initialize (code ${code ?? "null"}${signal ? `, signal ${signal}` : ""})`));
    };
    proc.once("error", onProcError);
    proc.once("exit", onEarlyExit);
  });
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${backend} adapter did not initialize in 60s`)), 60_000);
  });

  let init: acp.InitializeResponse;
  try {
    init = await Promise.race([initializePromise, procError, timeout]);
  } catch (e) {
    if (proc.exitCode === null) proc.kill();
    throw e;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (onProcError) proc.off("error", onProcError);
    if (onEarlyExit) proc.off("exit", onEarlyExit);
  }

  const c: Connection = {
    backend,
    process: proc,
    conn,
    init,
    source: attempt.source,
    command: attempt.command,
    localPath: attempt.localPath,
    sessionsByAcpId: new Map(),
  };
  proc.on("exit", (code) => {
    connections.delete(backend);
    for (const flowId of c.sessionsByAcpId.values()) {
      const s = sessions.get(flowId);
      if (s && s.status !== "closed" && s.status !== "error") {
        // The turn (if any) died with the process — nothing will ever
        // resolve it, so don't leave the session thinking one is in flight.
        s.turnActive = false;
        setStatus(s, "error", { error: `${backend} adapter exited (code ${code})` });
      }
    }
  });
  return c;
}

async function ensureConnection(backend: AgentBackend): Promise<Connection> {
  const existing = connections.get(backend);
  if (existing && existing.process.exitCode === null) return existing;
  connections.delete(backend);

  const attempts = await spawnAttempts(BACKENDS[backend]);
  let lastError: unknown;
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    try {
      const c = await startConnectionAttempt(backend, attempt);
      connections.set(backend, c);
      return c;
    } catch (e) {
      lastError = e;
      const canFallback = attempt.source === "local" && i < attempts.length - 1;
      adapterLog(
        backend,
        `${attempt.source} ACP adapter failed to initialize: ${(e as Error).message}${canFallback ? "; retrying bundled fallback" : ""}`
      );
      if (!canFallback) break;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`${backend} adapter failed to initialize`);
}

// Re-attach a session to a live connection after its adapter process died (or
// simply never had one, e.g. after an orchestrator restart). ACP's
// session/load asks the (possibly freshly spawned) adapter to replay the
// session's own history, so the conversation continues instead of dead-ending
// in "error" forever. Only available if the backend advertises the
// `loadSession` capability — Claude Code and Codex both do.
async function resumeConnection(s: LiveSession): Promise<Connection> {
  const acpSessionId = s.acpSessionId;
  if (!acpSessionId) throw new Error("Session never started");

  const existing = connections.get(s.backend);
  if (existing && existing.sessionsByAcpId.get(acpSessionId) === s.id) return existing;

  setStatus(s, "starting");
  try {
    const c = await ensureConnection(s.backend);
    if (c.sessionsByAcpId.get(acpSessionId) === s.id) return c; // raced with another resume

    if (!c.init.agentCapabilities?.loadSession) {
      throw new Error(
        `${BACKENDS[s.backend].name} doesn't support resuming a session after its process exits — start a new session to continue.`
      );
    }
    if (!s.branch) s.branch = (await runGit(s.cwd, ["branch", "--show-current"])).trim() || undefined;
    const resp = await c.conn.loadSession({
      sessionId: acpSessionId,
      cwd: s.cwd,
      mcpServers: [flowGraphMcp(s.id, s.repo, s.branch ?? "")],
    });
    s.modes = resp.modes ?? s.modes;
    s.configOptions = resp.configOptions ?? s.configOptions;
    s.error = undefined;
    c.sessionsByAcpId.set(acpSessionId, s.id);
    emit(s, "status", { modes: s.modes, configOptions: s.configOptions, runtime: runtimeInfo(c) });
    return c;
  } catch (e) {
    setStatus(s, "error", { error: (e as Error).message });
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Flow graph MCP injection (read-only) + activity routing

function flowGraphMcp(flowSessionId: string, repo = "", branch = ""): acp.McpServer {
  const orchPort = process.env.ORCHESTRATOR_PORT ?? "7500";
  const gatewayUrl = (process.env.GATEWAY_URL ?? "http://127.0.0.1:7433").replace(/\/+$/, "");
  const gatewayToken = process.env.GATEWAY_TOKEN || process.env.FLOW_ADMIN_TOKEN || "";
  const env: Array<{ name: string; value: string }> = [
    { name: "GATEWAY_MCP_READONLY", value: "1" },
    { name: "GRAPH_NAME", value: projectGraphName() },
    { name: "FLOW_AGENT_SESSION", value: flowSessionId },
    // remember-verb defaults: Flow runs this session, so it knows the checkout.
    // External MCP consumers pass {repo, branch} explicitly instead (Flow may
    // be remote — never assume a shared filesystem).
    { name: "FLOW_REPO", value: repo },
    { name: "FLOW_BRANCH", value: branch },
    // Base for search_knowledge (used as-is) and remember (/search → /remember).
    { name: "FLOW_MEMORY_URL", value: `http://127.0.0.1:${orchPort}/v1/memory/search` },
    { name: "FLOW_ACTIVITY_URL", value: `http://127.0.0.1:${orchPort}/v1/agents/graph-activity` },
    // The EFFECTIVE bearer, matching auth.ts's fallback: an empty string here
    // means the MCP omits the Authorization header and every activity report
    // and correction dispatch 401s silently in tokenless dev setups.
    { name: "FLOW_ACTIVITY_TOKEN", value: process.env.FLOW_ADMIN_TOKEN ?? "dev-token" },
    // correct_graph dispatch target — flags land in the corrections queue and
    // get verified against the base-branch checkout by the indexer.
    { name: "FLOW_CORRECTIONS_URL", value: `http://127.0.0.1:${orchPort}/v1/corrections` },
    // The gateway owns the local embedding model. Agent MCP subprocesses use
    // it over HTTP instead of loading one model copy per active session.
    { name: "FLOW_EMBED_URL", value: `${gatewayUrl}/v1/embed` },
  ];
  if (gatewayToken) env.push({ name: "FLOW_EMBED_TOKEN", value: gatewayToken });
  if (process.env.FALKOR_HOST) env.push({ name: "FALKOR_HOST", value: process.env.FALKOR_HOST });
  if (process.env.FALKOR_PORT) env.push({ name: "FALKOR_PORT", value: process.env.FALKOR_PORT });
  return { name: "flow-graph", command: binPath("tsx"), args: [GATEWAY_MCP], env };
}

export function recordGraphActivity(body: {
  session: string;
  verb: string;
  args?: string;
  nodeIds?: string[];
  ok?: boolean;
}): boolean {
  const s = sessions.get(body.session);
  if (!s) return false;
  emit(s, "graph", {
    verb: body.verb,
    args: body.args ?? "",
    nodeIds: body.nodeIds ?? [],
    ok: body.ok !== false,
  });
  return true;
}

// ---------------------------------------------------------------------------
// Session lifecycle

const GRAPH_PREAMBLE = `Call the flow-graph "orient" tool FIRST — before anything else — for your bearings (what this repo is, how it works, what memory holds); call it again after context compaction or whenever you feel lost.
You have access to the "flow-graph" MCP tools — a knowledge graph of this codebase and the business context around it. Consult it FIRST to orient yourself (find_entity, get_entity, read_query, list_schema: services, capabilities, APIs, resources and how they connect) before diving into files; when you hit an unexpected failure, search the symptom in the graph before digging.
Tools that contribute back — use them sparingly and precisely:
- correct_graph: if graph content contradicts the code (stale description, wrong or missing relationship), flag it with node ids + file:line evidence. The indexer verifies flags against the repo's base branch, so flag freely even mid-branch — but never present your own unmerged work as fact.
- remember: when the user says "remember this", states a durable rule ("always X", "we never Y"), or something clearly worth keeping surfaces, send the text — verbatim quotes plus enough context to stand alone — to Flow's memory. The distiller extracts and files it; you never classify or wait.`;

// PLACEMENT resolves a collision:
//   undefined       — normal start; but if the folder is already in use by a
//                     live session, DON'T start — return {collision} and let the
//                     UI ask the user.
//   "in_place"      — start anyway in the same folder (user chose to share it).
//   "separate_copy" — branch the checkout into an isolated worktree and run
//                     there (never overwrite the other session's tree).
export type SessionPlacement = "in_place" | "separate_copy";

export type CreateSessionResult =
  | { id: string; separateCopy: boolean }
  | { collision: true; active: { id: string; title: string; status: SessionStatus } }
  | { error: string };

export async function createSession(opts: {
  backend: AgentBackend;
  repo: string;
  prompt: string;
  placement?: SessionPlacement;
  // Explicit per-user WORK surface (a registered work folder): "use this
  // repo's knowledge, but make the changes in THIS checkout." Overrides the
  // repo's default surface.
  workFolder?: string;
  // Run inside an EXISTING managed separate copy (the "+ new session" action
  // on a copy card). The copy is already isolated, so no collision prompt —
  // targeting it is deliberate.
  worktreePath?: string;
  // Kickoff-chosen session config (model selector, thought-level toggles, …)
  // picked from the backend's advertised configOptions — applied right after
  // newSession, before the first turn. Same RPCs the session page uses live.
  config?: Record<string, string | boolean>;
  modeId?: string;
  // First-turn attachments (images inline, files written into the checkout) —
  // same handling as steered prompts.
  attachments?: PromptAttachment[];
}): Promise<CreateSessionResult> {
  const found = listRepoOptions().find((r) => r.name === opts.repo);
  if (!found) return { error: `Unknown repo "${opts.repo}" — connect it first` };
  // EXISTING COPY target: validate it up front. A managed copy bypasses the
  // work-folder guards below — it was branched off a work folder already.
  if (opts.worktreePath) {
    if (!isManagedWorktree(opts.worktreePath)) return { error: "That path isn't a Flow-managed copy." };
    if (!existsSync(opts.worktreePath)) return { error: `Copy folder not found: ${opts.worktreePath}` };
    if (managedRepoOf(opts.worktreePath) !== opts.repo) {
      return { error: `That copy doesn't belong to "${opts.repo}".` };
    }
  }
  if (!found.cloned && !opts.workFolder && !opts.worktreePath) {
    return { error: `Repo "${opts.repo}" is not cloned yet` };
  }
  // BRAIN/WORK separation: a GitHub-added repo's only checkout is Flow's
  // managed clone, which the indexer force-resets at will — never a place to
  // run agents. Sessions over these repos require an explicit work folder.
  if (found.surface === "managed" && !opts.workFolder && !opts.worktreePath) {
    return {
      error: `"${opts.repo}" was connected from GitHub, so Flow only indexes it. Pick one of your folders to run the agent in.`,
    };
  }
  let repoOpt = found;
  if (opts.workFolder) {
    if (!existsSync(opts.workFolder)) {
      return { error: `Work folder "${opts.workFolder}" doesn't exist on this machine` };
    }
    repoOpt = { ...found, path: opts.workFolder, cloned: true };
  }

  const title = opts.prompt.length > 80 ? opts.prompt.slice(0, 77) + "…" : opts.prompt;

  // COLLISION check (in-place default only). When the caller hasn't yet chosen a
  // placement and the target folder is already held by a live session, stop and
  // ask — starting a second agent in the same working tree lets them overwrite
  // each other's edits. Skipped for an explicit copy target: clicking "+ new
  // session" on a copy that's already busy is an informed choice.
  if (!opts.placement && !opts.worktreePath) {
    const active = findCollision(repoOpt.path);
    if (active) {
      return { collision: true, active: { id: active.id, title: active.title, status: active.status } };
    }
  }

  // Decide the working directory. SEPARATE COPY branches the checkout into an
  // isolated worktree and runs there; every other path runs in place. On
  // worktree-creation failure we surface {error} and do NOT silently fall back
  // to in_place — running in place is exactly what the user asked to avoid.
  let cwd = repoOpt.path;
  let worktreeId: string | undefined;
  if (opts.worktreePath) {
    cwd = opts.worktreePath;
    worktreeId = opts.worktreePath;
  } else if (opts.placement === "separate_copy") {
    const wt = await createSessionWorktree({
      repoName: repoOpt.name,
      srcCheckout: repoOpt.path,
      baseBranch: repoOpt.branch ?? "main",
      title,
    });
    if ("error" in wt) return { error: `Couldn't create a separate copy: ${wt.error}` };
    cwd = wt.path;
    worktreeId = wt.path; // the worktree path is the stable, derivable id
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  const s: LiveSession = {
    id,
    backend: opts.backend,
    repo: opts.repo,
    cwd,
    worktreeId,
    title,
    status: "starting",
    seq: 0,
    turnActive: false,
    queue: [],
    pendingPermissions: new Map(),
    subscribers: new Set(),
    createdAt: now,
    updatedAt: now,
  };
  sessions.set(id, s);
  insertSession.run(id, opts.backend, opts.repo, cwd, title, "starting", worktreeId ?? null, now, now);
  emit(s, "created", { backend: opts.backend, repo: opts.repo, title, cwd, separateCopy: Boolean(worktreeId) });

  // Async: connect, create ACP session, run the first turn.
  void (async () => {
    try {
      s.branch = (await runGit(cwd, ["branch", "--show-current"])).trim() || undefined;
      // Snapshot the working tree at session start, BEFORE the agent touches
      // anything — this is the base for the SESSION-scope diff, so it must be
      // captured before the first turn runs.
      const start = await captureStartState(cwd);
      s.startSha = start.sha;
      s.startUntracked = start.untracked;
      updateSessionStart.run(start.sha, JSON.stringify(start.untracked), Date.now(), id);
      const c = await ensureConnection(opts.backend);
      const resp = await c.conn.newSession({
        cwd,
        mcpServers: [flowGraphMcp(id, opts.repo, s.branch ?? "")],
      });
      s.acpSessionId = String(resp.sessionId);
      s.modes = resp.modes ?? null;
      // configOptions carry the agent's model selector (category "model") and
      // any thought/reasoning-level toggles — surfaced to the UI verbatim.
      s.configOptions = resp.configOptions ?? null;
      c.sessionsByAcpId.set(s.acpSessionId, id);
      // Apply kickoff-chosen mode + config (model, thought level, …) before
      // the first turn — same RPCs the session page drives live.
      if (opts.modeId) {
        try {
          await c.conn.setSessionMode({ sessionId: s.acpSessionId, modeId: opts.modeId });
        } catch {
          /* keep the agent default */
        }
      }
      if (opts.config) {
        for (const [configId, value] of Object.entries(opts.config)) {
          try {
            const r = await c.conn.setSessionConfigOption(
              typeof value === "boolean"
                ? { sessionId: s.acpSessionId, configId, value, type: "boolean" }
                : { sessionId: s.acpSessionId, configId, value }
            );
            if (r?.configOptions) s.configOptions = r.configOptions;
          } catch {
            /* keep the agent default */
          }
        }
      }
      emit(s, "status", { modes: s.modes, configOptions: s.configOptions, runtime: runtimeInfo(c) });
      await runTurn(s, opts.prompt, `${GRAPH_PREAMBLE}\n\n`, opts.attachments);
    } catch (e) {
      setStatus(s, "error", { error: (e as Error).message });
    }
  })();

  return { id, separateCopy: Boolean(worktreeId) };
}

// Land a non-image attachment on disk in the agent's checkout so the agent can
// read it with its own tools. Files go under a gitignored `.flow/attachments/`
// so they never show up in the session diff or a PR. Returns the absolute path.
function writeAttachmentToCheckout(cwd: string, name: string, data: string): string {
  const dir = path.join(cwd, ".flow", "attachments");
  mkdirSync(dir, { recursive: true });
  // `*` inside .flow ignores everything under it (including itself) — attachments
  // never pollute the working tree the agent is meant to be changing.
  const ignore = path.join(cwd, ".flow", ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
  // Sanitize + de-collide: keep the visible name, prefix a short unique token.
  const safe = (name || "file").replace(/[^A-Za-z0-9._-]/g, "_").slice(-80) || "file";
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const dest = path.join(dir, `${token}-${safe}`);
  writeFileSync(dest, Buffer.from(data, "base64"));
  return dest;
}

// Every turn — first prompt and steers alike — passes through here: preamble
// (first turn only) + the user's text. Memory is pull-only — agents consult
// orient/search_knowledge themselves; nothing is auto-injected per turn.
async function runTurn(s: LiveSession, text: string, preamble = "", attachments?: PromptAttachment[]): Promise<void> {
  const c = connections.get(s.backend);
  if (!c || !s.acpSessionId) throw new Error("session has no live connection");
  s.turnActive = true;
  setStatus(s, "running");
  const finalText = `${preamble}${text}`;

  // Split attachments: images ride inline (adapters render `image` blocks);
  // everything else is written to the checkout and handed over by path.
  const images = (attachments ?? []).filter((a) => IMAGE_MIME.test(a.mimeType));
  const files = (attachments ?? []).filter((a) => !IMAGE_MIME.test(a.mimeType));
  const fileRefs: Array<{ name: string; mimeType: string; path: string }> = [];
  for (const f of files) {
    try {
      fileRefs.push({ name: f.name, mimeType: f.mimeType, path: writeAttachmentToCheckout(s.cwd, f.name, f.data) });
    } catch {
      /* skip a file we couldn't write; the turn still runs */
    }
  }

  // Transcript shows the human text + thumbnails for images + chips for files;
  // the path note is appended only to what the agent sees, not the bubble.
  emit(s, "user_prompt", {
    text: finalText,
    images: images.map((a) => ({ data: a.data, mimeType: a.mimeType })),
    files: fileRefs.map((f) => ({ name: f.name, mimeType: f.mimeType })),
  });

  const agentText = fileRefs.length
    ? `${finalText}\n\n[Attached files — read these from disk before responding:]\n${fileRefs
        .map((f) => `- ${f.path} (${f.mimeType})`)
        .join("\n")}`
    : finalText;

  // Build ACP content blocks: text + inline images.
  const promptBlocks: acp.ContentBlock[] = [{ type: "text", text: agentText }];
  for (const img of images) {
    promptBlocks.push({ type: "image", data: img.data, mimeType: img.mimeType });
  }
  try {
    const result = await c.conn.prompt({
      sessionId: s.acpSessionId,
      prompt: promptBlocks,
    });
    s.turnActive = false;
    // Steering queued during the turn? Run it next.
    const next = s.queue.shift();
    if (next !== undefined && s.status !== "closed") {
      await runTurn(s, next.text, "", next.attachments);
      return;
    }
    if (s.status !== "closed") setStatus(s, "idle", { stopReason: result.stopReason });
  } catch (e) {
    s.turnActive = false;
    if (s.status !== "closed") setStatus(s, "error", { error: describeError(s.backend, e) });
  }
}

// Adapter errors are often a generic "Internal error" over ACP while the real
// cause (auth, usage limits) is on the adapter's stderr — surface that tail.
function describeError(backend: AgentBackend, e: unknown): string {
  const base = (e as Error).message ?? String(e);
  try {
    const log = readFileSync(path.join(SESSIONS_DIR, `adapter-${backend}.stderr.log`), "utf8");
    const lines = log.trim().split("\n");
    const last = lines[lines.length - 1] ?? "";
    // Strip ANSI escapes and log prefixes for a human-readable hint.
    const clean = last.replace(/\x1b\[[0-9;]*m/g, "").replace(/^[\d\-T:.Z\s]+(ERROR|WARN)\s+\S+\s*/, "");
    if (clean && !base.includes(clean.slice(0, 40))) return `${base} — ${clean.slice(0, 300)}`;
  } catch {
    /* no stderr log */
  }
  return base;
}

// Steering: when idle → new turn immediately. When a turn is active → cancel
// the current turn and run the steer prompt next (the user changed their mind).
export async function steer(id: string, text: string, attachments?: PromptAttachment[]): Promise<{ ok: true } | { error: string }> {
  const s = liveSession(id);
  if (!s || !s.acpSessionId) return { error: "Session is not live (reload-only or closed)" };
  let c: Connection;
  try {
    c = await resumeConnection(s);
  } catch (e) {
    return { error: (e as Error).message };
  }
  if (s.turnActive) {
    s.queue.push({ text, attachments });
    await c.conn.cancel({ sessionId: s.acpSessionId });
    return { ok: true };
  }
  void runTurn(s, text, "", attachments).catch(() => {});
  return { ok: true };
}

export async function cancelSession(id: string): Promise<{ ok: true } | { error: string }> {
  const s = sessions.get(id);
  if (!s || !s.acpSessionId) return { error: "Session is not live" };
  const c = connections.get(s.backend);
  if (!c) return { error: "Agent connection lost" };
  s.queue = [];
  // Cancelling must also unblock any pending permission (per ACP spec).
  for (const p of s.pendingPermissions.values()) {
    p.resolve({ outcome: { outcome: "cancelled" } });
  }
  s.pendingPermissions.clear();
  if (s.turnActive) await c.conn.cancel({ sessionId: s.acpSessionId });
  else setStatus(s, "idle", { stopReason: "cancelled" });
  return { ok: true };
}

export function resolvePermission(
  id: string,
  requestId: string,
  optionId: string | null
): { ok: true } | { error: string } {
  const s = sessions.get(id);
  if (!s) return { error: "Unknown session" };
  const pending = s.pendingPermissions.get(requestId);
  if (!pending) return { error: "No such pending permission (already answered?)" };
  s.pendingPermissions.delete(requestId);
  const response: acp.RequestPermissionResponse = optionId
    ? { outcome: { outcome: "selected", optionId } }
    : { outcome: { outcome: "cancelled" } };
  pending.resolve(response);
  emit(s, "permission_result", { requestId, optionId });
  if (s.status === "waiting") setStatus(s, "running");
  return { ok: true };
}

export async function setSessionMode(id: string, modeId: string): Promise<{ ok: true } | { error: string }> {
  const s = sessions.get(id);
  if (!s || !s.acpSessionId) return { error: "Session is not live" };
  const c = connections.get(s.backend);
  if (!c) return { error: "Agent connection lost" };
  try {
    await c.conn.setSessionMode({ sessionId: s.acpSessionId, modeId });
    emit(s, "status", { modeId });
    return { ok: true };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

// Set a session config option — the model selector (category "model") and any
// thought/reasoning-level toggles the agent advertised on session create.
// `value` is the option's value id (or a boolean for boolean options).
export async function setConfigOption(
  id: string,
  configId: string,
  value: string | boolean
): Promise<{ ok: true } | { error: string }> {
  const s = sessions.get(id);
  if (!s || !s.acpSessionId) return { error: "Session is not live" };
  const c = connections.get(s.backend);
  if (!c) return { error: "Agent connection lost" };
  try {
    const resp = await c.conn.setSessionConfigOption(
      typeof value === "boolean"
        ? { sessionId: s.acpSessionId, configId, value, type: "boolean" }
        : { sessionId: s.acpSessionId, configId, value }
    );
    if (resp?.configOptions) s.configOptions = resp.configOptions;
    emit(s, "status", { configOptions: s.configOptions });
    return { ok: true };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

// Kill adapter subprocesses when the orchestrator shuts down — `flow down`
// must not leave agent adapters (and their MCP children) running.
function killAdapters(): void {
  for (const c of connections.values()) {
    try {
      c.process.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  connections.clear();
}
process.once("SIGTERM", killAdapters);
process.once("SIGINT", killAdapters);
process.once("exit", killAdapters);

// Resolve a session's working directory (the repo checkout) from the live map
// or the DB, so it works for finished/reloaded sessions too.
function sessionCwd(id: string): string | null {
  const live = sessions.get(id);
  if (live) return live.cwd;
  const row = db.prepare(`SELECT cwd FROM agent_sessions WHERE id = ?`).get(id) as { cwd?: string } | undefined;
  return row?.cwd ?? null;
}

export function sessionLocation(id: string): { cwd: string } | null {
  const cwd = sessionCwd(id);
  return cwd ? { cwd } : null;
}

// ---------------------------------------------------------------------------
// Session diff — what the agent changed in its repo checkout. Sourced from
// `git` (not ACP tool-call content) so it's the same regardless of backend and
// works for reloaded/archived sessions. Non-mutating: never touches the index.

export type DiffScope = "session" | "base";

export interface SessionDiff {
  files: Array<{ path: string; additions: number; deletions: number; status: "modified" | "added" }>;
  diff: string;
  truncated: boolean;
  // The scope actually used (BASE degrades to SESSION when the base branch
  // can't be resolved), and the base branch name for BASE scope (null in
  // SESSION scope or when BASE degraded).
  scope: DiffScope;
  base: string | null;
}

const DIFF_MAX_BYTES = 400_000;
const UNTRACKED_MAX = 60;

// Resolve stdout even on non-zero exit — `git diff` exits 1 when differences
// exist (not an error), and we still want the diff text it printed.
function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 8000 },
      (_err, stdout) => resolve(stdout ?? "")
    );
  });
}

// Probe git commands whose signal is the exit code, not stdout (cat-file -e,
// rev-parse --verify): true iff git exited 0.
function gitOk(cwd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 5000 }, (err) => resolve(!err));
  });
}

// start_untracked is stored as a JSON array string; tolerate legacy/NULL/bad.
function parseUntracked(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// Snapshot the working tree at session start for the SESSION-scope diff.
// `git stash create` writes a commit object capturing the current tracked
// working tree + index WITHOUT touching either (unlike `git stash push`), and
// prints its sha — or NOTHING when the tree is clean, in which case HEAD is the
// snapshot. An empty repo (no HEAD) yields null: the session diff then falls
// back to diff-vs-HEAD, which itself no-ops until the first commit. We also
// record pre-existing untracked files so they don't pollute "what the agent
// did" (the stash-create commit doesn't include untracked files).
async function captureStartState(cwd: string): Promise<{ sha: string | null; untracked: string[] }> {
  const inside = (await runGit(cwd, ["rev-parse", "--is-inside-work-tree"])).trim();
  if (inside !== "true") return { sha: null, untracked: [] };
  let sha = (await runGit(cwd, ["stash", "create"])).trim();
  if (!sha) sha = (await runGit(cwd, ["rev-parse", "HEAD"])).trim();
  const untracked = (await runGit(cwd, ["ls-files", "--others", "--exclude-standard"]))
    .split("\n")
    .filter(Boolean);
  return { sha: sha || null, untracked };
}

// Resolve the repo's registered base branch (repos.json `branch`) to a git ref
// that exists in this checkout: prefer the remote-tracking base
// (origin/<branch>), fall back to a local branch of the same name. Returns null
// when neither exists (or no base branch is registered) — BASE scope then
// degrades to SESSION.
async function resolveBaseRef(cwd: string, repo: string): Promise<{ ref: string; name: string } | null> {
  const branch = listRepoOptions().find((r) => r.name === repo)?.branch;
  if (!branch) return null;
  for (const ref of [`origin/${branch}`, branch]) {
    if (await gitOk(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])) {
      return { ref, name: branch };
    }
  }
  return null;
}

// Session record needed for a diff — resolved from the live map or (for
// finished/reloaded sessions) the DB, so diffs work after a restart too.
function sessionRecord(id: string): { cwd: string; repo: string; startSha: string | null; startUntracked: string[] } | null {
  const live = sessions.get(id);
  if (live) {
    return { cwd: live.cwd, repo: live.repo, startSha: live.startSha ?? null, startUntracked: live.startUntracked ?? [] };
  }
  const row = db.prepare(`SELECT cwd, repo, start_sha, start_untracked FROM agent_sessions WHERE id = ?`).get(id) as
    | { cwd?: string; repo?: string; start_sha?: string | null; start_untracked?: string | null }
    | undefined;
  if (!row?.cwd) return null;
  return {
    cwd: row.cwd,
    repo: row.repo ?? "",
    startSha: row.start_sha ?? null,
    startUntracked: parseUntracked(row.start_untracked),
  };
}

// What changed, in one of two scopes:
//   SESSION (default) — everything since the session started: `git diff` of the
//     working tree against the start snapshot, plus untracked files the agent
//     added (excluding those that pre-existed the session). Survives the agent
//     committing (the snapshot is a fixed point, not HEAD).
//   BASE — the branch vs its registered base: `git diff` of the working tree
//     against `merge-base(base, HEAD)`. Deliberately the merge-base and not a
//     two-dot `base..HEAD`: we want what THIS branch adds on top of the fork
//     point, not upstream commits that landed on base afterwards (which would
//     show up reversed). Untracked: include all current untracked files.
// Non-mutating: only reads and `--no-index` diffs; never touches the index.
export async function sessionDiff(id: string, scope: DiffScope = "session"): Promise<SessionDiff | { error: string }> {
  const rec = sessionRecord(id);
  if (!rec) return { error: "Unknown session" };
  const { cwd } = rec;
  if (!existsSync(cwd)) return { error: `Folder not found: ${cwd}` };
  const inside = (await runGit(cwd, ["rev-parse", "--is-inside-work-tree"])).trim();
  if (inside !== "true") return { files: [], diff: "", truncated: false, scope, base: null };

  // Decide the ref we diff the working tree against, which untracked files to
  // exclude, and the scope/base we actually resolved (BASE may degrade).
  let baseRef = "HEAD";
  let baseName: string | null = null;
  let effectiveScope: DiffScope = scope;
  let excludeUntracked = new Set<string>();

  if (scope === "base") {
    const resolved = await resolveBaseRef(cwd, rec.repo);
    const mergeBase = resolved ? (await runGit(cwd, ["merge-base", resolved.ref, "HEAD"])).trim() : "";
    if (resolved && mergeBase) {
      baseRef = mergeBase;
      baseName = resolved.name;
    } else {
      effectiveScope = "session"; // no base to compare against — degrade
    }
  }

  if (effectiveScope === "session") {
    // Guard: the start snapshot is a DANGLING commit (nothing refers to it), so
    // `git gc` can prune it. Verify it still exists before diffing against it;
    // otherwise fall back to HEAD — today's diff-vs-HEAD behaviour.
    if (rec.startSha && (await gitOk(cwd, ["cat-file", "-e", `${rec.startSha}^{commit}`]))) {
      baseRef = rec.startSha;
      excludeUntracked = new Set(rec.startUntracked);
    } else {
      baseRef = "HEAD";
    }
  }

  const built = await buildDiff(cwd, baseRef, excludeUntracked);
  return { ...built, scope: effectiveScope, base: baseName };
}

// The shared diff-assembly: working tree vs `baseRef`, plus untracked files
// (minus any pre-existing ones) rendered as additions. Factored out of
// sessionDiff so the session-less worktree diff (worktreeDiff, below) reuses
// exactly the same machinery instead of duplicating it. Non-mutating: only
// reads and `--no-index` diffs; never touches the index.
async function buildDiff(
  cwd: string,
  baseRef: string,
  excludeUntracked: Set<string>
): Promise<{ files: SessionDiff["files"]; diff: string; truncated: boolean }> {
  const files: SessionDiff["files"] = [];

  // Tracked changes vs the chosen base (staged + unstaged, combined).
  const numstat = await runGit(cwd, ["diff", baseRef, "--numstat"]);
  for (const line of numstat.split("\n")) {
    const cols = line.split("\t");
    if (cols.length < 3) continue;
    files.push({
      path: cols[2],
      additions: cols[0] === "-" ? 0 : parseInt(cols[0], 10) || 0,
      deletions: cols[1] === "-" ? 0 : parseInt(cols[1], 10) || 0,
      status: "modified",
    });
  }
  let diff = await runGit(cwd, ["diff", baseRef]);

  // Untracked, non-ignored files → render as additions via --no-index, which
  // never writes to the index. SESSION scope drops files that pre-existed the
  // session; BASE scope shows all current untracked files.
  const untracked = (await runGit(cwd, ["ls-files", "--others", "--exclude-standard"]))
    .split("\n")
    .filter(Boolean)
    .filter((f) => !excludeUntracked.has(f))
    .slice(0, UNTRACKED_MAX);
  for (const f of untracked) {
    const d = await runGit(cwd, ["diff", "--no-index", "--", "/dev/null", f]);
    if (!d) continue;
    diff += (diff ? "\n" : "") + d;
    files.push({
      path: f,
      additions: d.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length,
      deletions: 0,
      status: "added",
    });
  }

  let truncated = false;
  if (diff.length > DIFF_MAX_BYTES) {
    diff = diff.slice(0, DIFF_MAX_BYTES);
    truncated = true;
  }
  return { files, diff, truncated };
}

// ---------------------------------------------------------------------------
// File/folder mentions (@-tagging) — lets the dashboard offer autocomplete
// over a repo checkout's tracked + untracked-but-not-ignored paths, the same
// way editor-integrated agent harnesses let you @-tag a file or folder.

export interface FileEntry {
  path: string;
  type: "file" | "dir";
}

const filesCache = new Map<string, { at: number; entries: FileEntry[] }>();
const FILES_CACHE_TTL = 15_000;

function gitLsFiles(cwd: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard"],
      { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 5000 },
      (err, stdout) => resolve(err ? [] : stdout.split("\n").filter(Boolean))
    );
  });
}

async function allEntries(cwd: string): Promise<FileEntry[]> {
  const cached = filesCache.get(cwd);
  if (cached && Date.now() - cached.at < FILES_CACHE_TTL) return cached.entries;
  const files = await gitLsFiles(cwd);
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  const entries: FileEntry[] = [
    ...files.map((p) => ({ path: p, type: "file" as const })),
    ...[...dirs].map((p) => ({ path: p, type: "dir" as const })),
  ];
  filesCache.set(cwd, { at: Date.now(), entries });
  return entries;
}

// Case-insensitive match: basename-prefix and substring hits rank above a
// scattered subsequence match. Good enough for @mention autocomplete — not a
// full fuzzy-match engine.
function matchScore(pathLower: string, query: string): number {
  const idx = pathLower.indexOf(query);
  if (idx >= 0) {
    const base = pathLower.slice(pathLower.lastIndexOf("/") + 1);
    if (base.startsWith(query)) return 0;
    if (idx === 0) return 1;
    return 2 + idx / pathLower.length;
  }
  let qi = 0;
  for (let i = 0; i < pathLower.length && qi < query.length; i++) {
    if (pathLower[i] === query[qi]) qi++;
  }
  return qi === query.length ? 10 + pathLower.length / 100 : -1;
}

async function filesUnder(cwd: string, query: string, limit: number): Promise<FileEntry[]> {
  const entries = await allEntries(cwd);
  const q = query.trim().toLowerCase();
  if (!q) return entries.filter((e) => e.type === "file").slice(0, limit);
  const scored = entries
    .map((e) => ({ e, score: matchScore(e.path.toLowerCase(), q) }))
    .filter((s) => s.score >= 0)
    .sort((a, b) => a.score - b.score || a.e.path.length - b.e.path.length);
  return scored.slice(0, limit).map((s) => s.e);
}

// List files/folders (for @mention autocomplete) in a live or archived
// session's repo checkout.
export async function listSessionFiles(
  id: string,
  query: string,
  limit = 40
): Promise<{ entries: FileEntry[] } | { error: string }> {
  const cwd = sessionCwd(id);
  if (!cwd) return { error: "Unknown session" };
  if (!existsSync(cwd)) return { error: `Folder not found: ${cwd}` };
  return { entries: await filesUnder(cwd, query, limit) };
}

// Same, but for the "start a new session" composer, which only has a repo
// name selected (no session yet).
export async function listRepoFiles(
  repo: string,
  query: string,
  limit = 40,
  dir?: string
): Promise<{ entries: FileEntry[] } | { error: string }> {
  const repoOpt = listRepoOptions().find((r) => r.name === repo);
  if (!repoOpt || !repoOpt.cloned) return { error: `Unknown repo "${repo}"` };
  // Autocomplete from where the session will actually run: the caller's work
  // folder when one is chosen, else the user's connected folder. A managed
  // (GitHub-only) repo has no browsable surface — the BRAIN clone is for
  // indexing, not for peeking.
  const root = dir ?? (repoOpt.surface === "folder" ? repoOpt.path : null);
  if (!root) return { error: `"${repo}" is index-only — pick a work folder to browse its files` };
  return { entries: await filesUnder(root, query, limit) };
}

// Open the session's repo folder in the OS file manager or VS Code. Local-mode
// convenience — the orchestrator runs on the user's machine, so it can launch
// GUI apps. The path comes from the session record, never from the client, and
// is passed as a spawn arg (no shell) so there's nothing to inject.
export function openLocation(id: string, target: "finder" | "vscode"): { ok: true } | { error: string } {
  const cwd = sessionCwd(id);
  if (!cwd) return { error: "Unknown session" };
  if (!existsSync(cwd)) return { error: `Folder not found: ${cwd}` };

  let cmd: string;
  let args: string[];
  if (target === "vscode") {
    cmd = "code";
    args = [cwd];
  } else if (process.platform === "darwin") {
    cmd = "open";
    args = [cwd];
  } else if (process.platform === "win32") {
    cmd = "explorer";
    args = [cwd];
  } else {
    cmd = "xdg-open";
    args = [cwd];
  }

  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      // `code` CLI not on PATH → fall back to the app bundle on macOS.
      if (target === "vscode" && process.platform === "darwin") {
        try {
          spawn("open", ["-a", "Visual Studio Code", cwd], { stdio: "ignore", detached: true }).unref();
        } catch {
          /* nothing else to try */
        }
      }
    });
    child.unref();
    return { ok: true };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export function subscribe(id: string, fn: (ev: SessionEvent) => void): (() => void) | null {
  const s = liveSession(id);
  if (!s) return null;
  s.subscribers.add(fn);
  return () => s.subscribers.delete(fn);
}

// ---------------------------------------------------------------------------
// Managed worktrees — Phase C: visibility + exits for the separate copies.
// The pure git ops live in worktrees.ts (runnable in the future local
// companion, no db). Here we add the parts that need the registry + session
// map: which repos to scan, which sessions are attached, the GitHub url, and
// the "no live session attached" remove guard.

// The repo's GitHub owner/repo parsed from its registry url (null for
// local-only repos). PR opening and compare URLs depend on this.
function repoGithub(repoName: string): { owner: string; repo: string } | null {
  const reposJson = process.env.REPOS_JSON_PATH;
  if (!reposJson || !existsSync(reposJson)) return null;
  try {
    const parsed = JSON.parse(readFileSync(reposJson, "utf8")) as { repos?: Array<{ name: string; url?: string }> };
    const url = parsed.repos?.find((r) => r.name === repoName)?.url;
    if (!url) return null;
    const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?\/?$/i);
    return m ? { owner: m[1], repo: m[2] } : null;
  } catch {
    return null;
  }
}

// Does this repo have a GitHub url? Gates PR actions in the UI (the session
// exit banner and the copies list both ask).
export function repoHasGithubUrl(repo: string): boolean {
  return repoGithub(repo) !== null;
}

export function repoBaseBranch(repo: string): string {
  return listRepoOptions().find((r) => r.name === repo)?.branch ?? "main";
}

export async function listRepoBranches(repo: string): Promise<{ branches: string[]; base: string } | { error: string }> {
  const repoOpt = listRepoOptions().find((r) => r.name === repo);
  if (!repoOpt || !repoOpt.cloned) return { error: `Unknown repo "${repo}"` };
  const base = repoOpt.branch ?? "main";
  const seen = new Set<string>();
  const branches: string[] = [];
  const add = (branch: string) => {
    const name = branch.trim();
    if (!name || name === "HEAD" || name === "origin/HEAD") return;
    const normalized = name.startsWith("origin/") ? name.slice("origin/".length) : name;
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    branches.push(normalized);
  };
  add(base);
  try {
    const refs = await runGit(repoOpt.path, ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes/origin"]);
    for (const line of refs.split(/\r?\n/)) add(line);
  } catch {
    try {
      add(await runGit(repoOpt.path, ["branch", "--show-current"]));
    } catch {
      /* base branch already included */
    }
  }
  return { branches, base };
}

// Sessions recorded against a worktree path (worktree_id). Realpath both sides:
// createSession stores the raw dest path, `git worktree list` emits realpaths,
// and on macOS those differ (/var vs /private/var). Live status wins over the
// stored row status when the session is in the live map.
function sessionsForWorktree(
  treePath: string
): Array<{ id: string; title: string; status: SessionStatus; backend: string; updated_at: number }> {
  const real = realpathOrSelf(treePath);
  const rows = db
    .prepare(
      `SELECT id, title, status, backend, updated_at, worktree_id FROM agent_sessions WHERE worktree_id IS NOT NULL ORDER BY updated_at DESC`
    )
    .all() as Array<{ id: string; title: string; status: string; backend: string; updated_at: number; worktree_id: string }>;
  return rows
    .filter((r) => realpathOrSelf(r.worktree_id) === real)
    .map((r) => {
      const live = sessions.get(r.id);
      return {
        id: r.id,
        title: r.title,
        status: (live?.status ?? r.status) as SessionStatus,
        backend: r.backend,
        updated_at: live?.updatedAt ?? r.updated_at,
      };
    });
}

export interface ManagedWorktree {
  repo: string;
  path: string;
  branch: string | null;
  base: string; // the repo's registered base branch
  aheadCount: number;
  dirty: boolean;
  merged: boolean;
  health: "ok" | "broken";
  sessions: Array<{ id: string; title: string; status: SessionStatus; backend: string; updated_at: number }>;
  github: boolean; // repo has a GitHub url → PR action is available
}

// Every flow-managed separate copy (optionally filtered to one repo). For each
// registered code checkout: prune, list, keep only trees under the managed root
// (the user's OWN primary checkout is never a row), and enrich with git facts +
// attached sessions. Never throws — a bad repo just contributes nothing.
export async function listManagedWorktrees(repoFilter?: string): Promise<ManagedWorktree[]> {
  if (!managedWorktreesRoot()) return [];
  const repos = listRepoOptions().filter((r) => r.cloned && (!repoFilter || r.name === repoFilter));
  const out: ManagedWorktree[] = [];
  for (const r of repos) {
    await pruneWorktrees(r.path);
    const trees = await listWorktrees(r.path);
    for (const t of trees) {
      if (!isManagedWorktree(t.path)) continue; // skips the primary checkout
      const info = await inspectWorktree({ treePath: t.path, baseBranch: r.branch ?? "main", branch: t.branch });
      out.push({
        repo: r.name,
        path: t.path,
        branch: info.branch,
        base: info.base,
        aheadCount: info.aheadCount,
        dirty: info.dirty,
        merged: info.merged,
        health: info.health,
        sessions: sessionsForWorktree(t.path),
        github: repoGithub(r.name) !== null,
      });
    }
  }
  return out;
}

// Resolve a managed tree path to its owning repo, source checkout, and current
// branch — the context the remove/apply/push/diff ops need. Returns null when
// the path isn't managed or its repo isn't registered.
async function resolveTree(
  treePath: string
): Promise<{ repo: string; src: string; branch: string | null; base: string } | null> {
  const repoName = managedRepoOf(treePath);
  if (!repoName) return null;
  const opt = listRepoOptions().find((r) => r.name === repoName);
  if (!opt) return null;
  const real = realpathOrSelf(treePath);
  // `git worktree list` still reports the branch of a folder-missing tree until
  // it's pruned, so this resolves the branch for broken rows too.
  const trees = await listWorktrees(opt.path);
  const match = trees.find((t) => realpathOrSelf(t.path) === real);
  return { repo: repoName, src: opt.path, branch: match?.branch ?? null, base: opt.branch ?? "main" };
}

export async function removeManagedWorktree(
  treePath: string,
  force = false
): Promise<{ ok: true } | { error: string }> {
  if (!isManagedWorktree(treePath)) return { error: "That path isn't a Flow-managed copy — refusing to remove it." };
  // Refuse while a LIVE session still runs here — pulling the tree out from
  // under a working agent would strand it.
  const attached = sessionsForWorktree(treePath).find((s) => ACTIVE_FOR_COLLISION.has(s.status));
  if (attached) return { error: `A session is still active on this copy ("${attached.title}"). Stop it first.` };
  const t = await resolveTree(treePath);
  if (!t) return { error: "Couldn't find the source checkout for this copy." };
  return removeWorktree({ srcCheckout: t.src, treePath, branch: t.branch, force });
}

export async function applyManagedWorktree(
  treePath: string
): Promise<{ ok: true; mergedInto: string } | { error: string }> {
  if (!isManagedWorktree(treePath)) return { error: "That path isn't a Flow-managed copy." };
  const t = await resolveTree(treePath);
  if (!t || !t.branch) return { error: "Couldn't find the branch for this copy." };
  return applyWorktree({ srcCheckout: t.src, treePath, branch: t.branch });
}

export async function pushManagedWorktree(
  treePath: string
): Promise<{ ok: true; compareUrl: string } | { error: string }> {
  if (!isManagedWorktree(treePath)) return { error: "That path isn't a Flow-managed copy." };
  const t = await resolveTree(treePath);
  if (!t || !t.branch) return { error: "Couldn't find the branch for this copy." };
  const gh = repoGithub(t.repo);
  if (!gh) return { error: "This repository isn't connected to GitHub." };
  return pushWorktree({ treePath, branch: t.branch, base: t.base, owner: gh.owner, repo: gh.repo });
}

export async function openPullRequestForManagedWorktree(
  treePath: string,
  targetBranch?: string
): Promise<
  | { ok: true; compareUrl: string; branch: string; targetBranch: string; committed: boolean }
  | { conflict: true; branch: string; targetBranch: string; files: string[] }
  | { error: string }
> {
  if (!isManagedWorktree(treePath)) return { error: "That path isn't a Flow-managed copy." };
  const t = await resolveTree(treePath);
  if (!t || !t.branch) return { error: "Couldn't find the branch for this copy." };
  const gh = repoGithub(t.repo);
  if (!gh) return { error: "This repository isn't connected to GitHub." };
  return openPullRequestWorktree({
    treePath,
    branch: t.branch,
    targetBranch: targetBranch?.trim() || t.base,
    owner: gh.owner,
    repo: gh.repo,
  });
}

export function openWorktreeLocation(
  treePath: string,
  target: "finder" | "vscode"
): { ok: true } | { error: string } {
  if (!isManagedWorktree(treePath)) return { error: "That path isn't a Flow-managed copy." };
  if (!existsSync(treePath)) return { error: `Folder not found: ${treePath}` };

  let cmd: string;
  let args: string[];
  if (target === "vscode") {
    cmd = "code";
    args = [treePath];
  } else {
    cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
    args = [treePath];
  }

  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      if (target === "vscode" && process.platform === "darwin") {
        try {
          spawn("open", ["-a", "Visual Studio Code", treePath], { stdio: "ignore", detached: true }).unref();
        } catch {
          /* best-effort fallback */
        }
      }
    });
    child.unref();
    return { ok: true };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

// Diff a managed tree that has NO session of its own: working dir vs the
// merge-base with its base branch. Same shape (and scope:"base") as the
// session diff, reusing buildDiff via worktreeDiff below.
export async function worktreeDiffAt(treePath: string): Promise<SessionDiff | { error: string }> {
  if (!isManagedWorktree(treePath)) return { error: "That path isn't a Flow-managed copy." };
  const t = await resolveTree(treePath);
  if (!t) return { error: "Unknown copy." };
  return worktreeDiff(treePath, t.repo);
}

// Base-scope diff for an arbitrary checkout (a worktree with no session).
// Mirrors sessionDiff's BASE branch: working tree vs merge-base(base, HEAD).
export async function worktreeDiff(treePath: string, repo: string): Promise<SessionDiff | { error: string }> {
  if (!existsSync(treePath)) return { error: `Folder not found: ${treePath}` };
  const inside = (await runGit(treePath, ["rev-parse", "--is-inside-work-tree"])).trim();
  if (inside !== "true") return { files: [], diff: "", truncated: false, scope: "base", base: null };
  const resolved = await resolveBaseRef(treePath, repo);
  const mergeBase = resolved ? (await runGit(treePath, ["merge-base", resolved.ref, "HEAD"])).trim() : "";
  if (!resolved || !mergeBase) {
    // No base to compare against — fall back to diff vs HEAD (still shows the
    // tree's uncommitted work), reported with a null base.
    const built = await buildDiff(treePath, "HEAD", new Set<string>());
    return { ...built, scope: "base", base: null };
  }
  const built = await buildDiff(treePath, mergeBase, new Set<string>());
  return { ...built, scope: "base", base: resolved.name };
}
