import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeURL from "node:url";
import * as NodeTest from "node:test";
const assert = NodeAssert;
const fs = NodeFSP;
const { tmpdir } = NodeOS;
const { join } = NodePath;
const { execFile } = NodeChildProcess;
const { promisify } = NodeUtil;
const { fileURLToPath } = NodeURL;
const { test } = NodeTest;
import { installLauncher, normalizeArgs, resolveReleaseHome } from "./flow-release.mjs";

const temporaryHome = async (t) => {
  const home = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "flow-cli-test-")));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return home;
};

test("one entry accepts local and Cloud setup and opens the UI by default", () => {
  assert.deepEqual(normalizeArgs([]), []);
  assert.deepEqual(normalizeArgs(["--web"]), []);
  // Binding a folder reuses the machine's installed tools; a bare setup installs them.
  assert.deepEqual(normalizeArgs(["setup", "--local", "--brain", "local-id", "--folder", "/p"]), [
    "setup",
    "--local",
    "true",
    "--brain",
    "local-id",
    "--folder",
    "/p",
  ]);
  assert.ok(normalizeArgs(["setup", "--cloud", "https://brain.example"]).includes("--cloud"));
  assert.deepEqual(normalizeArgs(["setup"]), ["setup", "--harness", "detected"]);
  assert.throws(
    () => normalizeArgs(["setup", "--local", "--cloud", "https://b.example"]),
    /Choose/,
  );
});

test("lifecycle and diagnostic commands never open the UI", () => {
  assert.deepEqual(normalizeArgs(["status"]), ["status", "--no-open"]);
  assert.deepEqual(normalizeArgs(["stop"]), ["stop", "--no-open"]);
  assert.deepEqual(normalizeArgs(["restart", "--no-open"]), ["restart", "--no-open"]);
  assert.deepEqual(normalizeArgs(["doctor", "--folder", "/p"]), [
    "agents",
    "doctor",
    "--folder",
    "/p",
  ]);
  assert.deepEqual(normalizeArgs(["brains", "list"]), ["brains", "list"]);
});

test("a machine has one Flow install, and a retired Cloud CLI install is adopted where it is", async (t) => {
  const home = await temporaryHome(t);
  const share = join(home, ".local/share");
  assert.equal(await resolveReleaseHome({}, home), join(share, "flow-browser"));
  // The desktop apps and install.sh resolve identically, so whichever of the
  // app or the CLI came first, both use the service in this folder.
  await fs.mkdir(join(share, "flow-cloud-cli/current"), { recursive: true });
  assert.equal(await resolveReleaseHome({}, home), join(share, "flow-cloud-cli"));
  await fs.mkdir(join(share, "flow-browser/current"), { recursive: true });
  assert.equal(await resolveReleaseHome({}, home), join(share, "flow-browser"));
  assert.equal(await resolveReleaseHome({ FLOW_RELEASE_HOME: "/opt/flow" }, home), "/opt/flow");
});

test("takes over an earlier Cloud CLI launcher but never someone else's flow", async (t) => {
  const home = await temporaryHome(t);
  const target = join(home, "bin/flow");
  await fs.mkdir(join(home, "bin"));
  await fs.writeFile(target, "#!/bin/sh\n# flow-cloud-cli-launcher\nexec old\n");
  await installLauncher(home, home, false);
  assert.match(await fs.readFile(target, "utf8"), /# flow-managed-launcher\n.*FLOW_RELEASE_HOME/s);
  await fs.writeFile(target, "#!/bin/sh\nexec something-else\n");
  await assert.rejects(installLauncher(home, home, false), /Refusing to overwrite/);
});

test("an updated earlier Cloud CLI install moves itself onto the one entry point", async (t) => {
  const user = await temporaryHome(t);
  const home = join(user, ".local/share/flow-cloud-cli");
  await fs.mkdir(join(home, "bin"), { recursive: true });
  await fs.mkdir(join(user, ".local/bin"), { recursive: true });
  const old = "#!/bin/sh\n# flow-cloud-cli-launcher\nexec old\n";
  await fs.writeFile(join(home, "bin/flow"), old);
  await fs.writeFile(join(user, ".local/bin/flow"), old);
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [fileURLToPath(new URL("./flow-cloud-cli.mjs", import.meta.url)), "--help"],
    { env: { ...process.env, HOME: user, FLOW_CLOUD_CLI_HOME: home, FLOW_RELEASE_HOME: "" } },
  );
  assert.match(stdout, /flow setup/);
  for (const launcher of [join(home, "bin/flow"), join(user, ".local/bin/flow")]) {
    const text = await fs.readFile(launcher, "utf8");
    assert.match(text, /# flow-managed-launcher/);
    assert.ok(text.includes(`FLOW_RELEASE_HOME='${home}'`));
    assert.ok(text.includes("scripts/flow-release.mjs"));
  }
});
