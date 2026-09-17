import type { DesktopFlowServiceStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeFlowService,
  describeFlowServiceActionResult,
  describeUnmanagedFlowService,
} from "./flowServiceSettings.logic";

const status = (overrides: {
  readonly installed?: boolean;
  readonly loaded?: boolean;
  readonly current?: boolean;
  readonly phase?: DesktopFlowServiceStatus["instance"]["phase"];
  readonly error?: string | null;
}): DesktopFlowServiceStatus => ({
  installed: overrides.installed ?? true,
  loaded: overrides.loaded ?? true,
  current: overrides.current ?? true,
  label: "com.flow.service",
  unitPath: "/Users/dev/Library/LaunchAgents/com.flow.service.plist",
  instance: {
    phase: overrides.phase ?? "ready",
    environmentId: "environment",
    dataHome: "/Users/dev/.flow",
    serverOrigin: "http://127.0.0.1:41234",
    error: overrides.error ?? null,
  },
});

describe("flow service settings presentation", () => {
  it("offers stop but not restart when a running service has no login unit", () => {
    const view = describeFlowService(status({ installed: false, loaded: false, current: false }));

    expect(view.stateLabel).toBe("Running");
    expect(view.canStop).toBe(true);
    expect(view.canRestart).toBe(false);
    expect(view.restartHint).toContain("flow service install");
    expect(view.unitDescription).toBe("Not set to start at login.");
  });

  it("offers restart but not stop once the service is stopped", () => {
    const view = describeFlowService(status({ phase: "stopped" }));

    expect(view.stateLabel).toBe("Not running");
    expect(view.canStop).toBe(false);
    expect(view.canRestart).toBe(true);
    expect(view.restartHint).toBe(null);
  });

  it("stops offering a stop while the service is already stopping", () => {
    expect(describeFlowService(status({ phase: "stopping" })).canStop).toBe(false);
  });

  it("surfaces the discovery reason when the service cannot be read", () => {
    const view = describeFlowService(
      status({ phase: "unreachable", error: "Service could not be reached." }),
    );

    expect(view.stateLabel).toBe("Not responding");
    expect(view.stateDescription).toBe("Service could not be reached.");
  });

  it("flags an installed unit that launches another installation", () => {
    const view = describeFlowService(status({ current: false }));

    expect(view.unitDescription).toContain("different installation");
    // A stale unit is still loaded, so the service manager can still restart it.
    expect(view.canRestart).toBe(true);
  });

  it("names the reason an action did not happen", () => {
    expect(
      describeFlowServiceActionResult({ ok: false, reason: "not-managed", detail: null }),
    ).toContain("can't be restarted from here");
    expect(
      describeFlowServiceActionResult({ ok: false, reason: "failed", detail: "launchctl said no" }),
    ).toBe("launchctl said no");
    expect(describeFlowServiceActionResult({ ok: true, reason: null, detail: null })).toBe(null);
  });

  it("tells an unmanaged host where the service is managed from", () => {
    expect(describeUnmanagedFlowService({ serverVersion: "1.2.3", desktopProtocol: 1 })).toContain(
      "command line",
    );
    expect(describeUnmanagedFlowService({ serverVersion: "1.2.3" })).toContain(
      "does not report a Flow service",
    );
  });
});
