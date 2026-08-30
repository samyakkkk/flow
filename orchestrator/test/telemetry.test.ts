// telemetry.test.ts — the usage snapshot is numbers/booleans only, the
// instance id is stable, reporting stays off without a PostHog key, and the
// capture payload sends counts under a stable anonymous distinct_id.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";

// Setup: workspace + in-memory DB before any imports that touch db
const workspace = mkdtempSync(join(tmpdir(), "flow-telemetry-"));
process.env.OPENCODE_WORKSPACE_DIR = workspace;
process.env.REPOS_JSON_PATH = join(workspace, "repos.json");
process.env.DB_PATH = ":memory:";
process.env.FLOW_ADMIN_TOKEN = "test-token-telemetry";
// Deliberately NOT setting FLOW_FAKE_OPENCODE: that flag hard-disables
// telemetry (so the rest of the suite can't leak events), and this file needs
// sends to reach its local capture server.
process.env.FLOW_DRAIN_DISABLE = "1";
process.env.LINEAR_API_KEY = "lin_api_test";
delete process.env.SLACK_BOT_TOKEN;
delete process.env.FLOW_GATEWAY_URL;
delete process.env.GRAPH_GATEWAY_URL;
// A default PostHog key ships in the settings registry — point the host at a
// dead local port so no test can ever reach the real capture endpoint.
process.env.FLOW_TELEMETRY_POSTHOG_HOST = "http://127.0.0.1:9";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { TelemetrySnapshot } from "../src/telemetry.js";

let telemetryInstanceId: () => string;
let telemetrySnapshot: () => Promise<TelemetrySnapshot>;
let sendTelemetry: () => Promise<boolean>;
let reportError: (scope: string, err: unknown) => Promise<boolean>;
let track: (event: string, props: Record<string, number | boolean | string>) => void;
let sanitizeTrackProps: (raw: unknown) => Record<string, number | boolean>;
let bumpCounter: (name: string, by?: number) => void;
let getSetting: (key: string) => string | undefined;
let putSetting: (key: string, value: string) => void;
let db: import("better-sqlite3").Database;

before(async () => {
  ({ telemetryInstanceId, telemetrySnapshot, sendTelemetry, reportError, track, sanitizeTrackProps, bumpCounter } =
    await import("../src/telemetry.js"));
  ({ getSetting, putSetting } = await import("../src/settings.js"));
  ({ default: db } = await import("../src/db.js"));

  // agent_sessions is created by the agents runtime, not db.ts's baseline —
  // create the same shape here rather than booting the whole ACP runtime.
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_sessions (
      id TEXT PRIMARY KEY,
      backend TEXT NOT NULL,
      repo TEXT NOT NULL,
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      worktree_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  writeFileSync(
    process.env.REPOS_JSON_PATH!,
    JSON.stringify({
      repos: [
        { name: "app", url: "https://github.com/acme/app", branch: "main", lastIndexedCommit: "abc123" },
        { name: "notes", url: "", branch: "main", kind: "docs" },
      ],
    })
  );

  const now = Date.now();
  const ins = db.prepare(
    `INSERT INTO agent_sessions (id, backend, repo, cwd, title, status, worktree_id, created_at, updated_at)
     VALUES (?, ?, 'app', '/tmp/x', 't', 'closed', ?, ?, ?)`
  );
  // Two flow-native sessions sharing one worktree, one captured external session.
  ins.run("s1", "claude", "/wt/a", now, now);
  ins.run("s2", "claude", "/wt/a", now, now);
  ins.run("ext-codex-abc", "ext:codex", null, now, now);

  // Two live managed worktrees on disk under <workspace>/worktrees/<repo>/<slug>
  mkdirSync(join(workspace, "worktrees", "app", "fix-login"), { recursive: true });
  mkdirSync(join(workspace, "worktrees", "app", "add-tests"), { recursive: true });
});

after(() => rmSync(workspace, { recursive: true, force: true }));

describe("telemetry snapshot", () => {
  test("instance id is minted once and stable", () => {
    const a = telemetryInstanceId();
    const b = telemetryInstanceId();
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f-]{36}$/);
  });

  test("snapshot reports counts and booleans only — no names, paths, or content", async () => {
    const snap = await telemetrySnapshot();

    assert.equal(snap.sources_total, 2);
    assert.equal(snap.sources_code, 1);
    assert.equal(snap.sources_docs, 1);
    assert.equal(snap.sources_indexed, 1);

    assert.equal(snap.sessions_total, 3);
    assert.equal(snap.sessions_via_flow, 2);
    assert.equal(snap.sessions_captured_external, 1);
    assert.equal(snap.sessions_last_7d, 3);
    assert.deepEqual(snap.sessions_by_backend, { claude: 2, "ext:codex": 1 });

    assert.equal(snap.worktrees_created_total, 1); // distinct worktree_id
    assert.equal(snap.worktrees_active, 2); // dirs on disk

    assert.equal(snap.connected_linear, true); // env key set
    assert.equal(snap.connected_slack, false);
    assert.equal(snap.graph_nodes, null); // no gateway configured ≠ zero nodes

    // Every value is a number, boolean, null, or a number-valued map — the
    // payload can never carry repo names, paths, or message content.
    for (const [key, value] of Object.entries(snap)) {
      if (["sessions_by_backend", "jobs_by_type", "counters"].includes(key)) {
        for (const v of Object.values(value as Record<string, number>)) {
          assert.equal(typeof v, "number");
        }
      } else if (["instance_id", "flow_mode", "version", "platform"].includes(key)) {
        assert.equal(typeof value, "string");
      } else {
        assert.ok(value === null || typeof value === "number" || typeof value === "boolean", key);
      }
    }
  });

  test("a default PostHog key ships in the registry; FLOW_TELEMETRY_DISABLE=1 is a hard off", async () => {
    assert.match(getSetting("FLOW_TELEMETRY_POSTHOG_KEY") ?? "", /^phc_/);
    process.env.FLOW_TELEMETRY_DISABLE = "1";
    try {
      assert.equal(await sendTelemetry(), false);
      assert.equal(await reportError("test", new Error("nope")), false);
    } finally {
      delete process.env.FLOW_TELEMETRY_DISABLE;
    }
  });

  test("FLOW_FAKE_OPENCODE=1 (test processes) also hard-disables sends", async () => {
    process.env.FLOW_FAKE_OPENCODE = "1";
    try {
      assert.equal(await sendTelemetry(), false);
    } finally {
      delete process.env.FLOW_FAKE_OPENCODE;
    }
  });

  test("bumpCounter accumulates durably and lands in the snapshot", async () => {
    bumpCounter("brain_search_total", 3);
    bumpCounter("brain_search_total");
    bumpCounter("memory_remember_total");
    const snap = await telemetrySnapshot();
    assert.equal(snap.counters.brain_search_total, 4);
    assert.equal(snap.counters.memory_remember_total, 1);
  });

  test("sanitizeTrackProps keeps only sane numeric/boolean keys", () => {
    assert.deepEqual(
      sanitizeTrackProps({
        harness_claude: true,
        detected_count: 3,
        repo_name: "secret-repo", // strings are dropped wholesale
        "weird key!": 1,
        nested: { a: 1 },
      }),
      { harness_claude: true, detected_count: 3 }
    );
    assert.deepEqual(sanitizeTrackProps("junk"), {});
  });

  test("sendTelemetry posts a PostHog capture event keyed by instance id", async () => {
    let captured: Record<string, unknown> | null = null;
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        captured = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;

    putSetting("FLOW_TELEMETRY_POSTHOG_KEY", "phc_test_key");
    putSetting("FLOW_TELEMETRY_POSTHOG_HOST", `http://127.0.0.1:${port}`);
    try {
      assert.equal(await sendTelemetry(), true);
    } finally {
      server.close();
    }

    assert.ok(captured, "capture endpoint was hit");
    const body = captured as Record<string, unknown>;
    assert.equal(body.api_key, "phc_test_key");
    assert.equal(body.event, "flow_snapshot");
    assert.equal(body.distinct_id, telemetryInstanceId());
    const props = body.properties as Record<string, unknown>;
    assert.equal(props.sessions_total, 3);
    assert.equal(props.$process_person_profile, false); // anonymous-tier events
    assert.equal("instance_id" in props, false); // identity travels as distinct_id only
    // Counters flatten to top-level chartable properties.
    assert.equal(props.brain_search_total, 4);
    assert.equal("counters" in props, false);
  });

  test("reportError sends class + Flow frame, never the message", async () => {
    let captured: Record<string, unknown> | null = null;
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        captured = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    putSetting("FLOW_TELEMETRY_POSTHOG_HOST", `http://127.0.0.1:${port}`);

    const err = new TypeError("secret /Users/someone/private-repo/path leaked");
    try {
      assert.equal(await reportError("test-scope", err), true);
    } finally {
      server.close();
    }

    assert.ok(captured, "capture endpoint was hit");
    const body = captured as Record<string, unknown>;
    assert.equal(body.event, "flow_error");
    assert.equal(body.distinct_id, telemetryInstanceId());
    const props = body.properties as Record<string, unknown>;
    assert.equal(props.scope, "test-scope");
    assert.equal(props.error_name, "TypeError");
    // The message (which can embed user paths) must never travel.
    assert.equal(JSON.stringify(body).includes("private-repo"), false);
    // This test file lives under orchestrator/ — the frame is basename:line.
    if (props.frame !== undefined) {
      assert.match(String(props.frame), /^[^/\\]+:\d+$/);
    }
  });

  test("track() fires a discrete usage event with enum-shaped props", async () => {
    let captured: Record<string, unknown> | null = null;
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        captured = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    putSetting("FLOW_TELEMETRY_POSTHOG_HOST", `http://127.0.0.1:${port}`);

    track("flow_session_started", { backend: "claude", placement: "separate_copy", native: true });
    // track() is fire-and-forget — wait for the capture to land.
    const deadline = Date.now() + 3000;
    while (!captured && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    server.close();

    assert.ok(captured, "capture endpoint was hit");
    const body = captured as Record<string, unknown>;
    assert.equal(body.event, "flow_session_started");
    assert.equal(body.distinct_id, telemetryInstanceId());
    const props = body.properties as Record<string, unknown>;
    assert.equal(props.backend, "claude");
    assert.equal(props.placement, "separate_copy");
    assert.equal(props.native, true);
    assert.equal(typeof props.version, "string"); // common context rides along
  });
});
