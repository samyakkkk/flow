import { useState } from "react";
import { Link } from "@tanstack/react-router";
import type {
  BrainWorkspace,
  BrainState,
  EnvironmentId,
  FilesystemBrowseResult,
  BrainResponse,
} from "@t3tools/contracts";
import {
  Github,
  Folder,
  FileText,
  MessageSquare,
  AudioLines,
  Layers,
  ArrowUp,
  ChevronRight,
  XIcon,
} from "lucide-react";
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
import type { SendBrainCommand } from "./BrainControls";

const active = (status: string) => ["queued", "cloning", "indexing", "embedding"].includes(status);
const statusLabel = (status: string) =>
  status === "embedding"
    ? "Saving"
    : status === "cloning"
      ? "Reading"
      : status === "ready"
        ? "Connected"
        : status === "waiting"
          ? "Needs a commit"
          : status.charAt(0).toUpperCase() + status.slice(1);

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
  const [repository, setRepository] = useState("");
  const [repositories, setRepositories] = useState<NonNullable<BrainResponse["repositories"]>>([]);
  const [branches, setBranches] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [folder, setFolder] = useState("");
  const [listing, setListing] = useState<FilesystemBrowseResult | null>(null);
  const browse = useAtomQueryRunner(filesystemEnvironment.browse, {
    reportFailure: false,
    refresh: true,
  });
  const [browsing, setBrowsing] = useState(false);
  const connected = (name: string) =>
    workspace.sources.some(
      (source) => !source.localPath && source.repository.toLowerCase() === name.toLowerCase(),
    );
  async function connect(names: string[]) {
    setError("");
    for (const name of names) {
      const branch =
        branches[name] ?? repositories.find((repo) => repo.name === name)?.defaultBranch;
      const result = await send({
        action: "import",
        workspaceId: workspace.id,
        repository: name,
        ...(branch ? { branch } : {}),
      });
      if (!result || result.error) {
        setError(result?.error ?? "Could not connect the repository. Retry.");
        return;
      }
      setSelected((current) => {
        const next = new Set(current);
        next.delete(name);
        return next;
      });
    }
    setRepository("");
    setModal(null);
  }
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
  const cards = [
    {
      name: "GitHub Repos",
      description: "Repositories and branches",
      icon: Github,
      action: () => {
        setError("");
        setModal("github");
        if (state.github.connected && repositories.length === 0)
          void send({ action: "listGithubRepositories" }).then((result) => {
            if (result?.repositories) setRepositories(result.repositories);
            else setError(result?.error ?? "Could not load repositories.");
          });
      },
      label: "Connect repositories",
    },
    {
      name: "Local Folder",
      description: "Code on this computer",
      icon: Folder,
      action: () => {
        setError("");
        setModal("folder");
      },
      label: "Choose folder",
    },
    { name: "Linear", description: "Issues and project specs", icon: Layers },
    { name: "Fireflies.ai", description: "Meeting transcripts", icon: AudioLines },
    { name: "Meeting Notes", description: "Notes and decisions", icon: FileText },
    { name: "Slack Bot", description: "Ask your brain in Slack", icon: MessageSquare },
  ];
  return (
    <section className="space-y-4" aria-label="Brain sources">
      <div>
        <h2 className="text-sm font-medium">Sources</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Add the code and context that contribute to {workspace.name}.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        {cards.map((card) => (
          <article
            key={card.name}
            className="flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-4"
          >
            <card.icon size={20} className="text-muted-foreground" />
            <div className="flex-1">
              <h3 className="text-xs font-medium">{card.name}</h3>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {card.description}
              </p>
            </div>
            {card.action ? (
              <Button
                aria-label={card.label}
                variant="outline"
                size="sm"
                className="w-full text-xs"
                onClick={card.action}
              >
                {card.name === "GitHub Repos" ? "Connect" : "Browse"}
              </Button>
            ) : (
              <span className="text-[11px] text-muted-foreground">Coming later</span>
            )}
          </article>
        ))}
      </div>
      {workspace.sources.length > 0 && (
        <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {workspace.sources.map((source) => (
            <article key={source.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              {source.localPath ? (
                <Folder size={16} className="text-muted-foreground" />
              ) : (
                <Github size={16} className="text-muted-foreground" />
              )}
              <div className="min-w-0 flex-1">
                {source.localPath ? (
                  <span className="text-sm font-medium">{source.repository}</span>
                ) : (
                  <a
                    href={`https://github.com/${source.repository}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm font-medium hover:underline"
                  >
                    {source.repository}
                  </a>
                )}
                <p
                  role="status"
                  className={`mt-1 break-words text-xs ${source.status === "error" ? "text-destructive" : "text-muted-foreground"}`}
                >
                  {source.message}
                </p>
                {source.localPath && (
                  <p className="mt-1 truncate text-xs text-muted-foreground">{source.localPath}</p>
                )}
              </div>
              <span className="rounded-md bg-muted px-2 py-1 text-[11px] text-muted-foreground">
                {statusLabel(source.status)}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void send({
                    action: active(source.status) ? "cancel" : "reindex",
                    workspaceId: workspace.id,
                    sourceId: source.id,
                  })
                }
              >
                {active(source.status)
                  ? "Cancel"
                  : source.status === "ready"
                    ? "Reindex"
                    : source.status === "waiting"
                      ? "Index"
                      : "Retry"}
              </Button>
              {!active(source.status) && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${source.repository} from brain`}
                  disabled={busy}
                  onClick={() =>
                    void send({
                      action: "removeSource",
                      workspaceId: workspace.id,
                      sourceId: source.id,
                    })
                  }
                >
                  <XIcon size={14} />
                </Button>
              )}
            </article>
          ))}
        </div>
      )}
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
              <>
                <form
                  className="flex items-end gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void connect([repository]);
                  }}
                >
                  <label className="min-w-0 flex-1 space-y-2 text-sm">
                    Repository URL
                    <Input
                      required
                      value={repository}
                      onChange={(event) => setRepository(event.target.value)}
                      placeholder="owner/repo or GitHub URL"
                    />
                  </label>
                  <Button type="submit" disabled={busy || !repository.trim()}>
                    Connect
                  </Button>
                </form>
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
                  <span className="text-xs text-muted-foreground">
                    {state.github.connected
                      ? `Signed in as ${state.github.login}`
                      : "Connect GitHub to browse your repositories."}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setError("");
                      void send({ action: "listGithubRepositories" }).then((result) => {
                        if (result?.repositories) setRepositories(result.repositories);
                        else setError(result?.error ?? "Could not load repositories.");
                      });
                    }}
                  >
                    Browse repositories
                  </Button>
                  {!state.github.connected && (
                    <Link to="/settings/source-control" className="text-xs underline">
                      Connect GitHub ↗
                    </Link>
                  )}
                </div>
                {repositories.length > 0 && (
                  <>
                    <Input
                      aria-label="Search GitHub repositories"
                      placeholder="Search repositories…"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                    />
                    <div className="max-h-64 divide-y divide-border overflow-y-auto rounded-lg border border-border">
                      {repositories
                        .filter((repo) => repo.name.toLowerCase().includes(search.toLowerCase()))
                        .map((repo) => (
                          <div key={repo.name} className="space-y-2 p-3 text-sm hover:bg-muted/40">
                            <label className="flex items-center gap-3">
                              <input
                                type="checkbox"
                                disabled={busy || connected(repo.name)}
                                checked={connected(repo.name) || selected.has(repo.name)}
                                onChange={(event) =>
                                  setSelected((current) => {
                                    const next = new Set(current);
                                    if (event.target.checked) next.add(repo.name);
                                    else next.delete(repo.name);
                                    return next;
                                  })
                                }
                              />
                              <span className="min-w-0 flex-1 truncate">{repo.name}</span>
                              <span className="text-xs text-muted-foreground">
                                {connected(repo.name)
                                  ? "Connected"
                                  : repo.private
                                    ? "Private"
                                    : "Public"}
                              </span>
                            </label>
                            {repo.description && (
                              <p className="pl-6 text-xs text-muted-foreground">
                                {repo.description}
                              </p>
                            )}
                            {selected.has(repo.name) && !connected(repo.name) && (
                              <label className="flex items-center gap-2 pl-6 text-xs text-muted-foreground">
                                Branch
                                <Input
                                  aria-label={`Branch for ${repo.name}`}
                                  size="sm"
                                  value={branches[repo.name] ?? repo.defaultBranch ?? ""}
                                  onChange={(event) =>
                                    setBranches((current) => ({
                                      ...current,
                                      [repo.name]: event.target.value,
                                    }))
                                  }
                                  placeholder="Default branch"
                                />
                              </label>
                            )}
                          </div>
                        ))}
                      {!repositories.some((repo) =>
                        repo.name.toLowerCase().includes(search.toLowerCase()),
                      ) && (
                        <p className="p-4 text-sm text-muted-foreground">
                          No repositories match your search.
                        </p>
                      )}
                    </div>
                  </>
                )}
              </>
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
            {modal === "github" ? (
              selected.size > 0 && (
                <Button disabled={busy} onClick={() => void connect([...selected])}>
                  Connect {selected.size} repositories
                </Button>
              )
            ) : (
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
