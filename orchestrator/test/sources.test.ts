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
// Registry writes (already-connected / collision tests) go to a temp
// workspace, never the real index-workspace.
const WSTMP = mkdtempSync(join(tmpdir(), "flow-sources-ws-"));
process.env.OPENCODE_WORKSPACE_DIR = WSTMP;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let inspectSource: (input: string) => Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let addSources: (sources: any[]) => Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let registerSource: (entry: any) => any;
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
  addSources = mod.addSources;
  registerSource = (await import("../src/opencode.js")).registerSource;
});

after(() => {
  globalThis.fetch = realFetch;
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { rmSync(WSTMP, { recursive: true, force: true }); } catch { /* best-effort */ }
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

  test("bare ~ (whole home folder) is rejected with a hint", async () => {
    await assert.rejects(() => inspectSource("~"), /whole home folder/);
  });
});

// alreadyConnected must mean THIS source, not this name — and /add must refuse
// to clobber a different source holding the same name (the registry is keyed
// by name, so registerSource would otherwise silently overwrite).
describe("already-connected identity + name collisions", () => {
  test("same name, different owner is NOT alreadyConnected", async () => {
    registerSource({ kind: "code", name: "colwidgets", url: "https://github.com/acme/colwidgets", branch: "main" });
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ default_branch: "main" }), { status: 200 })) as typeof fetch;
    try {
      const same = await inspectSource("https://github.com/acme/colwidgets");
      assert.equal(same.github.alreadyConnected, true, "same url → connected");
      const other = await inspectSource("https://github.com/other/colwidgets");
      assert.equal(other.github.alreadyConnected, false, "same name, different owner → NOT connected");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("add refuses a name collision with a different source", async () => {
    const docsDir = join(TMP, "col-docs");
    mkdirSync(docsDir, { recursive: true });
    const r = await addSources([{ type: "docs", path: docsDir, name: "colwidgets" }]);
    assert.equal(r.added.length, 0);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0].error, /already connected/);
  });

  test("re-adding the same identity is a harmless update, not an error", async () => {
    const docsDir = join(TMP, "col-notes");
    mkdirSync(docsDir, { recursive: true });
    registerSource({ kind: "docs", name: "col-notes", path: docsDir, status: "pending_ingestion" });
    const r = await addSources([{ type: "docs", path: docsDir, name: "col-notes" }]);
    assert.equal(r.errors.length, 0);
    assert.equal(r.added.length, 1);
  });
});
