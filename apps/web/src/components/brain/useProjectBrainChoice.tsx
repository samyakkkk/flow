import { BrainIcon } from "./BrainIcon";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BrainCommand, BrainState, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { brainCommand } from "../../state/brain";
import { useAtomCommand } from "../../state/use-atom-command";
import { BrainSelect, CreateBrainDialog } from "./BrainControls";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";

type Choice = { workspaceId: string | null } | null;
/** One confirmation for every folder/clone entry point, before project creation. */
export function useProjectBrainChoice({ required = false }: { required?: boolean } = {}) {
  const execute = useAtomCommand(brainCommand, { reportFailure: false });
  const [target, setTarget] = useState<{ environmentId: EnvironmentId; title: string } | null>(
    null,
  );
  const [state, setState] = useState<BrainState | null>(null);
  const [selected, setSelected] = useState("none");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const resolver = useRef<((choice: Choice) => void) | null>(null);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
      resolver.current?.(null);
      resolver.current = null;
    },
    [],
  );
  const chooseBrain = useCallback(
    (environmentId: EnvironmentId, title: string, projectId?: ProjectId): Promise<Choice> => {
      resolver.current?.(null);
      const request = ++generation.current;
      setTarget({ environmentId, title });
      setSelected(required ? "" : "none");
      setState(null);
      setError("");
      setCreateOpen(false);
      setLoading(true);
      void execute({
        environmentId,
        input: { action: "read", metadataOnly: true, projectId },
      }).then((result) => {
        if (generation.current !== request) return;
        setLoading(false);
        if (result._tag === "Success" && !result.value.error) {
          setState(result.value.state);
          const boundBrain = projectId
            ? result.value.state.workspaces.find((brain) => brain.projectIds?.includes(projectId))
            : undefined;
          setSelected(
            boundBrain?.id ?? result.value.state.workspaces[0]?.id ?? (required ? "" : "none"),
          );
          if (required && result.value.state.workspaces.length === 0) setCreateOpen(true);
        } else
          setError(
            required
              ? "Could not load brains from this computer. Retry to continue setting up this project."
              : "Could not load brains from this computer. You can retry, or continue without a brain.",
          );
      });
      return new Promise((resolve) => {
        resolver.current = resolve;
      });
    },
    [execute, required],
  );
  const finish = (choice: Choice) => {
    generation.current++;
    resolver.current?.(choice);
    resolver.current = null;
    setTarget(null);
  };
  const send = async (input: BrainCommand) => {
    if (!target) return null;
    const request = generation.current;
    const result = await execute({ environmentId: target.environmentId, input });
    if (generation.current !== request || result._tag === "Failure") return null;
    setState(result.value.state);
    return result.value;
  };
  const brainChoiceDialog = (
    <>
      <Dialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open) finish(null);
        }}
      >
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>{required ? "Choose a brain" : "Connect project to a brain"}</DialogTitle>
            <DialogDescription>
              {target?.title} will use the selected brain for knowledge, and its repository will be
              added as a source.
              {!required ? " You can also continue without a brain and connect one later." : null}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <BrainSelect
                label="Project brain"
                value={selected}
                disabled={loading}
                options={[
                  ...(!required ? [{ value: "none", label: "No brain" }] : []),
                  ...(state?.workspaces ?? []).map((brain) => ({
                    value: brain.id,
                    label: brain.name,
                    icon: <BrainIcon id={brain.id} />,
                  })),
                ]}
                onChange={setSelected}
              />
              <Button variant="outline" disabled={!state} onClick={() => setCreateOpen(true)}>
                New brain
              </Button>
            </div>
            {loading && (
              <p role="status" className="text-xs text-muted-foreground">
                Loading brains…
              </p>
            )}
            {error && (
              <div role="alert" className="space-y-2 text-xs text-destructive">
                <p>{error}</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setLoading(true);
                    void send({ action: "read", metadataOnly: true }).then((result) => {
                      setLoading(false);
                      if (result && !result.error) setError("");
                    });
                  }}
                >
                  Retry
                </Button>
              </div>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => finish(null)}>
              Cancel
            </Button>
            <Button
              disabled={loading || (required && !selected)}
              onClick={() => finish({ workspaceId: selected === "none" ? null : selected })}
            >
              {!required && selected === "none" ? "Continue without a brain" : "Connect brain"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <CreateBrainDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        state={state}
        send={send}
        initialName={required ? "My brain" : ""}
        onCreated={(id) => {
          if (required) finish({ workspaceId: id });
          else setSelected(id);
        }}
      />
    </>
  );
  return { chooseBrain, brainChoiceDialog };
}
