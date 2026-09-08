/* eslint-disable t3code/no-global-process-runtime -- Standalone Node bootstrap runs before workspace Effect services exist. */
import * as NodeFSP from "node:fs/promises";
const { mkdir, readFile, writeFile, rename, realpath, access, readdir } = NodeFSP;
import * as NodeFS from "node:fs";
const { openSync, closeSync } = NodeFS;
import * as NodePath from "node:path";
const { dirname, join, resolve } = NodePath;
import * as NodeURL from "node:url";
const { fileURLToPath } = NodeURL;
import * as NodeOS from "node:os";
const { homedir } = NodeOS;
import * as NodeCrypto from "node:crypto";
const { randomUUID } = NodeCrypto;
import * as NodeChildProcess from "node:child_process";
const { spawn, execFile } = NodeChildProcess;
import * as NodeUtil from "node:util";
const { promisify } = NodeUtil;
import * as NodeTimersPromises from "node:timers/promises";
const { setTimeout: delay } = NodeTimersPromises;
const exec = promisify(execFile);
export const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const registryRoot = () =>
  resolve(process.env.FLOW_INSTANCE_HOME || join(homedir(), ".local/share/flow-app"));
const reserved = new Set(["primary", "list", "status", "stop", "restart", "help"]);
export async function json(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
export async function atomic(path, data) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await rename(temp, path);
}
export function parse(args) {
  const input = {
    name: "primary",
    action: "start",
    dev: false,
    noOpen: false,
    replace: false,
    fresh: false,
  };
  if (args[0] === "--supervise") return { action: "supervise", directory: args[1] };
  if (args[0] === "--help" || args[0] === "help") return { action: "help" };
  if (args[0] === "dev") {
    input.dev = true;
    args = args.slice(1);
    if (["list", "status", "stop"].includes(args[0])) input.action = args.shift();
    if (input.action !== "list") {
      input.name = args.shift();
      if (!input.name || !/^[a-z][a-z0-9-]{0,47}$/.test(input.name) || reserved.has(input.name))
        throw Error("Choose a dev name using lowercase letters, digits and hyphens.");
    }
  } else if (["status", "stop", "restart"].includes(args[0])) input.action = args.shift();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--no-open") input.noOpen = true;
    else if (flag === "--replace") input.replace = true;
    else if (flag === "--fresh") input.fresh = true;
    else if (["--isolated", "--ui-only", "--shared-brain"].includes(flag)) {
      if (input.mode) throw Error("Choose only one development mode.");
      input.mode = flag.slice(2);
    } else if (["--code", "--from"].includes(flag)) {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw Error(`${flag} requires a value.`);
      input[flag.slice(2)] = value;
    } else throw Error(`Unknown option: ${flag}`);
  }
  if (!input.dev && (input.mode || input.from || input.fresh || input.code || input.replace))
    throw Error(
      "Instance configuration flags belong to flow dev NAME. Use flow restart for primary.",
    );
  if (input.fresh && (input.replace || (input.mode && input.mode !== "isolated")))
    throw Error("--fresh creates a new isolated unit; it cannot replace or share another unit.");
  if (input.mode === "isolated" && input.from) throw Error("--isolated cannot use --from.");
  if (
    input.action !== "start" &&
    (input.mode || input.from || input.fresh || input.code || input.replace)
  )
    throw Error("Configuration flags apply only when starting a development instance.");
  return input;
}
export async function control(directory, action = "status") {
  const state = await json(join(directory, "runtime.json"));
  if (!state) return null;
  const url = new URL(state.controlUrl);
  if (url.hostname !== "127.0.0.1" || url.protocol !== "http:")
    throw Error("Invalid instance control address.");
  try {
    const response = await fetch(`${url.origin}/${action}`, {
      method: "POST",
      headers: { authorization: `Bearer ${state.token}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return null;
    const result = await response.json();
    if (result.generation !== state.generation || result.id !== state.id)
      throw Error("Instance identity did not match; refusing to control it.");
    return result;
  } catch (error) {
    if (error.message?.includes("identity")) throw error;
    return null;
  }
}
export async function configure(input, directory) {
  const saved = await json(join(directory, "config.json"));
  if (saved) {
    if (input.fresh) throw Error(`${input.name} already exists. Use a new name for --fresh.`);
    if (input.code && (await realpath(resolve(input.code))) !== saved.code)
      throw Error("Use a new instance name to run a different checkout.");
    if ((input.mode && input.mode !== saved.mode) || (input.from && input.from !== saved.from))
      throw Error(
        "Use a new instance name for a different brain mode/source. --replace preserves configuration.",
      );
    return saved;
  }
  const code = await realpath(
    input.code ? resolve(input.code) : input.dev ? process.cwd() : sourceRoot,
  );
  await access(join(code, "apps/server/src/bin.ts"));
  const mode = input.mode || "isolated";
  if (input.from && mode === "isolated")
    throw Error("--from requires --shared-brain or --ui-only.");
  const from = mode === "isolated" ? undefined : input.from || "primary";
  if (from && (!/^[a-z][a-z0-9-]{0,47}$/.test(from) || from === input.name))
    throw Error("Invalid source instance.");
  const config = {
    version: 1,
    id: randomUUID(),
    name: input.name,
    code,
    mode,
    ...(from ? { from } : {}),
    dev: input.dev,
    home: join(directory, "data"),
  };
  await atomic(join(directory, "config.json"), config);
  return config;
}
export async function waitFor(directory, predicate, timeout = 120000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const status = await control(directory);
    if (status?.phase === "failed" && !predicate(status))
      throw Error(`${status.error}\nLog: ${join(directory, "runtime.log")}`);
    if (predicate(status)) return status;
    await delay(150);
  }
  throw Error(`Instance did not finish its transition. Inspect ${join(directory, "runtime.log")}`);
}
async function openBrowser(url) {
  const command =
    NodeOS.platform() === "darwin"
      ? ["open", [url]]
      : NodeOS.platform() === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  await exec(...command).catch(() => console.log(`Open ${url}`));
}
export async function lockLauncher(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const { DatabaseSync } = await import("node:sqlite");
  const mutex = new DatabaseSync(join(directory, "launcher-lock.sqlite"));
  try {
    const end = Date.now() + 180000;
    while (true) {
      try {
        mutex.exec("BEGIN EXCLUSIVE");
        return () => mutex.close();
      } catch (error) {
        if (error.errcode !== 5 || Date.now() >= end) throw error;
        await delay(100);
      }
    }
  } catch (error) {
    mutex.close();
    throw error;
  }
}
export async function start(input) {
  const directory = join(registryRoot(), "instances", input.name);
  const release = await lockLauncher(directory);
  try {
    const config = await configure(input, directory);
    let status = await control(directory);
    if (status && (input.replace || input.action === "restart" || status.phase === "failed")) {
      console.log(`Restarting ${input.name}; active turns may be interrupted. Data is preserved.`);
      await control(directory, "stop");
      await waitFor(directory, (value) => !value);
      status = null;
    }
    if (!status) {
      const log = openSync(join(directory, "runtime.log"), "a", 0o600);
      const child = spawn(
        process.execPath,
        [join(sourceRoot, "scripts/flow.mjs"), "--supervise", directory],
        { detached: true, stdio: ["ignore", log, log], env: process.env },
      );
      closeSync(log);
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
    }
    status = await waitFor(directory, (value) => value?.phase === "ready");
    console.log(
      `${config.name}: ${status.url}\nMode: ${config.mode}${config.from ? ` (uses ${config.from})` : ""}`,
    );
    const pairingConfig =
      config.mode === "ui-only"
        ? await json(join(registryRoot(), "instances", config.from, "config.json"))
        : config;
    const bin = join(pairingConfig.code, "apps/server/src/bin.ts");
    const { stdout } = await exec(
      process.execPath,
      ["--experimental-strip-types", bin, "pair", "--base-dir", pairingConfig.home],
      {
        cwd: pairingConfig.code,
        maxBuffer: 1024 * 1024,
        env: (await import("./supervisor.mjs")).cleanEnvironment(process.env),
      },
    );
    const match = /Pairing URL: (https?:\/\/\S+)/.exec(stdout);
    if (!match)
      throw Error(
        "App is ready but pairing could not be issued. Use flow status to find its address.",
      );
    const pairingUrl = new URL(match[1]);
    const frontend = new URL(status.url);
    pairingUrl.host = frontend.host;
    pairingUrl.protocol = frontend.protocol;
    if (!input.noOpen) await openBrowser(pairingUrl.toString());
    else console.log(`Pairing URL: ${pairingUrl}`);
    return status;
  } finally {
    release();
  }
}
export async function main(args) {
  const input = parse([...args]);
  if (NodeOS.platform() === "win32" && input.action !== "help")
    throw Error("The managed launcher currently supports macOS and Linux.");
  if (input.action === "supervise")
    return (await import("./supervisor.mjs")).supervise(input.directory);
  if (input.action === "help")
    return console.log(
      "flow [status|stop|restart] [--no-open]\nflow dev NAME [--isolated|--ui-only|--shared-brain] [--from primary] [--code PATH] [--replace|--fresh] [--no-open]\nflow dev list\nflow dev status NAME\nflow dev stop NAME",
    );
  if (input.action === "list") {
    const directory = join(registryRoot(), "instances");
    const names = await readdir(directory).catch((e) => {
      if (e.code === "ENOENT") return [];
      throw e;
    });
    for (const name of names) {
      const config = await json(join(directory, name, "config.json"));
      if (!config) continue;
      const status = await control(join(directory, name));
      console.log(`${name}\t${config.mode}\t${status?.phase || "stopped"}\t${status?.url || ""}`);
    }
    return;
  }
  const directory = join(registryRoot(), "instances", input.name);
  if (input.action === "status")
    return console.log((await control(directory)) || `${input.name}: stopped`);
  if (input.action === "stop") {
    const release = await lockLauncher(directory);
    try {
      const status = await control(directory, "stop");
      if (status) await waitFor(directory, (value) => !value);
      return console.log(`${input.name}: stopped`);
    } finally {
      release();
    }
  }
  return start(input);
}
