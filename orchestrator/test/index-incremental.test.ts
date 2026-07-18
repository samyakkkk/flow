// index-incremental.test.ts — full-pass vs incremental decision for
// push-triggered index runs. Incremental only when the last indexed commit
// is a real ancestor of HEAD on the same registered branch; anything
// surprising (first index, branch change, up-to-date) falls back to null =
// full pass.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

// Setup: workspace + in-memory DB before any imports that touch db
const workspace = mkdtempSync(join(tmpdir(), "flow-incremental-"));
process.env.OPENCODE_WORKSPACE_DIR = workspace;
process.env.DB_PATH = ":memory:";
process.env.FLOW_ADMIN_TOKEN = "test-token-incremental";
process.env.FLOW_FAKE_OPENCODE = "1";
process.env.FLOW_DRAIN_DISABLE = "1";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" };
function sh(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf8", env: gitEnv }).trim();
}

let incrementalContext: (repo: string, branch: string) => { from: string; to: string; stat: string } | null;
let c1 = "";
let c2 = "";

before(async () => {
  const repoDir = join(workspace, "repos", "inc-repo");
  execSync(`git init -q -b main ${repoDir}`, { env: gitEnv });
  sh(`git config user.email t@t && git config user.name t`, repoDir);
  writeFileSync(join(repoDir, "a.txt"), "one\n");
  sh(`git add . && git commit -qm one`, repoDir);
  c1 = sh(`git rev-parse HEAD`, repoDir);
  writeFileSync(join(repoDir, "b.txt"), "two\n");
  sh(`git add . && git commit -qm two`, repoDir);
  c2 = sh(`git rev-parse HEAD`, repoDir);

  writeFileSync(
    join(workspace, "repos.json"),
    JSON.stringify({ repos: [{ name: "inc-repo", url: "x", branch: "main", lastIndexedCommit: c1 }] }),
  );

  ({ incrementalContext } = await import("../src/opencode.js"));
});

after(() => rmSync(workspace, { recursive: true, force: true }));

describe("incremental index decision", () => {
  test("ancestor on the same branch → diff context", () => {
    const inc = incrementalContext("inc-repo", "main");
    assert.ok(inc);
    assert.equal(inc.from, c1);
    assert.equal(inc.to, c2);
    assert.match(inc.stat, /b\.txt/);
  });

  test("branch mismatch → full pass", () => {
    assert.equal(incrementalContext("inc-repo", "dev"), null);
  });

  test("unknown repo → full pass", () => {
    assert.equal(incrementalContext("nope", "main"), null);
  });

  test("already at HEAD → no incremental run", () => {
    const registry = { repos: [{ name: "inc-repo", url: "x", branch: "main", lastIndexedCommit: c2 }] };
    writeFileSync(join(workspace, "repos.json"), JSON.stringify(registry));
    assert.equal(incrementalContext("inc-repo", "main"), null);
  });

  test("non-ancestor last commit (rewritten history) → full pass", () => {
    const registry = { repos: [{ name: "inc-repo", url: "x", branch: "main", lastIndexedCommit: "0".repeat(40) }] };
    writeFileSync(join(workspace, "repos.json"), JSON.stringify(registry));
    assert.equal(incrementalContext("inc-repo", "main"), null);
  });
});
