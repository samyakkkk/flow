import { useState } from "react";
import {
  BrainIntegrationCatalog,
  BrainRepositoryPicker,
  BrainConnectedSources,
} from "@flow/brain-ui";
import { Link } from "@tanstack/react-router";
import type {
  BrainWorkspace,
  BrainState,
  EnvironmentId,
  FilesystemBrowseResult,
} from "@t3tools/contracts";
import { Folder, ArrowUp, ChevronRight } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { filesystemEnvironment } from "../../state/filesystem";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { type SendBrainCommand } from "./BrainControls";

const active = (status: string) => ["queued", "cloning", "indexing", "embedding"].includes(status);
// Same source catalog and focused connection dialogs as Flow's IntegrationCatalog.
// The memory-driven integrations stay visibly unavailable until their workers are ported.
export function BrainSources({
  workspace,
  state,
  environmentId,
  send,
  busy,
}: {
  workspace: BrainWorkspace;
  state: BrainState;
  environmentId: EnvironmentId;
  send: SendBrainCommand;
  busy: boolean;
}) {
  const [modal, setModal] = useState<"github" | "folder" | null>(null);
  const [connectedModal, setConnectedModal] = useState<"github" | "folder" | null>(null);
  const [error, setError] = useState("");
  const [folder, setFolder] = useState("");
  const [listing, setListing] = useState<FilesystemBrowseResult | null>(null);
  const browse = useAtomQueryRunner(filesystemEnvironment.browse, {
    reportFailure: false,
    refresh: true,
  });
  const [browsing, setBrowsing] = useState(false);
  async function browseFolder(path: string) {
    setBrowsing(true);
    setError("");
    try {
      const result = await browse({
        environmentId,
        input: { partialPath: path.endsWith("/") ? path : path + "/" },
      });
      if (result._tag === "Failure") {
        setError("Could not browse this folder on the selected computer.");
        return;
      }
      setListing(result.value);
      setFolder(result.value.parentPath);
    } finally {
      setBrowsing(false);
    }
  }
  return (
    <section className="space-y-4" aria-label="Brain sources">
      <BrainIntegrationCatalog
        brainName={workspace.name}
        github={{
          onConnect: () => {
            setError("");
            setModal("github");
          },
          onList: () => setConnectedModal("github"),
        }}
        folder={{
          description: workspace.remote
            ? "Use a checkout’s GitHub repository"
            : "Code on this computer",
          onConnect: () => {
            setError("");
            setModal("folder");
          },
          onList: () => setConnectedModal("folder"),
        }}
      />
      <Dialog
        open={connectedModal !== null}
        onOpenChange={(open) => !open && setConnectedModal(null)}
      >
        <DialogPopup className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {connectedModal === "github"
                ? "Connected GitHub repositories"
                : "Connected local folders"}
            </DialogTitle>
            <DialogDescription>
              Sources connected to {workspace.name}. Reindex to pull the latest committed changes.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {workspace.sources.some(
              (source) => Boolean(source.localPath) === (connectedModal === "folder"),
            ) ? (
              <BrainSourceList
                sources={workspace.sources.filter(
                  (source) => Boolean(source.localPath) === (connectedModal === "folder"),
                )}
                workspaceId={workspace.id}
                send={send}
                busy={busy}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                No {connectedModal === "github" ? "GitHub repositories" : "local folders"} connected
                yet.
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConnectedModal(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={modal !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setModal(null);
        }}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {modal === "github" ? "Connect GitHub repositories" : "Connect a local folder"}
            </DialogTitle>
            <DialogDescription>
              {modal === "github"
                ? `Select sources for ${workspace.name}. Public repositories work without signing in.`
                : "Choose a Git repository on this computer. Flow reads committed files without changing your working folder."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            {modal === "github" ? (
              <BrainRepositoryPicker
                connectedRepositories={workspace.sources
                  .filter((source) => !source.localPath)
                  .map((source) => source.repository)}
                connection={
                  <>
                    <span>
                      {state.github.connected
                        ? `Signed in as ${state.github.login}`
                        : "Connect GitHub to browse your repositories."}
                    </span>
                    {!state.github.connected && (
                      <Link to="/settings/source-control">Connect GitHub ↗</Link>
                    )}
                  </>
                }
                loadRepositories={async () => {
                  const result = await send(
                    { action: "listGithubRepositories", workspaceId: workspace.id },
                    true,
                  );
                  if (!result?.repositories)
                    throw Error(result?.error ?? "Could not load repositories.");
                  return result.repositories;
                }}
                loadBranches={async (repository) => {
                  const result = await send(
                    { action: "listGithubBranches", workspaceId: workspace.id, repository },
                    true,
                  );
                  if (!result?.branches) throw Error(result?.error ?? "Could not load branches.");
                  return result.branches;
                }}
                connect={async (repository, branch) => {
                  const result = await send({
                    action: "import",
                    workspaceId: workspace.id,
                    repository,
                    ...(branch ? { branch } : {}),
                  });
                  if (!result || result.error)
                    throw Error(result?.error ?? "Could not connect the repository.");
                }}
                onConnected={() => setModal(null)}
              />
            ) : (
              <>
                <form
                  className="flex items-end gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void browseFolder(folder || "~");
                  }}
                >
                  <label className="min-w-0 flex-1 space-y-2 text-sm">
                    Folder path
                    <Input
                      value={folder}
                      onChange={(event) => setFolder(event.target.value)}
                      placeholder="Browse to a repository…"
                    />
                  </label>
                  <Button variant="outline" type="submit" disabled={browsing}>
                    {browsing ? "Loading…" : "Browse"}
                  </Button>
                </form>
                {listing && (
                  <div className="max-h-64 overflow-y-auto rounded-lg border border-border">
                    <button
                      className="flex w-full items-center gap-2 p-3 text-xs hover:bg-muted"
                      onClick={() =>
                        void browseFolder(
                          listing.parentPath.replace(/[/\\][^/\\]+[/\\]?$/, "") || "/",
                        )
                      }
                    >
                      <ArrowUp size={14} />
                      Parent folder
                    </button>
                    {listing.entries.map((entry) => (
                      <button
                        className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-muted"
                        key={entry.fullPath}
                        onClick={() => void browseFolder(entry.fullPath)}
                      >
                        <Folder size={14} />
                        <span className="flex-1 text-left">{entry.name}</span>
                        <ChevronRight size={14} />
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setModal(null)}>
              Close
            </Button>
            {modal === "folder" && (
              <Button
                disabled={busy || !folder.trim()}
                onClick={() => {
                  setError("");
                  void send({
                    action: "importFolder",
                    workspaceId: workspace.id,
                    path: folder,
                  }).then((result) => {
                    if (result && !result.error) setModal(null);
                    else setError(result?.error ?? "Could not connect the folder.");
                  });
                }}
              >
                Connect folder
              </Button>
            )}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </section>
  );
}

export function BrainSourceList({
  sources,
  workspaceId,
  send,
  busy,
}: {
  sources: BrainWorkspace["sources"];
  workspaceId: string;
  send: SendBrainCommand;
  busy: boolean;
}) {
  return (
    <BrainConnectedSources
      sources={sources}
      busy={busy}
      onAction={(action, sourceId) => {
        void send({ action, workspaceId, sourceId });
      }}
    />
  );
}

export function BrainIndexing({
  workspace,
  send,
  busy,
}: {
  workspace: BrainWorkspace;
  send: SendBrainCommand;
  busy: boolean;
}) {
  const sources = workspace.sources.filter((source) => active(source.status));
  if (!sources.length) return null;
  return (
    <section aria-label="Active indexing">
      <BrainSourceList sources={sources} workspaceId={workspace.id} send={send} busy={busy} />
    </section>
  );
}
