// repo-status.test.ts — /v1/repos/status must tell the truth about failures.
// The old machine only surfaced lastError when a repo had NEVER indexed: a
// repo that indexed once and then failed nightly (signed-out Claude) showed
// "indexed" forever. Now the latest REAL terminal outcome wins, and internal
// lifecycle rows (superseded, repo_removed, stalled) never masquerade as
// user-facing failures.

// Setup: in-memory DB + temp workspace before any imports that touch them.
process.env.DB_PATH = ":memory:";
process.env.FLOW_ADMIN_TOKEN = "test-token-status";
process.env.FLOW_FAKE_OPENCODE = "1";
process.env.FLOW_DRAIN_DISABLE = "1";

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workspace = mkdtempSync(join(tmpdir(), "flow-repo-status-"));
mkdirSync(join(workspace, "repos"), { recursive: true });
process.env.OPENCODE_WORKSPACE_DIR = workspace;

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import type { RepoStatus } from "../src/opencode.js";

let repoStatuses: () => RepoStatus[];
let insertJobRow: (row: {
  id: string;
  repo: string;
  status: "done" | "failed";
  result: Record<string, unknown>;
  updatedAt: number;
}) => void;

before(async () => {
  const opencode = await import("../src/opencode.js");
  repoStatuses = opencode.repoStatuses;
  const db = (await import("../src/db.js")).default;
  const stmt = db.prepare(
    `INSERT INTO jobs (id, type, input, status, repo, result_json, updated_at)
     VALUES (@id, 'index_repo', '{}', @status, @repo, @result_json, @updated_at)`,
  );
  insertJobRow = ({ id, repo, status, result, updatedAt }) =>
    stmt.run({ id, repo, status, result_json: JSON.stringify(result), updated_at: updatedAt });
});

function writeRegistry(repos: Record<string, unknown>[]): void {
  writeFileSync(join(workspace, "repos.json"), JSON.stringify({ repos }, null, 2));
}

describe("repoStatuses failure surfacing", () => {
  test("previously-indexed repo with a newer real failure → failed, classified fields exposed", () => {
    writeRegistry([
      { name: "r-fail", url: "x", branch: "main", lastIndexedCommit: "abc", lastIndexedAt: "2026-08-01T00:00:00Z" },
    ]);
    insertJobRow({ id: "j1", repo: "r-fail", status: "done", result: { status: "ok" }, updatedAt: 1000 });
    insertJobRow({
      id: "j2",
      repo: "r-fail",
      status: "failed",
      result: {
        error: "Claude Code is signed out (its login expires from time to time), so indexing can't run.",
        code: "cli_auth",
        hint: "Open a terminal, run `claude`, and complete /login. Then hit Reindex.",
      },
      updatedAt: 2000,
    });

    const st = repoStatuses().find((r) => r.name === "r-fail")!;
    assert.equal(st.status, "failed");
    assert.match(st.lastError ?? "", /signed out/);
    assert.equal(st.lastErrorCode, "cli_auth");
    assert.match(st.lastErrorHint ?? "", /\/login/);
    assert.equal(st.lastFailedAt, 2000);
    // The last good index is still reported — the UI says both truths.
    assert.equal(st.lastIndexedAt, "2026-08-01T00:00:00Z");
  });

  test("internal lifecycle failures (superseded/stalled) never override indexed", () => {
    writeRegistry([
      { name: "r-noise", url: "x", branch: "main", lastIndexedCommit: "abc", lastIndexedAt: "2026-08-01T00:00:00Z" },
    ]);
    insertJobRow({ id: "n1", repo: "r-noise", status: "done", result: { status: "ok" }, updatedAt: 1000 });
    insertJobRow({ id: "n2", repo: "r-noise", status: "failed", result: { error: "superseded:xyz" }, updatedAt: 2000 });
    insertJobRow({ id: "n3", repo: "r-noise", status: "failed", result: { error: "stalled:process_restart" }, updatedAt: 3000 });

    const st = repoStatuses().find((r) => r.name === "r-noise")!;
    assert.equal(st.status, "indexed");
    assert.equal(st.lastError, null);
  });

  test("never-indexed repo with a real failure → failed (first-index death is visible)", () => {
    writeRegistry([{ name: "r-first", url: "x", branch: "main", lastIndexedCommit: null }]);
    insertJobRow({
      id: "f1",
      repo: "r-first",
      status: "failed",
      result: { error: "Coding CLI isn't installed on this machine, so Flow can't index.", code: "cli_not_installed" },
      updatedAt: 1000,
    });

    const st = repoStatuses().find((r) => r.name === "r-first")!;
    assert.equal(st.status, "failed");
    assert.equal(st.lastErrorCode, "cli_not_installed");
  });

  test("a success newer than old failures → indexed, no error shown", () => {
    writeRegistry([
      { name: "r-healed", url: "x", branch: "main", lastIndexedCommit: "def", lastIndexedAt: "2026-08-02T00:00:00Z" },
    ]);
    insertJobRow({ id: "h1", repo: "r-healed", status: "failed", result: { error: "old pain", code: "unknown" }, updatedAt: 1000 });
    insertJobRow({ id: "h2", repo: "r-healed", status: "done", result: { status: "ok" }, updatedAt: 2000 });

    const st = repoStatuses().find((r) => r.name === "r-healed")!;
    assert.equal(st.status, "indexed");
    assert.equal(st.lastError, null);
  });

  test("legacy failed rows without classification still show their raw error", () => {
    writeRegistry([{ name: "r-legacy", url: "x", branch: "main", lastIndexedCommit: null }]);
    insertJobRow({ id: "l1", repo: "r-legacy", status: "failed", result: { error: "Error: opencode exited 1" }, updatedAt: 1000 });

    const st = repoStatuses().find((r) => r.name === "r-legacy")!;
    assert.equal(st.status, "failed");
    assert.equal(st.lastError, "Error: opencode exited 1");
    assert.equal(st.lastErrorCode, null);
  });
});
