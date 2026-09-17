import { BRAND } from "@t3tools/shared/branding";
import type { DesktopAttachFailure, DesktopFlowServiceAdoption } from "@t3tools/contracts";

/**
 * Attach failure -> what the recovery screen says and offers.
 *
 * Kept out of the component because the interesting part is the mapping. The
 * desktop cannot talk to the Flow service, and the right answer differs per
 * reason: a service that was never installed is still being set up or needs a
 * second try, a stopped one needs starting, and one this build is too old to
 * talk to must never be offered a downgrade or a server of our own — only an
 * update, a browser, or another attempt.
 */

export type FlowServiceRecoveryAction =
  | "retry"
  | "start-service"
  | "check-for-updates"
  | "open-in-browser"
  | "use-legacy-backend";

export interface FlowServiceRecoveryPresentation {
  readonly title: string;
  readonly body: string;
  /** Ordered, primary first. The component renders the first as the default
      button and the rest as outlines. */
  readonly actions: readonly FlowServiceRecoveryAction[];
  /** Adoption steps to list, newest last. Empty when there is nothing to show. */
  readonly steps: readonly { readonly name: string; readonly ok: boolean }[];
  /** The technical line, shown behind a disclosure. Null when it adds nothing. */
  readonly detail: string | null;
  /** Said out loud next to "Continue with the built-in server", so the trade is
      visible before it is taken. Null when that action is not offered. */
  readonly legacyConsequence: string | null;
}

const STEP_LABELS: Record<string, string> = {
  "install-release": `Downloading ${BRAND.name}`,
  "install-service": "Registering the background service",
  "wait-ready": "Waiting for the service to start",
  verify: "Checking your data is where it was",
  "rollback-uninstall": "Undoing the partial setup",
};

export function describeAdoptionStep(name: string): string {
  return STEP_LABELS[name] ?? name;
}

// The way out is named in the same breath as the way in: the marker the
// desktop leaves is consumed on the next launch, so this is one relaunch, not
// a mode, and no Settings row is needed to undo it.
const LEGACY_CONSEQUENCE = `${BRAND.name} will run its own server instead, and coding agents you run outside this app stay disconnected until the service is set up. Quitting and reopening ${BRAND.name} goes back to the service.`;

export function describeFlowServiceRecovery(input: {
  readonly failure: DesktopAttachFailure;
  readonly adoption: DesktopFlowServiceAdoption | null;
  /** False on shells that cannot check for an app update. */
  readonly canCheckForUpdates: boolean;
}): FlowServiceRecoveryPresentation {
  const { failure, adoption } = input;
  const steps = (adoption?.steps ?? []).map((step) => ({ name: step.name, ok: step.ok }));

  if (failure.kind === "not-installed" && adoption?.outcome === "in-progress") {
    return {
      title: `Setting up the ${BRAND.name} service…`,
      body: `${BRAND.name} is installing the background service that keeps your coding agents connected. The first time can take a few minutes.`,
      // Nothing to offer while it is still working; interrupting it is how a
      // half-installed service happens.
      actions: [],
      steps,
      detail: null,
      legacyConsequence: null,
    };
  }

  if (failure.kind === "not-installed") {
    const failureMessage = adoption?.failure?.message ?? null;
    return {
      title:
        adoption?.outcome === "failed"
          ? `${BRAND.name} could not set up its background service.`
          : `${BRAND.name} has no background service yet.`,
      body:
        failureMessage ??
        `The service is what keeps your coding agents connected when this app is closed. ${BRAND.name} could not set one up.`,
      actions: ["retry", "use-legacy-backend"],
      steps,
      detail: failure.detail || null,
      legacyConsequence: LEGACY_CONSEQUENCE,
    };
  }

  if (failure.kind === "stopped") {
    return {
      title: `The ${BRAND.name} service is not running.`,
      body: "Coding agents outside this app are not being captured right now. Starting the service brings them, and your brain, back.",
      actions: ["start-service", "retry"],
      steps: [],
      detail: failure.detail || null,
      legacyConsequence: null,
    };
  }

  if (failure.kind === "incompatible") {
    return {
      title: `This app needs an update to connect to your ${BRAND.name} service.`,
      body: `The service is running and your data is untouched. This app is too old to talk to it, so update the app — the service is never downgraded to match.`,
      // Never "use the built-in server": a private child would fight the
      // running service for the instance lock.
      actions: [
        ...(input.canCheckForUpdates ? (["check-for-updates"] as const) : []),
        "open-in-browser",
        "retry",
      ],
      steps: [],
      detail: failure.detail || null,
      legacyConsequence: null,
    };
  }

  return {
    title: failure.reason,
    body: `${BRAND.name} could not reach the service. It may still be starting up.`,
    actions: ["retry"],
    steps: [],
    detail: failure.detail || null,
    legacyConsequence: null,
  };
}

export const FLOW_SERVICE_RECOVERY_ACTION_LABELS: Record<FlowServiceRecoveryAction, string> = {
  retry: "Try again",
  "start-service": "Start service",
  "check-for-updates": "Check for updates",
  "open-in-browser": "Open in browser",
  "use-legacy-backend": "Continue with the built-in server",
};
