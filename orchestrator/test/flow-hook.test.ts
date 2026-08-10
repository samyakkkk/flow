// flow-hook.test.ts — Ring 0 for the capture shim (bin/harness/flow-hook.mjs).
// Spawns the real script against a fake ingest server, with HOME pointed at a
// temp dir so ~/.flow resolution is hermetic. The shim's contract under test:
//   - real recorded hook payloads arrive as {harness, project, repo, event}
//   - secrets are redacted CLIENT-side, values masked / shapes preserved
//   - FLOW_SESSION_ID (Flow-run session) → no upload at all
//   - no config / dead server → exit 0, fast, silent
// Every path must exit 0 — a shim that can fail a user's session is a bug
// worse than lost capture.

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

const SHIM = resolve(import.meta.dirname, "../../bin/harness/flow-hook.mjs");

let home: string;
let server: Server;
let port: number;
let received: Array<{ auth: string | undefined; body: Record<string, unknown> }> = [];

function runShim(
  argv: string[],
  stdin: string,
  env: Record<string, string> = {}
): Promise<{ code: number | null; ms: number }> {
  return new Promise((resolvePromise) => {
    const start = Date.now();
    const child = spawn(process.execPath, [SHIM, ...argv], {
      env: { PATH: process.env.PATH ?? "", HOME: home, ...env },
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.stdin.write(stdin);
    child.stdin.end();
    child.on("exit", (code) => resolvePromise({ code, ms: Date.now() - start }));
  });
}

before(async () => {
  home = mkdtempSync(join(tmpdir(), "flow-hook-home-"));
  received = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.push({
        auth: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString()),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
  mkdirSync(join(home, ".flow"), { recursive: true });
  writeFileSync(
    join(home, ".flow", "config.json"),
    JSON.stringify({ remotes: { local: { url: `http://127.0.0.1:${port}`, token: "t0k3n" } } })
  );
});

after(async () => {
  await new Promise((r) => server.close(r));
  rmSync(home, { recursive: true, force: true });
});

// Real payload recorded from claude 2.1.170 (2026-08-06 spike), secret planted.
const claudeStop = {
  session_id: "e3948326-fe79-4a81-95d9-89cd63f1318b",
  transcript_path: "/Users/u/.claude/projects/-spike/e3948326.jsonl",
  cwd: "/Users/u/spike",
  permission_mode: "default",
  hook_event_name: "Stop",
  stop_hook_active: false,
  last_assistant_message: "Done. I set OPENROUTER key sk-or-v1-abcdef1234567890abcdef in your env.",
  background_tasks: [],
  session_crons: [],
};

describe("flow-hook shim", () => {
  test("uploads a recorded claude payload with binding + auth", async () => {
    const { code } = await runShim(
      ["--harness", "claude", "--project", "flow", "--repo", "flow", "--remote", "local"],
      JSON.stringify(claudeStop)
    );
    assert.equal(code, 0);
    assert.equal(received.length, 1);
    const r = received[0];
    assert.equal(r.auth, "Bearer t0k3n");
    assert.equal(r.body.harness, "claude");
    assert.equal(r.body.project, "flow");
    assert.equal(r.body.repo, "flow");
    const event = r.body.event as typeof claudeStop;
    assert.equal(event.hook_event_name, "Stop");
    assert.equal(event.session_id, claudeStop.session_id);
  });

  test("secrets are redacted client-side, prose preserved", () => {
    const event = received[0].body.event as typeof claudeStop;
    assert.ok(!event.last_assistant_message.includes("sk-or-v1"), "key value must not survive");
    assert.ok(event.last_assistant_message.includes("[redacted]"));
    assert.ok(event.last_assistant_message.startsWith("Done. I set OPENROUTER key"));
  });

  test("FLOW_SESSION_ID short-circuits before any upload", async () => {
    const count = received.length;
    const { code } = await runShim(["--harness", "claude"], JSON.stringify(claudeStop), {
      FLOW_SESSION_ID: "flow-run-session",
    });
    assert.equal(code, 0);
    assert.equal(received.length, count);
  });

  test("missing remote config: silent success, nothing sent", async () => {
    const count = received.length;
    const { code } = await runShim(
      ["--harness", "codex", "--remote", "nonexistent"],
      JSON.stringify(claudeStop)
    );
    assert.equal(code, 0);
    assert.equal(received.length, count);
  });

  test("unparseable stdin: exit 0", async () => {
    const { code } = await runShim(["--harness", "gemini"], "not json {{{");
    assert.equal(code, 0);
  });

  test("dead server: exit 0 within the session-safe deadline", async () => {
    writeFileSync(
      join(home, ".flow", "config.json"),
      JSON.stringify({ remotes: { local: { url: "http://127.0.0.1:1", token: "x" } } })
    );
    const { code, ms } = await runShim(["--harness", "claude"], JSON.stringify(claudeStop));
    assert.equal(code, 0);
    assert.ok(ms < 4000, `took ${ms}ms — must stay under SessionEnd-style timeouts`);
    // restore for any later tests
    writeFileSync(
      join(home, ".flow", "config.json"),
      JSON.stringify({ remotes: { local: { url: `http://127.0.0.1:${port}`, token: "t0k3n" } } })
    );
  });
});
