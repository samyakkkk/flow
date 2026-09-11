import { useEffect, useState } from "react";
import type { FlowBrowserUpdateState } from "@t3tools/contracts";
import { ArrowUpCircleIcon } from "lucide-react";
import { isElectron } from "../../env";
import { Button } from "../ui/button";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "../ui/alert-dialog";
import { fetchFlowBrowserUpdate, waitForFlowBrowserUpdate } from "./flowBrowserUpdate";

export function FlowBrowserUpdateNotice() {
  return isElectron ? null : <BrowserUpdateNotice />;
}

function BrowserUpdateNotice() {
  const [state, setState] = useState<FlowBrowserUpdateState | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    let pending = false;
    const check = async () => {
      if (document.hidden || pending) return;
      pending = true;
      try {
        const next = await fetchFlowBrowserUpdate();
        if (!disposed) setState(next);
      } catch {
        /* Source installations and older servers may not expose this route. */
      } finally {
        pending = false;
      }
    };
    void check();
    const timer = setInterval(() => void check(), 30000);
    const onVisible = () => void check();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const restart = async () => {
    if (!state?.readyVersion || restarting) return;
    setConfirming(false);
    setRestarting(true);
    setError(null);
    try {
      let target = state.readyVersion;
      try {
        target = (await fetchFlowBrowserUpdate(true)).readyVersion ?? target;
      } catch (cause) {
        // A dropped response can mean the restart already began. HTTP errors
        // are explicit rejections and should remain actionable immediately.
        if (cause instanceof Error && cause.message.startsWith("Flow update request failed"))
          throw cause;
      }
      await waitForFlowBrowserUpdate(target);
      window.location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not restart Flow. Please retry.");
      setRestarting(false);
    }
  };
  if (!state?.supported || (!state.readyVersion && !restarting && !error)) return null;
  return (
    <div className="rounded-lg border border-border bg-muted/40 p-3 text-xs">
      <div className="flex items-center gap-2 font-medium" role="status">
        <ArrowUpCircleIcon className="size-4 shrink-0" />
        {restarting ? "Restarting Flow…" : "Update ready"}
      </div>
      <p className="mt-1 text-muted-foreground">
        {restarting
          ? "This page will reload when Flow reconnects."
          : `Flow ${state.readyVersion} is ready to install.`}
      </p>
      {error && (
        <p className="mt-2 text-destructive" role="alert">
          {error}
        </p>
      )}
      <Button
        className="mt-2 w-full"
        size="sm"
        disabled={restarting}
        onClick={() => setConfirming(true)}
      >
        Restart to update
      </Button>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Restart Flow to update?</AlertDialogTitle>
            <AlertDialogDescription>
              This restarts the server hosting this app. Running agents and terminal commands may be
              interrupted. Your saved threads, projects, and Brain data stay in place.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)}>
              Later
            </Button>
            <Button onClick={() => void restart()}>Restart to update</Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
