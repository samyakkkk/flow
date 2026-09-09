import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { selectVersion, validateEvent } from "./flow-release-version.mjs";

NodeTest.test("first release starts at 0.1.0 and ignores other channels", () => {
  NodeAssert.deepEqual(selectVersion(["v9.0.0", "flow-v1.0.0-beta.1", "flow-v01.2.3"]), {
    version: "0.1.0",
    latest: undefined,
  });
});
NodeTest.test("increments the highest stable patch numerically", () => {
  NodeAssert.deepEqual(selectVersion(["flow-v0.1.9", "flow-v0.1.2", "flow-v0.1.10"]), {
    version: "0.1.11",
    latest: "0.1.10",
  });
  NodeAssert.equal(selectVersion(["flow-v1.99.99", "flow-v2.0.0"]).version, "2.0.1");
});
NodeTest.test("manual versions can advance a minor or major but cannot repeat or downgrade", () => {
  NodeAssert.equal(selectVersion(["flow-v0.1.2"], "0.2.0").version, "0.2.0");
  for (const version of ["0.1.2", "0.1.1", "v0.2.0", "0.02.0", "1.0.0-beta"]) {
    NodeAssert.throws(() => selectVersion(["flow-v0.1.2"], version));
  }
});
NodeTest.test("only release branch push/dispatch can publish, while PRs can validate", () => {
  validateEvent("push", "refs/heads/release");
  validateEvent("workflow_dispatch", "refs/heads/release");
  validateEvent("pull_request", "refs/pull/104/merge");
  for (const event of ["push", "workflow_dispatch", "schedule"]) {
    NodeAssert.throws(() => validateEvent(event, "refs/heads/main-v2"));
    NodeAssert.throws(() => validateEvent(event, "refs/tags/flow-v0.1.3"));
  }
});

NodeTest.test("CLI pins source and rejects publication from behind the latest release", (t) => {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "flow-version-"));
  t.after(() => NodeFS.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    NodeChildProcess.execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init");
  git("config", "user.name", "Release test");
  git("config", "user.email", "release@example.invalid");
  git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "first");
  const first = git("rev-parse", "HEAD");
  git("tag", "flow-v0.1.2");
  const output = NodePath.join(cwd, "output");
  const run = (sha, ref = "refs/heads/release") =>
    NodeChildProcess.spawnSync(
      process.execPath,
      [NodeURL.fileURLToPath(new URL("./flow-release-version.mjs", import.meta.url))],
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
  NodeAssert.equal(run(first).status, 0);
  NodeAssert.equal(
    NodeFS.readFileSync(output, "utf8"),
    `tag=flow-v0.1.3\nversion=0.1.3\ncommit=${first}\n`,
  );
  NodeAssert.notEqual(run("wrong-sha").status, 0);
  NodeAssert.notEqual(run(first, "refs/heads/main-v2").status, 0);
  git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "newer release");
  git("tag", "flow-v0.1.3");
  git("checkout", "--detach", first);
  NodeAssert.notEqual(run(first).status, 0);
});
