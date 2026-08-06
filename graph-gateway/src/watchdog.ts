// watchdog.ts — self-exit when this process is no longer the deployment's
// tracked service.
//
// Services are spawned detached (`flow up` returns; there is deliberately no
// controlling process), so "my controlling shell died" is not detectable — the
// durable ground truth is pids.json: `flow up` records the pid it spawned for
// each role, `flow down` clears it, `flow rm` deletes the whole project dir.
// A service that is alive while pids.json stops naming it is by definition an
// orphan (a kill that never landed, a supersede whose port sweep missed, a
// deleted project) and must exit itself — on a customer's EC2 nothing else
// ever will.
//
// Grace: staleness needs consecutive strikes across checks, so a mid-write
// pids.json (truncate+write is not atomic) or a transient FS hiccup never
// takes a healthy service down.

import { existsSync, readFileSync } from "node:fs";

const PIDS_PATH = process.env.FLOW_PIDS_PATH ?? "";
const ROLE = process.env.FLOW_SERVICE_ROLE ?? "";
const INTERVAL_MS = Number(process.env.FLOW_WATCHDOG_INTERVAL_MS ?? 60_000);
const SUPERSEDED_STRIKES = 2; // pids.json names someone else (or nobody)
const MISSING_STRIKES = 3; // pids.json (project dir) is gone

export function startWatchdog(onStale: (reason: string) => void = defaultOnStale): void {
  // Only active when `flow up` armed it — dev runs, tests, and Docker (where
  // the container is the lifecycle) are unaffected.
  if (!PIDS_PATH || !ROLE || process.env.FLOW_WATCHDOG === "0") return;
  let strikes = 0;
  let fired = false;
  const timer = setInterval(() => {
    if (fired) return;
    try {
      if (!existsSync(PIDS_PATH)) {
        if (++strikes >= MISSING_STRIKES) {
          fired = true;
          onStale(`${PIDS_PATH} is gone — project removed`);
        }
        return;
      }
      const pids = JSON.parse(readFileSync(PIDS_PATH, "utf8")) as Record<string, unknown>;
      const tracked = pids?.[ROLE];
      if (tracked !== process.pid) {
        if (++strikes >= SUPERSEDED_STRIKES) {
          fired = true;
          onStale(
            typeof tracked === "number"
              ? `superseded — pids.json now names pid ${tracked} as ${ROLE}`
              : `retired — pids.json no longer names a ${ROLE}`
          );
        }
        return;
      }
      strikes = 0;
    } catch {
      /* unreadable/mid-write — not evidence of staleness */
    }
  }, INTERVAL_MS);
  timer.unref?.();
}

function defaultOnStale(reason: string): void {
  console.warn(`[watchdog] ${ROLE} pid ${process.pid} is stale (${reason}) — shutting down`);
  // Graceful first (runs the service's SIGTERM cleanup: adapters, job
  // children), hard exit if that stalls.
  setTimeout(() => process.exit(0), 10_000).unref?.();
  process.kill(process.pid, "SIGTERM");
}
