import { useEffect, useState } from "react";
import type { BrainResponse, EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  BrainCircuitIcon,
  ChevronDownIcon,
  SparklesIcon,
  Maximize2Icon,
  AlertCircleIcon,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import { brainCommand } from "../../state/brain";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
} from "../ui/dialog";
import { BrainGraph } from "./BrainGraph";
import { useProjectBrainChoice } from "./useProjectBrainChoice";
import { Button } from "../ui/button";

export function ChatBrainPanel({
  environmentId,
  threadId,
  projectId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  projectId: ProjectId;
}) {
  const execute = useAtomCommand(brainCommand, { reportFailure: false });
  const [response, setResponse] = useState<BrainResponse | null>(null);
  const [error, setError] = useState(false);
  const [changedIds, setChangedIds] = useState<string[]>([]);
  const [savedNow, setSavedNow] = useState(false);
  const [memoriesExpanded, setMemoriesExpanded] = useState(true);
  const [brainExpanded, setBrainExpanded] = useState(false);
  const [view, setView] = useState<string | null>(null);
  const { chooseBrain, brainChoiceDialog } = useProjectBrainChoice();
  const [connecting, setConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  async function connectBrain() {
    if (connecting) return;
    setConnecting(true);
    setConnectionError("");
    try {
      const choice = await chooseBrain(environmentId, "This project", projectId);
      if (!choice) return;
      const result = await execute({
        environmentId,
        input: { action: "bindProject", projectId, workspaceId: choice.workspaceId },
      });
      if (result._tag === "Failure" || result.value.error) {
        setConnectionError(
          result._tag === "Success"
            ? result.value.error!
            : "Could not connect the brain. Please retry.",
        );
        return;
      }
      setRefreshKey((value) => value + 1);
    } finally {
      setConnecting(false);
    }
  }
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let pending = false;
    let revision: string | undefined;
    let previousNotes: Map<string, string> | undefined;
    let highlightTimer: ReturnType<typeof setTimeout>;
    let delay = 100;
    const refresh = async () => {
      if (disposed || pending || document.visibilityState === "hidden") return;
      pending = true;
      try {
        const result = await execute({
          environmentId,
          input: { action: "readChat", threadId, ...(revision ? { revision } : {}) },
        });
        if (disposed) return;
        if (result._tag === "Failure") {
          setError(true);
          delay = 5000;
          revision = undefined;
          return;
        }
        revision = result.value.chatMemories?.revision;
        delay = revision ? 100 : 5000;
        const currentNotes = new Map(
          result.value.chatMemories?.memories.map((note) => [note.id, note.text]),
        );
        if (
          previousNotes &&
          (currentNotes.size !== previousNotes.size ||
            [...currentNotes].some(([id, text]) => previousNotes!.get(id) !== text))
        ) {
          setChangedIds(
            [...currentNotes]
              .filter(([id, text]) => previousNotes!.get(id) !== text)
              .map(([id]) => id),
          );
          setSavedNow(true);
          clearTimeout(highlightTimer);
          highlightTimer = setTimeout(() => {
            setChangedIds([]);
            setSavedNow(false);
          }, 8000);
        }
        previousNotes = currentNotes;
        setError(Boolean(result.value.error));
        setResponse((previous) =>
          JSON.stringify(previous) === JSON.stringify(result.value) ? previous : result.value,
        );
      } catch {
        revision = undefined;
        delay = 5000;
        if (!disposed) setError(true);
      } finally {
        pending = false;
        if (!disposed) {
          clearTimeout(timer);
          timer = setTimeout(() => void refresh(), delay);
        }
      }
    };
    const visible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    void refresh();
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      clearTimeout(timer);
      clearTimeout(highlightTimer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [environmentId, threadId, execute, refreshKey]);
  const brain = response?.state.workspaces[0];
  const failedSources = brain?.sources.filter((source) => source.status === "error") ?? [];
  const notes = response?.chatMemories;
  const selectedMemory = notes?.memories.find((memory) => view === `memory:${memory.id}`);
  const memoryStatus = !brain
    ? "Connect a brain to save memories."
    : notes?.status === "extracting"
      ? "Updating memories…"
      : notes?.status === "error"
        ? "Extraction needs attention. Flow will retry."
        : notes?.status === "disabled"
          ? "Automatic extraction is disabled."
          : savedNow
            ? "Saved just now"
            : "Saved automatically from this conversation";
  return (
    <>
      <aside
        aria-label="Flow brain and chat memories"
        className="order-first m-3 min-h-0 shrink-0 self-start w-[calc(100%-1.5rem)] lg:order-last lg:ml-0 lg:mr-4 lg:mt-4 lg:w-80"
      >
        <div className="max-h-[55dvh] overflow-y-auto rounded-3xl border border-border/70 bg-card/95 p-4 shadow-[0_4px_24px_-8px_rgba(0,0,0,0.16)] lg:max-h-[75dvh]">
          <div className="mb-3 flex items-center gap-2">
            <BrainCircuitIcon className="size-4 text-primary" />
            <h2 className="text-sm font-semibold">Flow</h2>
            <span className="ml-auto text-xs text-muted-foreground">Your context</span>
          </div>
          {error && (
            <p role="alert" className="mb-3 text-xs text-destructive">
              Could not refresh context. {response ? "Showing last loaded data." : "Reconnecting…"}
            </p>
          )}
          {!response && !error && (
            <p role="status" className="py-3 text-xs text-muted-foreground">
              Loading your brain…
            </p>
          )}
          {!brain && (
            <div className="px-2 py-2">
              <Button
                size="sm"
                variant="outline"
                className="w-full"
                disabled={connecting}
                onClick={() => void connectBrain()}
              >
                {connecting ? "Connecting…" : "Connect brain"}
              </Button>
              {connectionError && (
                <p role="alert" className="pt-2 text-xs text-destructive">
                  {connectionError}
                </p>
              )}
            </div>
          )}
          {response && (
            <>
              <section aria-label="Connected brain">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    aria-expanded={brainExpanded}
                    onClick={() => setBrainExpanded((value) => !value)}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-2 py-2 text-left hover:bg-muted/60"
                  >
                    <BrainCircuitIcon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs text-muted-foreground">Brain</span>
                      <span className="block truncate text-sm">
                        {brain?.name ?? "No brain connected"}
                      </span>
                    </span>
                    <ChevronDownIcon
                      className={`size-4 shrink-0 text-muted-foreground ${brainExpanded ? "rotate-180" : ""}`}
                    />
                  </button>
                  {brain && (
                    <button
                      type="button"
                      aria-label="Expand brain graph"
                      onClick={() => setView("brain")}
                      className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <Maximize2Icon className="size-3.5" />
                    </button>
                  )}
                </div>
                {brain && failedSources.length > 0 && (
                  <div
                    role="alert"
                    className="mt-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive"
                  >
                    <div className="flex items-center gap-2 font-medium">
                      <AlertCircleIcon className="size-4 shrink-0" />
                      <span>
                        Indexing failed for {failedSources.length}{" "}
                        {failedSources.length === 1 ? "source" : "sources"}
                      </span>
                    </div>
                    <ul className="mt-2 max-h-40 space-y-2 overflow-y-auto">
                      {failedSources.map((source) => (
                        <li key={source.id}>
                          <details>
                            <summary className="cursor-pointer break-words font-medium">
                              {source.repository || source.localPath || "Source"}
                            </summary>
                            <p className="mt-1 whitespace-pre-wrap break-words">
                              {source.message ||
                                "Indexing did not complete. Open the brain to retry this source."}
                            </p>
                          </details>
                        </li>
                      ))}
                    </ul>
                    <Link
                      to="/brain"
                      search={{ brain: brain.id, environment: environmentId }}
                      className="mt-3 inline-block font-medium underline underline-offset-2"
                    >
                      Manage sources and retry →
                    </Link>
                  </div>
                )}
                {brainExpanded && (
                  <div className="mt-2 overflow-hidden rounded-xl border border-border/50">
                    {brain && response.state.database.status !== "ready" ? (
                      <p role="alert" className="p-3 text-xs text-destructive">
                        {response.state.database.message}
                      </p>
                    ) : brain?.knowledge.entities.length ? (
                      <BrainGraph knowledge={brain.knowledge} compact />
                    ) : (
                      <p className="p-3 text-xs text-muted-foreground">
                        {brain
                          ? "Index sources to see your knowledge graph."
                          : "Connect a brain above to give this chat shared knowledge."}
                      </p>
                    )}
                    <Link
                      to="/brain"
                      search={{ brain: brain?.id, environment: environmentId }}
                      className="block px-3 py-2 text-xs text-primary hover:underline"
                    >
                      Open brain →
                    </Link>
                  </div>
                )}
              </section>
              <section
                aria-label="Memories from this chat"
                className="mt-3 border-t border-border/60 pt-3"
              >
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    aria-expanded={memoriesExpanded}
                    onClick={() => setMemoriesExpanded((value) => !value)}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-2 py-2 text-left hover:bg-muted/60"
                  >
                    <SparklesIcon className="size-4 shrink-0 text-primary" />
                    <span className="flex-1 text-sm">Memories</span>
                    <span className="text-xs text-muted-foreground">
                      {notes?.memories.length ?? 0}
                    </span>
                    <ChevronDownIcon
                      className={`size-4 text-muted-foreground ${memoriesExpanded ? "rotate-180" : ""}`}
                    />
                  </button>
                  <button
                    type="button"
                    aria-label="Expand all chat memories"
                    onClick={() => setView("memories")}
                    className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <Maximize2Icon className="size-3.5" />
                  </button>
                </div>
                {memoriesExpanded && (
                  <>
                    <p role="status" className="px-2 py-2 text-[11px] text-muted-foreground">
                      {memoryStatus}
                    </p>
                    {notes?.memories.length ? (
                      <ol className="max-h-64 space-y-1 overflow-y-auto">
                        {notes.memories.map((memory) => (
                          <li
                            key={memory.id}
                            className={`rounded-xl transition-colors motion-reduce:transition-none ${changedIds.includes(memory.id) ? "bg-primary/10" : ""}`}
                          >
                            <button
                              type="button"
                              aria-label={`Read memory: ${memory.text}`}
                              onClick={() => setView(`memory:${memory.id}`)}
                              className="group flex w-full items-start gap-2 rounded-xl px-2 py-2.5 text-left hover:bg-muted/60"
                            >
                              <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary/50" />
                              <span className="line-clamp-3 flex-1 whitespace-pre-wrap break-words text-xs leading-relaxed">
                                {memory.text}
                              </span>
                              <Maximize2Icon className="mt-0.5 size-3 shrink-0 text-muted-foreground opacity-50 group-hover:opacity-100" />
                            </button>
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <p className="px-2 py-3 text-xs leading-relaxed text-muted-foreground">
                        No memories yet. Useful context will appear here as Flow learns from this
                        chat.
                      </p>
                    )}
                  </>
                )}
              </section>
            </>
          )}
        </div>
      </aside>
      {brainChoiceDialog}
      <Dialog
        open={view !== null}
        onOpenChange={(open) => {
          if (!open) setView(null);
        }}
      >
        <DialogPopup className={view === "brain" ? "sm:max-w-4xl" : "sm:max-w-2xl"}>
          <DialogHeader>
            <DialogTitle>
              {view === "brain"
                ? (brain?.name ?? "Brain")
                : view === "memories"
                  ? "This chat’s memories"
                  : "Chat memory"}
            </DialogTitle>
            <DialogDescription>
              {view === "brain"
                ? "The knowledge connected to this project."
                : "Saved from this conversation and available to your agent."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {view === "brain" ? (
              brain && response?.state.database.status === "ready" ? (
                <BrainGraph knowledge={brain.knowledge} />
              ) : (
                <p className="text-sm text-muted-foreground">The brain is currently unavailable.</p>
              )
            ) : view === "memories" ? (
              <div className="space-y-3">
                {notes?.memories.length ? (
                  notes.memories.map((memory) => (
                    <article key={memory.id} className="rounded-xl border border-border p-4">
                      <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                        {memory.text}
                      </p>
                    </article>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No memories saved from this chat yet.
                  </p>
                )}
              </div>
            ) : selectedMemory ? (
              <article>
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                  {selectedMemory.text}
                </p>
                <p className="mt-4 text-xs text-muted-foreground">
                  {selectedMemory.origin === "user_stated"
                    ? "From you"
                    : "Extracted from the conversation"}
                </p>
              </article>
            ) : null}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}
