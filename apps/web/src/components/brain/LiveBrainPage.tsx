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
import type { EnvironmentConnectionPresentation } from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";
import { PlusIcon, SettingsIcon, Folder } from "lucide-react";
import { brainCommand } from "../../state/brain";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { usePreparedConnection } from "../../state/session";
import { useProjects } from "../../state/entities";
import type { BrainSnapshot } from "../../brain/repository";
import { BrainPage } from "./BrainPage";
import { BrainDocumentLibrary } from "./BrainDocuments";
import { BrainSources, BrainIndexing } from "./BrainSources";
import { BrainSelect, CreateBrainDialog, ConnectCloudDialog, cliName } from "./BrainControls";
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
    memories: workspace?.knowledge.memories ?? [],
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
  const { environments, isReady } = useEnvironments();
  // An explicit environment must never silently resolve to a different brain host.
  const environmentId = selectedEnvironmentId
    ? (environments.find((entry) => entry.environmentId === selectedEnvironmentId)?.environmentId ??
      null)
    : (primary ?? environments[0]?.environmentId ?? null);
  return (
    <BrainController
      key={environmentId ?? "disconnected"}
      environmentId={environmentId}
      environmentsReady={isReady}
      connection={
        environments.find((entry) => entry.environmentId === environmentId)?.connection ?? null
      }
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
  environmentsReady,
  connection,
  selectedWorkspaceId,
  onSelectionChange,
  environmentSelector,
}: {
  environmentId: EnvironmentId | null;
  environmentsReady: boolean;
  connection: EnvironmentConnectionPresentation | null;
  selectedWorkspaceId: string | null;
  onSelectionChange: (workspaceId: string | null, environmentId: string | null) => void;
  environmentSelector: React.ReactNode;
}) {
  const execute = useAtomCommand(brainCommand, { reportFailure: false });
  const prepared = usePreparedConnection(environmentId);
  const canRequest =
    environmentsReady && connection?.phase === "connected" && Option.isSome(prepared);
  const [state, setState] = useState<BrainState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [cloudOpen, setCloudOpen] = useState(false);
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
      if (!environmentId || !canRequest) return null;
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
    [environmentId, execute, canRequest],
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

  const selectionError =
    state && selectedWorkspaceId && !workspace
      ? "This brain is not available on the selected computer. Choose another brain."
      : null;
  const connectionNotice = !environmentsReady
    ? { title: "Opening brain…", description: "Getting your computer connection ready." }
    : !environmentId
      ? {
          title: "Choose a brain computer",
          description: "Open Brain settings to choose the computer that hosts your brain.",
        }
      : connection?.phase === "offline"
        ? {
            title: "Brain computer is offline",
            description: "Your brain will be available when the computer reconnects.",
          }
        : connection?.phase === "error"
          ? {
              title: "Could not connect to your brain computer",
              description:
                connection.error ?? "Check the computer’s connection in Settings → Connections.",
            }
          : !canRequest
            ? {
                title:
                  connection?.phase === "reconnecting"
                    ? "Reconnecting to your brain…"
                    : "Connecting to your brain…",
                description: "Your knowledge graph will appear once the connection is ready.",
              }
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
        connectionNotice={
          workspace?.remote?.status === "error"
            ? {
                title: "Cloud Brain unavailable",
                description:
                  workspace.remote.message + " Reconnect to this server to access its knowledge.",
              }
            : connectionNotice
        }
        error={
          connectionNotice
            ? null
            : (error ??
              (workspace?.remote?.status === "error" ? workspace.remote.message : selectionError))
        }
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
                {workspace?.remote
                  ? `Cloud · ${workspace.remote.status === "ready" ? "Connected" : "Unavailable"}`
                  : workspace
                    ? "Shared knowledge for your projects"
                    : "Workspace knowledge"}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                disabled={!canRequest || busy}
                onClick={() => setCloudOpen(true)}
              >
                Connect cloud
              </Button>
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
                disabled={!state || !canRequest || busy}
                onClick={() => setCreateOpen(true)}
              >
                <PlusIcon size={14} />
                New brain
              </Button>
            </div>
          </header>
        }
        docs={
          workspace &&
          environmentId && (
            <BrainDocumentLibrary
              kind="doc"
              key={`docs:${environmentId}:${workspace.id}`}
              documents={workspace.knowledge.documents ?? []}
              environmentId={environmentId}
              workspaceId={workspace.id}
            />
          )
        }
        skills={
          workspace &&
          environmentId && (
            <BrainDocumentLibrary
              kind="skill"
              key={`skills:${environmentId}:${workspace.id}`}
              documents={workspace.knowledge.documents ?? []}
              legacyMemories={workspace.knowledge.memories}
              environmentId={environmentId}
              workspaceId={workspace.id}
            />
          )
        }
      >
        {workspace && workspace.remote?.status !== "error" && state && environmentId && (
          <BrainSources
            key={workspace.id}
            workspace={workspace}
            state={
              workspace.remote
                ? {
                    ...state,
                    github: workspace.remote.github ?? {
                      connected: false,
                      login: "",
                      message: "Cloud unavailable",
                    },
                    clis: workspace.remote.clis ?? [],
                  }
                : state
            }
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
      <ConnectCloudDialog
        open={cloudOpen}
        onOpenChange={setCloudOpen}
        send={send}
        onConnected={(id) => onSelectionChange(id, environmentId)}
      />
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
            {workspace?.remote && (
              <div className="space-y-2">
                <p className="text-sm break-all">{workspace.remote.endpoint}</p>
                <a
                  href={workspace.remote.endpoint}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm underline"
                >
                  Open cloud dashboard
                </a>
                <p className="text-xs text-muted-foreground">
                  Disconnecting removes this computer’s connection. The remote Brain and its data
                  stay on the server.
                </p>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    void send({ action: "disconnectCloud", workspaceId: workspace.id }).then(
                      (result) => {
                        if (result && !result.error) {
                          setSettingsOpen(false);
                          onSelectionChange(null, environmentId);
                        }
                      },
                    );
                  }}
                >
                  Disconnect cloud Brain
                </Button>
              </div>
            )}
            {workspace && !workspace.remote && (
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
