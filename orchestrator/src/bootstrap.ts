// bootstrap.ts — Extracted poller registration so it can be called both at
// startup (index.ts) and after a settings change (settings.ts PUT handler).
//
// reinitPollers() clears the existing registry and re-registers all pollers
// using the current getSetting() values (DB > env > default).

import { getSetting } from "./settings.js";
import { registerPoller } from "./pollers/engine.js";
import { linearFetchSince } from "./adapters/linear.js";
import { githubFetchSince } from "./adapters/github.js";

// ------------------------------------------------------------------
// Internal: clear registry (engine doesn't export a clear function, so
// we re-register with new config objects; timers are stopped by caller
// via stopAllPollers() before this is called).
// ------------------------------------------------------------------

// Re-export for use by index.ts
export { registerLinearPoller } from "./adapters/linear.js";
export { registerGithubPoller } from "./adapters/github.js";
export { registerFirefliesPoller } from "./adapters/meetings.js";

/**
 * Re-register all pollers with fresh config from getSetting().
 * Call stopAllPollers() first, then reinitPollers(), then startAllPollers().
 */
export function reinitPollers(): void {
  const linearIntervalMs = parseInt(
    getSetting("FLOW_LINEAR_POLL_MS") ?? "60000",
    10
  );
  const githubIntervalMs = parseInt(
    getSetting("FLOW_GITHUB_POLL_MS") ?? "60000",
    10
  );
  const firefliesIntervalMs = parseInt(
    getSetting("FLOW_FIREFLIES_POLL_MS") ?? "300000",
    10
  );

  // Linear poller
  registerPoller({
    source: "linear",
    resource: "_all",
    intervalMs: linearIntervalMs,
    fetchSince: linearFetchSince,
    enabled: () => {
      const key = getSetting("LINEAR_API_KEY") ?? process.env.LINEAR_API_KEY ?? "";
      return Boolean(key) && process.env.FLOW_POLL_DISABLE !== "1";
    },
  });

  // GitHub poller
  registerPoller({
    source: "github",
    intervalMs: githubIntervalMs,
    fetchSince: githubFetchSince,
    enabled: () => {
      const pollMs =
        getSetting("FLOW_GITHUB_POLL_MS") ?? process.env.FLOW_GITHUB_POLL_MS;
      const token =
        getSetting("GITHUB_TOKEN") ?? process.env.GITHUB_PAT ?? "";
      // GitHub poller: enabled if FLOW_GITHUB_POLL_MS is explicitly set
      // (either via DB setting or env) OR if GITHUB_TOKEN is set via DB
      return (
        (Boolean(pollMs) || Boolean(token)) &&
        process.env.FLOW_GITHUB_POLL_DISABLE !== "1" &&
        process.env.FLOW_POLL_DISABLE !== "1"
      );
    },
  });

  // Fireflies poller — dynamically import to avoid circular
  // We register via a wrapper that calls the adapter's fetchSince internally
  void (async () => {
    try {
      const { registerFirefliesPoller } = await import("./adapters/meetings.js");
      registerFirefliesPoller();
    } catch (err) {
      console.error("[bootstrap] registerFirefliesPoller error:", err);
    }
  })();
}
