/* eslint-disable t3code/no-global-process-runtime -- Standalone Node bootstrap runs before workspace Effect services exist. */
import * as NodeOS from "node:os";
import * as NodeSqlite from "node:sqlite";
const { DatabaseSync } = NodeSqlite;
import * as NodeHttp from "node:http";
const { createServer } = NodeHttp;
import * as NodeNet from "node:net";
const { createServer: tcpServer } = NodeNet;
import * as NodeCrypto from "node:crypto";
const { randomUUID, randomBytes } = NodeCrypto;
import * as NodeChildProcess from "node:child_process";
const { spawn } = NodeChildProcess;
import * as NodeEvents from "node:events";
const { once } = NodeEvents;
import * as NodePath from "node:path";
const { join } = NodePath;
import * as NodeFSP from "node:fs/promises";
const { rm } = NodeFSP;
import * as NodeTimersPromises from "node:timers/promises";
const { setTimeout: delay } = NodeTimersPromises;
import { atomic, json, registryRoot, control, sourceRoot } from "./launcher.mjs";
import { releaseController } from "./release-control.mjs";
import { prepareAutomaticUpdate, spawnReleaseCommand } from "../flow-release.mjs";
export async function freePort() {
  const server = tcpServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
export async function releaseServerPort(directory, allocate = freePort) {
  const file = join(directory, "release-port.json");
  const saved = await json(file);
  if (saved) {
    if (!Number.isInteger(saved.port) || saved.port < 1 || saved.port > 65535)
      throw Error("Invalid saved Flow server port.");
    return saved.port;
  }
  const port = await allocate();
  await atomic(file, { port });
  return port;
}
export function cleanEnvironment(env) {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        !/^(T3CODE_|T3_SERVICE_|T3_BOOT_|VITE_|FLOW_|FALKOR_|GRAPH_|GATEWAY_|ORCHESTRATOR_|OPENCODE_WORKSPACE|DB_PATH$|JOURNAL_PATH$|PORT$|HOST$)/.test(
          key,
        ),
    ),
  );
}
export async function supervise(directory) {
  const ownership = new DatabaseSync(join(directory, "supervisor-lock.sqlite"));
  try {
    ownership.exec("BEGIN EXCLUSIVE");
  } catch {
    ownership.close();
    return;
  }
  const config = await json(join(directory, "config.json"));
  const releaseHome = config.dev ? undefined : process.env.FLOW_RELEASE_HOME;
  const updates = releaseController({
    home: releaseHome,
    code: config.code,
    restart: (onFailure) => spawnReleaseCommand(releaseHome, ["restart", "--no-open"], onFailure),
  });
  let updateTimer;
  const generation = randomUUID();
  const token = randomBytes(32).toString("hex");
  const state = {
    id: config.id,
    generation,
    name: config.name,
    phase: "starting",
    pid: process.pid,
  };
  const children = [];
  let stopping = false;
  let relay;
  const signalChild = (child, signal) => {
    if (!Number.isInteger(child.pid) || child.pid <= 0) return;
    // Only process groups created by this supervisor are ever signalled.
    try {
      process.kill(NodeOS.platform() === "win32" ? child.pid : -child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(updateTimer);
    state.phase = "stopping";
    for (const child of children) signalChild(child, "SIGTERM");
    const force = setTimeout(() => {
      for (const child of children) signalChild(child, "SIGKILL");
    }, 20000);
    force.unref();
    await Promise.all(
      children.map((child) =>
        child.exitCode !== null || child.signalCode ? undefined : once(child, "exit"),
      ),
    );
    clearTimeout(force);
    for (const child of children) signalChild(child, "SIGKILL");
    if (relay) await relay.close();
    const saved = await json(join(directory, "runtime.json"));
    if (saved?.generation === generation)
      await rm(join(directory, "runtime.json"), { force: true });
    await new Promise((resolve) => server.close(resolve));
    ownership.close();
  };
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}` || request.method !== "POST") {
      response.writeHead(401).end();
      return;
    }
    if (request.url === "/update-status" || request.url === "/apply-update") {
      const operation = request.url === "/apply-update" ? updates.apply : updates.read;
      void operation()
        .then((value) => {
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify(value));
        })
        .catch((error) => {
          response.writeHead(409, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: error.message }));
        });
      return;
    }
    if (!["/status", "/stop"].includes(request.url)) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(state));
    if (request.url === "/stop") void stop();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  await atomic(join(directory, "runtime.json"), {
    id: config.id,
    generation,
    token,
    controlUrl: `http://127.0.0.1:${server.address().port}`,
    pid: process.pid,
  });
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
  const launch = async (command, args, options = {}) => {
    const child = spawn(
      process.execPath,
      [join(sourceRoot, "scripts/instances/child-guard.mjs"), command, ...args],
      {
        cwd: config.code,
        env: cleanEnvironment(process.env),
        stdio: ["ignore", "inherit", "inherit", "ipc"],
        detached: NodeOS.platform() !== "win32",
        ...options,
      },
    );
    children.push(child);
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.once("exit", (code) => {
      if (!stopping) {
        state.phase = "failed";
        for (const peer of children) if (peer !== child) signalChild(peer, "SIGTERM");
        state.error = `An owned process exited (${code}). Run flow ${config.name === "primary" ? "restart" : `dev ${config.name} --replace`}.`;
      }
    });
    return child;
  };
  try {
    const env = cleanEnvironment(process.env);
    let source;
    if (config.from) {
      source = await control(join(registryRoot(), "instances", config.from));
      if (source?.phase !== "ready")
        throw Error(`Source ${config.from} is not ready. Start it before this instance.`);
    }
    const webPort = await freePort();
    if (config.mode === "ui-only")
      relay = await (
        await import("./ui-proxy.mjs")
      ).uiProxy(join(registryRoot(), "instances", config.from));
    const serverPort = relay
      ? relay.port
      : releaseHome
        ? await releaseServerPort(directory)
        : await freePort();
    const webUrl = `http://localhost:${config.dev ? webPort : serverPort}`;
    let origin;
    if (config.mode !== "ui-only") {
      if (config.mode === "shared-brain") {
        const sourceConfig = await json(
          join(registryRoot(), "instances", config.from, "config.json"),
        );
        env.FLOW_SHARED_BRAIN_HOME = join(sourceConfig.home, "userdata");
      }
      env.FLOW_MANAGED_INSTANCE_ID = config.id;
      if (releaseHome) {
        env.FLOW_RELEASE_CONTROL_URL = `http://127.0.0.1:${server.address().port}`;
        env.FLOW_RELEASE_CONTROL_TOKEN = token;
      }
      env.T3CODE_HOME = config.home;
      env.T3CODE_DEV_ALLOWED_ORIGINS = webUrl;
      await launch(
        process.execPath,
        [
          "--experimental-strip-types",
          join(config.code, "apps/server/src/bin.ts"),
          // Release directories are application code, never user projects.
          ...(releaseHome ? ["serve"] : []),
          "--base-dir",
          config.home,
          "--port",
          String(serverPort),
          "--host",
          "127.0.0.1",
          ...(config.dev ? ["--dev-url", webUrl] : []),
          "--no-browser",
        ],
        { cwd: join(config.code, "apps/server"), env },
      );
      origin = `http://127.0.0.1:${serverPort}`;
    } else origin = source.origin;
    // UI-only attaches to the existing backend. No server is started against its home.
    if (config.dev)
      await launch(
        join(config.code, "node_modules/.bin/vp"),
        ["dev", "--port", String(webPort), "--strictPort"],
        {
          cwd: join(config.code, "apps/web"),
          env: {
            ...env,
            PORT: String(webPort),
            T3CODE_PORT: String(serverPort),
            T3CODE_SINGLE_ORIGIN_DEV: "1",
          },
        },
      );
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      if (stopping) break;
      if (state.phase === "failed") throw Error(state.error);
      try {
        const descriptor = await fetch(`${webUrl}/.well-known/t3/environment`, {
          signal: AbortSignal.timeout(1500),
        });
        if (descriptor.ok) {
          const remote = await descriptor.json();
          const runtime =
            config.mode === "ui-only"
              ? source
              : await json(join(config.home, "userdata/server-runtime.json"));
          if (runtime && remote.environmentId) {
            Object.assign(state, {
              phase: "ready",
              url: webUrl,
              origin,
              environmentId: remote.environmentId,
              home: config.home,
            });
            break;
          }
        }
      } catch {
        /* Startup is still publishing its endpoint. */
      }
      await delay(200);
    }
    if (!stopping && state.phase !== "ready")
      throw Error("Chat and brain did not become ready before the startup deadline.");
    if (!stopping && releaseHome) {
      const check = () => void prepareAutomaticUpdate(releaseHome).catch(console.error);
      check();
      updateTimer = setInterval(check, 6 * 60 * 60 * 1000);
      updateTimer.unref();
    }
  } catch (error) {
    state.phase = "failed";
    state.error = error.message;
    console.error(error);
    for (const child of children) signalChild(child, "SIGTERM");
  }
}
