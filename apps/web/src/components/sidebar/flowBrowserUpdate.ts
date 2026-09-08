import { FLOW_BROWSER_UPDATE_PATH, FlowBrowserUpdateState } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeUpdateState = Schema.decodeUnknownSync(FlowBrowserUpdateState);

export async function fetchFlowBrowserUpdate(apply = false): Promise<FlowBrowserUpdateState> {
  const response = await fetch(FLOW_BROWSER_UPDATE_PATH, {
    method: apply ? "POST" : "GET",
    credentials: "same-origin",
    cache: "no-store",
    ...(apply ? { headers: { "content-type": "application/json" }, body: "{}" } : {}),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new Error(`Flow update request failed (${response.status}). Please retry.`);
  return decodeUpdateState(await response.json());
}

/** Connection loss is expected during a restart; only the target version proves success. */
export async function waitForFlowBrowserUpdate(
  version: string,
  options = {
    read: () => fetchFlowBrowserUpdate(),
    wait: () => new Promise<void>((resolve) => setTimeout(resolve, 1500)),
    now: () => Date.now(),
  },
) {
  const deadline = options.now() + 120000;
  while (options.now() < deadline) {
    try {
      const state = await options.read();
      if (state.supported && state.currentVersion === version && !state.restarting) return;
    } catch {
      /* The server may be between stopping and accepting connections. */
    }
    await options.wait();
  }
  throw new Error(
    "Flow has not reconnected to the update yet. Retry once it is available; your saved work is retained.",
  );
}
