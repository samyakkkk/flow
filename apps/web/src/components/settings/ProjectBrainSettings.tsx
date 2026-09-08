import { BrainIcon } from "../brain/BrainIcon";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BrainCommand, BrainState, EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { brainCommand } from "../../state/brain";
import { useAtomCommand } from "../../state/use-atom-command";
import { BrainSelect, CreateBrainDialog } from "../brain/BrainControls";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function ProjectBrainSettings({
  members,
}: {
  members: readonly SidebarProjectGroupMember[];
}) {
  const environmentIds = [...new Set(members.map((member) => member.environmentId))];
  return (
    <SettingsSection title="Brain">
      <p className="px-4 text-sm text-muted-foreground">
        Choose the shared knowledge your project uses. Connecting a brain adds this repository as a
        source.
      </p>
      {environmentIds.map((environmentId) => (
        <EnvironmentBrainSettings
          key={environmentId}
          environmentId={environmentId}
          members={members.filter((member) => member.environmentId === environmentId)}
          showCheckout={members.length > 1}
        />
      ))}
    </SettingsSection>
  );
}

function EnvironmentBrainSettings({
  environmentId,
  members,
  showCheckout,
}: {
  environmentId: EnvironmentId;
  members: SidebarProjectGroupMember[];
  showCheckout: boolean;
}) {
  const execute = useAtomCommand(brainCommand, { reportFailure: false });
  const [state, setState] = useState<BrainState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [createFor, setCreateFor] = useState<ProjectId | null>(null);
  const pending = useRef(false);
  const generation = useRef(0);
  const send = useCallback(
    async (input: BrainCommand) => {
      if (pending.current) return null;
      pending.current = true;
      const request = ++generation.current;
      setBusy(true);
      setError("");
      try {
        const result = await execute({ environmentId, input });
        if (request !== generation.current) return null;
        if (result._tag === "Failure") {
          setError("Could not reach this machine's brains. Check the connection and retry.");
          return null;
        }
        setState(result.value.state);
        setError(result.value.error ?? "");
        return result.value;
      } finally {
        if (request === generation.current) {
          pending.current = false;
          setBusy(false);
        }
      }
    },
    [environmentId, execute],
  );

  useEffect(() => {
    void send({ action: "read", metadataOnly: true });
    return () => {
      generation.current++;
      pending.current = false;
    };
  }, [send]);

  return (
    <>
      {members.map((member) => (
        <SettingsRow
          key={member.id}
          title={
            showCheckout
              ? `Project brain · ${member.environmentLabel ?? "This machine"}`
              : "Project brain"
          }
          description={
            showCheckout
              ? member.workspaceRoot
              : "Select a brain, create one, or choose No brain to disconnect."
          }
          control={
            <div className="flex flex-wrap items-center gap-2">
              <BrainSelect
                label={`Brain for ${member.workspaceRoot}`}
                value={
                  state?.workspaces.find((brain) => brain.projectIds?.includes(member.id))?.id ??
                  "none"
                }
                options={[
                  {
                    value: "none",
                    label: state ? "No brain" : busy ? "Loading brains…" : "Brains unavailable",
                  },
                  ...(state?.workspaces ?? []).map((brain) => ({
                    value: brain.id,
                    label: brain.name,
                    icon: <BrainIcon id={brain.id} />,
                  })),
                ]}
                disabled={!state || busy}
                onChange={(value) => {
                  void send({
                    action: "bindProject",
                    projectId: member.id,
                    workspaceId: value === "none" ? null : value,
                  });
                }}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={!state || busy}
                onClick={() => setCreateFor(member.id)}
              >
                New brain
              </Button>
            </div>
          }
        />
      ))}
      {busy && (
        <p role="status" className="px-4 text-sm text-muted-foreground">
          Updating brains…
        </p>
      )}
      {error && (
        <div role="alert" className="flex items-center gap-2 px-4 text-sm text-destructive">
          <p>{error}</p>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void send({ action: "read", metadataOnly: true })}
          >
            Retry
          </Button>
        </div>
      )}
      <CreateBrainDialog
        open={createFor !== null}
        onOpenChange={(open) => {
          if (!open) setCreateFor(null);
        }}
        state={state}
        send={send}
        onCreated={(workspaceId) => {
          if (createFor) void send({ action: "bindProject", projectId: createFor, workspaceId });
        }}
      />
    </>
  );
}
