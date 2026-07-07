// lib/docker.mjs — FalkorDB provisioning for `flow up`.
//
// The ONLY thing Flow runs in Docker is FalkorDB (its graph database). Flow's
// own services (gateway / orchestrator / dashboard) run natively via `flow up`.
// If you already run FalkorDB — a container from a previous run, a native
// build, Colima/OrbStack, or a remote instance via FALKOR_HOST — Flow uses it
// and never touches Docker at all.
//
// Container name: flow-falkordb   Image: falkordb/falkordb:latest   Port: 6379

import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";

const CONTAINER_NAME = "flow-falkordb";
const IMAGE = "falkordb/falkordb:latest";
const HOST = process.env.FALKOR_HOST ?? "localhost";
const PORT = Number(process.env.FALKOR_PORT ?? 6379);

// A friendly, already-explained setup problem. flow.mjs's top-level catch prints
// err.message behind a ✗ — so these read as guidance, not a stack trace.
class SetupError extends Error {}

function isLocalHost(h) {
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

function docker(args, opts = {}) {
  return spawnSync("docker", args, { encoding: "utf-8", ...opts });
}

function dockerInstalled() {
  return docker(["--version"]).status === 0;
}

function dockerDaemonUp() {
  return docker(["info"], { stdio: ["ignore", "ignore", "ignore"] }).status === 0;
}

// Is something already accepting connections on FalkorDB's port?
function portOpen(host, port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port });
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

async function waitForPort(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portOpen(host, port)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function notReadyError() {
  // Container came up but never opened the port — surface why instead of a
  // silent 20s stall followed by "gateway didn't start".
  const logs = docker(["logs", "--tail", "20", CONTAINER_NAME]);
  const tail = ((logs.stdout ?? "") + (logs.stderr ?? "")).trim().split("\n").slice(-6).join("\n  ");
  return new SetupError(
    `FalkorDB didn't become reachable on ${HOST}:${PORT} within 20s.\n` +
      (tail ? `  Last container logs:\n  ${tail}\n` : "") +
      `  Inspect with:  docker logs ${CONTAINER_NAME}`
  );
}

/**
 * Ensure a FalkorDB is reachable for the gateway before services start.
 * Returns a status string the caller uses only for a one-line log:
 *   "external" — user manages it (remote FALKOR_HOST, or already on the port)
 *   "running"  — the flow-falkordb container was already up
 *   "started"  — the flow-falkordb container existed and we started it
 *   "launched" — we created the flow-falkordb container
 * Throws SetupError (friendly, no stack) when Docker is needed but unavailable.
 */
export async function ensureFalkordb() {
  // 1) Remote / user-managed FalkorDB — never touch Docker.
  if (!isLocalHost(HOST)) return "external";

  // 2) Already serving locally (our container from a previous run, a native
  //    FalkorDB, Colima/OrbStack…). Use it; don't require Docker at all.
  if (await portOpen(HOST, PORT)) return "running";

  // 3) We must bring the container up — Docker has to be usable. Fail with a fix.
  if (!dockerInstalled()) {
    throw new SetupError(
      `Docker isn't installed, and nothing is serving FalkorDB on ${HOST}:${PORT}.\n` +
        `  Flow runs its graph database (FalkorDB) in a container.\n` +
        `  → Install Docker Desktop: https://docs.docker.com/get-docker/  then re-run  flow up\n` +
        `  Prefer no Docker? Run FalkorDB yourself and point Flow at it:\n` +
        `      FALKOR_HOST=<host> FALKOR_PORT=<port> flow up`
    );
  }
  if (!dockerDaemonUp()) {
    throw new SetupError(
      `Docker is installed but its daemon isn't running.\n` +
        `  Start Docker Desktop (or your engine), wait until it's ready, then re-run  flow up.`
    );
  }

  // 4) Container already exists? inspect exits non-zero ONLY for "no such
  //    container" now that we know the daemon is up.
  const inspect = docker(["inspect", CONTAINER_NAME, "--format", "{{.State.Status}}"]);
  if (inspect.status === 0) {
    if (inspect.stdout.trim() === "running") return "running";
    // Exists but not running (exited/created/paused/dead) — start it.
    const started = docker(["start", CONTAINER_NAME]);
    if (started.status !== 0) {
      throw new SetupError(
        `Couldn't start the existing flow-falkordb container:\n  ${(started.stderr ?? "").trim().split("\n")[0]}\n` +
          `  Try:  docker rm -f ${CONTAINER_NAME}   then re-run  flow up  to recreate it.`
      );
    }
    if (!(await waitForPort(HOST, PORT, 20000))) throw notReadyError();
    return "started";
  }

  // 5) Create it.
  const run = docker(["run", "-d", "--name", CONTAINER_NAME, "-p", `${PORT}:6379`, IMAGE]);
  if (run.status !== 0) {
    const err = (run.stderr ?? "").trim();
    if (/already in use|address already in use|port is already allocated/i.test(err)) {
      throw new SetupError(
        `Port ${PORT} is already in use, so FalkorDB can't start.\n` +
          `  Something else (another Redis/FalkorDB?) holds it. Free it, or point Flow\n` +
          `  at that instance:  FALKOR_HOST=<host> FALKOR_PORT=<port> flow up`
      );
    }
    if (/name .* already in use/i.test(err)) {
      // Rare race: inspect said no-such-container but the name is taken. Recover.
      docker(["rm", "-f", CONTAINER_NAME]);
      const retry = docker(["run", "-d", "--name", CONTAINER_NAME, "-p", `${PORT}:6379`, IMAGE]);
      if (retry.status === 0 && (await waitForPort(HOST, PORT, 20000))) return "launched";
    }
    throw new SetupError(`Couldn't start FalkorDB via Docker:\n  ${err.split("\n")[0] || "unknown error"}`);
  }
  if (!(await waitForPort(HOST, PORT, 20000))) throw notReadyError();
  return "launched";
}
