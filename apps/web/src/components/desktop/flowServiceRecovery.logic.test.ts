import type { DesktopAttachFailure, DesktopFlowServiceAdoption } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { describeFlowServiceRecovery } from "./flowServiceRecovery.logic";

const failure = (
  kind: DesktopAttachFailure["kind"],
  reason = "Something went wrong.",
): DesktopAttachFailure => ({ kind, reason, detail: `detail for ${kind}` });

const adoption = (
  outcome: DesktopFlowServiceAdoption["outcome"],
  overrides: Partial<DesktopFlowServiceAdoption> = {},
): DesktopFlowServiceAdoption => ({
  outcome,
  steps: [{ name: "install-release", ok: true, detail: null }],
  failure: null,
  ...overrides,
});

const describe_ = (
  input: Partial<Parameters<typeof describeFlowServiceRecovery>[0]> & {
    readonly failure: DesktopAttachFailure;
  },
) =>
  describeFlowServiceRecovery({
    adoption: null,
    canCheckForUpdates: true,
    ...input,
  });

describe("flow service recovery presentation", () => {
  it("shows adoption progress with no actions while setup is running", () => {
    const view = describe_({
      failure: failure("not-installed"),
      adoption: adoption("in-progress"),
    });

    expect(view.title).toContain("Setting up");
    // Interrupting a running adoption is how a half-installed service happens.
    expect(view.actions).toEqual([]);
    expect(view.steps).toEqual([{ name: "install-release", ok: true }]);
  });

  it("offers a retry and the built-in server once adoption has failed", () => {
    const view = describe_({
      failure: failure("not-installed"),
      adoption: adoption("failed", {
        failure: { step: "install-release", message: "Download failed (503)." },
      }),
    });

    expect(view.body).toBe("Download failed (503).");
    expect(view.actions).toEqual(["retry", "use-legacy-backend"]);
    expect(view.legacyConsequence).toContain("stay disconnected");
    expect(view.detail).toBe("detail for not-installed");
  });

  it("offers the same two actions when adoption never ran", () => {
    const view = describe_({ failure: failure("not-installed") });

    expect(view.actions).toEqual(["retry", "use-legacy-backend"]);
    expect(view.steps).toEqual([]);
  });

  it("offers starting the service when it is installed but stopped", () => {
    const view = describe_({ failure: failure("stopped") });

    expect(view.actions).toEqual(["start-service", "retry"]);
    // Never a private child while an installed service owns the data home.
    expect(view.legacyConsequence).toBeNull();
  });

  it("never offers a downgrade or a server of our own when incompatible", () => {
    const view = describe_({ failure: failure("incompatible") });

    expect(view.actions).toEqual(["check-for-updates", "open-in-browser", "retry"]);
    expect(view.actions).not.toContain("use-legacy-backend");
    expect(view.actions).not.toContain("start-service");
  });

  it("drops the update action on a shell that cannot check for updates", () => {
    const view = describe_({ failure: failure("incompatible"), canCheckForUpdates: false });

    expect(view.actions).toEqual(["open-in-browser", "retry"]);
  });

  it("repeats the parked reason and offers only a retry when unreachable", () => {
    const view = describe_({ failure: failure("unreachable", "The service did not answer.") });

    expect(view.title).toBe("The service did not answer.");
    expect(view.actions).toEqual(["retry"]);
  });

  it("hides an empty detail instead of showing a blank disclosure", () => {
    const view = describe_({
      failure: { kind: "unreachable", reason: "No answer.", detail: "" },
    });

    expect(view.detail).toBeNull();
  });
});
