import { useCallback, useState } from "react";

import { useEnvironmentQuery } from "~/state/query";
import { desktopFlowServiceAtom, refreshDesktopFlowService } from "~/state/desktopFlowService";
import {
  describeFlowService,
  describeFlowServiceActionResult,
  describeUnmanagedFlowService,
} from "./flowServiceSettings.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";

/**
 * The reverse state for "quitting the app leaves the service running": what the
 * persistent Flow service is doing, and the two ways to act on it. Hosts that
 * cannot manage it (a browser tab, or a desktop shell older than the bridge
 * methods) get the same section read-only, so the service is never invisible.
 */
export function FlowServiceSettings({
  descriptor,
}: {
  readonly descriptor: {
    readonly serverVersion?: string;
    readonly desktopProtocol?: number;
  } | null;
}) {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const canManage = bridge?.getFlowServiceStatus !== undefined;
  const query = useEnvironmentQuery(canManage ? desktopFlowServiceAtom : null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<"stop" | "restart" | null>(null);
  const [isStopDialogOpen, setIsStopDialogOpen] = useState(false);

  const runAction = useCallback(
    async (action: "stop" | "restart") => {
      const call = action === "stop" ? bridge?.stopFlowService : bridge?.restartFlowService;
      if (!call) return;
      setPendingAction(action);
      setActionError(null);
      try {
        setActionError(describeFlowServiceActionResult(await call()));
      } catch (cause) {
        setActionError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setPendingAction(null);
        // The service may take a moment to settle, but the panel must not show
        // a state the user just changed, so re-read immediately either way.
        refreshDesktopFlowService();
      }
    },
    [bridge],
  );

  if (!canManage) {
    return (
      <SettingsSection {...searchableSetting("flow-service")}>
        <SettingsRow
          title="Service"
          description={describeUnmanagedFlowService({
            serverVersion: descriptor?.serverVersion ?? null,
            desktopProtocol: descriptor?.desktopProtocol ?? null,
          })}
        />
      </SettingsSection>
    );
  }

  const status = query.data;
  const view = status ? describeFlowService(status) : null;
  const loadError = query.error;

  return (
    <SettingsSection {...searchableSetting("flow-service")}>
      <SettingsRow
        title="Service"
        description={view?.stateDescription ?? loadError ?? "Reading the service status…"}
        status={
          <span className="block text-muted-foreground">{view ? view.unitDescription : null}</span>
        }
        control={
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">{view?.stateLabel ?? "—"}</span>
            <Button
              size="sm"
              variant="outline"
              disabled={!view?.canStop || pendingAction !== null}
              onClick={() => {
                setIsStopDialogOpen(true);
              }}
            >
              {pendingAction === "stop" ? "Stopping…" : "Stop service"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!view?.canRestart || pendingAction !== null}
              onClick={() => void runAction("restart")}
            >
              {pendingAction === "restart" ? "Restarting…" : "Restart"}
            </Button>
          </div>
        }
      />
      {view?.restartHint ? (
        <SettingsRow title="Start at login" description={view.restartHint} />
      ) : null}
      {view?.dataHome ? (
        <SettingsRow
          title="Data location"
          description="Where this machine's projects, history and brain live. It is never moved."
          control={<span className="font-mono text-sm break-all">{view.dataHome}</span>}
        />
      ) : null}
      {view?.serverOrigin ? (
        <SettingsRow
          title="Server address"
          description="The address this app and the browser attach to."
          control={<span className="font-mono text-sm break-all">{view.serverOrigin}</span>}
        />
      ) : null}
      {actionError ? (
        <SettingsRow
          title="Last action"
          status={<span className="block text-destructive">{actionError}</span>}
        />
      ) : null}
      <AlertDialog
        open={isStopDialogOpen}
        onOpenChange={(open) => {
          if (pendingAction !== null) return;
          setIsStopDialogOpen(open);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop the Flow service?</AlertDialogTitle>
            <AlertDialogDescription>
              Coding agents running outside this app stop capturing until the service is started
              again. Open projects and any work in progress on this machine stop with it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              disabled={pendingAction !== null}
              render={<Button variant="outline" disabled={pendingAction !== null} />}
            >
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={pendingAction !== null}
              onClick={() => {
                setIsStopDialogOpen(false);
                void runAction("stop");
              }}
            >
              Stop service
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
}
