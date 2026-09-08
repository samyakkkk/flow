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
const checkInterval = 6 * 60 * 60 * 1000;
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

export function validateRelease(release) {
  if (!tagPattern.test(release.tag_name) || release.draft || release.prerelease)
    throw Error("The latest release is not a stable Flow browser release (flow-vX.Y.Z).");
  const urls = [assetName, `${assetName}.sha256`].map((name) => {
    const asset = release.assets?.find((entry) => entry.name === name);
    const expected = `https://github.com/${repository}/releases/download/${release.tag_name}/${name}`;
    if (asset?.browser_download_url !== expected) throw Error(`Release is missing ${name}.`);
    return expected;
  });
  return { tag: release.tag_name, archiveUrl: urls[0], checksumUrl: urls[1] };
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

async function download(url, fetcher = fetch) {
  const response = await fetcher(url, {
    signal: AbortSignal.timeout(120000),
    headers: { "User-Agent": "Flow-browser-installer" },
  });
  if (!response.ok) throw Error(`Download failed (${response.status}): ${url}`);
  return response;
}

export async function latestRelease(fetcher = fetch) {
  return validateRelease(
    await (
      await download(`https://api.github.com/repos/${repository}/releases/latest`, fetcher)
    ).json(),
  );
}

export function verifyArchive(bytes, checksum) {
  const expected = /^([a-fA-F0-9]{64})\s+\*?flow-source\.tar\.gz\s*$/
    .exec(checksum)?.[1]
    .toLowerCase();
  if (!expected || createHash("sha256").update(bytes).digest("hex") !== expected)
    throw Error("Flow release checksum verification failed.");
}

async function buildRelease(directory) {
  // Use the release's frozen workspace lockfile; never publish/install upstream t3.
  await run("bash", [join(directory, "scripts/install-flow.sh"), "--build-only"], directory);
  await run(process.execPath, [join(directory, "apps/server/src/bin.ts"), "--version"], directory);
}

export async function stageRelease(home, release, { fetcher = fetch, build = buildRelease } = {}) {
  const current = await json(join(home, "current", "flow-release.json"));
  if (!newerTag(release.tag, current?.tag)) return current;
  const releases = join(home, "releases");
  await fs.mkdir(releases, { recursive: true });
  const directory = join(releases, release.tag);
  let receipt = await json(join(directory, "flow-release.json"));
  if (!receipt) {
    const temporary = await fs.mkdtemp(join(releases, ".prepare-"));
    try {
      const bytes = Buffer.from(await (await download(release.archiveUrl, fetcher)).arrayBuffer());
      const checksum = await (await download(release.checksumUrl, fetcher)).text();
      verifyArchive(bytes, checksum);
      const archive = join(temporary, "source.tar.gz");
      await fs.writeFile(archive, bytes);
      const source = join(temporary, "source");
      await fs.mkdir(source);
      await run("tar", ["-xzf", archive, "-C", source], temporary);
      for (const entry of [
        "scripts/flow-release.mjs",
        "scripts/flow.mjs",
        "apps/server/src/bin.ts",
        "pnpm-lock.yaml",
      ])
        await fs.access(join(source, entry));
      await build(source);
      await fs.access(join(source, "apps/web/dist/index.html"));
      receipt = { tag: release.tag, sha256: createHash("sha256").update(bytes).digest("hex") };
      await atomic(join(source, "flow-release.json"), receipt);
      await fs.rename(source, directory);
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }
  if (receipt.tag !== release.tag) throw Error("Installed release identity does not match.");
  const link = join(home, `.current-${randomUUID()}`);
  await fs.symlink(join("releases", release.tag), link);
  await fs.rename(link, join(home, "current"));
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

export async function installLauncher(home, prefix) {
  const bin = join(prefix, "bin");
  await fs.mkdir(bin, { recursive: true });
  const target = join(bin, "flow");
  try {
    const existing = await fs.readFile(target, "utf8");
    if (!existing.includes("\n# flow-managed-launcher\n"))
      throw Error(`Refusing to overwrite ${target}. Choose another --prefix.`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  const temp = join(bin, `.flow-${randomUUID()}`);
  await fs.writeFile(
    temp,
    `#!/bin/sh\n# flow-managed-launcher\nexport FLOW_RELEASE_HOME=${quote(home)}\nexec ${quote(process.execPath)} ${quote(join(home, "current/scripts/flow-release.mjs"))} "$@"\n`,
    { mode: 0o755 },
  );
  await fs.rename(temp, target);
  console.log(`Installed ${target}. Add ${bin} to PATH, then run flow.`);
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
    await run(process.execPath, [join(code, "scripts/flow.mjs"), ...args], code);
  } finally {
    commandLock.close();
  }
}

export async function spawnReleaseCommand(home, args, onFailure = () => {}) {
  const log = openSync(join(home, "update.log"), "a", 0o600);
  const child = spawn(process.execPath, [join(home, "current/scripts/flow-release.mjs"), ...args], {
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, FLOW_RELEASE_HOME: home },
  });
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

export async function main(args) {
  const [major, minor, patch] = process.versions.node.split(".").map(Number);
  if (major !== 24 || minor < 13 || (minor === 13 && patch < 1))
    throw Error("Install Node.js 24.13.1+ (24.x) first.");
  if (
    !(
      (platform() === "darwin" && arch() === "arm64") ||
      (platform() === "linux" && arch() === "x64")
    )
  )
    throw Error("Flow's local Brain supports Apple Silicon macOS 15+ and Linux x64.");
  if (platform() === "darwin" && Number(NodeOS.release().split(".")[0]) < 24)
    throw Error("Flow's local Brain requires macOS 15 or later.");
  const requestedHome = resolve(
    process.env.FLOW_RELEASE_HOME || join(homedir(), ".local/share/flow-browser"),
  );
  await fs.mkdir(requestedHome, { recursive: true });
  const home = await fs.realpath(requestedHome);
  process.env.FLOW_INSTANCE_HOME ||= join(home, "instance-home");
  if (args[0] === "install") {
    if (args.length !== 1 && !(args.length === 3 && args[1] === "--prefix"))
      throw Error("Usage: install [--prefix DIRECTORY]");
    await update(home);
    return installLauncher(home, resolve(args[2] || join(homedir(), ".local")));
  }
  if (args[0] === "update") {
    if (args.length > 2 || (args[1] && args[1] !== "--check"))
      throw Error("Usage: flow update [--check]");
    return update(home, args[1] === "--check");
  }
  if (args[0] === "--help" || args[0] === "help")
    console.log(
      "flow update [--check]\nAutomatic preparation: at startup and every six hours while running. FLOW_AUTO_UPDATE=0 disables it.",
    );
  return launch(home, args);
}

if (process.argv[1] && (await fs.realpath(process.argv[1]).catch(() => null)) === self)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
