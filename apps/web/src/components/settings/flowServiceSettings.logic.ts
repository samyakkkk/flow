import { BRAND } from "@t3tools/shared/branding";
import type { DesktopFlowServiceActionResult, DesktopFlowServiceStatus } from "@t3tools/contracts";

/**
 * Status -> what the Flow service panel says and offers. Kept out of the
 * component because the interesting part is the mapping: a service the app does
 * not own can be running without a login unit, installed without being loaded,
 * or loaded while its instance is unreachable, and each combination allows a
 * different pair of actions.
 */

export interface FlowServicePresentation {
  readonly stateLabel: string;
  readonly stateDescription: string;
  /** What the login-service unit is doing, in one sentence. */
  readonly unitDescription: string;
  readonly dataHome: string | null;
  readonly serverOrigin: string | null;
  readonly canStop: boolean;
  readonly canRestart: boolean;
  /** Why restarting is unavailable, when it is. */
  readonly restartHint: string | null;
}

const RESTART_HINT =
  "Restarting is available once the service starts at login. Install it with `flow service install`.";

export function describeFlowService(status: DesktopFlowServiceStatus): FlowServicePresentation {
  const { phase, error } = status.instance;
  const running = phase === "ready" || phase === "starting";
  return {
    stateLabel:
      phase === "ready"
        ? "Running"
        : phase === "starting"
          ? "Starting"
          : phase === "stopping"
            ? "Stopping"
            : phase === "not-configured"
              ? "Not installed"
              : phase === "stopped"
                ? "Not running"
                : phase === "unreachable"
                  ? "Not responding"
                  : phase === "failed"
                    ? "Failed"
                    : "Needs attention",
    stateDescription:
      phase === "ready"
        ? `Coding agents capture into this machine's brain whether or not ${BRAND.name} is open.`
        : phase === "starting"
          ? "The service is coming up."
          : phase === "stopping"
            ? "The service is shutting down."
            : phase === "not-configured"
              ? "No service is installed on this machine yet."
              : phase === "stopped"
                ? "Coding agents outside this app are not being captured right now."
                : (error ?? "The service could not be read. Check it with `flow service status`."),
    unitDescription: !status.installed
      ? status.loaded
        ? "A service manager is running it, but its unit file is gone. Reinstall it with `flow service install`."
        : "Not set to start at login."
      : !status.loaded
        ? "Installed, but no service manager has it loaded."
        : status.current
          ? `Starts at login (${status.label}).`
          : `Starts at login, but the installed unit launches a different installation. Reinstall it with \`flow service install\`.`,
    dataHome: status.instance.dataHome,
    serverOrigin: status.instance.serverOrigin,
    // Stopping a service that is already on its way down would do nothing, and
    // there is nothing to stop in any other phase.
    canStop: running,
    canRestart: status.loaded,
    restartHint: status.loaded ? null : RESTART_HINT,
  };
}

/** The message to show after an action, or null when it worked. */
export function describeFlowServiceActionResult(
  result: DesktopFlowServiceActionResult,
): string | null {
  if (result.ok) return null;
  switch (result.reason) {
    case "not-managed":
      return "No service manager owns the Flow service, so it can't be restarted from here.";
    case "not-running":
      return "The Flow service wasn't running.";
    default:
      return result.detail ?? "The Flow service didn't respond to that request.";
  }
}

/**
 * The read-only line a host that cannot manage the service shows: a browser
 * tab, or a desktop shell too old to expose the bridge methods. `desktopProtocol`
 * is the only field that says whether the connected server is a service-era
 * build at all.
 */
export function describeUnmanagedFlowService(input: {
  readonly serverVersion?: string | null;
  readonly desktopProtocol?: number | null;
}): string {
  const version = input.serverVersion ? ` Server version ${input.serverVersion}.` : "";
  return input.desktopProtocol === undefined || input.desktopProtocol === null
    ? `This server does not report a Flow service.${version}`
    : `Managed from the ${BRAND.name} desktop app or the \`flow\` command line on that machine.${version}`;
}
