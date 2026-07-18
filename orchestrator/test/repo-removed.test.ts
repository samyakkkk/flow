// repo-removed.test.ts — removing a repo actually disconnects it: registry
// entry dropped, poller watch removed, parked/queued index jobs cancelled,
// managed clone deleted. Also: adding owner2/web while owner1/web holds the
// name is refused instead of silently overwriting the registry entry.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Setup: workspace + in-memory DB before any imports that touch db
const workspace = mkdtempSync(join(tmpdir(), "flow-repo-removed-"));
process.env.OPENCODE_WORKSPACE_DIR = workspace;
process.env.DB_PATH = ":memory:";
process.env.FLOW_ADMIN_TOKEN = "test-token-repo-removed";
process.env.FLOW_FAKE_OPENCODE = "1";
process.env.FLOW_DRAIN_DISABLE = "1";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Job } from "../src/opencode.js";

let enqueueJob: (opts: { type: "index_repo"; input: Record<string, unknown>; repo?: string }) => Promise<{ id: string }>;
let getJob: (id: string) => Job | null;
let removeRepo: (name: string) => Promise<Record<string, unknown>>;
let connectGithubRepo: (url: string, branch?: string) => Promise<unknown>;
let listWorkspaceRepos: () => { name: string }[];
let watchRepo: (ownerRepo: string, branch: string) => void;
let registeredRepos: Map<string, string>;

before(async () => {
  writeFileSync(
    join(workspace, "repos.json"),
    JSON.stringify({ repos: [{ name: "web", url: "https://github.com/owner1/web", branch: "main" }] }),
  );
  mkdirSync(join(workspace, "repos", "web"), { recursive: true });
  writeFileSync(join(workspace, "repos", "web", "README.md"), "clone contents\n");

  const opencode = await import("../src/opencode.js");
  ({ enqueueJob, getJob, removeRepo, connectGithubRepo, listWorkspaceRepos } = opencode);
  ({ watchRepo, registeredRepos } = await import("../src/adapters/github.js"));
});

after(() => rmSync(workspace, { recursive: true, force: true }));

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor: condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("repo lifecycle: collision guard + removal cleanup", () => {
  test("connecting a same-named repo from another owner is refused", async () => {
    await assert.rejects(
      () => connectGithubRepo("https://github.com/owner2/web", "main"),
      /already connected/,
    );
    // owner1's entry survived untouched.
    assert.equal(listWorkspaceRepos().length, 1);
  });

  test("removeRepo cleans registry, watch, parked jobs, and clone", async () => {
    watchRepo("owner1/web", "main");

    const running = await enqueueJob({
      type: "index_repo",
      input: { repo: "web", branch: "main", url: "https://github.com/owner1/web", simulate_delay_ms: 300 },
    });
    await waitFor(() => getJob(running.id)?.status === "running");
    const parked = await enqueueJob({
      type: "index_repo",
      input: { repo: "web", branch: "main", url: "https://github.com/owner1/web" },
    });
    await waitFor(() => getJob(parked.id)?.status === "queued");

    const summary = await removeRepo("web");

    assert.equal(getJob(parked.id)?.status, "failed");
    assert.equal((JSON.parse(getJob(parked.id)!.result_json!) as { error: string }).error, "repo_removed");
    assert.equal(existsSync(join(workspace, "repos", "web")), false);
    assert.equal(listWorkspaceRepos().length, 0);
    assert.equal(registeredRepos.has("owner1/web"), false);
    assert.equal(summary.registry, "removed");
    assert.equal(summary.checkout, "clone removed");

    // The running job finishes without resurrecting anything.
    await waitFor(() => getJob(running.id)?.status === "done");
    assert.equal(listWorkspaceRepos().length, 0);
  });
});
