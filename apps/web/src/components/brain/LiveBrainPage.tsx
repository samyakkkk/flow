import { BrainIcon } from "./BrainIcon";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BrainCommand,
  BrainState,
  BrainCli,
  BrainWorkspace,
  BrainResponse,
  EnvironmentId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { PlusIcon, SettingsIcon, Folder } from "lucide-react";
import { brainCommand } from "../../state/brain";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects } from "../../state/entities";
import type { BrainSnapshot } from "../../brain/repository";
import { BrainPage } from "./BrainPage";
import { BrainSources, BrainIndexing } from "./BrainSources";
import { BrainSelect, CreateBrainDialog, cliName } from "./BrainControls";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
} from "../ui/dialog";

function toSnapshot(workspace: BrainWorkspace | undefined): BrainSnapshot {
  return {
    id: workspace?.id ?? "",
    name: workspace?.name ?? "",
    description: "",
    entities: (workspace?.knowledge.entities ?? []).map((entity, index, entities) => ({
      ...entity,
      x:
        entities.length === 1
          ? 50
          : 50 + 35 * Math.cos((index / entities.length) * 2 * Math.PI - Math.PI / 2),
      y:
        entities.length === 1
          ? 50
          : 50 + 35 * Math.sin((index / entities.length) * 2 * Math.PI - Math.PI / 2),
    })),
    edges: workspace?.knowledge.edges ?? [],
    memories: [],
    sources: (workspace?.sources ?? []).map((source) => ({
      name: source.repository,
      detail: source.message,
    })),
  };
}

export function LiveBrainPage({
  selectedWorkspaceId,
  selectedEnvironmentId,
  onSelectionChange,
}: {
  selectedWorkspaceId: string | null;
  selectedEnvironmentId: string | null;
  onSelectionChange: (workspaceId: string | null, environmentId: string | null) => void;
}) {
  const primary = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  // An explicit environment must never silently resolve to a different brain host.
  const environmentId = selectedEnvironmentId
    ? (environments.find((entry) => entry.environmentId === selectedEnvironmentId)?.environmentId ??
      null)
    : (primary ?? environments[0]?.environmentId ?? null);
  return (
    <BrainController
      key={environmentId ?? "disconnected"}
      environmentId={environmentId}
      selectedWorkspaceId={selectedWorkspaceId}
      onSelectionChange={onSelectionChange}
      environmentSelector={
        <BrainSelect
          label="Brain computer"
          value={environmentId ?? ""}
          options={environments.map((entry) => ({
            value: entry.environmentId,
            label: entry.label,
          }))}
          onChange={(value) => onSelectionChange(null, value)}
        />
      }
    />
  );
}

function BrainController({
  environmentId,
  selectedWorkspaceId,
  onSelectionChange,
  environmentSelector,
}: {
  environmentId: EnvironmentId | null;
  selectedWorkspaceId: string | null;
  onSelectionChange: (workspaceId: string | null, environmentId: string | null) => void;
  environmentSelector: React.ReactNode;
}) {
  const execute = useAtomCommand(brainCommand, { reportFailure: false });
  const [state, setState] = useState<BrainState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const mounted = useRef(true);
  const pending = useRef<Promise<unknown> | null>(null);
  const transportError = useRef(false);
  const allProjects = useProjects();
  const projects = allProjects.filter((project) => project.environmentId === environmentId);
  const workspace = selectedWorkspaceId
    ? state?.workspaces.find((item) => item.id === selectedWorkspaceId)
    : state?.workspaces[0];

  const send = useCallback(
    async (input: BrainCommand, background = false): Promise<BrainResponse | null> => {
      if (!environmentId) return null;
      while (pending.current) {
        if (background && input.action === "read") return null;
        await pending.current.catch(() => {});
      }
      if (!mounted.current) return null;
      if (!background) setBusy(true);
      const request = execute({ environmentId, input });
      pending.current = request;
      try {
        const result = await request;
        if (!mounted.current) return null;
        if (result._tag === "Failure") {
          transportError.current = true;
          const failure = squashAtomCommandFailure(result);
          setError(
            failure instanceof Error
              ? failure.message
              : "Could not reach this brain. Reconnect and retry.",
          );
          return null;
        }
        setState(result.value.state);
        if (!background || result.value.error || transportError.current)
          setError(result.value.error);
        transportError.current = false;
        return result.value;
      } finally {
        if (pending.current === request) pending.current = null;
        if (mounted.current && !background) setBusy(false);
      }
    },
    [environmentId, execute],
  );

  useEffect(() => {
    mounted.current = true;
    void send({ action: "read" }, true);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void send({ action: "read" }, true);
    }, 2000);
    const refreshOnVisible = () => {
      if (document.visibilityState === "visible") void send({ action: "read" }, true);
    };
    document.addEventListener("visibilitychange", refreshOnVisible);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshOnVisible);
    };
  }, [send]);

  useEffect(() => {
    if (!selectedWorkspaceId && workspace) onSelectionChange(workspace.id, environmentId);
  }, [environmentId, onSelectionChange, selectedWorkspaceId, workspace]);

  const selectionError = !environmentId
    ? "Connect to the computer that hosts this brain."
    : state && selectedWorkspaceId && !workspace
      ? "This brain is not available on the selected computer. Choose another brain."
      : null;
  const isIndexing =
    workspace?.sources.some((source) =>
      ["queued", "cloning", "indexing", "embedding"].includes(source.status),
    ) ?? false;
  return (
    <>
      <BrainPage
        snapshot={toSnapshot(workspace)}
        hasBrain={Boolean(workspace)}
        isIndexing={isIndexing}
        loading={!state && Boolean(environmentId) && !error}
        error={error ?? selectionError}
        onCreate={() => setCreateOpen(true)}
        indexing={workspace && <BrainIndexing workspace={workspace} send={send} busy={busy} />}
        toolbar={
          <header className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <BrainSelect
                label="Current brain"
                value={workspace?.id ?? ""}
                disabled={!state?.workspaces.length}
                options={(state?.workspaces ?? []).map((item) => ({
                  value: item.id,
                  label: item.name,
                  icon: <BrainIcon id={item.id} />,
                }))}
                onChange={(value) => onSelectionChange(value, environmentId)}
              />
              <span className="text-xs text-muted-foreground">
                {workspace ? "Shared knowledge for your projects" : "Workspace knowledge"}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Brain settings"
                onClick={() => setSettingsOpen(true)}
              >
                <SettingsIcon size={16} />
              </Button>
              <Button
                variant="outline"
                disabled={!state || busy}
                onClick={() => setCreateOpen(true)}
              >
                <PlusIcon size={14} />
                New brain
              </Button>
            </div>
          </header>
        }
      >
        {workspace && state && environmentId && (
          <BrainSources
            key={workspace.id}
            workspace={workspace}
            state={state}
            environmentId={environmentId}
            send={send}
            busy={busy}
          />
        )}
        {workspace && (
          <section className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-medium">Connected projects</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Projects that use this brain's knowledge.
                </p>
              </div>
              <BrainSelect
                label="Connect an existing project"
                value=""
                disabled={busy}
                options={projects
                  .filter((project) => !workspace.projectIds?.includes(project.id))
                  .map((project) => ({ value: project.id, label: project.title }))}
                onChange={(id) => {
                  const project = projects.find((entry) => entry.id === id);
                  if (project)
                    void send({
                      action: "bindProject",
                      projectId: project.id,
                      workspaceId: workspace.id,
                    });
                }}
              />
            </div>
            <div className="divide-y divide-border rounded-xl border border-border bg-card">
              {!projects.some((project) => workspace.projectIds?.includes(project.id)) && (
                <p className="p-4 text-xs text-muted-foreground">
                  Create a project from the sidebar or connect an existing one above. Its repository
                  will be added as a source automatically.
                </p>
              )}
              {projects
                .filter((project) => workspace.projectIds?.includes(project.id))
                .map((project) => {
                  const connected = state?.workspaces.find((brain) =>
                    brain.projectIds?.includes(project.id),
                  );
                  return (
                    <div key={project.id} className="flex flex-wrap items-center gap-3 p-4">
                      <Folder size={16} className="text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-sm">{project.title}</span>
                      <BrainSelect
                        label={`Brain for ${project.title}`}
                        value={connected?.id ?? "none"}
                        disabled={busy}
                        options={[
                          { value: "none", label: "No brain" },
                          ...(state?.workspaces ?? []).map((brain) => ({
                            value: brain.id,
                            label: brain.name,
                            icon: <BrainIcon id={brain.id} />,
                          })),
                        ]}
                        onChange={(value) =>
                          void send({
                            action: "bindProject",
                            projectId: project.id,
                            workspaceId: value === "none" ? null : value,
                          })
                        }
                      />
                    </div>
                  );
                })}
            </div>
          </section>
        )}
      </BrainPage>
      <CreateBrainDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        state={state}
        send={send}
        onCreated={(id) => onSelectionChange(id, environmentId)}
      />
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>Brain settings</DialogTitle>
            <DialogDescription>
              {workspace?.name ?? "Choose where your brain runs."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-5">
            <div className="space-y-2">
              <p className="text-sm">Computer</p>
              {environmentSelector}
            </div>
            {workspace && (
              <div className="space-y-2">
                <p className="text-sm">Default indexing CLI</p>
                <BrainSelect
                  label="Default indexing CLI"
                  value={workspace.cli}
                  options={(state?.clis ?? []).map((entry) => ({
                    value: entry.id,
                    label: cliName(entry.id),
                    disabled: !entry.installed,
                  }))}
                  disabled={busy}
                  onChange={(value) =>
                    void send({
                      action: "configure",
                      workspaceId: workspace.id,
                      cli: value as BrainCli,
                    })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Used when you connect or reindex a source. Running jobs keep their selected CLI.
                </p>
              </div>
            )}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}
