/* eslint-disable t3code/no-global-process-runtime -- Standalone Node bootstrap runs before workspace Effect services exist. */
import * as NodeFSP from "node:fs/promises";
const { mkdir, readFile, writeFile, rename, rm } = NodeFSP;
import * as NodePath from "node:path";
const { dirname, join, delimiter } = NodePath;
import * as NodeOS from "node:os";
const { homedir, platform } = NodeOS;
import * as NodeCrypto from "node:crypto";
const { randomUUID } = NodeCrypto;
import * as NodeChildProcess from "node:child_process";
const { execFile } = NodeChildProcess;
import { configure, control, lockLauncher, registryRoot, sourceRoot } from "./launcher.mjs";
import { renderLaunchdPlist, renderSystemdUnit } from "./service-unit.mjs";
import { releaseRuntime } from "../flow-release.mjs";

export const launchdLabel = "com.flow.service";
export const systemdUnit = "flow.service";

// Every process this module runs goes through a runner so callers (and tests)
// see the exact argv. `ok` is false for a non-zero exit or a missing binary.
export const spawnRunner = (command, args) =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: 30000 }, (error, stdout, stderr) =>
      resolve({ ok: !error, stdout: stdout || "", stderr: stderr || String(error?.message || "") }),
    );
  });

export function unitLocation({ homeDirectory = homedir(), host = platform() } = {}) {
  return host === "darwin"
    ? {
        label: launchdLabel,
        path: join(homeDirectory, "Library/LaunchAgents", `${launchdLabel}.plist`),
      }
    : { label: systemdUnit, path: join(homeDirectory, ".config/systemd/user", systemdUnit) };
}

// The unit runs `flow.mjs --supervise` directly. `flow` itself detaches a
// supervisor and exits, which a service manager would read as a crash and
// respawn forever.
export async function servicePlan({
  homeDirectory = homedir(),
  host = platform(),
  registry = registryRoot(),
  releaseHome = process.env.FLOW_RELEASE_HOME,
  code,
  nodePath,
} = {}) {
  // An installed release is upgraded by swapping `current`, so the unit points
  // through that symlink rather than at the release it was installed from.
  const root = code ?? (releaseHome ? join(releaseHome, "current") : sourceRoot);
  const node = nodePath ?? (releaseHome ? await releaseRuntime(root) : process.execPath);
  const directory = join(registry, "instances/primary");
  return {
    ...unitLocation({ homeDirectory, host }),
    nodePath: node,
    args: [join(root, "scripts/flow.mjs"), "--supervise", directory],
    // T3CODE_HOME is deliberately absent: the supervisor sets it per child from
    // the instance's recorded home, and cleanEnvironment strips an inherited one.
    env: {
      // Mirrors the PATH a release launch builds (flow-release.mjs), minus the
      // user's shell, which a service manager does not run.
      PATH: [
        dirname(node),
        ...(releaseHome ? [join(root, "runtime/git/bin"), join(releaseHome, "tools/bin")] : []),
        join(homeDirectory, ".local/bin"),
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
      ].join(delimiter),
      FLOW_INSTANCE_HOME: registry,
      ...(releaseHome ? { FLOW_RELEASE_HOME: releaseHome } : {}),
      FLOW_SERVICE_MANAGED: "1",
    },
    logPath: join(directory, "runtime.log"),
    workingDirectory: homeDirectory,
    directory,
  };
}

export const renderUnit = (plan, host = platform()) =>
  host === "darwin" ? renderLaunchdPlist(plan) : renderSystemdUnit(plan);

const target = (plan) => `gui/${process.getuid()}/${plan.label}`;

async function writeDurably(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, contents, { mode: 0o600 });
  await rename(temp, path);
}

async function readUnit(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function activate(plan, host, run) {
  if (host === "darwin") {
    // Not loaded is the normal case on a first install, so the unload is best effort.
    await run("launchctl", ["bootout", target(plan)]);
    const bootstrap = await run("launchctl", ["bootstrap", `gui/${process.getuid()}`, plan.path]);
    if (!bootstrap.ok)
      throw Error(`launchctl could not load the Flow service: ${bootstrap.stderr}`);
    return;
  }
  const reload = await run("systemctl", ["--user", "daemon-reload"]);
  if (!reload.ok) throw Error(`systemd could not reload its user units: ${reload.stderr}`);
  const enable = await run("systemctl", ["--user", "enable", "--now", systemdUnit]);
  if (!enable.ok) throw Error(`systemd could not enable the Flow service: ${enable.stderr}`);
}

async function deactivate(plan, host, run) {
  if (host === "darwin") return void (await run("launchctl", ["bootout", target(plan)]));
  await run("systemctl", ["--user", "disable", "--now", systemdUnit]);
  await run("systemctl", ["--user", "daemon-reload"]);
}

async function loaded(plan, host, run) {
  if (host === "darwin") return (await run("launchctl", ["print", target(plan)])).ok;
  const enabled = await run("systemctl", ["--user", "is-enabled", systemdUnit]);
  const active = await run("systemctl", ["--user", "is-active", systemdUnit]);
  return enabled.ok || active.ok;
}

/**
 * The installed unit, when it is both present and current. Callers use this to
 * decide whether a lifecycle command belongs to the service manager.
 */
export async function managedService(options = {}) {
  const { host = platform(), run = spawnRunner } = options;
  const plan = await servicePlan(options);
  const installed = await readUnit(plan.path);
  if (installed === null) return null;
  const current = installed === renderUnit(plan, host);
  return { plan, current, loaded: await loaded(plan, host, run) };
}

/** Restart through the service manager, so its restart policy stays authoritative. */
export async function restartManaged(service, { host = platform(), run = spawnRunner } = {}) {
  const command =
    host === "darwin"
      ? ["launchctl", ["kickstart", "-k", target(service.plan)]]
      : ["systemctl", ["--user", "restart", systemdUnit]];
  const result = await run(...command);
  if (!result.ok) throw Error(`The Flow service could not be restarted: ${result.stderr}`);
}

export async function installService(options = {}) {
  const { host = platform(), run = spawnRunner, home } = options;
  const plan = await servicePlan(options);
  const release = await lockLauncher(plan.directory);
  try {
    // The service and the CLI must agree on where this machine's data lives.
    await configure({ name: "primary", action: "start", dev: false, home }, plan.directory);
  } finally {
    release();
  }
  const unit = renderUnit(plan, host);
  await writeDurably(plan.path, unit);
  await activate(plan, host, run);
  return { label: plan.label, unitPath: plan.path, installed: true };
}

export async function uninstallService(options = {}) {
  const { host = platform(), run = spawnRunner } = options;
  const plan = await servicePlan(options);
  await deactivate(plan, host, run);
  await rm(plan.path, { force: true });
  // Data is never touched: the instance keeps its home, brain and worktrees.
  return { label: plan.label, unitPath: plan.path, installed: false };
}

export async function serviceStatus(options = {}) {
  const { host = platform() } = options;
  const plan = await servicePlan(options);
  const service = await managedService(options);
  return {
    label: plan.label,
    unitPath: plan.path,
    installed: service !== null,
    current: service?.current ?? false,
    loaded: service?.loaded ?? false,
    instance: (await control(plan.directory)) ?? { phase: "stopped" },
  };
}

export async function service(verb, options = {}) {
  if (verb === "install")
    return console.log(JSON.stringify(await installService(options), null, 2));
  if (verb === "uninstall")
    return console.log(JSON.stringify(await uninstallService(options), null, 2));
  if (verb === "status") return console.log(JSON.stringify(await serviceStatus(options), null, 2));
  throw Error("Usage: flow service install|status|uninstall [--home PATH]");
}
