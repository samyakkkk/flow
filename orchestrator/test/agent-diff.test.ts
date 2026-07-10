// agent-diff.test.ts — SESSION- and BASE-scope session diffs, and the
// agent_sessions migration hazard.
//
// Offline + hermetic: temp git repos created with `git init`, session rows
// inserted straight into the (in-memory) DB — no agent adapters spawned. The
// diffs are the real sessionDiff() output; the start snapshot is computed the
// same way createSession() does (git stash create, or HEAD when clean).

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";

// Env BEFORE importing anything that touches the DB.
process.env.DB_PATH = ":memory:";
process.env.FLOW_ADMIN_TOKEN = "test-admin-token-agentdiff";
process.env.FLOW_FAKE_OPENCODE = "1";
process.env.FLOW_DRAIN_DISABLE = "1";
process.env.FLOW_POLL_DISABLE = "1";

let TMP: string;
let db: import("better-sqlite3").Database;
let sessionDiff: typeof import("../src/agents/runtime.js").sessionDiff;
let migrate: typeof import("../src/migrations.js").migrate;
let LATEST_VERSION: number;

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

function gitInit(dir: string): void {
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@t.co"]);
  git(dir, ["config", "user.name", "t"]);
}

function write(dir: string, name: string, content: string): void {
  writeFileSync(join(dir, name), content);
}

function commit(dir: string, name: string, content: string, msg: string): void {
  write(dir, name, content);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", msg]);
}

// Mirror runtime.captureStartState(): stash-create commit, or HEAD when clean,
// plus the pre-existing untracked list.
function snapshot(dir: string): { sha: string | null; untracked: string[] } {
  let sha = git(dir, ["stash", "create"]).trim();
  if (!sha) sha = git(dir, ["rev-parse", "HEAD"]).trim();
  const untracked = git(dir, ["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
  return { sha: sha || null, untracked };
}

let counter = 0;
function makeSession(repo: string, cwd: string, snap: { sha: string | null; untracked: string[] }): string {
  const id = `sess-${++counter}`;
  db.prepare(
    `INSERT INTO agent_sessions (id, backend, repo, cwd, title, status, start_sha, start_untracked, created_at, updated_at)
     VALUES (?, 'opencode', ?, ?, 't', 'idle', ?, ?, ?, ?)`
  ).run(id, repo, cwd, snap.sha, JSON.stringify(snap.untracked), Date.now(), Date.now());
  return id;
}

// Point the repo registry at a temp repos.json so BASE scope can resolve a
// base branch. listRepoOptions() reads REPOS_JSON_PATH at call time.
function setRegistry(entries: Array<{ name: string; localPath: string; branch?: string }>): void {
  const p = join(TMP, `repos-${++counter}.json`);
  writeFileSync(p, JSON.stringify({ repos: entries }));
  process.env.REPOS_JSON_PATH = p;
}

before(async () => {
  TMP = mkdtempSync(join(tmpdir(), "flow-agentdiff-"));
  const rt = await import("../src/agents/runtime.js");
  sessionDiff = rt.sessionDiff;
  const dbMod = await import("../src/db.js");
  db = dbMod.default;
  const mig = await import("../src/migrations.js");
  migrate = mig.migrate;
  LATEST_VERSION = mig.LATEST_VERSION;
});

after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("sessionDiff — SESSION scope", () => {
  test("dirty checkout: pre-existing edits + untracked excluded", async () => {
    const dir = mkdtempSync(join(TMP, "repo-"));
    gitInit(dir);
    commit(dir, "a.txt", "one\n", "init");
    // Pre-existing uncommitted work, present BEFORE the session starts:
    write(dir, "a.txt", "one-edited-by-user\n"); // tracked edit
    write(dir, "preexisting.txt", "user scratch\n"); // untracked
    const snap = snapshot(dir);
    // The agent does its own thing — adds a new file, never touches a.txt.
    write(dir, "agent-new.txt", "agent work\n");
    const id = makeSession("r", dir, snap);

    const r = await sessionDiff(id, "session");
    assert.ok(!("error" in r));
    if ("error" in r) return;
    const paths = r.files.map((f) => f.path).sort();
    assert.deepEqual(paths, ["agent-new.txt"]);
    assert.ok(!r.diff.includes("preexisting.txt"), "pre-existing untracked file excluded");
    assert.ok(!r.diff.includes("one-edited-by-user"), "pre-existing edit not attributed to agent");
    assert.equal(r.scope, "session");
    assert.equal(r.base, null);
  });

  test("agent commits: committed work still shows in session scope", async () => {
    const dir = mkdtempSync(join(TMP, "repo-"));
    gitInit(dir);
    commit(dir, "a.txt", "one\n", "init");
    const snap = snapshot(dir); // clean → HEAD
    // Agent edits AND commits — diff-vs-HEAD would now show nothing.
    commit(dir, "a.txt", "one-agent\n", "agent commit");

    const id = makeSession("r", dir, snap);
    const r = await sessionDiff(id, "session");
    assert.ok(!("error" in r));
    if ("error" in r) return;
    assert.deepEqual(r.files.map((f) => f.path), ["a.txt"]);
    assert.ok(r.diff.includes("one-agent"), "committed change survives in session scope");
  });

  test("missing start_sha (gc-pruned): falls back to diff vs HEAD", async () => {
    const dir = mkdtempSync(join(TMP, "repo-"));
    gitInit(dir);
    commit(dir, "a.txt", "one\n", "init");
    // Bogus snapshot sha — as if git gc pruned the dangling stash commit.
    const id = makeSession("r", dir, { sha: "0".repeat(40), untracked: [] });
    // Uncommitted agent edit that diff-vs-HEAD will catch.
    write(dir, "a.txt", "one-agent\n");

    const r = await sessionDiff(id, "session");
    assert.ok(!("error" in r));
    if ("error" in r) return;
    assert.deepEqual(r.files.map((f) => f.path), ["a.txt"]);
    assert.ok(r.diff.includes("one-agent"));
    assert.equal(r.scope, "session");
  });
});

describe("sessionDiff — BASE scope", () => {
  test("diverged base: shows branch's additions, not upstream drift", async () => {
    const dir = mkdtempSync(join(TMP, "repo-"));
    gitInit(dir);
    commit(dir, "base.txt", "base\n", "fork point");
    // Branch off, add feature work.
    git(dir, ["checkout", "-q", "-b", "feature"]);
    commit(dir, "feature.txt", "feature\n", "feature commit");
    // Meanwhile main diverges with an unrelated commit (upstream drift).
    git(dir, ["checkout", "-q", "main"]);
    commit(dir, "main-later.txt", "later\n", "main advances");
    git(dir, ["checkout", "-q", "feature"]);
    // An uncommitted feature edit too.
    write(dir, "feature.txt", "feature-wip\n");

    setRegistry([{ name: "r", localPath: dir, branch: "main" }]);
    const id = makeSession("r", dir, snapshot(dir));

    const r = await sessionDiff(id, "base");
    assert.ok(!("error" in r));
    if ("error" in r) return;
    assert.equal(r.scope, "base");
    assert.equal(r.base, "main");
    const paths = r.files.map((f) => f.path).sort();
    assert.ok(paths.includes("feature.txt"), "branch's own file shown");
    assert.ok(!paths.includes("main-later.txt"), "upstream drift NOT shown");
    assert.ok(r.diff.includes("feature-wip"), "uncommitted branch work included");
  });

  test("unresolvable base: degrades to session scope", async () => {
    const dir = mkdtempSync(join(TMP, "repo-"));
    gitInit(dir);
    commit(dir, "a.txt", "one\n", "init");
    const snap = snapshot(dir);
    write(dir, "a.txt", "one-agent\n");
    // Registry has no branch for this repo → base can't resolve.
    setRegistry([{ name: "r", localPath: dir }]);
    const id = makeSession("r", dir, snap);

    const r = await sessionDiff(id, "base");
    assert.ok(!("error" in r));
    if ("error" in r) return;
    assert.equal(r.scope, "session", "degraded to session");
    assert.equal(r.base, null);
    assert.ok(r.diff.includes("one-agent"));
  });
});

describe("migration 7 — agent_sessions snapshot columns", () => {
  const OLD_SHAPE = `
    CREATE TABLE agent_sessions (
      id TEXT PRIMARY KEY, backend TEXT NOT NULL, repo TEXT NOT NULL,
      cwd TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
      acp_session_id TEXT, stop_reason TEXT, error TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`;

  function cols(d: import("better-sqlite3").Database): Set<string> {
    return new Set((d.prepare("PRAGMA table_info(agent_sessions)").all() as Array<{ name: string }>).map((r) => r.name));
  }

  test("existing DB with OLD agent_sessions shape gains the columns", () => {
    const d = new BetterSqlite3(":memory:");
    d.exec(OLD_SHAPE);
    d.pragma("user_version = 6");
    migrate(d, { fresh: false });
    const c = cols(d);
    assert.ok(c.has("start_sha") && c.has("start_untracked") && c.has("worktree_id"));
    assert.equal(d.pragma("user_version", { simple: true }), LATEST_VERSION);
    d.close();
  });

  test("DB predating agent_sessions: migration creates the table with columns", () => {
    // The hazard: agent_sessions is created by runtime.ts, not db.ts's
    // baseline, so an older DB may not have it when migration 7 runs.
    const d = new BetterSqlite3(":memory:");
    d.pragma("user_version = 6");
    assert.doesNotThrow(() => migrate(d, { fresh: false }));
    const c = cols(d);
    assert.ok(c.has("start_sha") && c.has("start_untracked") && c.has("worktree_id"));
    d.close();
  });

  test("fresh DB is stamped to latest, migrations skipped", () => {
    const d = new BetterSqlite3(":memory:");
    migrate(d, { fresh: true });
    assert.equal(d.pragma("user_version", { simple: true }), LATEST_VERSION);
    // Fresh path runs no migration bodies, so no agent_sessions here — the
    // runtime.ts baseline is what creates it current on a fresh DB.
    d.close();
  });
});
