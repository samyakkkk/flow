// indexer-failure.test.ts — the failure classifier turns raw CLI/git/env
// errors into {code, message, hint} a user can act on, and the preflight
// names the broken layer (gateway vs FalkorDB) before a CLI ever spawns.

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import {
  classifyIndexerFailure,
  isInternalFailure,
  preflightIndexEnvironment,
} from "../src/indexer-failure.js";

describe("classifyIndexerFailure", () => {
  test("claude signed out (stderr) → cli_auth with /login hint", () => {
    const f = classifyIndexerFailure("claude", {
      status: 1,
      stderr: "Invalid API key · Please run /login",
    });
    assert.equal(f.code, "cli_auth");
    assert.match(f.message, /Claude Code/);
    assert.match(f.hint ?? "", /\/login/);
  });

  test("claude OAuth expiry on stdout (stream-json) is still caught", () => {
    const f = classifyIndexerFailure("claude", {
      status: 1,
      stdout: '{"type":"result","is_error":true,"result":"OAuth token has expired. Please obtain a new token or refresh your existing token."}',
    });
    assert.equal(f.code, "cli_auth");
  });

  test("codex not logged in → cli_auth with codex login hint", () => {
    const f = classifyIndexerFailure("codex", { status: 1, stderr: "Error: Not logged in. Run codex login." });
    assert.equal(f.code, "cli_auth");
    assert.match(f.hint ?? "", /codex login/);
  });

  test("opencode 401 → cli_auth with opencode hint", () => {
    const f = classifyIndexerFailure("opencode", { status: 1, stderr: "AI_APICallError: 401 Unauthorized" });
    assert.equal(f.code, "cli_auth");
    assert.match(f.hint ?? "", /opencode auth login/);
  });

  test("credit balance → cli_limit", () => {
    const f = classifyIndexerFailure("claude", { status: 1, stderr: "Your credit balance is too low" });
    assert.equal(f.code, "cli_limit");
  });

  test("CLI missing (resolver message) → cli_not_installed", () => {
    const f = classifyIndexerFailure(undefined, {
      errorMessage: '"claude" CLI not found on PATH — install it or set INDEXER_RUNTIME to an installed backend.',
    });
    assert.equal(f.code, "cli_not_installed");
  });

  test("spawn ENOENT → cli_not_installed", () => {
    const f = classifyIndexerFailure("codex", { status: null, errorMessage: "spawn codex ENOENT" });
    assert.equal(f.code, "cli_not_installed");
  });

  test("timeout message → timeout with minutes in the message", () => {
    const f = classifyIndexerFailure("opencode", {
      status: null,
      errorMessage: "opencode timed out after 2700000ms",
    });
    assert.equal(f.code, "timeout");
    assert.match(f.message, /45-minute/);
  });

  test("private clone denied → clone_auth with token hint", () => {
    const f = classifyIndexerFailure(undefined, {
      errorMessage: "git clone failed for web: remote: Repository not found.",
    });
    assert.equal(f.code, "clone_auth");
    assert.match(f.hint ?? "", /GitHub token/);
  });

  test("clone network failure → clone_failed", () => {
    const f = classifyIndexerFailure(undefined, {
      errorMessage: "git fetch failed for web: Could not resolve host github.com",
    });
    assert.equal(f.code, "clone_failed");
  });

  test("connection refused mentioning 6379 → db_down; otherwise gateway_down", () => {
    const db = classifyIndexerFailure("claude", { status: 1, stderr: "connect ECONNREFUSED 127.0.0.1:6379" });
    assert.equal(db.code, "db_down");
    const gw = classifyIndexerFailure("claude", { status: 1, stderr: "connect ECONNREFUSED 127.0.0.1:7433" });
    assert.equal(gw.code, "gateway_down");
  });

  test("no exit code and no known pattern → killed", () => {
    const f = classifyIndexerFailure("claude", { status: null, stderr: "" });
    assert.equal(f.code, "killed");
  });

  test("unrecognized nonzero exit → unknown, keeps a detail line", () => {
    const f = classifyIndexerFailure("claude", { status: 1, stderr: "something exploded\n  at foo.ts:1" });
    assert.equal(f.code, "unknown");
    assert.equal(f.detail, "something exploded");
  });
});

describe("isInternalFailure", () => {
  test("lifecycle bookkeeping is internal; real messages are not", () => {
    assert.equal(isInternalFailure("superseded:abc"), true);
    assert.equal(isInternalFailure("repo_removed"), true);
    assert.equal(isInternalFailure("stalled:process_restart"), true);
    assert.equal(isInternalFailure("Claude Code is signed out"), false);
    assert.equal(isInternalFailure(null), false);
  });
});

describe("preflightIndexEnvironment", () => {
  let server: Server | null = null;
  const origGateway = process.env.GATEWAY_URL;

  after(() => {
    server?.close();
    if (origGateway === undefined) delete process.env.GATEWAY_URL;
    else process.env.GATEWAY_URL = origGateway;
  });

  function serve(body: unknown): Promise<number> {
    return new Promise((resolve) => {
      server?.close();
      server = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      });
      server.listen(0, "127.0.0.1", () => {
        resolve((server!.address() as { port: number }).port);
      });
    });
  }

  test("healthy gateway + healthy falkordb → null", async () => {
    const port = await serve({ ok: true, falkordb: { ok: true } });
    process.env.GATEWAY_URL = `http://127.0.0.1:${port}`;
    assert.equal(await preflightIndexEnvironment(), null);
  });

  test("gateway up, falkordb dead → db_down with the probe's error", async () => {
    const port = await serve({ ok: true, falkordb: { ok: false, error: "FalkorDB connect did not answer within 2500ms" } });
    process.env.GATEWAY_URL = `http://127.0.0.1:${port}`;
    const f = await preflightIndexEnvironment();
    assert.equal(f?.code, "db_down");
    assert.match(f?.detail ?? "", /2500ms/);
  });

  test("older gateway without the falkordb field → null (never blocks)", async () => {
    const port = await serve({ ok: true, verbs: [] });
    process.env.GATEWAY_URL = `http://127.0.0.1:${port}`;
    assert.equal(await preflightIndexEnvironment(), null);
  });

  test("gateway unreachable → gateway_down", async () => {
    server?.close();
    server = null;
    process.env.GATEWAY_URL = "http://127.0.0.1:1"; // nothing listens on port 1
    const f = await preflightIndexEnvironment();
    assert.equal(f?.code, "gateway_down");
    assert.match(f?.hint ?? "", /flow up/);
  });
});
