import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import type {
  BrainCommand,
  BrainState,
  BrainCli,
  BrainWorkspace,
  EnvironmentId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { GitBranch, Github, Database, RefreshCw } from "lucide-react";
import { brainCommand } from "../../state/brain";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import type { BrainSnapshot } from "../../brain/repository";
import { BrainPage } from "./BrainPage";

function toSnapshot(workspace: BrainWorkspace | undefined): BrainSnapshot {
  if (!workspace)
    return {
      id: "",
      name: "Your workspace",
      description:
        "Create a workspace, connect a repository, and build its knowledge with your preferred CLI.",
      entities: [],
      edges: [],
      memories: [],
      sources: [],
    };
  return {
    id: workspace.id,
    name: workspace.name,
    description:
      "Repository knowledge stored in your workspace’s FalkorDB graph, with source evidence and local embeddings.",
    entities: workspace.knowledge.entities.map((entity, index, entities) => ({
      ...entity,
      x:
        entities.length === 1
          ? 50
          : 50 + 33 * Math.cos((index / entities.length) * 2 * Math.PI - Math.PI / 2),
      y:
        entities.length === 1
          ? 50
          : 50 + 34 * Math.sin((index / entities.length) * 2 * Math.PI - Math.PI / 2),
    })),
    edges: workspace.knowledge.edges,
    memories: workspace.knowledge.memories,
    sources: workspace.sources.map((source) => ({
      name: source.repository,
      detail: source.message,
    })),
  };
}

export function LiveBrainPage() {
  const primary = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const [chosenEnvironment, setChosenEnvironment] = useState<EnvironmentId | null>(null);
  const environmentId = chosenEnvironment ?? primary ?? environments[0]?.environmentId ?? null;
  // Keying the controller prevents late responses from the old environment leaking into the new one.
  return (
    <BrainController
      key={environmentId ?? "disconnected"}
      environmentId={environmentId}
      environmentSelector={
        <label>
          Computer{" "}
          <select
            aria-label="Brain computer"
            value={environmentId ?? ""}
            onChange={(event) =>
              setChosenEnvironment(
                environments.find((environment) => environment.environmentId === event.target.value)
                  ?.environmentId ?? null,
              )
            }
          >
            {environments.map((environment) => (
              <option value={environment.environmentId} key={environment.environmentId}>
                {environment.label}
              </option>
            ))}
          </select>
        </label>
      }
    />
  );
}

function BrainController({
  environmentId,
  environmentSelector,
}: {
  environmentId: EnvironmentId | null;
  environmentSelector: React.ReactNode;
}) {
  const execute = useAtomCommand(brainCommand, { reportFailure: false });
  const [state, setState] = useState<BrainState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [workspaceId, setWorkspaceId] = useState("");
  const [name, setName] = useState("");
  const [cli, setCli] = useState<BrainCli>("claude");
  const [repository, setRepository] = useState("");
  const mounted = useRef(true);
  const pending = useRef<Promise<unknown> | null>(null);
  const transportError = useRef(false);
  const workspace =
    state?.workspaces.find((item) => item.id === workspaceId) ?? state?.workspaces[0];
  const send = useCallback(
    async (input: BrainCommand, background = false) => {
      if (!environmentId) return false;
      while (pending.current) {
        if (background) return false;
        await pending.current.catch(() => {});
      }
      if (!background) setBusy(true);
      const request = execute({ environmentId, input });
      pending.current = request;
      try {
        const result = await request;
        if (!mounted.current) return false;
        if (result._tag === "Failure") {
          transportError.current = true;
          const failure = squashAtomCommandFailure(result);
          setError(
            failure instanceof Error
              ? failure.message
              : "Could not reach this computer’s brain. Reconnect and retry.",
          );
          return false;
        }
        setState(result.value.state);
        if (input.action === "create")
          setWorkspaceId(result.value.state.workspaces.at(-1)?.id ?? "");
        if (!background || result.value.error || transportError.current)
          setError(result.value.error);
        transportError.current = false;
        return !result.value.error;
      } finally {
        if (pending.current === request) pending.current = null;
        if (mounted.current) setBusy(false);
      }
    },
    [environmentId, execute],
  );
  useEffect(() => {
    mounted.current = true;
    void send({ action: "read" }, true);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void send({ action: "read" }, true);
    }, 3000);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [send]);
  const controls = (
    <div className="brain-live-controls">
      <div className="brain-connection-row">
        {environmentSelector}
        <button disabled={busy} onClick={() => void send({ action: "read" })}>
          <RefreshCw size={13} />
          Refresh
        </button>
      </div>
      {error && (
        <div role="alert" className="brain-error">
          {error}
        </div>
      )}
      {!state && (
        <p role="status">
          {environmentId
            ? "Connecting to the local brain runtime…"
            : "Connect to a computer to open its brain."}
        </p>
      )}
      {state && (
        <>
          <div className="brain-health">
            <div>
              <Database size={17} />
              <strong>FalkorDB</strong>
              <span className={`brain-status brain-status-${state.database.status}`}>
                {state.database.status}
              </span>
              <small>{state.database.message}</small>
              {state.database.status !== "ready" && (
                <button disabled={busy} onClick={() => void send({ action: "start" })}>
                  Retry runtime
                </button>
              )}
            </div>
            <div>
              <span className="brain-dot" />
              <strong>Local embeddings</strong>
              <span className="brain-status">{state.embeddings.status}</span>
              <small>{state.embeddings.message}</small>
            </div>
          </div>
          <details open={!workspace} className="brain-workspace-create">
            <summary>New brain workspace</summary>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void send({ action: "create", name, cli }).then((ok) => {
                  if (ok) setName("");
                });
              }}
            >
              <label>
                Workspace name
                <input
                  required
                  maxLength={80}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="e.g. My product"
                />
              </label>
              <label>
                Default indexing CLI
                <select value={cli} onChange={(event) => setCli(event.target.value as BrainCli)}>
                  <option value="claude">Claude Code</option>
                  <option value="codex">Codex</option>
                </select>
              </label>
              <button disabled={busy || !name.trim()} type="submit">
                Create workspace
              </button>
            </form>
          </details>
          {workspace && (
            <div className="brain-cli">
              <label>
                Default indexing CLI{" "}
                <select
                  aria-label="Default indexing CLI"
                  value={workspace.cli}
                  disabled={busy}
                  onChange={(event) =>
                    void send({
                      action: "configure",
                      workspaceId: workspace.id,
                      cli: event.target.value as BrainCli,
                    })
                  }
                >
                  {(["claude", "codex"] as const).map((id) => (
                    <option key={id} value={id}>
                      {id === "claude" ? "Claude Code" : "Codex"}
                      {state.clis.find((entry) => entry.id === id)?.installed
                        ? ""
                        : " · not installed"}
                    </option>
                  ))}
                </select>
              </label>
              <small>
                Used for the next index. Uses your CLI’s existing sign-in and model settings.
              </small>
            </div>
          )}
        </>
      )}
    </div>
  );
  const sources = (
    <section className="brain-card brain-sources">
      <div className="brain-card-heading">
        <div>
          <h2>
            <Github size={16} />
            GitHub connection
          </h2>
          <p>
            {state?.github.connected
              ? `Connected as ${state.github.login}`
              : "Import a public repository or connect your GitHub account."}
          </p>
        </div>
        <button disabled={busy || !state} onClick={() => void send({ action: "refreshGithub" })}>
          Refresh connection
        </button>
      </div>
      <div className="brain-github-body">
        <p>{state?.github.message}</p>
        {!state?.github.connected && (
          <Link to="/settings/source-control">Connect GitHub in settings ↗</Link>
        )}
        {workspace && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void send({ action: "import", workspaceId: workspace.id, repository }).then((ok) => {
                if (ok) setRepository("");
              });
            }}
          >
            <label>
              GitHub repository
              <input
                aria-label="GitHub repository"
                value={repository}
                required
                onChange={(event) => setRepository(event.target.value)}
                placeholder="owner/repository or GitHub URL"
              />
            </label>
            <button
              type="submit"
              disabled={busy || !repository.trim() || state?.database.status !== "ready"}
            >
              Connect & build brain
            </button>
          </form>
        )}
        <p className="brain-disclosure">
          The selected CLI analyzes repository text using your provider subscription. This first
          architecture pass reads up to 80 text files; coverage is shown after indexing.
        </p>
        {workspace?.sources.map((source) => (
          <div className="brain-live-source" key={source.id}>
            <GitBranch size={17} />
            <div>
              <a href={`https://github.com/${source.repository}`} target="_blank" rel="noreferrer">
                {source.repository}
              </a>
              <span className={`brain-status brain-status-${source.status}`}>{source.status}</span>
              <small role="status">{source.message}</small>
              {source.commit && (
                <small>
                  {source.branch} · {source.commit.slice(0, 8)} ·{" "}
                  {source.indexedAt ? new Date(source.indexedAt).toLocaleString() : ""}
                </small>
              )}
            </div>
            {["queued", "cloning", "indexing", "embedding"].includes(source.status) ? (
              <button
                disabled={busy}
                onClick={() =>
                  void send({ action: "cancel", workspaceId: workspace.id, sourceId: source.id })
                }
              >
                Cancel
              </button>
            ) : (
              <button
                disabled={busy}
                onClick={() =>
                  void send({ action: "reindex", workspaceId: workspace.id, sourceId: source.id })
                }
              >
                {source.status === "ready" ? "Reindex" : "Retry"}
              </button>
            )}
          </div>
        ))}
        {!workspace && <p>Create a workspace above to connect its repositories.</p>}
      </div>
    </section>
  );
  return (
    <BrainPage
      key={workspace?.id ?? "empty"}
      snapshot={toSnapshot(workspace)}
      workspaces={state?.workspaces ?? []}
      onWorkspaceChange={setWorkspaceId}
      controls={controls}
      sources={sources}
      runtimeLabel={
        state?.database.status === "ready"
          ? "Connected to this computer’s persistent graph"
          : "Not connected"
      }
    />
  );
}
