import { BrainIcon } from "./BrainIcon";
import { useEffect, useRef, useState } from "react";
import type { BrainResponse, EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { retainChatContextOnError } from "@t3tools/client-runtime/state/brain";
import {
  BrainCircuitIcon,
  ChevronDownIcon,
  BookOpenIcon,
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
import { BrainDocumentDialog, BrainDocumentLibrary } from "./BrainDocuments";

export function ChatBrainPanel({
  environmentId,
  threadId,
  projectId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId | null;
  projectId: ProjectId;
}) {
  const execute = useAtomCommand(brainCommand, { reportFailure: false });
  const [response, setResponse] = useState<BrainResponse | null>(null);
  const [error, setError] = useState(false);
  const [changedIds, setChangedIds] = useState<string[]>([]);
  const [savedNow, setSavedNow] = useState(false);
  const [notesExpanded, setNotesExpanded] = useState(true);
  const [brainExpanded, setBrainExpanded] = useState(false);
  const [view, setView] = useState<string | null>(null);
  const { chooseBrain, brainChoiceDialog } = useProjectBrainChoice();
  const [connecting, setConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const autoExpandedThread = useRef<ThreadId | null>(null);
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
          input: threadId
            ? { action: "readChat", threadId, ...(revision ? { revision } : {}) }
            : { action: "read", projectId, metadataOnly: true },
        });
        if (disposed) return;
        if (result._tag === "Failure") {
          setError(true);
          delay = 5000;
          revision = undefined;
          return;
        }
        if (result.value.error) {
          revision = undefined;
          delay = 5000;
          setError(true);
          setResponse((previous) => retainChatContextOnError(previous, result.value));
          return;
        }
        revision = result.value.chatMemories?.revision;
        delay = revision ? 100 : 5000;
        const currentNotes = new Map([
          ...(result.value.chatMemories?.memories.map((note) => [note.id, note.text] as const) ??
            []),
          ...(result.value.chatMemories?.notes
            ? [[result.value.chatMemories.notes.id, result.value.chatMemories.notes.text] as const]
            : []),
          ...(result.value.chatMemories?.documents?.map(
            (doc) => [doc.id, String(doc.revision)] as const,
          ) ?? []),
        ]);
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
        setError(false);
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
  }, [environmentId, threadId, projectId, execute, refreshKey]);
  const brain = threadId
    ? response?.state.workspaces[0]
    : response?.state.workspaces.find((workspace) => workspace.projectIds?.includes(projectId));
  const failedSources = brain?.sources.filter((source) => source.status === "error") ?? [];
  const notes = response?.chatMemories;
  const consultedNodeIds = [...new Set(notes?.consultedNodeIds ?? [])];
  const consultedNodeCount = consultedNodeIds.length;
  useEffect(() => {
    if (consultedNodeCount === 0 || autoExpandedThread.current === threadId) return;
    autoExpandedThread.current = threadId;
    setBrainExpanded(true);
  }, [consultedNodeCount, threadId]);
  const memoryStatus = !brain
    ? "Connect a brain to preserve this conversation."
    : notes?.status === "extracting"
      ? "Updating notes, memories, and skills…"
      : notes?.status === "error"
        ? "Extraction needs attention. Flow will retry."
        : notes?.status === "disabled"
          ? "Automatic extraction is disabled."
          : savedNow
            ? "Saved just now"
            : notes?.notes
              ? "Saved automatically from this conversation"
              : "Ready for conversation notes";
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
                    {brain ? (
                      <BrainIcon id={brain.id} />
                    ) : (
                      <BrainCircuitIcon className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs text-muted-foreground">Brain</span>
                      <span className="block truncate text-sm">
                        {brain?.name ?? "No brain connected"}
                      </span>
                    </span>
                    {consultedNodeCount > 0 && (
                      <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                        {consultedNodeCount} used
                      </span>
                    )}
                    <ChevronDownIcon
                      className={`size-4 shrink-0 text-muted-foreground ${brainExpanded ? "rotate-180" : ""}`}
                    />
                  </button>
                  {brain && threadId && (
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
                      <BrainGraph
                        knowledge={brain.knowledge}
                        highlightedNodeIds={consultedNodeIds}
                        compact
                      />
                    ) : (
                      <p className="p-3 text-xs text-muted-foreground">
                        {brain
                          ? threadId
                            ? "Index sources to see your knowledge graph."
                            : "Open this brain to explore its knowledge graph."
                          : "Connect a brain above to give this chat shared knowledge."}
                      </p>
                    )}
                    {consultedNodeCount > 0 && (
                      <p
                        role="status"
                        className="border-t border-border/50 px-3 py-2 text-[11px] text-muted-foreground"
                      >
                        Highlighting {consultedNodeCount}{" "}
                        {consultedNodeCount === 1 ? "node" : "nodes"} used by this chat
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
            </>
          )}
          <section aria-label="Conversation notes" className="mt-3 border-t border-border/60 pt-3">
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-expanded={notesExpanded}
                onClick={() => setNotesExpanded((value) => !value)}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-2 py-2 text-left hover:bg-muted/60"
              >
                <BookOpenIcon className="size-4 shrink-0 text-primary" />
                <span className="flex-1 text-sm">Conversation notes</span>
                <ChevronDownIcon
                  className={`size-4 text-muted-foreground ${notesExpanded ? "rotate-180" : ""}`}
                />
              </button>
              {notes?.notes && (
                <button
                  type="button"
                  aria-label="Read full conversation notes"
                  onClick={() => setView("notes")}
                  className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <Maximize2Icon className="size-3.5" />
                </button>
              )}
            </div>
            {notesExpanded && (
              <>
                <p role="status" className="px-2 py-2 text-[11px] text-muted-foreground">
                  {memoryStatus}
                </p>
                {notes?.notes ? (
                  <button
                    type="button"
                    aria-label="Read full notes"
                    onClick={() => setView("notes")}
                    className={`w-full rounded-xl px-2 py-2 text-left hover:bg-muted/60 ${changedIds.includes(notes.notes.id) ? "bg-primary/5" : ""}`}
                  >
                    <span className="line-clamp-6 whitespace-pre-wrap break-words text-xs leading-relaxed">
                      {notes.notes.text}
                    </span>
                    <span className="mt-2 block text-[11px] text-primary">Read full notes →</span>
                  </button>
                ) : (
                  <p className="px-2 py-3 text-xs leading-relaxed text-muted-foreground">
                    {brain
                      ? "Your task, progress, and corrections will appear here from the first message."
                      : "Notes help you and your agent pick up where this conversation left off."}
                  </p>
                )}
                {notes?.extractionError && (
                  <details className="px-2 pb-2 text-xs text-destructive">
                    <summary className="cursor-pointer">Extraction needs attention</summary>
                    <p className="mt-2 break-words">{notes.extractionError}</p>
                  </details>
                )}
              </>
            )}
          </section>
          {brain && (
            <BrainDocumentLibrary
              key={brain.id}
              compact
              environmentId={environmentId}
              workspaceId={brain.id}
              documents={notes?.documents ?? []}
              legacyMemories={(notes?.memories ?? []).map((memory) => ({
                id: memory.id,
                kind: "Decision" as const,
                title: memory.text.slice(0, 140),
                body: memory.text,
                source: "Conversation",
                entityIds: [],
              }))}
            />
          )}
        </div>
      </aside>
      {brainChoiceDialog}
      {brain && (
        <BrainDocumentDialog
          document={view === "notes" ? (notes?.notes ?? null) : null}
          initial={notes?.notes ?? undefined}
          environmentId={environmentId}
          workspaceId={brain.id}
          onClose={() => setView(null)}
        />
      )}
      <Dialog
        open={view === "brain"}
        onOpenChange={(open) => {
          if (!open) setView(null);
        }}
      >
        <DialogPopup className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>{brain?.name ?? "Brain"}</DialogTitle>
            <DialogDescription>The knowledge connected to this project.</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {brain && response?.state.database.status === "ready" ? (
              <BrainGraph knowledge={brain.knowledge} highlightedNodeIds={consultedNodeIds} />
            ) : (
              <p className="text-sm text-muted-foreground">The brain is currently unavailable.</p>
            )}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}
