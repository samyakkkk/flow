import type { DesktopAttachFailure, DesktopFlowServiceAdoption } from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";

import { APP_DISPLAY_NAME } from "../../branding";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import {
  describeAdoptionStep,
  describeFlowServiceRecovery,
  FLOW_SERVICE_RECOVERY_ACTION_LABELS,
  type FlowServiceRecoveryAction,
} from "./flowServiceRecovery.logic";

/**
 * The whole window, when the desktop could not attach to the Flow service.
 *
 * It is deliberately the only entry point for this: there is no workspace to
 * put a banner in, and Settings (which owns the service's steady state) is not
 * reachable without a connected server. The screen is dumb — the failure kind
 * arrives on the desktop bridge and `flowServiceRecovery.logic.ts` decides what
 * to say; everything here is calls back across the bridge and plain layout.
 *
 * No spinners: the adoption steps are a static list that grows as the journal
 * does, which says more than an animation and costs no frames.
 */

// Polling only while adoption is running: a journal that says "in progress"
// gains a line every minute or so, and the screen is otherwise idle.
const ADOPTION_POLL_INTERVAL_MS = 2_000;

function useAdoptionJournal(active: boolean): DesktopFlowServiceAdoption | null {
  const [adoption, setAdoption] = useState<DesktopFlowServiceAdoption | null>(null);

  useEffect(() => {
    const read = window.desktopBridge?.getFlowServiceAdoption;
    if (!read) return;
    let cancelled = false;
    const load = () => {
      void read().then(
        (next) => {
          if (!cancelled) setAdoption(next);
        },
        () => undefined,
      );
    };
    load();
    if (!active) return;
    const timer = window.setInterval(load, ADOPTION_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active]);

  return adoption;
}

export function FlowServiceRecoverySurface({
  failure,
}: {
  readonly failure: DesktopAttachFailure;
}) {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  // Adoption is the only thing that progresses without the user, so it is the
  // only thing worth re-reading.
  const adoption = useAdoptionJournal(failure.kind === "not-installed");
  const [pending, setPending] = useState<FlowServiceRecoveryAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const view = describeFlowServiceRecovery({
    failure,
    adoption,
    canCheckForUpdates: typeof bridge?.checkForUpdate === "function",
  });

  const runAction = useCallback(
    (action: FlowServiceRecoveryAction) => {
      setPending(action);
      setActionError(null);
      const finish = (message: string | null) => {
        setPending(null);
        setActionError(message);
        // A successful retry re-attaches in the main process; the renderer only
        // learns about it by booting again against a live server.
        if (message === null && (action === "retry" || action === "start-service")) {
          window.location.reload();
        }
      };
      const fail = (message: string) => {
        finish(message);
      };

      switch (action) {
        case "retry": {
          const retry = bridge?.retryFlowServiceAttach;
          if (!retry) return fail("This app cannot retry the connection.");
          void retry().then(
            (result) => finish(result.ok ? null : (result.detail ?? "The retry did not start.")),
            () => fail("The retry did not start."),
          );
          return;
        }
        case "start-service": {
          const restart = bridge?.restartFlowService;
          if (!restart) return fail("This app cannot start the service.");
          void restart().then(
            (result) =>
              finish(
                result.ok
                  ? null
                  : result.reason === "not-managed"
                    ? "Nothing on this machine is set to run the service. Run `flow start` in a terminal."
                    : (result.detail ?? "The service did not start."),
              ),
            () => fail("The service did not start."),
          );
          return;
        }
        case "check-for-updates": {
          const check = bridge?.checkForUpdate;
          if (!check) return fail("This app cannot check for updates.");
          void check().then(
            () => finish(null),
            () => fail("The update check failed."),
          );
          return;
        }
        case "open-in-browser": {
          const open = bridge?.openFlowServiceInBrowser;
          if (!open) return fail("This app cannot open the service in a browser.");
          void open().then(
            (result) =>
              finish(result.ok ? null : (result.detail ?? "The browser could not be opened.")),
            () => fail("The browser could not be opened."),
          );
          return;
        }
        case "use-legacy-backend": {
          const relaunch = bridge?.relaunchWithLegacyBackend;
          if (!relaunch) return fail("This app cannot switch to the built-in server.");
          void relaunch().then(
            (result) => finish(result.ok ? null : (result.detail ?? "The relaunch failed.")),
            () => fail("The relaunch failed."),
          );
          return;
        }
      }
    },
    [bridge],
  );

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute inset-x-0 top-0 h-44 bg-[radial-gradient(44rem_16rem_at_top,color-mix(in_srgb,var(--color-amber-500)_12%,transparent),transparent)]" />
        <div className="absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_90%,var(--color-black))_0%,var(--background)_55%)]" />
      </div>

      <section className="relative w-full max-w-xl rounded-2xl border border-border/80 bg-card/90 p-6 shadow-2xl shadow-black/20 backdrop-blur-md sm:p-8">
        <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
          {APP_DISPLAY_NAME}
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">{view.title}</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{view.body}</p>

        {view.steps.length > 0 ? (
          <ul className="mt-5 space-y-1.5 text-sm">
            {view.steps.map((step) => (
              <li className="flex items-center gap-2 text-muted-foreground" key={step.name}>
                <span aria-hidden className="text-xs">
                  {step.ok ? "✓" : "•"}
                </span>
                <span className={step.ok ? "text-foreground/85" : undefined}>
                  {describeAdoptionStep(step.name)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}

        {actionError ? (
          <div className="mt-5 rounded-lg border border-destructive/30 bg-destructive/6 px-3 py-2 text-sm text-destructive">
            {actionError}
          </div>
        ) : null}

        {view.actions.length > 0 ? (
          <div className="mt-5 flex flex-wrap gap-2">
            {view.actions.map((action, index) => (
              <Button
                disabled={pending !== null}
                key={action}
                onClick={() => {
                  runAction(action);
                }}
                size="sm"
                variant={index === 0 ? "default" : "outline"}
              >
                {FLOW_SERVICE_RECOVERY_ACTION_LABELS[action]}
              </Button>
            ))}
          </div>
        ) : null}

        {view.legacyConsequence ? (
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            {view.legacyConsequence}
          </p>
        ) : null}

        {view.detail ? (
          <Collapsible className="mt-5">
            <CollapsibleTrigger className="text-xs font-medium text-muted-foreground underline-offset-4 hover:underline">
              Technical detail
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="mt-2 max-h-48 overflow-auto rounded-lg border border-border/70 bg-background/80 px-3 py-2 text-xs whitespace-pre-wrap text-foreground/85">
                {view.detail}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        ) : null}
      </section>
    </div>
  );
}
