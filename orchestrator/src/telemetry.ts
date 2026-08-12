// telemetry.ts — anonymous, numbers-only usage snapshot + optional PostHog
// phone-home.
//
// WHAT LEAVES THE MACHINE: counts and booleans only — how many repos are
// connected, how many nodes the graph has, how many sessions/worktrees exist,
// whether Slack/Linear/etc. are configured. Never names, paths, repo URLs,
// code, or message content. GET /v1/telemetry returns the exact payload so a
// self-hoster can audit what would be sent.
//
// TRANSPORT: PostHog's capture API — one plain fetch, no SDK dependency.
// Off until FLOW_TELEMETRY_POSTHOG_KEY is set (env or dashboard setting);
// FLOW_TELEMETRY_DISABLE=1 force-disables even with a key. The key is
// re-read on every tick, so pasting it into the dashboard settings enables
// reporting without a restart. Sends once shortly after boot, then daily.
//
// IDENTITY: a random UUID minted once per deployment and kept in the config
// table. distinct_id in PostHog = one Flow instance; "how many people use
// Flow" is a unique-count over it. $process_person_profile:false keeps the
// events anonymous-tier (no person profiles).

import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import db from "./db.js";
import { listWorkspaceRepos } from "./opencode.js";
import { managedWorktreesRoot } from "./agents/worktrees.js";
import { getSetting } from "./settings.js";
import { getFlowMode } from "./mode.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const INSTANCE_ID_KEY = "telemetry:instance_id";
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FIRST_SEND_DELAY_MS = 2 * 60 * 1000;

// ------------------------------------------------------------------
// Snapshot
// ------------------------------------------------------------------

export interface TelemetrySnapshot {
  instance_id: string;
  flow_mode: "local" | "prod";
  version: string;
  platform: string;
  node_major: number;
  sources_total: number;
  sources_code: number;
  sources_docs: number;
  sources_indexed: number;
  graph_nodes: number | null;
  graph_edges: number | null;
  memories: number;
  observations: number;
  corpus_events: number;
  corpus_slack_messages: number;
  corpus_linear_tickets: number;
  corpus_meeting_segments: number;
  sessions_total: number;
  sessions_via_flow: number;
  sessions_captured_external: number;
  sessions_last_7d: number;
  sessions_last_30d: number;
  sessions_by_backend: Record<string, number>;
  jobs_total: number;
  jobs_done: number;
  jobs_failed: number;
  errors_since_boot: number;
  worktrees_created_total: number;
  worktrees_active: number;
  work_folders_total: number;
  work_folder_owners: number;
  connected_slack: boolean;
  connected_linear: boolean;
  connected_github: boolean;
  connected_fireflies: boolean;
  connected_llm_key: boolean;
}

export function telemetryInstanceId(): string {
  const row = db.prepare("SELECT value FROM config WHERE key = ?").get(INSTANCE_ID_KEY) as
    | { value: string }
    | undefined;
  if (row) {
    try {
      return JSON.parse(row.value) as string;
    } catch {
      return row.value;
    }
  }
  const id = randomUUID();
  db.prepare("INSERT INTO config (key, value) VALUES (?, ?)").run(INSTANCE_ID_KEY, JSON.stringify(id));
  return id;
}

function orchestratorVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "../package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function count(sql: string, ...params: unknown[]): number {
  try {
    return (db.prepare(sql).get(...params) as { c: number } | undefined)?.c ?? 0;
  } catch {
    return 0;
  }
}

// agent_sessions.created_at is Date.now() ms for flow-native rows; normalize
// to seconds in SQL so second-resolution rows (external capture) compare too.
const CREATED_AT_SEC = "(CASE WHEN created_at > 100000000000 THEN created_at / 1000 ELSE created_at END)";

function sessionsByBackend(): Record<string, number> {
  const out: Record<string, number> = {};
  try {
    const rows = db
      .prepare("SELECT backend, count(*) AS c FROM agent_sessions GROUP BY backend")
      .all() as Array<{ backend: string; c: number }>;
    for (const r of rows) out[r.backend] = r.c;
  } catch {
    /* table absent on ancient DBs — counts stay empty */
  }
  return out;
}

// Live worktree dirs under <workspace>/worktrees/<repo>/<slug>. Filesystem
// truth (removed copies disappear); the cumulative number comes from
// agent_sessions.worktree_id instead.
function activeWorktreeCount(): number {
  const root = managedWorktreesRoot();
  if (!root) return 0;
  let n = 0;
  try {
    for (const repo of readdirSync(root, { withFileTypes: true })) {
      if (!repo.isDirectory()) continue;
      try {
        n += readdirSync(path.join(root, repo.name), { withFileTypes: true }).filter((d) =>
          d.isDirectory()
        ).length;
      } catch {
        /* repo dir raced away */
      }
    }
  } catch {
    return 0;
  }
  return n;
}

// Node/edge totals via the gateway's read_query verb (same boundary as
// memory/anchor-provider.ts). null = gateway unreachable, not zero.
async function graphCounts(): Promise<{ nodes: number | null; edges: number | null }> {
  const base = process.env.FLOW_GATEWAY_URL || process.env.GRAPH_GATEWAY_URL || "";
  if (!base) return { nodes: null, edges: null };
  const url = `${base.replace(/\/$/, "")}/v1/verbs/read_query`;
  const token = process.env.FLOW_ADMIN_TOKEN || process.env.FLOW_ACTIVITY_TOKEN || "";
  const run = async (cypher: string): Promise<number | null> => {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ cypher }),
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) return null;
      const body = (await res.json().catch(() => ({}))) as { rows?: Array<{ c?: number }> };
      const c = body.rows?.[0]?.c;
      return typeof c === "number" ? c : null;
    } catch {
      return null;
    }
  };
  const [nodes, edges] = await Promise.all([
    run("MATCH (n) RETURN count(n) AS c"),
    run("MATCH ()-[r]->() RETURN count(r) AS c"),
  ]);
  return { nodes, edges };
}

export async function telemetrySnapshot(): Promise<TelemetrySnapshot> {
  let repos: ReturnType<typeof listWorkspaceRepos> = [];
  try {
    repos = listWorkspaceRepos();
  } catch {
    /* registry unreadable — counts stay 0 */
  }
  const docs = repos.filter((r) => r.kind === "docs").length;
  const graph = await graphCounts();
  const nowSec = Math.floor(Date.now() / 1000);
  const day = 86_400;
  const isSet = (key: string): boolean => Boolean(getSetting(key));

  return {
    instance_id: telemetryInstanceId(),
    flow_mode: getFlowMode(),
    version: orchestratorVersion(),
    platform: process.platform,
    node_major: parseInt(process.versions.node.split(".")[0], 10),
    sources_total: repos.length,
    sources_code: repos.length - docs,
    sources_docs: docs,
    sources_indexed: repos.filter((r) => Boolean(r.lastIndexedCommit)).length,
    graph_nodes: graph.nodes,
    graph_edges: graph.edges,
    memories: count("SELECT count(*) AS c FROM memories"),
    observations: count("SELECT count(*) AS c FROM observations"),
    corpus_events: count("SELECT count(*) AS c FROM events"),
    corpus_slack_messages: count("SELECT count(*) AS c FROM slack_messages"),
    corpus_linear_tickets: count("SELECT count(*) AS c FROM linear_tickets"),
    corpus_meeting_segments: count("SELECT count(*) AS c FROM meeting_segments"),
    sessions_total: count("SELECT count(*) AS c FROM agent_sessions"),
    sessions_via_flow: count("SELECT count(*) AS c FROM agent_sessions WHERE id NOT LIKE 'ext-%'"),
    sessions_captured_external: count("SELECT count(*) AS c FROM agent_sessions WHERE id LIKE 'ext-%'"),
    sessions_last_7d: count(
      `SELECT count(*) AS c FROM agent_sessions WHERE ${CREATED_AT_SEC} >= ?`,
      nowSec - 7 * day
    ),
    sessions_last_30d: count(
      `SELECT count(*) AS c FROM agent_sessions WHERE ${CREATED_AT_SEC} >= ?`,
      nowSec - 30 * day
    ),
    sessions_by_backend: sessionsByBackend(),
    jobs_total: count("SELECT count(*) AS c FROM jobs"),
    jobs_done: count("SELECT count(*) AS c FROM jobs WHERE status = 'done'"),
    jobs_failed: count("SELECT count(*) AS c FROM jobs WHERE status = 'failed'"),
    errors_since_boot: errorEventCount,
    worktrees_created_total: count(
      "SELECT count(DISTINCT worktree_id) AS c FROM agent_sessions WHERE worktree_id IS NOT NULL"
    ),
    worktrees_active: activeWorktreeCount(),
    work_folders_total: count("SELECT count(*) AS c FROM work_folders"),
    work_folder_owners: count("SELECT count(DISTINCT owner) AS c FROM work_folders"),
    connected_slack: isSet("SLACK_BOT_TOKEN") && isSet("SLACK_APP_TOKEN"),
    connected_linear: isSet("LINEAR_API_KEY"),
    connected_github: isSet("GITHUB_TOKEN"),
    connected_fireflies: isSet("FIREFLIES_API_KEY"),
    connected_llm_key: isSet("LLM_API_KEY") || isSet("OPENROUTER_API_KEY"),
  };
}

// ------------------------------------------------------------------
// PostHog reporter
// ------------------------------------------------------------------

function posthogTarget(): { url: string; apiKey: string } | null {
  if (process.env.FLOW_TELEMETRY_DISABLE === "1") return null;
  // The fake-opencode flag marks a test process — the default key is real,
  // and a test run must never emit events.
  if (process.env.FLOW_FAKE_OPENCODE === "1") return null;
  const apiKey = getSetting("FLOW_TELEMETRY_POSTHOG_KEY");
  if (!apiKey) return null;
  const host = getSetting("FLOW_TELEMETRY_POSTHOG_HOST") || "https://us.i.posthog.com";
  return { url: `${host.replace(/\/$/, "")}/capture/`, apiKey };
}

// One capture call — every event goes through here. Best-effort by design:
// an unreachable PostHog must never affect Flow.
async function capture(event: string, properties: Record<string, unknown>): Promise<boolean> {
  const target = posthogTarget();
  if (!target) return false;
  try {
    const res = await fetch(target.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: target.apiKey,
        event,
        distinct_id: telemetryInstanceId(),
        properties: {
          ...properties,
          version: orchestratorVersion(),
          flow_mode: getFlowMode(),
          $process_person_profile: false,
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function sendTelemetry(): Promise<boolean> {
  try {
    const snap = await telemetrySnapshot();
    const { instance_id, ...properties } = snap;
    void instance_id; // identity travels as distinct_id only
    return await capture("flow_snapshot", properties);
  } catch {
    return false;
  }
}

// Discrete usage events — the "verbs" layer next to the snapshot's "nouns":
// individually timestamped by PostHog, so frequency/retention insights work.
// Same privacy rules as everything here: values must be numbers, booleans, or
// fixed enums (backend ids, placement kinds) — never titles, names, or paths.
export function track(event: string, properties: Record<string, number | boolean | string>): void {
  void capture(event, properties);
}

// ------------------------------------------------------------------
// Error reporting — same pipeline, same rules. An error event carries the
// error CLASS and a Flow-source frame (basename:line of OUR open-source
// files), never the message: messages routinely embed user paths, repo
// names, and URLs. Capped per process so a crash loop can't burn the
// PostHog quota.
// ------------------------------------------------------------------

const ERROR_EVENTS_MAX_PER_PROCESS = 50;
let errorEventCount = 0;

// First stack frame that points into Flow's own source, reduced to
// basename:line ("runtime.ts:1151"). Frames outside our tree (user cwd,
// node internals) are skipped — their paths are not ours to send.
function flowFrame(stack: string | undefined): string | null {
  if (!stack) return null;
  for (const line of stack.split("\n")) {
    const m = /\(?([^()\s]+\.(?:ts|mts|mjs|js)):(\d+):\d+\)?$/.exec(line.trim());
    if (!m) continue;
    const p = m[1];
    if (!/\/(?:orchestrator|graph-gateway|dashboard|bin)\/[^ ]*$/.test(p)) continue;
    return `${path.basename(p)}:${m[2]}`;
  }
  return null;
}

export async function reportError(scope: string, err: unknown): Promise<boolean> {
  if (errorEventCount >= ERROR_EVENTS_MAX_PER_PROCESS) return false;
  if (!posthogTarget()) return false;
  errorEventCount++;
  const e = err instanceof Error ? err : new Error(String(err));
  const code = (e as NodeJS.ErrnoException).code;
  const frame = flowFrame(e.stack);
  return capture("flow_error", {
    scope,
    error_name: e.name,
    ...(typeof code === "string" ? { error_code: code } : {}),
    ...(frame ? { frame } : {}),
  });
}

let firstTimer: NodeJS.Timeout | null = null;
let intervalTimer: NodeJS.Timeout | null = null;
let monitorInstalled = false;

export function startTelemetryReporter(): void {
  if (process.env.FLOW_TELEMETRY_DISABLE === "1") {
    console.log("[telemetry] disabled (FLOW_TELEMETRY_DISABLE=1)");
    return;
  }
  // The key is resolved inside sendTelemetry on every tick, so the timers run
  // unconditionally — setting the key from the dashboard later just works.
  if (!posthogTarget()) {
    console.log("[telemetry] idle — set FLOW_TELEMETRY_POSTHOG_KEY to enable usage reporting");
  }
  // uncaughtExceptionMonitor OBSERVES crashes without altering crash
  // behavior (unlike an 'uncaughtException' listener, which would swallow
  // them). Node 22 throws unhandled rejections, so they land here too.
  if (!monitorInstalled) {
    monitorInstalled = true;
    process.on("uncaughtExceptionMonitor", (err) => void reportError("uncaught", err));
  }
  const interval = parseInt(process.env.FLOW_TELEMETRY_INTERVAL_MS ?? "", 10) || DEFAULT_INTERVAL_MS;
  firstTimer = setTimeout(() => void sendTelemetry(), FIRST_SEND_DELAY_MS);
  firstTimer.unref();
  intervalTimer = setInterval(() => void sendTelemetry(), interval);
  intervalTimer.unref();
}

export function stopTelemetryReporter(): void {
  if (firstTimer) clearTimeout(firstTimer);
  if (intervalTimer) clearInterval(intervalTimer);
  firstTimer = null;
  intervalTimer = null;
}

// ------------------------------------------------------------------
// Route — the audit window: exactly what a phone-home would send.
// ------------------------------------------------------------------

// Events the CLI may relay through us (it has no PostHog key of its own).
// A whitelist plus number/boolean-only properties keeps this from becoming an
// arbitrary-string funnel into our project under the admin token.
const CLI_TRACKABLE = new Set(["flow_setup_run"]);

export function sanitizeTrackProps(raw: unknown): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= 20) break;
    if (!/^[a-z0-9_]{1,40}$/.test(k)) continue;
    if (typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  return out;
}

export function registerTelemetryRoutes(app: FastifyInstance): void {
  app.get("/v1/telemetry", async (_req, reply) => {
    const snapshot = await telemetrySnapshot();
    return reply.send({
      snapshot,
      reporting: posthogTarget() ? "on" : "off",
    });
  });

  app.post<{ Body: { event?: string; properties?: unknown } }>(
    "/v1/telemetry/track",
    async (req, reply) => {
      const { event, properties } = req.body ?? {};
      if (!event || !CLI_TRACKABLE.has(event)) {
        return reply.code(400).send({ error: "unknown event" });
      }
      track(event, sanitizeTrackProps(properties));
      return reply.code(202).send({ ok: true });
    }
  );
}
