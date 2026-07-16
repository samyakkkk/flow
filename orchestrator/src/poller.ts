// poller.ts — Re-exports from pollers/engine.ts with a simplified API surface.
//
// This module exists so adapters (github.ts, linear.ts, fireflies.ts) can import
// from a single "../poller.js" path rather than "../pollers/engine.js". It also
// provides the registerPoller() wrapper that accepts the PollerConfig<T> generic
// style (fetchSince → {items, nextCursor}, toEvent: item→NormalizedEvent) instead
// of the engine's FetchResult style (fetchSince → {events, nextCursor}).
//
// Both APIs are valid entry points to the same underlying engine. Adapters that
// use the generic style (github, linear, fireflies) use registerPoller() from here.
// The engine is the single source of truth for cursor persistence and scheduling.

import { createLogger } from "@flow/logger";
import { registerPoller as engineRegisterPoller, stopAllPollers, pollNow } from "./pollers/engine.js";

const log = createLogger("poller");
export { stopAllPollers, pollNow, getAllPollStatus } from "./pollers/engine.js";
export type { PollCursorRow, FetchResult, PollerConfig as EnginePollerConfig } from "./pollers/engine.js";

import type { NormalizedEvent } from "./events.js";

// ------------------------------------------------------------------
// Generic PollerConfig<T>: adapter-friendly style
// ------------------------------------------------------------------

export interface PollerConfig<T> {
  /** Adapter name, e.g. "github", "linear", "fireflies". */
  source: string;
  /** Resource key within the adapter. Defaults to "_all". */
  resource?: string;
  /** Poll interval in milliseconds. */
  intervalMs: number;
  /**
   * Fetch items since the given cursor.
   * cursor === "" on the very first run.
   */
  fetchSince: (cursor: string) => Promise<{ items: T[]; nextCursor: string }>;
  /** Map a fetched item to a NormalizedEvent. */
  toEvent: (item: T) => NormalizedEvent;
  /** Lag threshold (ms) for catching_up status. Default: 5 × intervalMs. */
  lagThresholdMs?: number;
}

/**
 * Register and start a poll-since-cursor poller using the generic item API.
 *
 * Returns null if FLOW_POLL_DISABLE=1. The underlying engine handles
 * scheduling, backoff, cursor persistence, and status tracking.
 */
export function registerPoller<T>(cfg: PollerConfig<T>): null {
  const resource = cfg.resource ?? "_all";

  // Wrap the generic fetchSince into the engine's FetchResult shape
  engineRegisterPoller({
    source: cfg.source,
    resource,
    intervalMs: cfg.intervalMs,
    fetchSince: async (cursor: string) => {
      const { items, nextCursor } = await cfg.fetchSince(cursor);
      return {
        events: items.map(cfg.toEvent),
        nextCursor,
      };
    },
    enabled: () => process.env.FLOW_POLL_DISABLE !== "1",
  });

  // startAllPollers() is called from index.ts boot; registration just queues it.
  return null;
}

/**
 * Stop a specific poller by source+resource. Delegates to pollNow-cancel pattern.
 * The engine handles full cleanup; this is a convenience alias.
 */
export function stopPoller(source: string, resource = "_all"): void {
  // The engine doesn't have a per-key stop exposed yet — stopAllPollers() is
  // the clean shutdown. For now, this is a no-op (pollers self-terminate when
  // the engine is stopped via stopAllPollers in index.ts onClose hook).
  log.info("stopPoller called — use stopAllPollers() for full shutdown", { source, resource });
}

/**
 * Expose the raw DB cursor accessor for the ingest-status route and tests.
 */
export { getAllPollStatus as getCursors } from "./pollers/engine.js";
