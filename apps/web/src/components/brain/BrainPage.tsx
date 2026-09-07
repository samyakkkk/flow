import { isElectron } from "../../env";
import { type ReactNode } from "react";
import { BrainCircuit, Network, PlusIcon } from "lucide-react";
import type { BrainSnapshot } from "../../brain/repository";
import { SidebarInset } from "../ui/sidebar";
import { Button } from "../ui/button";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import "./brain.css";
import { BrainGraph } from "./BrainGraph";

export function BrainPage({
  snapshot,
  hasBrain,
  isIndexing,
  loading,
  error,
  toolbar,
  children,
  onCreate,
}: {
  snapshot: BrainSnapshot;
  hasBrain: boolean;
  isIndexing: boolean;
  loading: boolean;
  error: string | null;
  toolbar: ReactNode;
  children: ReactNode;
  onCreate: () => void;
}) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <WorkspacePageHeader electron={isElectron} className="border-b border-border/50">
        <BrainCircuit size={16} className="text-muted-foreground" />
        <span className="text-sm">Brain</span>
      </WorkspacePageHeader>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl space-y-6 px-5 py-6 md:px-8">
          {toolbar}
          {error && (
            <p
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
            >
              {error}
            </p>
          )}
          <section
            aria-label="Brain knowledge graph"
            className="overflow-hidden rounded-xl border border-border bg-card"
          >
            <header className="flex items-center justify-between gap-4 border-b border-border/60 px-5 py-4">
              <div>
                <h2 className="flex items-center gap-2 text-sm font-medium">
                  <Network size={16} className="text-muted-foreground" />
                  Knowledge graph
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  {hasBrain
                    ? "Explore what this brain knows and where it came from."
                    : "Connect sources to map your code and how it works."}
                </p>
              </div>
              {hasBrain && (
                <span className="text-xs text-muted-foreground">
                  {isIndexing
                    ? "Building knowledge…"
                    : `${snapshot.entities.length} ${snapshot.entities.length === 1 ? "entity" : "entities"} · ${snapshot.edges.length} relationships`}
                </span>
              )}
            </header>
            {snapshot.entities.length > 0 ? (
              <BrainGraph
                key={snapshot.id}
                knowledge={{
                  entities: snapshot.entities.map((entity) => ({
                    ...entity,
                    source: entity.source ?? "",
                  })),
                  edges: snapshot.edges,
                }}
              />
            ) : (
              <div className="brain-graph-surface">
                <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                  <BrainCircuit size={28} className="text-muted-foreground/60" />
                  <h3 className="text-sm font-medium">
                    {loading
                      ? "Opening brain…"
                      : !hasBrain
                        ? "Create your first brain"
                        : isIndexing
                          ? "Building your knowledge graph…"
                          : snapshot.sources.length > 0
                            ? "No knowledge indexed yet"
                            : "Your brain starts with a source"}
                  </h3>
                  <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
                    {hasBrain
                      ? isIndexing
                        ? "The graph will update when indexing completes."
                        : snapshot.sources.length > 0
                          ? "Check the connected sources below to start or retry indexing."
                          : "Connect a GitHub repository or local folder below."
                      : "Choose a name and the CLI that will build its knowledge."}
                  </p>
                  {!hasBrain && !loading && (
                    <Button variant="outline" onClick={onCreate}>
                      <PlusIcon size={14} />
                      New brain
                    </Button>
                  )}
                </div>
              </div>
            )}
          </section>
          {hasBrain && children}
        </div>
      </main>
    </SidebarInset>
  );
}
