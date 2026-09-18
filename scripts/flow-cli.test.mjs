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
// These run on Windows too, where the launcher is a batch file named flow.cmd.
const win = process.platform === "win32";
const flowCommand = win ? "flow.cmd" : "flow";
const { execFile } = NodeChildProcess;
const { promisify } = NodeUtil;
const { fileURLToPath } = NodeURL;
const { dirname } = NodePath;
const { test } = NodeTest;
import {
  brainStore,
  bundledGit,
  bundledNode,
  installLauncher,
  launcherScript,
  moveDirectory,
  pointCurrent,
  normalizeArgs,
  removeInstallation,
  resolveReleaseHome,
  retireBrowserApp,
} from "./flow-release.mjs";

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
  assert.equal(
    await resolveReleaseHome({ FLOW_RELEASE_HOME: "/opt/flow" }, home),
    NodePath.resolve("/opt/flow"),
  );
});

// The retired Cloud CLI never ran on Windows, so there is nothing to take over there.
test(
  "takes over an earlier Cloud CLI launcher but never someone else's flow",
  { skip: win },
  async (t) => {
    const home = await temporaryHome(t);
    const target = join(home, "bin/flow");
    await fs.mkdir(join(home, "bin"));
    await fs.writeFile(target, "#!/bin/sh\n# flow-cloud-cli-launcher\nexec old\n");
    await installLauncher(home, home, false);
    assert.match(
      await fs.readFile(target, "utf8"),
      /# flow-managed-launcher\n.*FLOW_RELEASE_HOME/s,
    );
    await fs.writeFile(target, "#!/bin/sh\nexec something-else\n");
    await assert.rejects(installLauncher(home, home, false), /Refusing to overwrite/);
  },
);

test(
  "an updated earlier Cloud CLI install moves itself onto the one entry point",
  { skip: win },
  async (t) => {
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
  },
);

test("installing retires only the browser app this installation wrote", async (t) => {
  const user = await temporaryHome(t);
  const home = join(user, ".local/share/flow-browser");
  const apps = join(user, "Applications");
  const marker = join(apps, "Flow.app/Contents/flow-browser-launcher");
  await fs.mkdir(dirname(marker), { recursive: true });

  await fs.writeFile(marker, "/somewhere/else\n");
  assert.equal(await retireBrowserApp(home, apps), null, "another installation's app stays");

  await fs.writeFile(marker, home + "\n");
  assert.equal(await retireBrowserApp(home, apps), join(apps, "Flow.app"));
  assert.equal(await fs.stat(join(apps, "Flow.app")).catch(() => null), null);

  // A real desktop app has no ownership marker and must never be removed.
  await fs.mkdir(join(apps, "Flow.app/Contents/MacOS"), { recursive: true });
  assert.equal(await retireBrowserApp(home, apps), null);
  assert.ok(await fs.stat(join(apps, "Flow.app")));
});

const installation = async (t, { dataInside = true } = {}) => {
  const user = await temporaryHome(t);
  const home = join(user, ".local/share/flow-browser");
  const dataHome = dataInside
    ? join(home, "instance-home/instances/primary/data")
    : join(user, ".t3");
  for (const directory of [
    join(home, "releases/one"),
    join(home, "bin"),
    dataHome,
    join(user, ".local/bin"),
  ])
    await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(join(dataHome, "userdata.sqlite"), "conversations");
  await fs.mkdir(brainStore(dataHome), { recursive: true });
  await fs.writeFile(join(brainStore(dataHome), "graph.rdb"), "brain");
  const launcher = launcherScript(home, "node");
  await fs.writeFile(join(home, "bin", flowCommand), launcher);
  await fs.writeFile(join(user, ".local/bin", flowCommand), launcher);
  return { user, home, dataHome };
};

test("uninstalling removes the program and keeps the data until you ask", async (t) => {
  const { user, home, dataHome } = await installation(t);
  const { kept } = await removeInstallation(home, {
    dataHomes: [dataHome],
    path: join(user, ".local/bin"),
    agentHome: join(user, ".flow"),
  });
  assert.equal(
    await fs.stat(join(home, "releases/one")).catch(() => null),
    null,
    "the release goes",
  );
  assert.equal(
    await fs.stat(join(user, ".local/bin", flowCommand)).catch(() => null),
    null,
    "our launcher goes",
  );
  assert.equal(await fs.readFile(join(dataHome, "userdata.sqlite"), "utf8"), "conversations");
  assert.equal(await fs.readFile(join(brainStore(dataHome), "graph.rdb"), "utf8"), "brain");
  assert.ok(kept.some((path) => path.startsWith(join(home, "instance-home"))));
});

test("purging deletes the data and Brain, but never the retired backups", async (t) => {
  const { user, home, dataHome } = await installation(t, { dataInside: false });
  const agentHome = join(user, ".flow");
  await fs.mkdir(join(agentHome, "retired/2026"), { recursive: true });
  await fs.writeFile(join(agentHome, "retired/2026/settings.json"), "a file Flow replaced");
  await fs.mkdir(join(agentHome, "bin"), { recursive: true });

  const { kept } = await removeInstallation(home, {
    purge: true,
    dataHomes: [dataHome],
    path: join(user, ".local/bin"),
    agentHome,
  });
  assert.equal(await fs.stat(home).catch(() => null), null);
  assert.equal(await fs.stat(dataHome).catch(() => null), null);
  assert.equal(await fs.stat(brainStore(dataHome)).catch(() => null), null);
  assert.equal(await fs.stat(join(agentHome, "bin")).catch(() => null), null);
  // The only copy of files Flow changed elsewhere survives a purge.
  assert.equal(
    await fs.readFile(join(agentHome, "retired/2026/settings.json"), "utf8"),
    "a file Flow replaced",
  );
  assert.deepEqual(kept, [join(agentHome, "retired")]);
});

test("uninstalling never removes another installation's flow command", async (t) => {
  const { user, home, dataHome } = await installation(t);
  const foreign = join(user, ".local/bin", flowCommand);
  await fs.writeFile(foreign, launcherScript(NodePath.resolve("/opt/other"), "node"));
  await removeInstallation(home, {
    purge: true,
    dataHomes: [dataHome],
    path: join(user, ".local/bin"),
    agentHome: join(user, ".flow"),
  });
  assert.match(await fs.readFile(foreign, "utf8"), /opt[\\/]other/);
});

test("Windows gets a batch launcher that survives a home with spaces", () => {
  const home = "C:\\Users\\Ada Lovelace\\AppData\\Local\\flow-browser";
  const script = launcherScript(home, `${home}\\current\\runtime\\bin\\node.exe`, true);
  assert.match(script, /^@echo off\r\nrem flow-managed-launcher\r\n/);
  // `set "NAME=value"` keeps spaces and a trailing quote out of the value.
  assert.ok(script.includes(`set "FLOW_RELEASE_HOME=${home}"`));
  assert.ok(script.includes(`"${home}\\current\\runtime\\bin\\node.exe" --disable-warning`));
  assert.ok(script.trimEnd().endsWith("%*"), "arguments are forwarded");
  // And the POSIX form is unchanged.
  assert.match(
    launcherScript("/home/ada/flow", "/usr/bin/node", false),
    /^#!\/bin\/sh\n# flow-managed-launcher\n/,
  );
});

test("a bundle keeps Node and Git where each platform expects them", () => {
  assert.equal(bundledNode("/b", false), join("/b", "runtime/bin/node"));
  assert.equal(bundledGit("/b", false), join("/b", "runtime/git/bin/git"));
  assert.match(bundledNode("C:\\b", true), /node\.exe$/);
  assert.match(bundledGit("C:\\b", true), /cmd[\\/]git\.exe$/);
});

test("pointing current at a new release replaces the old one and keeps both trees", async (t) => {
  const home = await temporaryHome(t);
  for (const name of ["one", "two"]) {
    await fs.mkdir(join(home, "releases", name), { recursive: true });
    await fs.writeFile(join(home, "releases", name, "marker"), name);
  }
  await pointCurrent(home, join(home, "releases/one"));
  assert.equal(await fs.readFile(join(home, "current/marker"), "utf8"), "one");
  await pointCurrent(home, join(home, "releases/two"));
  assert.equal(await fs.readFile(join(home, "current/marker"), "utf8"), "two");
  // Replacing the pointer must never delete the release it used to name.
  assert.equal(await fs.readFile(join(home, "releases/one/marker"), "utf8"), "one");
});

test("a file the system holds locked is handed back, not fatal", async (t) => {
  // Windows refuses to delete the Node that `flow uninstall` is running on.
  const { user, home, dataHome } = await installation(t);
  const { removed, deferred } = await removeInstallation(home, {
    purge: true,
    dataHomes: [dataHome],
    path: join(user, ".local/bin"),
    agentHome: join(user, ".flow"),
    remove: async (target) => {
      if (target === home) throw Object.assign(Error("resource busy"), { code: "EBUSY" });
      await fs.rm(target, { recursive: true, force: true });
    },
  });
  assert.deepEqual(deferred, [home]);
  assert.ok(removed.includes(dataHome), "everything that could go, went");
  assert.equal(await fs.stat(dataHome).catch(() => null), null);
});

test("moving a release into place outlasts a handle Windows has not let go of", async () => {
  let calls = 0;
  const busy = async () => {
    calls += 1;
    if (calls < 3) throw Object.assign(Error("operation not permitted"), { code: "EPERM" });
  };
  await moveDirectory("a", "b", { rename: busy, wait: 0 });
  assert.equal(calls, 3);
  // It gives up rather than spin forever, and other errors are not retried.
  const stuck = async () => {
    throw Object.assign(Error("operation not permitted"), { code: "EPERM" });
  };
  await assert.rejects(
    moveDirectory("a", "b", { rename: stuck, wait: 0, attempts: 3 }),
    /not permitted/,
  );
  calls = 0;
  const missing = async () => {
    calls += 1;
    throw Object.assign(Error("no such file"), { code: "ENOENT" });
  };
  await assert.rejects(moveDirectory("a", "b", { rename: missing, wait: 0 }), /no such file/);
  assert.equal(calls, 1);
});
