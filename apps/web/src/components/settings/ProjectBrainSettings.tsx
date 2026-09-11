import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BrainCommand, BrainState, EnvironmentId } from "@t3tools/contracts";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { brainCommand } from "../../state/brain";
import { useAtomCommand } from "../../state/use-atom-command";
import { BrainSelect, CreateBrainDialog } from "../brain/BrainControls";
import { BrainIcon } from "../brain/BrainIcon";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function ProjectBrainSettings({
  members,
}: {
  members: readonly SidebarProjectGroupMember[];
}) {
  const execute = useAtomCommand(brainCommand, { reportFailure: false });
  const targets = useMemo(
    () => [...new Map(members.map((member) => [member.environmentId, member])).values()],
    [members],
  );
  const [states, setStates] = useState<Map<EnvironmentId, BrainState>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const pending = useRef(false);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    const results = await Promise.all(
      targets.map(async (target) => {
        const result = await execute({
          environmentId: target.environmentId,
          input: { action: "read", metadataOnly: true, projectId: target.id },
        });
        return { target, result };
      }),
    );
    if (request !== generation.current) return;
    const next = new Map<EnvironmentId, BrainState>();
    for (const { target, result } of results) {
      if (result._tag === "Success" && !result.value.error)
        next.set(target.environmentId, result.value.state);
    }
    setStates(next);
    if (next.size !== targets.length)
      setError("Could not load brains from every machine for this project. Reconnect and retry.");
  }, [execute, targets]);
  useEffect(() => {
    void refresh();
    return () => {
      generation.current++;
    };
  }, [refresh]);
  const first = targets[0];
  const available = first ? states.get(first.environmentId) : undefined;
  const loaded = states.size === targets.length && targets.length > 0;
  const choices = (available?.workspaces ?? []).filter((brain) =>
    targets.every((target) =>
      states.get(target.environmentId)?.workspaces.some((other) => other.id === brain.id),
    ),
  );
  const assignments = new Set(
    members.map(
      (member) =>
        states
          .get(member.environmentId)
          ?.workspaces.find((brain) => brain.projectIds?.includes(member.id))?.id ?? "none",
    ),
  );
  const mixed = loaded && assignments.size > 1;
  const selected = mixed ? "conflict" : ([...assignments][0] ?? "none");
  async function bind(workspaceId: string | null) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      for (const target of targets) {
        const result = await execute({
          environmentId: target.environmentId,
          input: { action: "bindProject", projectId: target.id, workspaceId },
        });
        if (result._tag === "Failure" || result.value.error) {
          setError(
            result._tag === "Success"
              ? (result.value.error ?? "Could not save the project brain.")
              : "Could not save the brain on every machine. Reconnect and retry.",
          );
          break;
        }
      }
      await refresh();
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function send(input: BrainCommand) {
    if (!first) return null;
    const result = await execute({ environmentId: first.environmentId, input });
    if (result._tag === "Failure") return null;
    setStates((previous) => new Map(previous).set(first.environmentId, result.value.state));
    return result.value;
  }
  return (
    <SettingsSection title="Brain">
      <SettingsRow
        title="Project brain"
        description="One brain for this project, shared by its checkouts and chats. Connecting adds the repository as a source."
        control={
          <div className="flex flex-wrap items-center gap-2">
            <BrainSelect
              label="Project brain"
              value={selected}
              disabled={!loaded || busy}
              options={[
                { value: "none", label: loaded ? "No brain" : "Loading brains…" },
                ...(mixed
                  ? [{ value: "conflict", label: "Choose one brain", disabled: true }]
                  : []),
                ...choices.map((brain) => ({
                  value: brain.id,
                  label: brain.name,
                  icon: <BrainIcon id={brain.id} />,
                })),
              ]}
              onChange={(value) => void bind(value === "none" ? null : value)}
            />
            {targets.length === 1 && (
              <Button
                size="sm"
                variant="outline"
                disabled={!loaded || busy}
                onClick={() => setCreateOpen(true)}
              >
                New brain
              </Button>
            )}
          </div>
        }
      />
      {mixed && (
        <p role="alert" className="px-4 text-sm text-destructive">
          This project's checkouts previously used different brains. Choose one above to use for the
          whole project.
        </p>
      )}
      {loaded && targets.length > 1 && choices.length === 0 && (
        <p className="px-4 text-sm text-muted-foreground">
          Connect these machines to the same shared brain to select it for this project.
        </p>
      )}
      {busy && (
        <p role="status" className="px-4 text-sm text-muted-foreground">
          Saving project brain…
        </p>
      )}
      {error && (
        <div role="alert" className="flex items-center gap-2 px-4 text-sm text-destructive">
          <p>{error}</p>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setError("");
              void refresh();
            }}
          >
            Retry
          </Button>
        </div>
      )}
      <CreateBrainDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        state={available ?? null}
        send={send}
        onCreated={(id) => void bind(id)}
      />
    </SettingsSection>
  );
}
