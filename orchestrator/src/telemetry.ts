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
  const apiKey = getSetting("FLOW_TELEMETRY_POSTHOG_KEY");
  if (!apiKey) return null;
  const host = getSetting("FLOW_TELEMETRY_POSTHOG_HOST") || "https://us.i.posthog.com";
  return { url: `${host.replace(/\/$/, "")}/capture/`, apiKey };
}

export async function sendTelemetry(): Promise<boolean> {
  const target = posthogTarget();
  if (!target) return false;
  try {
    const snap = await telemetrySnapshot();
    const { instance_id, ...properties } = snap;
    const res = await fetch(target.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: target.apiKey,
        event: "flow_snapshot",
        distinct_id: instance_id,
        properties: { ...properties, $process_person_profile: false },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    // Best-effort by design: an unreachable PostHog must never affect Flow.
    return false;
  }
}

let firstTimer: NodeJS.Timeout | null = null;
let intervalTimer: NodeJS.Timeout | null = null;

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

export function registerTelemetryRoutes(app: FastifyInstance): void {
  app.get("/v1/telemetry", async (_req, reply) => {
    const snapshot = await telemetrySnapshot();
    return reply.send({
      snapshot,
      reporting: posthogTarget() ? "on" : "off",
    });
  });
}
