import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { selectVersion, validateEvent } from "./flow-release-version.mjs";

test("first release starts at 0.1.0 and ignores other channels", () => {
  assert.deepEqual(selectVersion(["v9.0.0", "flow-v1.0.0-beta.1", "flow-v01.2.3"]), {
    version: "0.1.0",
    latest: undefined,
  });
});
test("increments the highest stable patch numerically", () => {
  assert.deepEqual(selectVersion(["flow-v0.1.9", "flow-v0.1.2", "flow-v0.1.10"]), {
    version: "0.1.11",
    latest: "0.1.10",
  });
  assert.equal(selectVersion(["flow-v1.99.99", "flow-v2.0.0"]).version, "2.0.1");
});
test("manual versions can advance a minor or major but cannot repeat or downgrade", () => {
  assert.equal(selectVersion(["flow-v0.1.2"], "0.2.0").version, "0.2.0");
  for (const version of ["0.1.2", "0.1.1", "v0.2.0", "0.02.0", "1.0.0-beta"]) {
    assert.throws(() => selectVersion(["flow-v0.1.2"], version));
  }
});
test("only release branch push/dispatch can publish, while PRs can validate", () => {
  validateEvent("push", "refs/heads/release");
  validateEvent("workflow_dispatch", "refs/heads/release");
  validateEvent("pull_request", "refs/pull/104/merge");
  for (const event of ["push", "workflow_dispatch", "schedule"]) {
    assert.throws(() => validateEvent(event, "refs/heads/main-v2"));
    assert.throws(() => validateEvent(event, "refs/tags/flow-v0.1.3"));
  }
});

test("CLI pins source and rejects publication from behind the latest release", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "flow-version-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init");
  git("config", "user.name", "Release test");
  git("config", "user.email", "release@example.invalid");
  git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "first");
  const first = git("rev-parse", "HEAD");
  git("tag", "flow-v0.1.2");
  const output = join(cwd, "output");
  const run = (sha, ref = "refs/heads/release") =>
    spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./flow-release-version.mjs", import.meta.url))],
      {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: "push",
          GITHUB_REF: ref,
          GITHUB_SHA: sha,
          GITHUB_OUTPUT: output,
          FLOW_VERSION: "",
        },
      },
    );
  assert.equal(run(first).status, 0);
  assert.equal(readFileSync(output, "utf8"), `tag=flow-v0.1.3\nversion=0.1.3\ncommit=${first}\n`);
  assert.notEqual(run("wrong-sha").status, 0);
  assert.notEqual(run(first, "refs/heads/main-v2").status, 0);
  git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "newer release");
  git("tag", "flow-v0.1.3");
  git("checkout", "--detach", first);
  assert.notEqual(run(first).status, 0);
});
