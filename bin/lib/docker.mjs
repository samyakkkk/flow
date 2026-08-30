// lib/docker.mjs — FalkorDB provisioning for `flow up`.
//
// The ONLY thing Flow runs in Docker is FalkorDB (its graph database). Flow's
// own services (gateway / orchestrator / dashboard) run natively via `flow up`.
// If you already run FalkorDB — a container from a previous run, a native
// build, Colima/OrbStack, or a remote instance via FALKOR_HOST — Flow uses it
// and never touches Docker at all.
//
// Two rules keep first-run failures from being silent or fatal:
//   1. NEVER trust a port blindly. Whatever answers on the FalkorDB port is
//      verified over RESP (PING + GRAPH.LIST) before Flow adopts it — a plain
//      Redis or some other service squatting 6379 previously got adopted
//      silently, and every graph write then failed where users can't see it.
//   2. RECOVER instead of demanding the user free a port. When the default
//      port is squatted by something that isn't FalkorDB (a half-finished
//      install, someone's Redis), Flow starts its container on a nearby free
//      port and persists that choice as a machine default (<data>/global.json,
//      FALKOR_PORT) so services and every future `flow up` agree.
//
// Container: flow-falkordb (per FalkorDB port; FALKOR_CONTAINER overrides)
// Image: falkordb/falkordb:latest   Port: resolved (see resolveFalkorTarget)

import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

const IMAGE = "falkordb/falkordb:latest";
const DEFAULT_PORT = 6379;
// When the default port is squatted, scan this window for a home.
const RELOCATE_PORTS = Array.from({ length: 20 }, (_, i) => 6380 + i);

// A friendly, already-explained setup problem. flow.mjs's top-level catch prints
// err.message behind a ✗ — so these read as guidance, not a stack trace.
class SetupError extends Error {}

function isLocalHost(h) {
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

function containerNameFor(port) {
  return (
    process.env.FALKOR_CONTAINER ?? (port === DEFAULT_PORT ? "flow-falkordb" : `flow-falkordb-${port}`)
  );
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

// ── Machine defaults (<data>/global.json) ────────────────────────────────────
// Same file orchestrator/src/global-settings.ts manages (plain JSON, 0600).
// FALKOR_PORT lands here when Flow relocates off a squatted default port.

function readMachineDefault(dataDir, key) {
  try {
    const p = join(dataDir, "global.json");
    if (!existsSync(p)) return undefined;
    const v = JSON.parse(readFileSync(p, "utf-8"))?.[key];
    return typeof v === "string" && v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

function writeMachineDefault(dataDir, key, value) {
  mkdirSync(dataDir, { recursive: true }); // very first run — nothing exists yet
  const p = join(dataDir, "global.json");
  let obj = {};
  try {
    if (existsSync(p)) obj = JSON.parse(readFileSync(p, "utf-8")) ?? {};
  } catch {
    obj = {};
  }
  obj[key] = value;
  writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf-8");
  try {
    chmodSync(p, 0o600);
  } catch {
    /* best-effort — matches global-settings.ts */
  }
}

// ── RESP probes ──────────────────────────────────────────────────────────────

// Is something already accepting connections on this port?
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

// Send one command over the wire (RESP array form) and return the raw reply
// text, or null on connect/timeout failure. We only ever need the first line
// of the reply to classify what's answering — no full RESP parser required.
export function respQuery(host, port, args, timeoutMs = 1500) {
  const payload =
    `*${args.length}\r\n` + args.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join("");
  return new Promise((resolve) => {
    const sock = createConnection({ host, port });
    let buf = "";
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => sock.write(payload));
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      if (buf.includes("\r\n")) done(buf);
    });
    sock.once("timeout", () => done(null));
    sock.once("error", () => done(null));
  });
}

function firstLine(reply) {
  return (reply ?? "").split("\r\n")[0] ?? "";
}

// Is the thing answering on host:port a FalkorDB we can use? PING proves it
// speaks Redis protocol; GRAPH.LIST proves the graph module is loaded (a
// plain Redis answers PING happily and then fails every graph query).
export async function verifyFalkordb(host, port) {
  const ping = await respQuery(host, port, ["PING"]);
  if (ping === null) {
    return { ok: false, reason: "it does not speak the Redis protocol (no reply to PING)" };
  }
  if (!ping.startsWith("+PONG")) {
    const line = firstLine(ping);
    return {
      ok: false,
      reason: line.startsWith("-NOAUTH")
        ? "it is a password-protected Redis, not Flow's FalkorDB"
        : `it answered PING with ${JSON.stringify(line.slice(0, 60))}`,
    };
  }
  const list = await respQuery(host, port, ["GRAPH.LIST"]);
  if (list === null) return { ok: false, reason: "it stopped answering (GRAPH.LIST got no reply)" };
  if (list.startsWith("-")) {
    const line = firstLine(list);
    return /unknown command/i.test(line)
      ? { ok: false, reason: "it is a plain Redis without the FalkorDB graph module" }
      : { ok: false, reason: `GRAPH.LIST failed: ${line.slice(1, 80)}` };
  }
  return { ok: true };
}

// ── Image ────────────────────────────────────────────────────────────────────

// Pull the FalkorDB image if it isn't cached locally. Pull progress is shown
// (stdout inherited); stderr is captured so a failure reports its REAL cause —
// never the "Unable to find image … locally" informational line.
async function ensureImage() {
  const have = docker(["image", "inspect", IMAGE], { stdio: ["ignore", "ignore", "ignore"] });
  if (have.status === 0) return;

  console.log(`  downloading FalkorDB image (first run, a few hundred MB)…`);
  const pull = spawnSync("docker", ["pull", IMAGE], {
    encoding: "utf-8",
    stdio: ["ignore", "inherit", "pipe"], // progress → terminal, errors → captured
  });
  if (pull.status === 0) return;

  const err = (pull.stderr ?? "").trim();
  const cause =
    err
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !/unable to find image/i.test(l))
      .pop() ?? "unknown error";
  if (/toomanyrequests|rate limit/i.test(err)) {
    throw new SetupError(
      `Docker Hub refused the FalkorDB image pull — you've hit its anonymous rate limit.\n` +
        `  Fix: run  docker login  (a free Docker Hub account raises the limit), or wait\n` +
        `  an hour, then re-run  flow up.\n` +
        `  (${cause})`
    );
  }
  throw new SetupError(
    `Couldn't download the FalkorDB image (docker pull ${IMAGE}):\n` +
      `  ${cause}\n` +
      `  Usually a network hiccup — check connectivity/VPN and re-run  flow up.\n` +
      `  You can also pull it yourself to watch the full output:  docker pull ${IMAGE}`
  );
}

function notReadyError(host, port, container) {
  // Container came up but never opened the port — surface why instead of a
  // silent 20s stall followed by "gateway didn't start".
  const logs = docker(["logs", "--tail", "20", container]);
  const tail = ((logs.stdout ?? "") + (logs.stderr ?? "")).trim().split("\n").slice(-6).join("\n  ");
  return new SetupError(
    `FalkorDB didn't become reachable on ${host}:${port} within 20s.\n` +
      (tail ? `  Last container logs:\n  ${tail}\n` : "") +
      `  Inspect with:  docker logs ${container}`
  );
}

// ── Provisioning ─────────────────────────────────────────────────────────────

function requireDocker(host, port) {
  if (!dockerInstalled()) {
    throw new SetupError(
      `Docker isn't installed, and nothing is serving FalkorDB on ${host}:${port}.\n` +
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
}

// Start (or create) the flow container for this port. Returns "started" |
// "launched"; throws SetupError with the real cause otherwise.
async function upContainer(host, port) {
  const container = containerNameFor(port);
  const inspect = docker(["inspect", container, "--format", "{{.State.Status}}"]);
  if (inspect.status === 0) {
    if (inspect.stdout.trim() !== "running") {
      const started = docker(["start", container]);
      if (started.status !== 0) {
        throw new SetupError(
          `Couldn't start the existing ${container} container:\n  ${(started.stderr ?? "").trim().split("\n")[0]}\n` +
            `  Try:  docker rm -f ${container}   then re-run  flow up  to recreate it.`
        );
      }
    }
    if (!(await waitForPort(host, port, 20000))) throw notReadyError(host, port, container);
    return inspect.stdout.trim() === "running" ? "running" : "started";
  }

  const run = docker(["run", "-d", "--name", container, "-p", `${port}:6379`, IMAGE]);
  if (run.status !== 0) {
    const err = (run.stderr ?? "").trim();
    if (/name .* already in use/i.test(err)) {
      // Rare race: inspect said no-such-container but the name is taken. Recover.
      docker(["rm", "-f", container]);
      const retry = docker(["run", "-d", "--name", container, "-p", `${port}:6379`, IMAGE]);
      if (retry.status === 0 && (await waitForPort(host, port, 20000))) return "launched";
    }
    if (/already in use|address already in use|port is already allocated/i.test(err)) {
      // Port taken but nothing ANSWERED on it earlier (a stopped-but-mapped
      // proxy, a TIME_WAIT ghost, another daemon). Caller may retry elsewhere.
      const e = new SetupError(
        `Port ${port} is already allocated, so FalkorDB can't bind there.`
      );
      e.portTaken = true;
      throw e;
    }
    const cause =
      err.split("\n").map((l) => l.trim()).filter((l) => l && !/unable to find image/i.test(l)).pop() ??
      "unknown error";
    throw new SetupError(`Couldn't start FalkorDB via Docker:\n  ${cause}`);
  }
  if (!(await waitForPort(host, port, 20000))) throw notReadyError(host, port, container);
  return "launched";
}

// Resolve where FalkorDB should live. Explicit env wins (the user pinned it);
// otherwise the machine default written by a previous relocation; otherwise
// the stock port.
function resolveFalkorTarget(dataDir) {
  const host = process.env.FALKOR_HOST ?? "localhost";
  if (process.env.FALKOR_PORT) {
    return { host, port: Number(process.env.FALKOR_PORT), pinned: true };
  }
  const saved = dataDir ? readMachineDefault(dataDir, "FALKOR_PORT") : undefined;
  if (saved && Number.isFinite(Number(saved))) {
    return { host, port: Number(saved), pinned: false };
  }
  return { host, port: DEFAULT_PORT, pinned: false };
}

/**
 * Ensure a VERIFIED FalkorDB is reachable for the gateway before services
 * start. Returns { status, host, port, relocatedFrom? }:
 *   status "external" — user manages it (remote FALKOR_HOST)
 *   status "running"  — something verified was already serving the port
 *   status "started"  — an existing flow container was started
 *   status "launched" — the flow container was created
 * `relocatedFrom` is set when the resolved port was squatted by a non-FalkorDB
 * and Flow moved to a free port (persisted as machine default FALKOR_PORT).
 * Throws SetupError (friendly, no stack) when it can't produce a working DB.
 */
export async function ensureFalkordb({ dataDir } = {}) {
  const { host, port, pinned } = resolveFalkorTarget(dataDir);

  // 1) Remote / user-managed FalkorDB — never touch Docker, but still verify:
  //    a wrong host/port should fail HERE with a reason, not as gateway noise.
  if (!isLocalHost(host)) {
    const v = await verifyFalkordb(host, port);
    if (!v.ok) {
      throw new SetupError(
        `FALKOR_HOST points at ${host}:${port}, but ${v.reason}.\n` +
          `  Fix the address (FALKOR_HOST/FALKOR_PORT) or start FalkorDB there, then re-run  flow up.`
      );
    }
    return { status: "external", host, port };
  }

  // 2) Something is already serving the port. Verify before adopting — a
  //    plain Redis or a random service here used to get adopted silently,
  //    and every graph write then failed invisibly.
  if (await portOpen(host, port)) {
    const v = await verifyFalkordb(host, port);
    if (v.ok) return { status: "running", host, port };
    if (pinned) {
      throw new SetupError(
        `FALKOR_PORT is set to ${port}, but ${v.reason}.\n` +
          `  Free the port or unset FALKOR_PORT and let Flow pick one, then re-run  flow up.`
      );
    }
    // Squatted → relocate to a free nearby port and remember the choice.
    requireDocker(host, port);
    await ensureImage();
    for (const candidate of RELOCATE_PORTS) {
      if (await portOpen(host, candidate)) {
        // Occupied: adopt it ONLY if it's already a working FalkorDB (e.g. a
        // relocated container from an interrupted earlier run).
        const cv = await verifyFalkordb(host, candidate);
        if (!cv.ok) continue;
        if (dataDir) writeMachineDefault(dataDir, "FALKOR_PORT", String(candidate));
        return { status: "running", host, port: candidate, relocatedFrom: port, reason: v.reason };
      }
      try {
        const status = await upContainer(host, candidate);
        if (dataDir) writeMachineDefault(dataDir, "FALKOR_PORT", String(candidate));
        return { status, host, port: candidate, relocatedFrom: port, reason: v.reason };
      } catch (err) {
        if (err?.portTaken) continue; // race — try the next candidate
        throw err;
      }
    }
    throw new SetupError(
      `Port ${port} is in use but ${v.reason}, and no free port was found in ` +
        `${RELOCATE_PORTS[0]}–${RELOCATE_PORTS[RELOCATE_PORTS.length - 1]}.\n` +
        `  Free one of those ports, or point Flow at your own FalkorDB:\n` +
        `      FALKOR_HOST=<host> FALKOR_PORT=<port> flow up`
    );
  }

  // 3) Nothing on the port — bring the container up. Docker has to be usable.
  requireDocker(host, port);
  //    Make sure the image is present BEFORE `docker run`. Two reasons:
  //    (a) a first-run pull is ~hundreds of MB — inside a silent spawnSync the
  //        user stares at nothing for minutes; an explicit pull shows progress.
  //    (b) when a run-triggered pull fails, docker's stderr STARTS with the
  //        informational "Unable to find image … locally" line — reporting that
  //        first line hides the real cause (network, Docker Hub rate limit).
  await ensureImage();
  try {
    const status = await upContainer(host, port);
    return { status, host, port };
  } catch (err) {
    // Nothing ANSWERS on the port yet docker can't bind it (stopped container
    // holding the mapping, half-closed listener from an interrupted install).
    // Same recovery as the squatted case: relocate, unless the user pinned it.
    if (!err?.portTaken || pinned) throw err;
    for (const candidate of RELOCATE_PORTS) {
      if (await portOpen(host, candidate)) continue;
      try {
        const status = await upContainer(host, candidate);
        if (dataDir) writeMachineDefault(dataDir, "FALKOR_PORT", String(candidate));
        return {
          status,
          host,
          port: candidate,
          relocatedFrom: port,
          reason: "the port is allocated by another process or container",
        };
      } catch (e2) {
        if (e2?.portTaken) continue;
        throw e2;
      }
    }
    throw err;
  }
}
