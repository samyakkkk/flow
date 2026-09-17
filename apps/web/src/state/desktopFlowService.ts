import type { DesktopBridge, DesktopFlowServiceStatus } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

// The service runs outside this app, so its state changes without the renderer
// hearing about it. A short stale time keeps the panel honest without polling.
const DESKTOP_FLOW_SERVICE_STALE_TIME_MS = 10_000;

type DesktopFlowServiceBridge = Pick<DesktopBridge, "getFlowServiceStatus">;

class DesktopFlowServiceUnavailableError extends Schema.TaggedErrorClass<DesktopFlowServiceUnavailableError>()(
  "DesktopFlowServiceUnavailableError",
  {},
) {
  override get message(): string {
    return "Flow service management is unavailable.";
  }
}

class DesktopFlowServiceLoadError extends Schema.TaggedErrorClass<DesktopFlowServiceLoadError>()(
  "DesktopFlowServiceLoadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to load the Flow service status.";
  }
}

function getDesktopFlowServiceBridge(): DesktopFlowServiceBridge | undefined {
  return typeof window === "undefined" ? undefined : window.desktopBridge;
}

export function createDesktopFlowServiceAtom(
  getBridge: () => DesktopFlowServiceBridge | undefined,
) {
  const loadDesktopFlowServiceStatus = Effect.fn("loadDesktopFlowServiceStatus")(function* () {
    const getStatus = getBridge()?.getFlowServiceStatus;
    // Absent on browser hosts and on desktop shells older than the service
    // work; both render the panel read-only instead of an error.
    if (!getStatus) {
      return yield* new DesktopFlowServiceUnavailableError();
    }
    return yield* Effect.tryPromise({
      try: (): Promise<DesktopFlowServiceStatus> => getStatus(),
      catch: (cause) => new DesktopFlowServiceLoadError({ cause }),
    });
  });

  return Atom.make(loadDesktopFlowServiceStatus()).pipe(
    Atom.swr({
      staleTime: DESKTOP_FLOW_SERVICE_STALE_TIME_MS,
      revalidateOnMount: true,
    }),
    Atom.keepAlive,
    Atom.withLabel("desktop:flow-service:load"),
  );
}

export const desktopFlowServiceAtom = createDesktopFlowServiceAtom(getDesktopFlowServiceBridge);

export function refreshDesktopFlowService(): void {
  appAtomRegistry.refresh(desktopFlowServiceAtom);
}
