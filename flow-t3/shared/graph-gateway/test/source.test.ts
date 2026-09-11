import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { sourceRead, sourceSearch } from "../src/source.js";

test("source tools read indexed Git objects, restrict the registry, and preserve revision evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flow-source-"));
  const repo = join(dir, "repos", "example");
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    git("config", "user.name", "Flow test"); git("config", "user.email", "test@example.invalid");
    writeFileSync(join(repo, "app.ts"), "first\nknown fact\nlast\n");
    writeFileSync(join(repo, "a:b.ts"), "known fact\n");
    writeFileSync(join(dir, "outside"), "outside secret");
    symlinkSync(join(dir, "outside"), join(repo, "link"));
    git("add", "."); git("commit", "-qm", "indexed");
    const indexed = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "app.ts"), "new revision\n");
    git("add", "."); git("commit", "-qm", "new head");
    const head = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "app.ts"), "dirty secret\n");
    writeFileSync(join(repo, ".env"), "untracked secret\n");
    const registry = join(dir, "repos.json");
    writeFileSync(registry, JSON.stringify({ repos: [
      { name: "example", url: "https://example.invalid/repo", lastIndexedCommit: indexed, localPath: "/not-the-brain" },
      { name: "denied", localPath: repo, sourceRead: false },
      { name: "docs", kind: "docs", localPath: repo },
    ] }));
    const read = await sourceRead({ repo: "example", path: "app.ts", start_line: 2, end_line: 2 }, registry);
    assert.ok("content" in read);
    assert.equal(read.content, "known fact"); assert.equal(read.revision, indexed);
    assert.equal(read.verification, "indexed_revision"); assert.equal(read.total_lines, 3);
    const newer = await sourceRead({ repo: "example", path: "app.ts", revision: head }, registry);
    assert.ok("content" in newer); assert.equal(newer.content, "new revision");
    assert.equal(newer.verification, "different_or_unindexed_revision");
    const found = await sourceSearch({ repo: "example", query: "known fact" }, registry);
    assert.ok("matches" in found);
    assert.deepEqual(found.matches, [{ path: "a:b.ts", line: 1, text: "known fact" }, { path: "app.ts", line: 2, text: "known fact" }]);
    const limited = await sourceSearch({ repo: "example", query: "known fact", limit: 1 }, registry);
    assert.ok("matches" in limited); assert.equal(limited.matches.length, 1); assert.equal(limited.truncated, true);
    const none = await sourceSearch({ repo: "example", query: "secret" }, registry);
    assert.ok("matches" in none); assert.deepEqual(none.matches, []);
    for (const path of ["../outside", "/etc/passwd", "link", ".env", "app.ts/../link", "app.ts\0"]) {
      assert.equal((await sourceRead({ repo: "example", path }, registry) as { status: string }).status, "error", path);
    }
    for (const name of ["unknown", "denied", "docs", "../example"]) {
      assert.equal((await sourceRead({ repo: name, path: "app.ts" }, registry) as { status: string }).status, "error", name);
    }
    assert.equal((await sourceRead({ repo: "example", path: "app.ts", revision: "HEAD" }, registry) as { status: string }).status, "error");
    assert.equal((await sourceRead({ repo: "example", path: "app.ts", end_line: 1000 }, registry) as { status: string }).status, "error");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
