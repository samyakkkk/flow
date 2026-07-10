// sources.test.ts — inspectSource classification.
//
// Offline + hermetic: git repos are created in temp dirs with `git init`, and
// the GitHub REST call is stubbed (no network). Covers every classification
// branch: github_url, git_repo, git_repo_local_only, folder, container,
// unsupported (.git file), and the prod-mode path refusal.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Env BEFORE importing anything that touches the DB.
process.env.DB_PATH = ":memory:";
process.env.FLOW_ADMIN_TOKEN = "test-admin-token-sources";
process.env.FLOW_FAKE_OPENCODE = "1";
process.env.FLOW_DRAIN_DISABLE = "1";
process.env.FLOW_POLL_DISABLE = "1";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let inspectSource: (input: string) => Promise<any>;
let TMP: string;
const realFetch = globalThis.fetch;

function gitInit(dir: string, remote?: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t.co"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  if (remote) execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir });
}

before(async () => {
  TMP = mkdtempSync(join(tmpdir(), "flow-sources-"));
  const mod = await import("../src/sources.js");
  inspectSource = mod.inspectSource;
});

after(() => {
  globalThis.fetch = realFetch;
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("inspectSource", () => {
  test("github_url — parses owner/name, stubbed default branch", async () => {
    // Stub the GitHub REST call so the test is offline + deterministic.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ default_branch: "trunk" }), { status: 200 })) as typeof fetch;
    try {
      const r = await inspectSource("https://github.com/acme/widgets.git");
      assert.equal(r.kind, "github_url");
      assert.equal(r.github.owner, "acme");
      assert.equal(r.github.name, "widgets");
      assert.equal(r.github.url, "https://github.com/acme/widgets");
      assert.equal(r.github.defaultBranch, "trunk");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("github_url — falls back to main when the API fails", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 404 })) as typeof fetch;
    try {
      const r = await inspectSource("github.com/acme/widgets");
      assert.equal(r.kind, "github_url");
      assert.equal(r.github.defaultBranch, "main");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("git_repo — GitHub remote", async () => {
    const dir = join(TMP, "gh-repo");
    gitInit(dir, "https://github.com/acme/tool.git");
    writeFileSync(join(dir, "README.md"), "hi"); // untracked → dirty
    const r = await inspectSource(dir);
    assert.equal(r.kind, "git_repo");
    assert.equal(r.repo.name, "gh-repo");
    assert.equal(r.repo.remoteUrl, "https://github.com/acme/tool");
    assert.equal(r.repo.dirty, true);
  });

  test("git_repo_local_only — no remote", async () => {
    const dir = join(TMP, "local-repo");
    gitInit(dir);
    const r = await inspectSource(dir);
    assert.equal(r.kind, "git_repo_local_only");
    assert.equal(r.repo.remoteUrl, null);
  });

  test("git_repo_local_only — non-GitHub remote keeps url for display", async () => {
    const dir = join(TMP, "gitlab-repo");
    gitInit(dir, "https://gitlab.com/acme/tool.git");
    const r = await inspectSource(dir);
    assert.equal(r.kind, "git_repo_local_only");
    assert.equal(r.repo.remoteUrl, "https://gitlab.com/acme/tool");
  });

  test("folder — junk-defended docs counts", async () => {
    const dir = join(TMP, "docs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "guide.md"), "# guide");
    writeFileSync(join(dir, "notes.txt"), "notes");
    writeFileSync(join(dir, "app.bin"), "binary"); // non-keep ext → binary skip
    writeFileSync(join(dir, ".secret"), "x");       // hidden skip
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "x.md"), "dep");
    const r = await inspectSource(dir);
    assert.equal(r.kind, "folder");
    assert.equal(r.docs.fileCount, 2);
    assert.ok(r.docs.skipped.binary >= 1, "binary skip counted");
    assert.ok(r.docs.skipped.hidden >= 1, "hidden skip counted");
    assert.ok(r.docs.skipped.deps >= 1, "node_modules dep skip counted");
  });

  test("container — nested repos + docs carve-out", async () => {
    const dir = join(TMP, "workspace");
    mkdirSync(dir, { recursive: true });
    gitInit(join(dir, "svc-a"), "https://github.com/acme/svc-a.git");
    writeFileSync(join(dir, "svc-a", "big.md"), "inside repo — must be carved out");
    writeFileSync(join(dir, "top.md"), "top-level doc");
    const r = await inspectSource(dir);
    assert.equal(r.kind, "container");
    assert.equal(r.children.repos.length, 1);
    assert.equal(r.children.repos[0].name, "svc-a");
    assert.equal(r.children.repos[0].checkedDefault, true);
    // The repo subtree is carved out — only top.md is counted as docs.
    assert.equal(r.children.docs.fileCount, 1);
  });

  test("container — third-party repo under vendor/ is not pre-checked", async () => {
    const dir = join(TMP, "ws2");
    mkdirSync(join(dir, "vendor"), { recursive: true });
    gitInit(join(dir, "vendor", "lib"), "https://github.com/acme/lib.git");
    const r = await inspectSource(dir);
    assert.equal(r.kind, "container");
    const child = r.children.repos.find((c: { name: string }) => c.name === "lib");
    assert.ok(child, "vendor/lib found");
    assert.equal(child.thirdParty, true);
    assert.equal(child.checkedDefault, false);
  });

  test("unsupported — .git FILE (submodule/worktree)", async () => {
    const dir = join(TMP, "submodule");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".git"), "gitdir: /somewhere/.git/modules/x");
    const r = await inspectSource(dir);
    assert.equal(r.kind, "unsupported");
  });

  test("prod mode — refuses local path before touching fs", async () => {
    const saved = process.env.FLOW_MODE;
    process.env.FLOW_MODE = "prod";
    try {
      await assert.rejects(
        () => inspectSource("/tmp/whatever"),
        /local paths aren't available on a remote Flow/,
      );
    } finally {
      if (saved === undefined) delete process.env.FLOW_MODE;
      else process.env.FLOW_MODE = saved;
    }
  });

  test("non-absolute path is rejected", async () => {
    await assert.rejects(() => inspectSource("./relative/path"), /absolute/);
  });
});
