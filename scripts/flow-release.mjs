#!/usr/bin/env node
import * as NodeFSP from "node:fs/promises";
const fs = NodeFSP;
import * as NodeFS from "node:fs";
const { openSync, closeSync } = NodeFS;
import * as NodePath from "node:path";
const { join, resolve } = NodePath;
import * as NodeOS from "node:os";
const { homedir, platform, arch } = NodeOS;
import * as NodeURL from "node:url";
const { fileURLToPath, pathToFileURL } = NodeURL;
import * as NodeCrypto from "node:crypto";
const { createHash, randomUUID } = NodeCrypto;
import * as NodeChildProcess from "node:child_process";
const { spawn } = NodeChildProcess;
import * as NodeSqlite from "node:sqlite";
const { DatabaseSync } = NodeSqlite;

const repository = "samyakkkk/flow";
const tagPattern = /^flow-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const assetName = "flow-source.tar.gz";
const macAssetName = "flow-browser-darwin-arm64.tar.gz";
const bundledAssets = {
  "darwin-arm64": macAssetName,
  "linux-x64": "flow-browser-linux-x64.tar.gz",
  // No native graph database exists for Windows, so this bundle carries none:
  // the computer connects to a Cloud Brain instead of hosting one.
  "win32-x64": "flow-browser-win32-x64.tar.gz",
};
const windows = platform() === "win32";
/** Where a bundle keeps its private Node and Git, which differ on Windows. */
export const bundledNode = (directory, win = windows) =>
  join(directory, win ? "runtime/bin/node.exe" : "runtime/bin/node");
export const bundledGit = (directory, win = windows) =>
  join(directory, win ? "runtime/git/cmd/git.exe" : "runtime/git/bin/git");
// Git for Windows puts a GNU tar on PATH that reads `C:` as a remote host; the
// one Windows ships understands drive letters.
const tar = windows ? join(process.env.SystemRoot || "C:\\Windows", "System32/tar.exe") : "tar";
const checkInterval = 6 * 60 * 60 * 1000;
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const self = fileURLToPath(import.meta.url);

async function json(path) {
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function atomic(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value) + "\n", { mode: 0o600 });
  await fs.rename(temp, path);
}

export function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0 ? resolve() : reject(Error(`${command} failed (${signal || code}).`)),
    );
  });
}

export function validateRelease(release, target = { platform: platform(), arch: arch() }) {
  if (!tagPattern.test(release.tag_name) || release.draft || release.prerelease)
    throw Error("The latest release is not a stable Flow browser release (flow-vX.Y.Z).");
  const bundledAsset = bundledAssets[`${target.platform}-${target.arch}`];
  const selectedAsset =
    bundledAsset && release.assets?.some((entry) => entry.name === bundledAsset)
      ? bundledAsset
      : assetName;
  const urls = [selectedAsset, `${selectedAsset}.sha256`].map((name) => {
    const asset = release.assets?.find((entry) => entry.name === name);
    const expected = `https://github.com/${repository}/releases/download/${release.tag_name}/${name}`;
    if (asset?.browser_download_url !== expected) throw Error(`Release is missing ${name}.`);
    return expected;
  });
  return {
    tag: release.tag_name,
    archiveUrl: urls[0],
    checksumUrl: urls[1],
    assetName: selectedAsset,
  };
}

export function newerTag(candidate, current) {
  if (!tagPattern.test(candidate) || (current && !tagPattern.test(current)))
    throw Error("Invalid Flow release version.");
  if (!current) return true;
  const a = candidate.slice(6).split(".").map(BigInt);
  const b = current.slice(6).split(".").map(BigInt);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

async function download(url, fetcher = fetch, timeout = 120000) {
  const response = await fetcher(url, {
    signal: AbortSignal.timeout(timeout),
    headers: { "User-Agent": "Flow-browser-installer" },
  });
  if (!response.ok) throw Error(`Download failed (${response.status}): ${url}`);
  return response;
}

export async function latestRelease(fetcher = fetch) {
  const releases = await (
    await download(`https://api.github.com/repos/${repository}/releases?per_page=100`, fetcher)
  ).json();
  if (!Array.isArray(releases)) throw Error("GitHub returned an invalid Flow release feed.");

  const stableBrowserReleases = releases.filter(
    (release) =>
      release &&
      tagPattern.test(release.tag_name) &&
      release.draft !== true &&
      release.prerelease !== true,
  );
  const latest = stableBrowserReleases.reduce(
    (selected, release) =>
      selected === undefined || newerTag(release.tag_name, selected.tag_name) ? release : selected,
    undefined,
  );
  if (!latest) throw Error("No stable Flow browser release (flow-vX.Y.Z) is available.");
  return validateRelease(latest);
}

export function verifyArchive(bytes, checksum, name = assetName) {
  const match = /^([a-fA-F0-9]{64})\s+\*?(\S+)\s*$/.exec(checksum);
  const expected =
    match && match[2] === name && [assetName, ...Object.values(bundledAssets)].includes(name)
      ? match[1].toLowerCase()
      : null;
  if (!expected || createHash("sha256").update(bytes).digest("hex") !== expected)
    throw Error("Flow release checksum verification failed.");
}

async function buildRelease(directory) {
  if (await verifyBundle(directory)) return;
  // Use the release's frozen workspace lockfile; never publish/install upstream t3.
  await run("bash", [join(directory, "scripts/install-flow.sh"), "--build-only"], directory);
  await run(process.execPath, [join(directory, "apps/server/src/bin.ts"), "--version"], directory);
}

export async function verifyBundle(directory) {
  const bundle = await json(join(directory, "flow-bundle.json"));
  if (!bundle) return null;
  if (
    bundle.format !== 1 ||
    bundle.platform !== platform() ||
    bundle.arch !== arch() ||
    !tagPattern.test(bundle.tag)
  )
    throw Error("This Flow bundle does not support this platform.");
  await fs.access(bundledNode(directory), NodeFS.constants.X_OK);
  await fs.access(bundledGit(directory), NodeFS.constants.X_OK);
  await fs.access(join(directory, "apps/web/dist/index.html"));
  await run(
    bundledNode(directory),
    [join(directory, "apps/server/src/bin.ts"), "--version"],
    directory,
  );
  return bundle;
}

export async function releaseRuntime(directory) {
  const bundled = bundledNode(directory);
  return (await fs.stat(bundled).catch(() => null)) ? bundled : process.execPath;
}

/** Move a release into place. On Windows a rename fails while anything still
    holds a handle inside the directory, and a just-exited program or an
    antivirus scan of it does for a moment; retrying briefly is the remedy. */
export async function moveDirectory(
  from,
  to,
  { rename = fs.rename, attempts = 40, wait = 250 } = {},
) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await rename(from, to);
    } catch (error) {
      if (!["EPERM", "EBUSY", "EACCES"].includes(error.code) || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

/** Make `<home>/current` name this release. A relative symlink swapped in by
    rename is atomic on POSIX. Windows needs a privilege to create symlinks and
    cannot rename over a directory link, so it uses a junction and replaces it
    in two steps; `rmdir` removes only the junction, never what it points at. */
export async function pointCurrent(home, target, win = windows) {
  const current = join(home, "current");
  const link = join(home, `.current-${randomUUID()}`);
  if (!win) {
    await fs.symlink(NodePath.relative(home, target), link);
    return fs.rename(link, current);
  }
  await fs.symlink(resolve(target), link, "junction");
  await fs.rmdir(current).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  await fs.rename(link, current);
}

/** Recreate the directory links a Windows bundle records instead of shipping
    (see bundle-links.mjs for why). Safe to repeat: a release is verified where
    it is staged and linked again once renamed into place, because a junction
    does not follow its directory. Lives here, not beside recordLinks, because
    this file is also shipped alone as the desktop apps' bootstrap. */
export const linkManifest = "flow-links.json";
export async function restoreLinks(root, type = "junction") {
  const links = await json(join(root, linkManifest));
  if (!links) return 0;
  for (const link of links) {
    const path = resolve(root, link.path);
    const target = resolve(NodePath.dirname(path), link.target);
    for (const resolved of [path, target])
      if (NodePath.relative(root, resolved).startsWith(".."))
        throw Error(`Bundle link leaves the release: ${link.path}`);
    const existing = await fs.lstat(path).catch(() => null);
    if (existing && !existing.isSymbolicLink())
      throw Error(`Bundle link would replace real files: ${link.path}`);
    // rm without `recursive` removes the link itself, never its target.
    if (existing) await fs.rm(path);
    await fs.mkdir(NodePath.dirname(path), { recursive: true });
    await fs.symlink(target, path, type);
  }
  return links.length;
}

export async function adoptBundle(home, directory, checksum) {
  // A Windows bundle ships its directory links as a manifest (bundle-links.mjs).
  await restoreLinks(directory);
  const bundle = await verifyBundle(directory);
  if (!bundle || !/^[a-f0-9]{64}$/.test(checksum)) throw Error("Invalid verified Flow bundle.");
  const lock = new DatabaseSync(join(home, "update-lock.sqlite"));
  try {
    lock.exec("BEGIN EXCLUSIVE");
    const current = await json(join(home, "current/flow-release.json"));
    if (current && newerTag(current.tag, bundle.tag))
      throw Error("A newer Flow version is already installed.");
    if (current?.tag === bundle.tag && (await json(join(home, "current/flow-bundle.json"))))
      return current;
    const releases = join(home, "releases");
    await fs.mkdir(releases, { recursive: true });
    const target = join(releases, `${bundle.tag}-${bundle.platform}-${bundle.arch}`);
    const receipt = { tag: bundle.tag, sha256: checksum };
    const existing = await json(join(target, "flow-release.json"));
    if (existing && existing.sha256 !== checksum)
      throw Error("Release already exists with a different checksum.");
    if (!existing) {
      await atomic(join(directory, "flow-release.json"), receipt);
      await moveDirectory(directory, target);
      // Junctions are absolute, so the rename left them pointing at staging.
      await restoreLinks(target);
    }
    await pointCurrent(home, target);
    return receipt;
  } finally {
    lock.close();
  }
}

export async function stageRelease(home, release, { fetcher = fetch, build = buildRelease } = {}) {
  const current = await json(join(home, "current", "flow-release.json"));
  if (!newerTag(release.tag, current?.tag)) return current;
  const releases = join(home, "releases");
  await fs.mkdir(releases, { recursive: true });
  const directory = join(
    releases,
    Object.values(bundledAssets).includes(release.assetName)
      ? `${release.tag}-${platform()}-${arch()}`
      : release.tag,
  );
  let receipt = await json(join(directory, "flow-release.json"));
  if (!receipt) {
    const temporary = await fs.mkdtemp(join(releases, ".prepare-"));
    try {
      const bytes = Buffer.from(
        await (await download(release.archiveUrl, fetcher, 900000)).arrayBuffer(),
      );
      const checksum = await (await download(release.checksumUrl, fetcher)).text();
      verifyArchive(bytes, checksum, release.assetName || assetName);
      const archive = join(temporary, "source.tar.gz");
      await fs.writeFile(archive, bytes);
      const source = join(temporary, "source");
      await fs.mkdir(source);
      await run(tar, ["-xzf", archive, "-C", source], temporary);
      for (const entry of [
        "scripts/flow-release.mjs",
        "scripts/flow.mjs",
        "apps/server/src/bin.ts",
        "pnpm-lock.yaml",
      ])
        await fs.access(join(source, entry));
      const bundle = await json(join(source, "flow-bundle.json"));
      if (bundle && bundle.tag !== release.tag)
        throw Error("Bundle version does not match release.");
      if (Object.values(bundledAssets).includes(release.assetName) && !bundle)
        throw Error("Release is missing its prebuilt bundle.");
      await restoreLinks(source);
      await build(source);
      await fs.access(join(source, "apps/web/dist/index.html"));
      receipt = { tag: release.tag, sha256: createHash("sha256").update(bytes).digest("hex") };
      await atomic(join(source, "flow-release.json"), receipt);
      await moveDirectory(source, directory);
      await restoreLinks(directory);
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }
  if (receipt.tag !== release.tag) throw Error("Installed release identity does not match.");
  await pointCurrent(home, directory);
  return receipt;
}

export async function update(home, checkOnly = false) {
  await fs.mkdir(home, { recursive: true });
  const lock = new DatabaseSync(join(home, "update-lock.sqlite"));
  try {
    try {
      lock.exec("BEGIN EXCLUSIVE");
    } catch (error) {
      if (error.errcode === 5) throw Error("Another Flow update is in progress.", { cause: error });
      throw error;
    }
    await atomic(join(home, "last-check.json"), { at: Date.now() });
    const release = await latestRelease();
    const current = await json(join(home, "current", "flow-release.json"));
    if (!newerTag(release.tag, current?.tag))
      return console.log(`Flow ${current.tag} is up to date.`);
    if ((await json(join(home, "current/flow-bundle.json"))) && release.assetName === assetName)
      throw Error("This release does not contain a ready-built package for this platform.");
    if (checkOnly)
      return console.log(`Flow ${release.tag} is available. Run flow update to prepare it.`);
    console.log(`Preparing Flow ${release.tag}…`);
    await stageRelease(home, release);
    console.log(
      `Flow ${release.tag} is ready. Running instances stay on their current version until stopped or explicitly restarted.`,
    );
  } finally {
    lock.close();
  }
}

// One Flow install per machine, in the folder install.sh and the desktop apps
// have always used. The retired Cloud CLI installed elsewhere; its hooks and
// service unit record absolute paths, so such an install is adopted where it
// is rather than moved. Desktop apps resolve the same way
// (apps/desktop/src/backend/serviceDiscovery.ts), as does install.sh.
export const releaseHomeNames = ["flow-browser", "flow-cloud-cli"];
export async function resolveReleaseHome(env = process.env, homeDirectory = homedir()) {
  if (env.FLOW_RELEASE_HOME) return resolve(env.FLOW_RELEASE_HOME);
  const share = join(homeDirectory, ".local/share");
  for (const name of releaseHomeNames)
    if (await fs.stat(join(share, name, "current")).catch(() => null)) return join(share, name);
  return join(share, releaseHomeNames[0]);
}

/** The text of the `flow` command for this installation. Windows gets a batch
    file: `%~dp0`-free and fully quoted, since a home may contain spaces. */
export function launcherScript(home, node, win = windows) {
  const entry = join(home, "current/scripts/flow-release.mjs");
  // Node prints an ExperimentalWarning for node:sqlite on every run; it is
  // noise in front of the one line a person is looking for.
  return win
    ? `@echo off\r\nrem flow-managed-launcher\r\nset "FLOW_RELEASE_HOME=${home}"\r\n"${node}" --disable-warning=ExperimentalWarning "${entry}" %*\r\n`
    : `#!/bin/sh\n# flow-managed-launcher\nexport FLOW_RELEASE_HOME=${quote(home)}\nexec ${quote(node)} --disable-warning=ExperimentalWarning ${quote(entry)} "$@"\n`;
}
const launcherName = (win = windows) => (win ? "flow.cmd" : "flow");
const managedLauncher = /(?:^|\n)(?:# |rem )flow-(?:managed|cloud-cli)-launcher\r?\n/;

export async function installLauncher(home, prefix, announce = true) {
  const bin = join(prefix, "bin");
  await fs.mkdir(bin, { recursive: true });
  const target = join(bin, launcherName());
  try {
    const existing = await fs.readFile(target, "utf8");
    if (!managedLauncher.test(existing))
      throw Error(`Refusing to overwrite ${target}. Choose another --prefix.`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temp = join(bin, `.flow-${randomUUID()}`);
  await fs.writeFile(temp, launcherScript(home, await releaseRuntime(join(home, "current"))), {
    mode: 0o755,
  });
  await fs.rename(temp, target);
  if (announce) console.log(`Installed ${target}. Add ${bin} to PATH, then run flow.`);
}

/** Take Flow off this machine: unregister the coding tools, stop and remove the
    service, then delete the installation. `purge` also deletes its data. The
    order matters — the registrations and the service are removed while this
    installation still exists to do it. */
export async function uninstall(home, purge) {
  const instances = join(
    process.env.FLOW_INSTANCE_HOME || join(home, "instance-home"),
    "instances",
  );
  const dataHomes = [];
  for (const name of await fs.readdir(instances).catch(() => [])) {
    const config = await json(join(instances, name, "config.json"));
    if (config?.home) dataHomes.push(config.home);
  }
  const step = async (label, args) => {
    try {
      await main(args);
    } catch (error) {
      // A half-installed or already-stopped Flow must not block the rest.
      console.error(`Could not ${label}: ${error.message}`);
    }
  };
  await step("unregister Flow from your coding tools", ["agents", "uninstall"]);
  await step("stop the Flow service", ["stop"]);
  if (!windows) await step("remove the Flow service", ["service", "uninstall"]);

  const { removed, kept, deferred } = await removeInstallation(home, { purge, dataHomes });
  for (const path of removed) console.log(`Removed ${path}`);
  if (deferred.length) {
    // `rmdir` removes a junction itself, never the directory it points at.
    const paths = [...new Set([...deferred, ...(kept.length ? [] : [home])])];
    const script = [
      "ping -n 3 127.0.0.1 >nul",
      ...paths.map((path) => `rmdir /s /q "${path}" 2>nul & del /f /q "${path}" 2>nul`),
    ].join(" & ");
    spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${script}"`], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      windowsVerbatimArguments: true,
      cwd: homedir(),
    }).unref();
    for (const path of deferred) console.log(`Removing ${path} as this command exits`);
  }
  for (const path of kept) console.log(`Kept ${path}`);
  console.log(
    purge
      ? "Flow is uninstalled and its data is gone."
      : "Flow is uninstalled. Your projects, conversations and Brains are kept; `flow uninstall --purge` deletes those too.",
  );
}

/** Every `flow` command this installation owns: `<home>/bin/flow` plus whatever
    it wrote onto PATH. A launcher belonging to another installation, or a
    `flow` that is somebody else’s program, is never touched. */
async function ownedLaunchers(home, path = process.env.PATH || "") {
  const name = launcherName();
  const candidates = new Set([join(home, "bin", name), join(homedir(), ".local/bin", name)]);
  for (const directory of path.split(NodePath.delimiter))
    if (directory) candidates.add(join(directory, name));
  const owned = [];
  for (const file of candidates) {
    const text = await fs.readFile(file, "utf8").catch(() => null);
    // Owned means ours *and* pointing at this home, in either launcher form.
    if (
      text &&
      managedLauncher.test(text) &&
      (text.includes(`FLOW_RELEASE_HOME=${quote(home)}`) ||
        text.includes(`"FLOW_RELEASE_HOME=${home}"`))
    )
      owned.push(file);
  }
  return owned;
}

/** Where a data home keeps its graph database: a hash of the Brain directory,
    because FalkorDB needs a short socket path (apps/server/src/brain/BrainRuntime.ts). */
export const brainStore = (dataHome) =>
  join(
    homedir(),
    ".flow-brain",
    createHash("sha256").update(join(dataHome, "userdata/brain")).digest("hex").slice(0, 12),
  );

/** Delete this installation from disk. Without `purge` the program goes and
    every data home stays, including one that lives inside the installation.
    With `purge` the conversations, Brains and agent registrations go too —
    nothing restores them. Retired backups are always kept: they are the only
    copy of files Flow changed outside itself. */
export async function removeInstallation(
  home,
  {
    purge = false,
    dataHomes = [],
    agentHome = process.env.FLOW_AGENT_HOME || join(homedir(), ".flow"),
    ...rest
  } = {},
) {
  const removed = [];
  const kept = [];
  // Windows will not delete a program that is running, and `flow uninstall`
  // runs on the Node inside the installation. What is locked is left for the
  // caller to remove once this process has exited.
  const deferred = [];
  const remove = rest.remove ?? ((target) => fs.rm(target, { recursive: true, force: true }));
  const drop = async (target) => {
    if (!(await fs.lstat(target).catch(() => null))) return;
    try {
      await remove(target);
      removed.push(target);
    } catch (error) {
      if (!["EBUSY", "EPERM", "ENOTEMPTY"].includes(error.code)) throw error;
      deferred.push(target);
    }
  };
  for (const launcher of await ownedLaunchers(home, rest.path)) await drop(launcher);
  const app = await retireBrowserApp(home, rest.applicationsDir);
  if (app) removed.push(app);

  if (purge) {
    for (const dataHome of dataHomes) {
      await drop(brainStore(dataHome));
      await drop(dataHome);
    }
    // `retired/` holds the only copy of files Flow replaced elsewhere on this
    // machine, so it outlives the installation that made it.
    for (const entry of await fs.readdir(agentHome).catch(() => []))
      if (entry === "retired") kept.push(join(agentHome, entry));
      else await drop(join(agentHome, entry));
    if (!kept.length) await drop(agentHome);
    await drop(home);
    return { removed, kept, deferred };
  }

  // Keep every data home, including one stored inside this installation.
  const inside = dataHomes.filter((dataHome) => resolve(dataHome).startsWith(home + NodePath.sep));
  for (const entry of await fs.readdir(home).catch(() => []))
    if (
      inside.some(
        (dataHome) =>
          resolve(dataHome).startsWith(join(home, entry) + NodePath.sep) ||
          resolve(dataHome) === join(home, entry),
      )
    )
      kept.push(join(home, entry));
    else await drop(join(home, entry));
  if (!kept.length && !deferred.length) await drop(home);
  else kept.push(...inside);
  return { removed, kept: [...new Set(kept)], deferred };
}

/** Installs before this one added a `Flow.app` that only opened the browser UI.
    `flow` opens your browser directly, so the launcher is removed — but only
    the one this installation wrote, never a desktop app or another install’s. */
export async function retireBrowserApp(
  home,
  directory = process.env.FLOW_APPLICATIONS_DIR || join(homedir(), "Applications"),
) {
  const target = join(directory, "Flow.app");
  const owner = await fs
    .readFile(join(target, "Contents/flow-browser-launcher"), "utf8")
    .catch(() => null);
  if (owner?.trim() !== home) return null;
  await fs.rm(target, { recursive: true, force: true });
  return target;
}

// `<home>/bin/flow` always works. The command on PATH is taken only when it is
// free or already ours, unless the caller named the prefix and so expects it.
async function installLaunchers(home, prefix, announce = true) {
  await installLauncher(home, home, false);
  try {
    await installLauncher(home, resolve(prefix || join(homedir(), ".local")), announce);
  } catch (error) {
    if (prefix) throw error;
    console.log(`Another flow command is already installed. Use ${join(home, "bin/flow")}.`);
  }
}

export async function selectPrimaryRelease({ directory, home, launcher }) {
  home = await fs.realpath(home);
  const config = await json(join(directory, "config.json"));
  const running = await launcher.control(directory);
  const code = await fs.realpath(join(home, "current"));
  if (config && !config.code.startsWith(join(home, "releases") + "/"))
    throw Error(
      "The primary instance belongs to a source checkout. Use a separate FLOW_INSTANCE_HOME for this release installation.",
    );
  if (config && !running && config.code !== code) {
    // An unreachable control endpoint alone is not proof the process stopped.
    const ownership = new DatabaseSync(join(directory, "supervisor-lock.sqlite"));
    try {
      try {
        ownership.exec("BEGIN EXCLUSIVE");
      } catch (error) {
        if (error.errcode === 5) return config.code;
        throw error;
      }
      await atomic(join(directory, "config.json"), { ...config, code });
    } finally {
      ownership.close();
    }
  }
  return running && config ? config.code : code;
}

async function launch(home, args) {
  const current = await fs.realpath(join(home, "current"));
  const launcher = await import(pathToFileURL(join(current, "scripts/instances/launcher.mjs")));
  const input = launcher.parse([...args]);
  let code = current;
  const commandLock = new DatabaseSync(join(home, "command-lock.sqlite"));
  try {
    commandLock.exec("PRAGMA busy_timeout = 180000");
    commandLock.exec("BEGIN EXCLUSIVE");
    if (!input.dev && ["start", "restart"].includes(input.action)) {
      const directory = join(launcher.registryRoot(), "instances/primary");
      const releaseLock = await launcher.lockLauncher(directory);
      try {
        // Check ownership before an explicit restart can stop anything.
        await selectPrimaryRelease({ directory, home, launcher });
        // Only an explicit restart may stop the running primary. Select its new
        // code after it has stopped, preserving the same identity and data home.
        if (input.action === "restart") {
          await launcher.control(directory, "stop");
          await launcher.waitFor(directory, (status) => !status);
        }
        code = await selectPrimaryRelease({ directory, home, launcher });
      } finally {
        releaseLock();
      }
    }
    const runtime = await releaseRuntime(code);
    const tools = join(home, "tools");
    if (await json(join(code, "flow-bundle.json"))) {
      // Provider CLI installs must survive replacing the versioned app/runtime.
      process.env.npm_config_prefix ||= process.env.NPM_CONFIG_PREFIX || tools;
    }
    process.env.PATH = [
      NodePath.dirname(runtime),
      NodePath.dirname(bundledGit(code)),
      join(tools, "bin"),
      join(homedir(), ".local/bin"),
      process.env.PATH || "",
    ].join(NodePath.delimiter);
    await run(
      runtime,
      ["--disable-warning=ExperimentalWarning", join(code, "scripts/flow.mjs"), ...args],
      code,
    );
  } finally {
    commandLock.close();
  }
}

export async function spawnReleaseCommand(home, args, onFailure = () => {}) {
  const log = openSync(join(home, "update.log"), "a", 0o600);
  const child = spawn(
    await releaseRuntime(join(home, "current")),
    [join(home, "current/scripts/flow-release.mjs"), ...args],
    {
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, FLOW_RELEASE_HOME: home },
    },
  );
  closeSync(log);
  child.once("exit", (code) => {
    if (code !== 0) onFailure();
  });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
}

export async function prepareAutomaticUpdate(home) {
  if (process.env.FLOW_AUTO_UPDATE === "0") return;
  const checked = await json(join(home, "last-check.json"));
  if (!checked || Date.now() - checked.at >= checkInterval)
    await spawnReleaseCommand(home, ["update"]);
}

export const usage = `Flow — local and Cloud Brains, one service for the CLI, browser and desktop apps.
flow [--web|--no-open]       Start or reuse Flow and open it
flow setup [--harness detected|all|claude,codex,…]   Install Flow's tools for your coding agents
flow setup --brain ID [--folder PATH]               Bind a folder to a Brain
flow setup --cloud URL --cloud-brain ID --enrollment-file FILE [--folder PATH]
flow brains list
flow brains create --name NAME --cli claude|codex|opencode
flow agents install|uninstall|resolve|status|doctor|flush|remove [--folder PATH]
flow status | flow stop | flow restart | flow service install|status|uninstall
flow update [--check]        Updates also prepare at startup and every six hours; FLOW_AUTO_UPDATE=0 disables that.
flow uninstall [--purge]     Remove Flow from this computer; --purge also deletes its data
The packaged CLI includes Node.`;

export function normalizeArgs(args) {
  if (args.length === 1 && args[0] === "--web") return [];
  if (args[0] === "doctor") return ["agents", ...args];
  // Lifecycle commands report and return; they never open a window.
  if (["status", "stop", "restart"].includes(args[0]))
    return args.includes("--no-open") ? args : [...args, "--no-open"];
  if (args[0] !== "setup") return args;
  if (args.includes("--local") && args.includes("--cloud"))
    throw Error("Choose --local or --cloud, not both.");
  const setup = args.flatMap((arg) => (arg === "--local" ? ["--local", "true"] : [arg]));
  // Without a Brain, setup installs machine-level tools; folders bind later.
  if (!setup.includes("--harness") && !setup.includes("--brain") && !setup.includes("--cloud"))
    setup.push("--harness", "detected");
  return setup;
}

// Installed hook shims are copies; keep them matching the code that now runs.
async function refreshAgentShims(agentHome) {
  const shims = join(agentHome, "bin");
  if (!(await fs.stat(shims).catch(() => null))) return;
  const source = join(NodePath.dirname(self), "../flow-t3/shared/bin/harness");
  for (const [from, to] of [
    ["flow-hook.mjs", "flow-hook"],
    ...[
      "agent-connector.mjs",
      "capture-replay.mjs",
      "agent-home.mjs",
      "cloud-setup.mjs",
      "resolve.mjs",
      "routing.mjs",
    ].map((name) => [name, name]),
  ]) {
    if (!(await fs.stat(join(source, from)).catch(() => null))) return;
    const temporary = join(shims, `.${to}-${randomUUID()}`);
    await fs.copyFile(join(source, from), temporary);
    await fs.rename(temporary, join(shims, to));
  }
}

export async function main(args) {
  if (args[0] === "--help" || args[0] === "help") return console.log(usage);
  args = normalizeArgs(args);
  const requestedHome = await resolveReleaseHome();
  process.env.FLOW_RELEASE_HOME = requestedHome;
  process.env.FLOW_INSTANCE_HOME ||= join(requestedHome, "instance-home");
  // Installs made by the retired Cloud CLI keep their hooks under the CLI home,
  // as copies that only this entry point refreshes. The machine-wide `~/.flow`
  // is owned by the running service and is never touched from here.
  const cloudAgentHome = join(requestedHome, "agents");
  if (!process.env.FLOW_AGENT_HOME && (await fs.stat(cloudAgentHome).catch(() => null))) {
    process.env.FLOW_AGENT_HOME = cloudAgentHome;
    await refreshAgentShims(cloudAgentHome);
  }
  if (args[0] === "setup" || args[0] === "agents" || args[0] === "brains") {
    if ((args[0] === "setup" || args[0] === "brains") && !args.includes("--state-dir")) {
      await main(["--no-open"]);
      const { primaryStateDir } = await import("./instances/service-discovery.mjs");
      args = [...args, "--state-dir", await primaryStateDir(process.env.FLOW_INSTANCE_HOME)];
    }
    if (args[0] === "brains") {
      const { manageBrains } = await import("./cli-brains.mjs");
      return manageBrains(args.slice(1));
    }
    const connector = await import("../flow-t3/shared/bin/harness/agent-connector.mjs");
    return connector.main(args[0] === "agents" ? args.slice(1) : args);
  }

  const [major, minor, patch] = process.versions.node.split(".").map(Number);
  if (major !== 24 || minor < 13 || (minor === 13 && patch < 1))
    throw Error("Install Node.js 24.13.1+ (24.x) first.");
  if (
    !(
      (platform() === "darwin" && arch() === "arm64") ||
      (platform() === "linux" && arch() === "x64") ||
      (platform() === "win32" && arch() === "x64")
    )
  )
    throw Error("Flow supports Apple Silicon macOS 15+, Linux x64 and Windows x64.");
  if (platform() === "darwin" && Number(NodeOS.release().split(".")[0]) < 24)
    throw Error("Flow's local Brain requires macOS 15 or later.");
  await fs.mkdir(requestedHome, { recursive: true, mode: 0o700 });
  const home = await fs.realpath(requestedHome);
  if (args[0] === "install-bundle") {
    if (args.length !== 3 && !(args.length === 5 && args[3] === "--prefix"))
      throw Error("Usage: install-bundle DIRECTORY CHECKSUM [--prefix DIRECTORY]");
    await adoptBundle(home, resolve(args[1]), args[2]);
    await retireBrowserApp(home);
    return installLaunchers(home, args[4], false);
  }
  if (args[0] === "install") {
    if (args.length !== 1 && !(args.length === 3 && args[1] === "--prefix"))
      throw Error("Usage: install [--prefix DIRECTORY]");
    await update(home);
    return installLaunchers(home, args[2]);
  }
  if (args[0] === "update") {
    if (args.length > 2 || (args[1] && args[1] !== "--check"))
      throw Error("Usage: flow update [--check]");
    return update(home, args[1] === "--check");
  }
  if (args[0] === "uninstall") {
    if (args.length > 2 || (args[1] && args[1] !== "--purge"))
      throw Error("Usage: flow uninstall [--purge]");
    return uninstall(home, args[1] === "--purge");
  }
  return launch(home, args);
}

if (process.argv[1] && (await fs.realpath(process.argv[1]).catch(() => null)) === self)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
