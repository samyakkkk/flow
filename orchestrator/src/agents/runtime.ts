// Agents v1 — ACP runtime. The orchestrator is the ACP client for every
// coding agent on this machine (Claude Code, Codex, OpenCode): it spawns the
// agent's ACP adapter as a subprocess, creates sessions in connected-repo
// checkouts, injects Flow's read-only graph MCP into each session, streams
// every session update to subscribers (SSE), and relays steering (follow-up
// prompts, cancel, permission replies, mode changes).
//
// Cloud shape: nothing in here is reachable except through the orchestrator's
// HTTP API — the dashboard never spawns agents itself. Later, "cloud mode" is
// the same API in front of containers instead of local processes.

import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import db from "../db.js";

// ---------------------------------------------------------------------------
// Backends

export type AgentBackend = "claude" | "codex" | "opencode";

const FLOW_ROOT = fileURLToPath(new URL("../../..", import.meta.url)); // flow/
const GATEWAY_MCP = path.join(FLOW_ROOT, "graph-gateway", "src", "mcp.ts");

// npm workspaces hoist bins to the root node_modules; fall back to the
// orchestrator's own node_modules for non-workspace installs.
function binPath(name: string): string {
  const hoisted = path.join(FLOW_ROOT, "node_modules", ".bin", name);
  if (existsSync(hoisted)) return hoisted;
  return path.join(FLOW_ROOT, "orchestrator", "node_modules", ".bin", name);
}
const TSX_BIN = binPath("tsx");

interface BackendDescriptor {
  id: AgentBackend;
  name: string;
  executable: string; // the agent CLI users install/authenticate
  spawn: { command: string; args: string[]; bundled?: boolean };
  installHint: string;
}

export const BACKENDS: Record<AgentBackend, BackendDescriptor> = {
  claude: {
    id: "claude",
    name: "Claude Code",
    executable: "claude",
    // Bundled adapters (installed as orchestrator deps) — no npx cold start.
    spawn: { command: "claude-agent-acp", args: [], bundled: true },
    installHint: "npm i -g @anthropic-ai/claude-code",
  },
  codex: {
    id: "codex",
    name: "Codex",
    executable: "codex",
    spawn: { command: "codex-acp", args: [], bundled: true },
    installHint: "npm i -g @openai/codex",
  },
  opencode: {
    id: "opencode",
    name: "OpenCode",
    executable: "opencode",
    spawn: { command: "opencode", args: ["acp"] },
    installHint: "curl -fsSL https://opencode.ai/install | bash",
  },
};

// ---------------------------------------------------------------------------
// Detection — which agents are installed on this machine

export interface DetectedAgent {
  id: AgentBackend;
  name: string;
  installed: boolean;
  version?: string;
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
      const version = await execVersion(b.executable);
      return {
        id: b.id,
        name: b.name,
        installed: version !== null,
        version: version ?? undefined,
        installHint: b.installHint,
      };
    })
  );
  detectCache = { at: Date.now(), agents };
  return agents;
}

// ---------------------------------------------------------------------------
// Project context (graph name, repos, session storage dir)

const PROJECT_DIR = path.dirname(process.env.DB_PATH ?? path.join(FLOW_ROOT, "data", "flow.db"));
const SESSIONS_DIR = path.join(PROJECT_DIR, "agent-sessions");

function projectGraphName(): string {
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
}

export function listRepoOptions(): RepoOption[] {
  const reposJson = process.env.REPOS_JSON_PATH;
  const out: RepoOption[] = [];
  if (reposJson && existsSync(reposJson)) {
    try {
      const parsed = JSON.parse(readFileSync(reposJson, "utf8")) as {
        repos?: Array<{ name: string }>;
      };
      const reposDir = path.join(path.dirname(reposJson), "repos");
      for (const r of parsed.repos ?? []) {
        const p = path.join(reposDir, r.name);
        out.push({ name: r.name, path: p, cloned: existsSync(p) });
      }
    } catch {
      /* empty list */
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Session store — SQLite metadata + JSONL event transcript + live subscribers

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
  cwd: string;
  title: string;
  status: SessionStatus;
  acpSessionId?: string;
  modes?: unknown; // SessionModeState from newSession, passed to UI verbatim
  configOptions?: unknown; // SessionConfigOption[] — model/thought selectors, verbatim
  stopReason?: string;
  error?: string;
  seq: number;
  turnActive: boolean;
  queue: string[]; // queued steering prompts
  pendingPermissions: Map<string, PendingPermission>;
  subscribers: Set<(ev: SessionEvent) => void>;
  createdAt: number;
  updatedAt: number;
}

const sessions = new Map<string, LiveSession>();

const insertSession = db.prepare(
  `INSERT INTO agent_sessions (id, backend, repo, cwd, title, status, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);
const updateSessionRow = db.prepare(
  `UPDATE agent_sessions SET status=?, acp_session_id=?, stop_reason=?, error=?, updated_at=? WHERE id=?`
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
  s.status = status;
  if (extra?.stopReason) s.stopReason = extra.stopReason;
  if (extra?.error) s.error = extra.error;
  s.updatedAt = Date.now();
  updateSessionRow.run(status, s.acpSessionId ?? null, s.stopReason ?? null, s.error ?? null, s.updatedAt, s.id);
  emit(s, "status", { status, stopReason: s.stopReason, error: s.error });
}

export function getSession(id: string): LiveSession | undefined {
  return sessions.get(id);
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

// ---------------------------------------------------------------------------
// ACP connections — one adapter process per backend, shared across sessions

interface Connection {
  backend: AgentBackend;
  process: ChildProcessWithoutNullStreams;
  conn: acp.ClientSideConnection;
  init: acp.InitializeResponse;
  sessionsByAcpId: Map<string, string>; // acp session id → flow session id
}

const connections = new Map<AgentBackend, Connection>();

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
      // Flow's own graph MCP is read-only by construction — auto-approve it
      // so consulting the brain never stalls a session. Humans still gate
      // file edits, shell commands, and every other tool.
      const title = String(params.toolCall?.title ?? "");
      if (title.includes("flow-graph")) {
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
      const u = params.update as { sessionUpdate?: string; configOptions?: unknown };
      if (u.sessionUpdate === "config_option_update" && u.configOptions) {
        s.configOptions = u.configOptions;
      }
      emit(s, "update", params.update);
    },
  };
}

async function ensureConnection(backend: AgentBackend): Promise<Connection> {
  const existing = connections.get(backend);
  if (existing && existing.process.exitCode === null) return existing;
  connections.delete(backend);

  const desc = BACKENDS[backend];
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const command = desc.spawn.bundled ? binPath(desc.spawn.command) : desc.spawn.command;
  const proc = spawn(command, desc.spawn.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
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

  const init = await Promise.race([
    conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      // Advertise session config-option support so agents send their model
      // selector (and thought-level toggles) as configOptions we can drive.
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        session: { configOptions: { boolean: {} } },
      },
    }),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${backend} adapter did not initialize in 60s`)), 60_000)),
  ]);

  const c: Connection = { backend, process: proc, conn, init, sessionsByAcpId: new Map() };
  proc.on("exit", (code) => {
    connections.delete(backend);
    for (const flowId of c.sessionsByAcpId.values()) {
      const s = sessions.get(flowId);
      if (s && s.status !== "closed" && s.status !== "error") {
        setStatus(s, "error", { error: `${backend} adapter exited (code ${code})` });
      }
    }
  });
  connections.set(backend, c);
  return c;
}

// ---------------------------------------------------------------------------
// Flow graph MCP injection (read-only) + activity routing

function flowGraphMcp(flowSessionId: string): acp.McpServer {
  const orchPort = process.env.ORCHESTRATOR_PORT ?? "7500";
  const env: Array<{ name: string; value: string }> = [
    { name: "GATEWAY_MCP_READONLY", value: "1" },
    { name: "GRAPH_NAME", value: projectGraphName() },
    { name: "FLOW_AGENT_SESSION", value: flowSessionId },
    { name: "FLOW_ACTIVITY_URL", value: `http://127.0.0.1:${orchPort}/v1/agents/graph-activity` },
    { name: "FLOW_ACTIVITY_TOKEN", value: process.env.FLOW_ADMIN_TOKEN ?? "" },
  ];
  if (process.env.FALKOR_HOST) env.push({ name: "FALKOR_HOST", value: process.env.FALKOR_HOST });
  if (process.env.FALKOR_PORT) env.push({ name: "FALKOR_PORT", value: process.env.FALKOR_PORT });
  return { name: "flow-graph", command: TSX_BIN, args: [GATEWAY_MCP], env };
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

const GRAPH_PREAMBLE = `You have access to the "flow-graph" MCP tools (find_entity, get_entity, read_query, list_schema) — a knowledge graph of this codebase and the business context around it. Consult it FIRST to orient yourself (services, capabilities, APIs, resources and how they connect) before diving into files. It is read-only.`;

export async function createSession(opts: {
  backend: AgentBackend;
  repo: string;
  prompt: string;
}): Promise<{ id: string } | { error: string }> {
  const repoOpt = listRepoOptions().find((r) => r.name === opts.repo);
  if (!repoOpt) return { error: `Unknown repo "${opts.repo}" — connect it first` };
  if (!repoOpt.cloned) return { error: `Repo "${opts.repo}" is not cloned yet` };

  const id = crypto.randomUUID();
  const title = opts.prompt.length > 80 ? opts.prompt.slice(0, 77) + "…" : opts.prompt;
  const now = Date.now();
  const s: LiveSession = {
    id,
    backend: opts.backend,
    repo: opts.repo,
    cwd: repoOpt.path,
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
  insertSession.run(id, opts.backend, opts.repo, repoOpt.path, title, "starting", now, now);
  emit(s, "created", { backend: opts.backend, repo: opts.repo, title, cwd: repoOpt.path });

  // Async: connect, create ACP session, run the first turn.
  void (async () => {
    try {
      const c = await ensureConnection(opts.backend);
      const resp = await c.conn.newSession({
        cwd: repoOpt.path,
        mcpServers: [flowGraphMcp(id)],
      });
      s.acpSessionId = String(resp.sessionId);
      s.modes = resp.modes ?? null;
      // configOptions carry the agent's model selector (category "model") and
      // any thought/reasoning-level toggles — surfaced to the UI verbatim.
      s.configOptions = resp.configOptions ?? null;
      c.sessionsByAcpId.set(s.acpSessionId, id);
      emit(s, "status", { modes: s.modes, configOptions: s.configOptions });
      await runTurn(s, `${GRAPH_PREAMBLE}\n\n${opts.prompt}`);
    } catch (e) {
      setStatus(s, "error", { error: (e as Error).message });
    }
  })();

  return { id };
}

async function runTurn(s: LiveSession, text: string): Promise<void> {
  const c = connections.get(s.backend);
  if (!c || !s.acpSessionId) throw new Error("session has no live connection");
  s.turnActive = true;
  setStatus(s, "running");
  emit(s, "user_prompt", { text });
  try {
    const result = await c.conn.prompt({
      sessionId: s.acpSessionId,
      prompt: [{ type: "text", text }],
    });
    s.turnActive = false;
    // Steering queued during the turn? Run it next.
    const next = s.queue.shift();
    if (next !== undefined && s.status !== "closed") {
      await runTurn(s, next);
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
export async function steer(id: string, text: string): Promise<{ ok: true } | { error: string }> {
  const s = sessions.get(id);
  if (!s || !s.acpSessionId) return { error: "Session is not live (reload-only or closed)" };
  const c = connections.get(s.backend);
  if (!c) return { error: "Agent connection lost" };
  if (s.turnActive) {
    s.queue.push(text);
    await c.conn.cancel({ sessionId: s.acpSessionId });
    return { ok: true };
  }
  void runTurn(s, text).catch(() => {});
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
  const s = sessions.get(id);
  if (!s) return null;
  s.subscribers.add(fn);
  return () => s.subscribers.delete(fn);
}
