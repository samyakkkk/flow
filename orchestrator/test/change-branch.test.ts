// change-branch.test.ts — a single-branch managed clone must survive the
// registered branch changing (main → dev): refreshRepoCheckout adds the new
// branch to the fetch refspec before fetching, so the reset to
// origin/<new-branch> resolves. Without the set-branches fix the fetch never
// creates the remote-tracking ref and every reindex after a branch change
// fails until the clone dir is deleted by hand.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

// Setup: workspace + in-memory DB before any imports that touch db
const workspace = mkdtempSync(join(tmpdir(), "flow-change-branch-"));
process.env.OPENCODE_WORKSPACE_DIR = workspace;
process.env.DB_PATH = ":memory:";
process.env.FLOW_ADMIN_TOKEN = "test-token-change-branch";
process.env.FLOW_FAKE_OPENCODE = "1";
process.env.FLOW_DRAIN_DISABLE = "1";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

function sh(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
}

describe("change_branch survives single-branch clones", () => {
  let origin: string;
  let refreshRepoCheckout: (name: string, branch: string) => Promise<void>;

  before(async () => {
    ({ refreshRepoCheckout } = await import("../src/opencode.js"));

    // Origin with two branches: main and dev (dev one commit ahead).
    origin = join(workspace, "origin.git");
    const seed = join(workspace, "seed");
    execSync(`git init -q -b main ${seed}`, { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
    sh(`git config user.email t@t && git config user.name t`, seed);
    writeFileSync(join(seed, "a.txt"), "one\n");
    sh(`git add . && git commit -qm one`, seed);
    sh(`git checkout -qb dev`, seed);
    writeFileSync(join(seed, "b.txt"), "two\n");
    sh(`git add . && git commit -qm two`, seed);
    sh(`git checkout -q main`, seed);
    execSync(`git clone -q --bare ${seed} ${origin}`, { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });

    // Managed clone the way ensureRepoClone makes it: single-branch on main.
    execSync(`git clone -q --single-branch --branch main ${origin} ${join(workspace, "repos", "sb-repo")}`, {
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
    });
  });

  after(() => rmSync(workspace, { recursive: true, force: true }));

  test("refresh onto a branch outside the original refspec succeeds", async () => {
    const clone = join(workspace, "repos", "sb-repo");
    // Sanity: the clone is genuinely single-branch — origin/dev is unknown.
    assert.throws(() => sh(`git rev-parse origin/dev`, clone));

    await refreshRepoCheckout("sb-repo", "dev");

    // The checkout now sits on origin/dev's tip (the "two" commit).
    assert.equal(sh(`git log -1 --format=%s`, clone), "two");
  });
});
