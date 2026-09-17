import * as NodeTest from "node:test";
const { test } = NodeTest;
import * as NodeAssert from "node:assert/strict";
const assert = NodeAssert;
import * as NodeFSP from "node:fs/promises";
const { mkdtemp, readFile, rm, stat, writeFile } = NodeFSP;
import * as NodeOS from "node:os";
const { tmpdir } = NodeOS;
import * as NodePath from "node:path";
const { join } = NodePath;
import {
  installService,
  launchdLabel,
  managedService,
  restartManaged,
  serviceStatus,
  servicePlan,
  systemdUnit,
  uninstallService,
} from "./service.mjs";
import { parse } from "./launcher.mjs";

// Nothing in these tests may touch the real launchd/systemd session, so every
// process the service layer would run is recorded instead of executed.
function recorder(results = {}) {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args].join(" "));
    return results[[command, ...args].join(" ")] ?? { ok: true, stdout: "", stderr: "" };
  };
  return { calls, run };
}

async function fixture(t, extra = {}) {
  const root = await NodeFSP.realpath(await mkdtemp(join(tmpdir(), "flow-service-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    options: {
      homeDirectory: join(root, "user"),
      registry: join(root, "registry"),
      releaseHome: "",
      ...extra,
    },
  };
}

test("service verbs parse, and only install may record a home", () => {
  assert.equal(parse(["service", "install"]).verb, "install");
  assert.equal(parse(["service", "install", "--home", "/srv/flow"]).home, "/srv/flow");
  assert.equal(parse(["service", "status"]).action, "service");
  assert.throws(() => parse(["service", "reload"]), /install\|status\|uninstall/);
  assert.throws(() => parse(["service", "status", "--home", "/srv/flow"]), /only when starting/);
});

test("the launch agent supervises the primary instance directly and is never given a home", async (t) => {
  const { root, options } = await fixture(t);
  const { calls, run } = recorder();
  const result = await installService({ ...options, host: "darwin", run });
  const plistPath = join(root, "user/Library/LaunchAgents", `${launchdLabel}.plist`);
  assert.deepEqual(result, { label: launchdLabel, unitPath: plistPath, installed: true });
  const plist = await readFile(plistPath, "utf8");
  const directory = join(root, "registry/instances/primary");
  assert.ok(plist.includes(`<string>${process.execPath}</string>`));
  assert.ok(plist.includes("<string>--supervise</string>"));
  assert.ok(plist.includes(`<string>${directory}</string>`));
  // `flow`/`start` detach and exit; launchd would read that as a crash loop.
  assert.ok(!/<string>(flow|start)<\/string>/.test(plist));
  assert.ok(plist.includes("<key>FLOW_SERVICE_MANAGED</key>\n    <string>1</string>"));
  assert.ok(
    plist.includes(`<key>FLOW_INSTANCE_HOME</key>\n    <string>${options.registry}</string>`),
  );
  assert.ok(!plist.includes("T3CODE_HOME"));
  assert.ok(!plist.includes("FLOW_RELEASE_HOME"));
  assert.deepEqual(calls, [
    `launchctl bootout gui/${process.getuid()}/${launchdLabel}`,
    `launchctl bootstrap gui/${process.getuid()} ${plistPath}`,
  ]);
  // Installing configures the instance, so the service and the CLI agree on the home.
  const config = JSON.parse(await readFile(join(directory, "config.json"), "utf8"));
  assert.equal(config.name, "primary");
  assert.equal(config.home, join(directory, "data"));
});

test("an adopted home is recorded once by install", async (t) => {
  const { root, options } = await fixture(t);
  const adopted = join(root, "existing-data");
  const { run } = recorder();
  await installService({ ...options, host: "linux", run, home: adopted });
  const config = JSON.parse(
    await readFile(join(root, "registry/instances/primary/config.json"), "utf8"),
  );
  assert.equal(config.home, adopted);
});

test("a systemd install reloads and enables the user unit", async (t) => {
  const { root, options } = await fixture(t);
  const { calls, run } = recorder();
  const result = await installService({ ...options, host: "linux", run });
  assert.equal(result.unitPath, join(root, "user/.config/systemd/user", systemdUnit));
  assert.match(await readFile(result.unitPath, "utf8"), /^Restart=on-failure$/m);
  assert.deepEqual(calls, [
    "systemctl --user daemon-reload",
    `systemctl --user enable --now ${systemdUnit}`,
  ]);
});

test("a release install runs the private node through the current release symlink", async (t) => {
  const { root, options } = await fixture(t);
  const releaseHome = join(root, "release");
  const node = join(releaseHome, "current/runtime/bin/node");
  await NodeFSP.mkdir(NodePath.dirname(node), { recursive: true });
  await writeFile(node, "", { mode: 0o755 });
  const plan = await servicePlan({ ...options, host: "darwin", releaseHome });
  assert.equal(plan.nodePath, node);
  assert.deepEqual(plan.args, [
    join(releaseHome, "current/scripts/flow.mjs"),
    "--supervise",
    join(root, "registry/instances/primary"),
  ]);
  assert.equal(plan.env.FLOW_RELEASE_HOME, releaseHome);
  assert.ok(plan.env.PATH.startsWith(`${NodePath.dirname(node)}:`));
});

test("a refused bootstrap fails loudly instead of leaving a silent unit", async (t) => {
  const { root, options } = await fixture(t);
  const plistPath = join(root, "user/Library/LaunchAgents", `${launchdLabel}.plist`);
  const { run } = recorder({
    [`launchctl bootstrap gui/${process.getuid()} ${plistPath}`]: {
      ok: false,
      stdout: "",
      stderr: "Load failed: 5",
    },
  });
  await assert.rejects(installService({ ...options, host: "darwin", run }), /Load failed/);
});

test("status reports the installed unit, whether it is current, and the instance phase", async (t) => {
  const { options } = await fixture(t);
  const { run } = recorder();
  const missing = await serviceStatus({ ...options, host: "darwin", run });
  assert.equal(missing.installed, false);
  assert.equal(missing.loaded, false);
  assert.deepEqual(missing.instance, { phase: "stopped" });
  await installService({ ...options, host: "darwin", run });
  const installed = await serviceStatus({ ...options, host: "darwin", run });
  assert.equal(installed.installed, true);
  assert.equal(installed.current, true);
  assert.equal(installed.loaded, true);
  // A unit left behind by an older install is present but no longer current.
  await writeFile(installed.unitPath, "<plist>stale</plist>");
  const stale = await serviceStatus({ ...options, host: "darwin", run });
  assert.equal(stale.current, false);
  const unloaded = recorder({
    [`launchctl print gui/${process.getuid()}/${launchdLabel}`]: {
      ok: false,
      stdout: "",
      stderr: "not found",
    },
  });
  assert.equal(
    (await serviceStatus({ ...options, host: "darwin", run: unloaded.run })).loaded,
    false,
  );
});

test("a managed instance is restarted by the service manager, not by a second supervisor", async (t) => {
  const { options } = await fixture(t);
  const { run } = recorder();
  await installService({ ...options, host: "darwin", run });
  const managed = await managedService({ ...options, host: "darwin", run });
  assert.equal(managed.loaded, true);
  const mac = recorder();
  await restartManaged(managed, { host: "darwin", run: mac.run });
  assert.deepEqual(mac.calls, [`launchctl kickstart -k gui/${process.getuid()}/${launchdLabel}`]);
  const linux = recorder();
  await restartManaged(managed, { host: "linux", run: linux.run });
  assert.deepEqual(linux.calls, [`systemctl --user restart ${systemdUnit}`]);
});

test("uninstall unloads and removes the unit while leaving the data alone", async (t) => {
  const { root, options } = await fixture(t);
  const { run } = recorder();
  await installService({ ...options, host: "darwin", run });
  const directory = join(root, "registry/instances/primary");
  const removal = recorder();
  const result = await uninstallService({ ...options, host: "darwin", run: removal.run });
  assert.equal(result.installed, false);
  await assert.rejects(stat(result.unitPath), { code: "ENOENT" });
  assert.deepEqual(removal.calls, [`launchctl bootout gui/${process.getuid()}/${launchdLabel}`]);
  await stat(join(directory, "config.json"));
  assert.equal(await managedService({ ...options, host: "darwin", run }), null);
  const linux = recorder();
  await uninstallService({ ...options, host: "linux", run: linux.run });
  assert.deepEqual(linux.calls, [
    `systemctl --user disable --now ${systemdUnit}`,
    "systemctl --user daemon-reload",
  ]);
});
