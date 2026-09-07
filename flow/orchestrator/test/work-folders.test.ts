// work-folders.test.ts — per-user WORK surfaces: folders are scoped to their
// owner (no cross-user leakage on shared deployments), re-registration is
// idempotent, and the registry seed maps legacy localPath entries to the
// "local" owner.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Setup: workspace + in-memory DB before any imports that touch db
const workspace = mkdtempSync(join(tmpdir(), "flow-work-folders-"));
process.env.OPENCODE_WORKSPACE_DIR = workspace;
process.env.DB_PATH = ":memory:";
process.env.FLOW_ADMIN_TOKEN = "test-token-work-folders";
process.env.FLOW_FAKE_OPENCODE = "1";
process.env.FLOW_DRAIN_DISABLE = "1";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

let addWorkFolder: (owner: string, path: string, repo?: string) => void;
let listWorkFolders: (owner: string) => { owner: string; path: string; repo: string | null }[];
let removeWorkFolder: (owner: string, path: string) => void;
let seedWorkFoldersFromRegistry: () => void;

before(async () => {
  ({ addWorkFolder, listWorkFolders, removeWorkFolder, seedWorkFoldersFromRegistry } = await import(
    "../src/work-folders.js"
  ));
});

after(() => rmSync(workspace, { recursive: true, force: true }));

describe("per-user work folders", () => {
  test("folders are scoped to their owner — no cross-user leakage", () => {
    addWorkFolder("samyak@pixelapps.io", "/Users/samyak/code/orbit-api", "orbit-api");
    addWorkFolder("teammate@pixelapps.io", "/home/teammate/orbit-api", "orbit-api");

    const mine = listWorkFolders("samyak@pixelapps.io");
    assert.equal(mine.length, 1);
    assert.equal(mine[0].path, "/Users/samyak/code/orbit-api");
    // The teammate's dashboard never sees my paths, and vice versa.
    const theirs = listWorkFolders("teammate@pixelapps.io");
    assert.equal(theirs.length, 1);
    assert.equal(theirs[0].path, "/home/teammate/orbit-api");
  });

  test("re-registration is idempotent and fills the repo hint", () => {
    addWorkFolder("u1", "/tmp/checkout");
    addWorkFolder("u1", "/tmp/checkout", "web");
    const folders = listWorkFolders("u1");
    assert.equal(folders.length, 1);
    assert.equal(folders[0].repo, "web");
  });

  test("remove deletes only the owner's entry", () => {
    addWorkFolder("u2", "/tmp/shared-path");
    addWorkFolder("u3", "/tmp/shared-path");
    removeWorkFolder("u2", "/tmp/shared-path");
    assert.equal(listWorkFolders("u2").length, 0);
    assert.equal(listWorkFolders("u3").length, 1);
  });

  test("seed maps legacy registry localPath entries to the 'local' owner", () => {
    writeFileSync(
      join(workspace, "repos.json"),
      JSON.stringify({
        repos: [
          { name: "app", url: "https://github.com/acme/app", localPath: "/Users/x/app", branch: "main" },
          { name: "no-checkout", url: "https://github.com/acme/no-checkout", branch: "main" },
        ],
      }),
    );
    seedWorkFoldersFromRegistry();
    const local = listWorkFolders("local");
    assert.equal(local.length, 1);
    assert.equal(local[0].path, "/Users/x/app");
    assert.equal(local[0].repo, "app");
    // Idempotent on re-seed.
    seedWorkFoldersFromRegistry();
    assert.equal(listWorkFolders("local").length, 1);
  });
});
