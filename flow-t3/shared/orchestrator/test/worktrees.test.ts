// worktrees.test.ts — the "separate copy" flow: worktree creation off a base,
// the gitignored-file overlay pass (.env COPIED not symlinked; node_modules
// CoW clone), unique-slug collision, base-ref fallback, porcelain parsing, and
// the pure cwd-collision predicate.
//
// Offline + hermetic: real temp git repos created with `git init` (no remotes),
// no agent adapters spawned. REPOS_JSON_PATH is pointed at a temp file so the
// worktree destination (dirname(REPOS_JSON_PATH)/worktrees/...) is inside TMP.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, lstatSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Env BEFORE importing anything that touches the DB (runtime.ts loads db.js).
process.env.DB_PATH = ":memory:";
process.env.FLOW_ADMIN_TOKEN = "test-admin-token-worktrees";
process.env.FLOW_FAKE_OPENCODE = "1";
process.env.FLOW_DRAIN_DISABLE = "1";
process.env.FLOW_POLL_DISABLE = "1";

let TMP: string;
let createSessionWorktree: typeof import("../src/agents/worktrees.js").createSessionWorktree;
let listWorktrees: typeof import("../src/agents/worktrees.js").listWorktrees;
let inspectWorktree: typeof import("../src/agents/worktrees.js").inspectWorktree;
let removeWorktree: typeof import("../src/agents/worktrees.js").removeWorktree;
let applyWorktree: typeof import("../src/agents/worktrees.js").applyWorktree;
let openPullRequestWorktree: typeof import("../src/agents/worktrees.js").openPullRequestWorktree;
let isManagedWorktree: typeof import("../src/agents/worktrees.js").isManagedWorktree;
let managedRepoOf: typeof import("../src/agents/worktrees.js").managedRepoOf;
let collidingSession: typeof import("../src/agents/runtime.js").collidingSession;

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

function gitInit(dir: string): void {
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@t.co"]);
  git(dir, ["config", "user.name", "t"]);
}

function commit(dir: string, name: string, content: string, msg: string): void {
  writeFileSync(join(dir, name), content);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", msg]);
}

// A fresh source checkout with one commit on `main`.
let counter = 0;
function makeCheckout(): string {
  const dir = mkdtempSync(join(TMP, `src-${++counter}-`));
  gitInit(dir);
  commit(dir, "README.md", "hello\n", "init");
  return dir;
}

function makeCheckoutWithOrigin(): { src: string; remote: string } {
  const src = makeCheckout();
  const remote = join(TMP, `remote-${++counter}.git`);
  execFileSync("git", ["init", "--bare", "-q", remote]);
  git(src, ["remote", "add", "origin", remote]);
  git(src, ["push", "-u", "origin", "main"]);
  return { src, remote };
}

// Point REPOS_JSON_PATH at a temp file so worktrees land under
// dirname(REPOS_JSON_PATH)/worktrees/<repo>/<slug> — i.e. inside TMP.
function setWorkspace(): void {
  const p = join(TMP, `repos-${++counter}.json`);
  writeFileSync(p, JSON.stringify({ repos: [] }));
  process.env.REPOS_JSON_PATH = p;
}

before(async () => {
  TMP = mkdtempSync(join(tmpdir(), "flow-worktrees-"));
  setWorkspace();
  const wt = await import("../src/agents/worktrees.js");
  createSessionWorktree = wt.createSessionWorktree;
  listWorktrees = wt.listWorktrees;
  inspectWorktree = wt.inspectWorktree;
  removeWorktree = wt.removeWorktree;
  applyWorktree = wt.applyWorktree;
  openPullRequestWorktree = wt.openPullRequestWorktree;
  isManagedWorktree = wt.isManagedWorktree;
  managedRepoOf = wt.managedRepoOf;
  const rt = await import("../src/agents/runtime.js");
  collidingSession = rt.collidingSession;
});

after(() => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("createSessionWorktree — creation + branch naming", () => {
  test("creates a worktree off base with a flow/<slug> branch", async () => {
    const src = makeCheckout();
    const r = await createSessionWorktree({
      repoName: "myrepo",
      srcCheckout: src,
      baseBranch: "main",
      title: "Fix the login redirect bug now",
    });
    assert.ok(!("error" in r), "error" in r ? r.error : "");
    if ("error" in r) return;
    // Branch: flow/ + kebab of first ~4 title words + a random suffix.
    assert.match(r.branch, /^flow\/fix-the-login-redirect-[a-z0-9]+$/);
    // The worktree dir exists and is a real checkout (has the committed file).
    assert.ok(existsSync(r.path), "worktree path exists");
    assert.ok(existsSync(join(r.path, "README.md")), "base content checked out");
    // The branch exists in the source checkout and the worktree is on it.
    assert.ok(git(src, ["branch", "--list", r.branch]).includes(r.branch));
    assert.equal(git(r.path, ["branch", "--show-current"]).trim(), r.branch);
  });
});

describe("createSessionWorktree — .env overlay (COPY not symlink)", () => {
  test(".env and .env.local are copied as independent snapshots", async () => {
    const src = makeCheckout();
    writeFileSync(join(src, ".env"), "SECRET=original\n");
    writeFileSync(join(src, ".env.local"), "LOCAL=original\n");

    const r = await createSessionWorktree({
      repoName: "envrepo",
      srcCheckout: src,
      baseBranch: "main",
      title: "env overlay test",
    });
    assert.ok(!("error" in r));
    if ("error" in r) return;

    for (const name of [".env", ".env.local"]) {
      const copyPath = join(r.path, name);
      assert.ok(existsSync(copyPath), `${name} copied into worktree`);
      // NOT a symlink — a real file.
      assert.ok(!lstatSync(copyPath).isSymbolicLink(), `${name} is not a symlink`);
      // Content matches the source.
      assert.equal(readFileSync(copyPath, "utf8"), readFileSync(join(src, name), "utf8"));
    }

    // Editing the copy does NOT change the user's golden file (blast radius stays
    // inside the worktree — the whole reason we copy instead of symlink).
    writeFileSync(join(r.path, ".env"), "SECRET=agent-edited\n");
    assert.equal(readFileSync(join(src, ".env"), "utf8"), "SECRET=original\n", "original .env untouched");
  });
});

describe("createSessionWorktree — node_modules overlay (CoW clone)", () => {
  test("node_modules cloned when package.json present; independent of original", async () => {
    const src = makeCheckout();
    writeFileSync(join(src, "package.json"), JSON.stringify({ name: "x" }));
    mkdirSync(join(src, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(src, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");

    const r = await createSessionWorktree({
      repoName: "noderepo",
      srcCheckout: src,
      baseBranch: "main",
      title: "node modules overlay",
    });
    assert.ok(!("error" in r));
    if ("error" in r) return;

    const clonedFile = join(r.path, "node_modules", "left-pad", "index.js");
    assert.ok(existsSync(clonedFile), "a file inside node_modules arrived in the worktree");
    assert.equal(readFileSync(clonedFile, "utf8"), "module.exports = 1;\n");

    // Editing the clone must not mutate the original tree (CoW = independent).
    writeFileSync(clonedFile, "module.exports = 2;\n");
    assert.equal(
      readFileSync(join(src, "node_modules", "left-pad", "index.js"), "utf8"),
      "module.exports = 1;\n",
      "original node_modules untouched"
    );
  });

  test("no package.json → node_modules NOT copied", async () => {
    const src = makeCheckout();
    mkdirSync(join(src, "node_modules"), { recursive: true });
    writeFileSync(join(src, "node_modules", "stray.js"), "x\n");

    const r = await createSessionWorktree({
      repoName: "nopkg",
      srcCheckout: src,
      baseBranch: "main",
      title: "no package json",
    });
    assert.ok(!("error" in r));
    if ("error" in r) return;
    assert.ok(!existsSync(join(r.path, "node_modules")), "node_modules skipped without package.json");
  });
});

describe("createSessionWorktree — unique slug on collision", () => {
  test("two worktrees from the same title get distinct branches and paths", async () => {
    const src = makeCheckout();
    const a = await createSessionWorktree({ repoName: "dup", srcCheckout: src, baseBranch: "main", title: "same title here" });
    const b = await createSessionWorktree({ repoName: "dup", srcCheckout: src, baseBranch: "main", title: "same title here" });
    assert.ok(!("error" in a) && !("error" in b));
    if ("error" in a || "error" in b) return;
    assert.notEqual(a.branch, b.branch, "distinct branch names");
    assert.notEqual(a.path, b.path, "distinct worktree paths");
    // Both share the same human-readable prefix, differ only in suffix.
    assert.match(a.branch, /^flow\/same-title-here-/);
    assert.match(b.branch, /^flow\/same-title-here-/);
  });
});

describe("createSessionWorktree — base ref fallback", () => {
  test("origin/<base> missing → falls back to local base branch", async () => {
    // No remote at all, so origin/main can't resolve; local main must be used.
    const src = makeCheckout();
    const mainSha = git(src, ["rev-parse", "main"]).trim();
    const r = await createSessionWorktree({
      repoName: "fallback",
      srcCheckout: src,
      baseBranch: "main",
      title: "base fallback",
    });
    assert.ok(!("error" in r));
    if ("error" in r) return;
    // The worktree branched from local main's commit (README present, HEAD's
    // parent chain contains main's tip).
    assert.ok(existsSync(join(r.path, "README.md")));
    assert.equal(git(r.path, ["rev-parse", "HEAD"]).trim(), mainSha, "branched off local main");
  });

  test("unknown base branch → falls back to HEAD, still creates", async () => {
    const src = makeCheckout();
    const r = await createSessionWorktree({
      repoName: "headfb",
      srcCheckout: src,
      baseBranch: "does-not-exist",
      title: "head fallback",
    });
    assert.ok(!("error" in r), "error" in r ? r.error : "");
    if ("error" in r) return;
    assert.ok(existsSync(join(r.path, "README.md")), "branched off HEAD");
  });
});

describe("listWorktrees — porcelain parsing", () => {
  test("lists the main checkout plus created worktrees", async () => {
    const src = makeCheckout();
    const r = await createSessionWorktree({ repoName: "listrepo", srcCheckout: src, baseBranch: "main", title: "list me" });
    assert.ok(!("error" in r));
    if ("error" in r) return;

    const trees = await listWorktrees(src);
    // At least the source checkout + the new worktree. git reports realpaths
    // (macOS /var → /private/var), so compare via realpathSync.
    assert.ok(trees.length >= 2, `expected >=2 worktrees, got ${trees.length}`);
    const paths = trees.map((t) => realpathSync(t.path));
    assert.ok(paths.includes(realpathSync(src)), "source checkout listed");
    assert.ok(paths.includes(realpathSync(r.path)), "new worktree listed");
    const created = trees.find((t) => realpathSync(t.path) === realpathSync(r.path));
    assert.equal(created?.branch, r.branch, "branch name parsed (refs/heads/ stripped)");
    assert.ok(created?.head, "HEAD sha parsed");
  });

  test("non-git dir → empty list, no throw", async () => {
    const notgit = mkdtempSync(join(TMP, "notgit-"));
    const trees = await listWorktrees(notgit);
    assert.deepEqual(trees, []);
  });
});

describe("collidingSession — pure cwd-collision predicate", () => {
  const fake = (id: string, cwd: string, status: string) => ({ id, cwd, status }) as {
    id: string;
    cwd: string;
    status: import("../src/agents/runtime.js").SessionStatus;
  };

  test("active session in the same cwd collides", () => {
    const list = [fake("a", "/repo/x", "running"), fake("b", "/repo/y", "idle")];
    const hit = collidingSession(list, "/repo/x");
    assert.equal(hit?.id, "a");
  });

  test("all of starting/running/waiting/idle count as active", () => {
    for (const status of ["starting", "running", "waiting", "idle"] as const) {
      const hit = collidingSession([fake("s", "/repo/x", status)], "/repo/x");
      assert.equal(hit?.id, "s", `${status} should collide`);
    }
  });

  test("closed/error sessions never collide", () => {
    for (const status of ["closed", "error"] as const) {
      const hit = collidingSession([fake("s", "/repo/x", status)], "/repo/x");
      assert.equal(hit, undefined, `${status} must not collide`);
    }
  });

  test("different cwd does not collide", () => {
    const hit = collidingSession([fake("a", "/repo/x", "running")], "/repo/other");
    assert.equal(hit, undefined);
  });
});

// ===========================================================================
// Phase C — visibility + exits. The pure git functions are tested directly
// (route handlers stay thin), against real temp git repos.
// ===========================================================================

// Create a worktree off a fresh checkout and return the pieces the exits need.
async function makeTree(title = "phase c work"): Promise<{ src: string; path: string; branch: string }> {
  const src = makeCheckout();
  const r = await createSessionWorktree({ repoName: "pc", srcCheckout: src, baseBranch: "main", title });
  if ("error" in r) throw new Error(String(r.error));
  return { src, path: r.path, branch: r.branch };
}

describe("inspectWorktree — aheadCount / dirty / merged", () => {
  test("fresh copy: 0 ahead, clean, merged (HEAD == base)", async () => {
    const { path } = await makeTree();
    const info = await inspectWorktree({ treePath: path, baseBranch: "main" });
    assert.equal(info.health, "ok");
    assert.equal(info.aheadCount, 0, "nothing added yet");
    assert.equal(info.dirty, false, "clean tree");
    assert.equal(info.merged, true, "HEAD is an ancestor of base");
    assert.equal(info.base, "main");
  });

  test("a commit makes it 1 ahead and not merged", async () => {
    const { path } = await makeTree();
    commit(path, "feature.txt", "new work\n", "add feature");
    const info = await inspectWorktree({ treePath: path, baseBranch: "main" });
    assert.equal(info.aheadCount, 1);
    assert.equal(info.merged, false, "the commit isn't in base yet");
  });

  test("an uncommitted edit sets dirty", async () => {
    const { path } = await makeTree();
    writeFileSync(join(path, "scratch.txt"), "wip\n");
    const info = await inspectWorktree({ treePath: path, baseBranch: "main" });
    assert.equal(info.dirty, true);
  });

  test("missing folder → broken", async () => {
    const { src, path } = await makeTree();
    // Delete the tree folder out from under git (simulates a manual rm).
    rmSync(path, { recursive: true, force: true });
    const info = await inspectWorktree({ treePath: path, baseBranch: "main" });
    assert.equal(info.health, "broken");
    void src;
  });
});

describe("managed-dir filter — primary checkout is not a copy", () => {
  test("isManagedWorktree true for the copy, false for the primary checkout", async () => {
    const { src, path } = await makeTree();
    assert.equal(isManagedWorktree(path), true, "the copy is under the managed root");
    assert.equal(isManagedWorktree(src), false, "the user's own checkout is NOT managed");
  });

  test("managedRepoOf returns the owning repo name", async () => {
    const src = makeCheckout();
    const r = await createSessionWorktree({ repoName: "acme", srcCheckout: src, baseBranch: "main", title: "x" });
    assert.ok(!("error" in r));
    if ("error" in r) return;
    assert.equal(managedRepoOf(r.path), "acme");
    assert.equal(managedRepoOf(src), null, "primary checkout has no managed repo");
  });
});

describe("removeWorktree — guards", () => {
  test("refuses a non-managed path", async () => {
    const { src } = await makeTree();
    const r = await removeWorktree({ srcCheckout: src, treePath: src });
    assert.ok("error" in r, "non-managed path refused");
  });

  test("refuses a dirty copy without force, then removes with force", async () => {
    const { src, path, branch } = await makeTree();
    writeFileSync(join(path, "scratch.txt"), "wip\n");
    const refused = await removeWorktree({ srcCheckout: src, treePath: path, branch });
    assert.ok("error" in refused, "dirty copy refused without force");

    const forced = await removeWorktree({ srcCheckout: src, treePath: path, branch, force: true });
    assert.ok(!("error" in forced), "error" in forced ? forced.error : "");
    assert.ok(!existsSync(path), "worktree folder removed");
    assert.ok(!git(src, ["branch", "--list", branch]).includes(branch), "flow/ branch deleted");
  });

  test("removes a clean copy and deletes its branch", async () => {
    const { src, path, branch } = await makeTree();
    const r = await removeWorktree({ srcCheckout: src, treePath: path, branch });
    assert.ok(!("error" in r), "error" in r ? r.error : "");
    assert.ok(!existsSync(path), "folder gone");
    assert.ok(!git(src, ["branch", "--list", branch]).includes(branch), "branch gone");
  });

  test("missing folder → prunes and succeeds", async () => {
    const { src, path, branch } = await makeTree();
    rmSync(path, { recursive: true, force: true });
    const r = await removeWorktree({ srcCheckout: src, treePath: path, branch });
    assert.ok(!("error" in r), "error" in r ? r.error : "");
    // Metadata pruned: git no longer lists the dead tree.
    const paths = (await listWorktrees(src)).map((t) => realpathSync(t.path));
    assert.ok(!paths.some((p) => p === realpathSync(src) ? false : p.includes("pc")), "dead tree pruned");
  });
});

describe("applyWorktree — merge back into the user's folder", () => {
  test("happy path: the copy's commit lands in the src checkout", async () => {
    const { src, path, branch } = await makeTree();
    commit(path, "feature.txt", "shipped\n", "add feature from copy");

    const r = await applyWorktree({ srcCheckout: src, treePath: path, branch });
    assert.ok(!("error" in r), "error" in r ? r.error : "");
    if ("error" in r) return;
    assert.equal(r.mergedInto, "main");
    // The src checkout now carries the copy's file and commit.
    assert.ok(existsSync(join(src, "feature.txt")), "file merged into src");
    assert.ok(git(src, ["log", "--oneline"]).includes("add feature from copy"), "commit in src history");

    // And inspect now reports the copy as merged (HEAD ⊆ base).
    const info = await inspectWorktree({ treePath: path, baseBranch: "main" });
    assert.equal(info.merged, true, "copy detected as merged after apply");
  });

  test("refuses a dirty copy", async () => {
    const { src, path, branch } = await makeTree();
    writeFileSync(join(path, "scratch.txt"), "uncommitted\n");
    const r = await applyWorktree({ srcCheckout: src, treePath: path, branch });
    assert.ok("error" in r && /commit or discard/i.test(r.error), JSON.stringify(r));
  });

  test("refuses a dirty src checkout", async () => {
    const { src, path, branch } = await makeTree();
    commit(path, "feature.txt", "shipped\n", "add feature");
    writeFileSync(join(src, "README.md"), "locally edited\n"); // dirty the user's folder
    const r = await applyWorktree({ srcCheckout: src, treePath: path, branch });
    assert.ok("error" in r && /uncommitted changes/i.test(r.error), JSON.stringify(r));
  });

  test("conflict → merge aborted, src left clean", async () => {
    const { src, path, branch } = await makeTree();
    // Both sides change the SAME line of README → an unmergeable conflict.
    commit(path, "README.md", "changed-by-copy\n", "copy edits README");
    commit(src, "README.md", "changed-by-user\n", "user edits README");

    const r = await applyWorktree({ srcCheckout: src, treePath: path, branch });
    assert.ok("error" in r && /doesn't merge cleanly/i.test(r.error), JSON.stringify(r));
    // The user's folder is exactly as we found it: clean, on their own version.
    assert.equal(git(src, ["status", "--porcelain"]).trim(), "", "src clean after abort");
    assert.equal(readFileSync(join(src, "README.md"), "utf8"), "changed-by-user\n", "src content preserved");
  });
});

describe("openPullRequestWorktree — PR-first handoff", () => {
  test("dirty copy is committed and pushed to the exact origin branch", async () => {
    const { src, remote } = makeCheckoutWithOrigin();
    const r = await createSessionWorktree({ repoName: "prrepo", srcCheckout: src, baseBranch: "main", title: "open pr dirty copy" });
    assert.ok(!("error" in r), "error" in r ? r.error : "");
    if ("error" in r) return;

    writeFileSync(join(r.path, "feature.txt"), "ready for review\n");
    const pr = await openPullRequestWorktree({
      treePath: r.path,
      branch: r.branch,
      targetBranch: "main",
      owner: "acme",
      repo: "prrepo",
    });

    assert.ok(!("error" in pr) && !("conflict" in pr), JSON.stringify(pr));
    if ("error" in pr || "conflict" in pr) return;
    assert.equal(pr.committed, true);
    assert.match(pr.compareUrl, /github\.com\/acme\/prrepo\/compare\/main\.\.\.flow\/open-pr-dirty-copy-/);
    assert.equal(git(r.path, ["status", "--porcelain"]).trim(), "", "copy is clean after auto-commit");
    assert.ok(git(r.path, ["log", "--oneline", "-1"]).includes("Flow agent changes"), "auto-commit created");
    assert.ok(
      execFileSync("git", ["ls-remote", "--heads", remote, r.branch], { encoding: "utf8" }).includes(`refs/heads/${r.branch}`),
      "remote branch exists after push"
    );
  });

  test("merge conflicts are reported before opening a PR", async () => {
    const { src, remote } = makeCheckoutWithOrigin();
    const r = await createSessionWorktree({ repoName: "conflictrepo", srcCheckout: src, baseBranch: "main", title: "conflict pr" });
    assert.ok(!("error" in r), "error" in r ? r.error : "");
    if ("error" in r) return;

    writeFileSync(join(r.path, "README.md"), "changed-by-copy\n");
    commit(src, "README.md", "changed-by-main\n", "main edits readme");
    git(src, ["push", "origin", "main"]);

    const pr = await openPullRequestWorktree({
      treePath: r.path,
      branch: r.branch,
      targetBranch: "main",
      owner: "acme",
      repo: "conflictrepo",
    });

    assert.ok("conflict" in pr, JSON.stringify(pr));
    if (!("conflict" in pr)) return;
    assert.equal(pr.targetBranch, "main");
    assert.ok(pr.files.length === 0 || pr.files.includes("README.md"), `conflict files: ${pr.files.join(", ")}`);
    assert.equal(
      execFileSync("git", ["ls-remote", "--heads", remote, r.branch], { encoding: "utf8" }).trim(),
      "",
      "conflicting branch is not pushed before resolution"
    );
  });
});
