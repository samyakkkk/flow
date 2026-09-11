// pollers/engine.ts — Generalized poll-since-cursor ingestion engine.
//
// Design contract (system.md, Multi-project contract):
//   - Polling is THE ingestion mechanism; webhooks are optional poll-now accelerators.
//   - Each (source, resource) pair has a cursor persisted in poll_cursors.
//     resource defaults to "_all" for source-level pollers (linear, fireflies).
//     GitHub uses per-repo resource keys ("owner/repo").
//   - Per-source loop with jitter; cursor advanced only after successful fetch.
//   - On error → status=error, exponential backoff (x2 up to 15 min), never crash.
//   - On boot with old cursor → status=catching_up; after first successful fetch reverts to ok.
//   - Backoff resets on first successful fetch.
//   - FLOW_POLL_DISABLE=1 prevents ALL pollers from starting (test env).
//
// Usage (two call styles):
//   // Style A — source-level poller (Linear, Fireflies):
//   registerPoller({ source: "linear", intervalMs: 60_000, fetchSince, enabled });
//   startAllPollers();
//
//   // Style B — per-resource (GitHub, one call per repo):
//   registerPoller({ source: "github", resource: "owner/repo", intervalMs: 60_000, fetchSince, enabled });
//   startAllPollers();

import db from "../db.js";
import type { NormalizedEvent } from "../events.js";

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

export interface FetchResult {
  events: NormalizedEvent[];
  /** Opaque cursor string; engine persists it only after a successful fetch. */
  nextCursor: string;
}

export interface PollerConfig {
  /** Unique source key — must match poll_cursors.source. */
  source: string;
  /**
   * Resource key within the source (e.g. "owner/repo" for GitHub, "_all" for
   * source-level pollers). Defaults to "_all".
   */
  resource?: string;
  /** Base polling interval in ms (actual = intervalMs ± jitter). */
  intervalMs: number;
  /**
   * Called with the last-persisted cursor (or "" on first boot).
   * Must NOT throw for recoverable errors — throw only for
   * configuration / unrecoverable issues.
   */
  fetchSince(cursor: string): Promise<FetchResult>;
  /**
   * Returns true if required credentials are present.
   * Engine skips the tick (does not backoff) when false.
   */
  enabled(): boolean;
}

export type PollStatus = "ok" | "error" | "catching_up" | "disabled" | "idle";

export interface PollCursorRow {
  source: string;
  resource: string;
  cursor: string;
  last_poll_at: number;
  status: PollStatus;
  detail: string | null;
}

// ------------------------------------------------------------------
// DB helpers (poll_cursors table: PRIMARY KEY(source, resource))
// ------------------------------------------------------------------

function getRow(source: string, resource: string): PollCursorRow | undefined {
  return db
    .prepare("SELECT * FROM poll_cursors WHERE source = ? AND resource = ?")
    .get(source, resource) as PollCursorRow | undefined;
}

function upsertRow(row: PollCursorRow & { last_poll_at?: number }): void {
  db.prepare(`
    INSERT INTO poll_cursors (source, resource, cursor, last_poll_at, status)
    VALUES (@source, @resource, @cursor, @last_poll_at, @status)
    ON CONFLICT(source, resource) DO UPDATE SET
      cursor       = excluded.cursor,
      last_poll_at = excluded.last_poll_at,
      status       = excluded.status
  `).run({
    source: row.source,
    resource: row.resource,
    cursor: row.cursor,
    last_poll_at: row.last_poll_at ?? Math.floor(Date.now() / 1000),
    status: row.status,
  });
}

// ------------------------------------------------------------------
// Jitter: ± 10% of intervalMs so multiple pollers don't align
// ------------------------------------------------------------------

function withJitter(ms: number): number {
  const jitter = Math.floor(ms * 0.1 * (Math.random() * 2 - 1));
  return Math.max(1000, ms + jitter);
}

// ------------------------------------------------------------------
// Backoff constants
// ------------------------------------------------------------------

const MIN_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 15 * 60_000; // 15 min

// ------------------------------------------------------------------
// Registry — keyed by "source:resource"
// ------------------------------------------------------------------

const registry = new Map<string, PollerConfig & { resource: string }>();
// Per-poller backoff state
const backoffMs = new Map<string, number>();
// Per-poller timer handles
const timers = new Map<string, ReturnType<typeof setTimeout>>();

let running = false;

function pollerKey(source: string, resource: string): string {
  return `${source}:${resource}`;
}

export function registerPoller(config: PollerConfig): void {
  const resource = config.resource ?? "_all";
  const key = pollerKey(config.source, resource);
  registry.set(key, { ...config, resource });
}

// ------------------------------------------------------------------
// Single poll tick
// ------------------------------------------------------------------

async function tick(key: string): Promise<void> {
  const config = registry.get(key);
  if (!config) return;

  const { source, resource } = config;

  if (!config.enabled()) {
    // Not yet configured — mark disabled but do not backoff
    upsertRow({
      source,
      resource,
      cursor: getRow(source, resource)?.cursor ?? "",
      status: "disabled",
      detail: null,
    });
    scheduleNext(key, config.intervalMs);
    return;
  }

  const row = getRow(source, resource);
  const cursor = row?.cursor ?? "";

  // Determine if this looks like a boot with an old cursor (catching_up)
  // Heuristic: cursor is non-empty and last_poll_at was more than 2 intervals ago
  const now = Math.floor(Date.now() / 1000);
  const isCatchingUp =
    cursor !== "" &&
    row?.last_poll_at !== undefined &&
    row.last_poll_at > 0 &&
    now - row.last_poll_at > (config.intervalMs / 1000) * 2;

  const nextStatus: PollStatus = isCatchingUp ? "catching_up" : "ok";

  try {
    const result = await config.fetchSince(cursor);

    // Emit events via processEvent (import here to avoid circular at module load)
    const { processEvent } = await import("../events.js");
    for (const event of result.events) {
      try {
        await processEvent(event);
      } catch (err) {
        console.error(`[poller:${source}:${resource}] processEvent error for event ${event.id}: ${err}`);
      }
    }

    // Advance cursor + reset backoff
    upsertRow({
      source,
      resource,
      cursor: result.nextCursor,
      last_poll_at: now,
      status: nextStatus,
      detail: null,
    });
    backoffMs.delete(key);

    if (isCatchingUp) {
      console.log(`[poller:${source}:${resource}] catching_up: processed ${result.events.length} events, cursor=${result.nextCursor}`);
    } else if (result.events.length > 0) {
      console.log(`[poller:${source}:${resource}] fetched ${result.events.length} events, cursor=${result.nextCursor}`);
    }

    scheduleNext(key, config.intervalMs);
  } catch (err) {
    const errMsg = String(err);
    const prev = backoffMs.get(key) ?? MIN_BACKOFF_MS;
    const next = Math.min(prev * 2, MAX_BACKOFF_MS);
    backoffMs.set(key, next);

    upsertRow({
      source,
      resource,
      cursor,           // do NOT advance cursor on error
      last_poll_at: now,
      status: "error",
      detail: null,
    });

    console.error(`[poller:${source}:${resource}] error: ${errMsg}; backing off ${next}ms`);
    scheduleNext(key, next);
  }
}

// ------------------------------------------------------------------
// Scheduler helpers
// ------------------------------------------------------------------

function scheduleNext(key: string, baseMs: number): void {
  if (!running) return;
  const delay = withJitter(baseMs);
  const t = setTimeout(() => {
    void tick(key);
  }, delay);
  timers.set(key, t);
}

// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

export function startAllPollers(): void {
  if (process.env.FLOW_POLL_DISABLE === "1") {
    console.log("[poller-engine] FLOW_POLL_DISABLE=1 — not starting any pollers");
    return;
  }
  if (running) return;
  running = true;

  for (const [key, config] of registry) {
    console.log(`[poller-engine] Starting poller key=${key}, interval=${config.intervalMs}ms`);
    // Stagger initial starts so they don't all fire at once
    const initialDelay = Math.floor(Math.random() * Math.min(config.intervalMs, 5000));
    const t = setTimeout(() => {
      void tick(key);
    }, initialDelay);
    timers.set(key, t);
  }
}

export function stopAllPollers(): void {
  running = false;
  for (const [, t] of timers) {
    clearTimeout(t);
  }
  timers.clear();
}

/**
 * Force an immediate poll tick for a source+resource (webhook "poll-now" accelerator).
 * resource defaults to "_all". Clears any pending scheduled timer.
 */
export function pollNow(source: string, resource = "_all"): void {
  const key = pollerKey(source, resource);
  const existing = timers.get(key);
  if (existing) clearTimeout(existing);
  void tick(key);
}

/**
 * Return all cursor rows for the status endpoint.
 */
export function getAllPollStatus(): PollCursorRow[] {
  return db.prepare("SELECT * FROM poll_cursors ORDER BY source, resource").all() as PollCursorRow[];
}
