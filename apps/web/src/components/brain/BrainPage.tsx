import { Tabs } from "@base-ui/react/tabs";
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
  connectionNotice,
  error,
  toolbar,
  indexing,
  skills,
  memories,
  children,
  onCreate,
}: {
  snapshot: BrainSnapshot;
  hasBrain: boolean;
  isIndexing: boolean;
  loading: boolean;
  connectionNotice: { title: string; description: string } | null;
  error: string | null;
  toolbar: ReactNode;
  indexing: ReactNode;
  skills?: ReactNode;
  memories?: ReactNode;
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
          {snapshot.entities.length > 0 && connectionNotice && (
            <p
              role="status"
              className="rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground"
            >
              {connectionNotice.title} {connectionNotice.description}
            </p>
          )}
          {error && (
            <p
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
            >
              {error}
            </p>
          )}
          <Tabs.Root defaultValue="graph" className="space-y-6">
            <Tabs.List
              aria-label="Brain views"
              className="flex gap-1 overflow-x-auto border-b border-border"
            >
              {[
                ["graph", "Knowledge Graph"],
                ["skills", "Auto-Skills"],
                ["memories", "Memories"],
              ].map(([value, label]) => (
                <Tabs.Tab
                  key={value}
                  value={value}
                  className="shrink-0 border-b-2 border-transparent px-4 py-3 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[active]:border-primary data-[active]:text-foreground"
                >
                  {label}
                </Tabs.Tab>
              ))}
            </Tabs.List>
            <Tabs.Panel value="graph" className="space-y-6 outline-none">
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
                        ? `Building · ${snapshot.entities.length} entities · ${snapshot.edges.length} relationships`
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
                    <div
                      role="status"
                      className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center"
                    >
                      <BrainCircuit size={28} className="text-muted-foreground/60" />
                      <h3 className="text-sm font-medium">
                        {connectionNotice
                          ? connectionNotice.title
                          : loading
                            ? "Opening brain…"
                            : error && !hasBrain
                              ? "Brain unavailable"
                              : !hasBrain
                                ? "Create your first brain"
                                : isIndexing
                                  ? "Building your knowledge graph…"
                                  : snapshot.sources.length > 0
                                    ? "No knowledge indexed yet"
                                    : "Map your code and its connections"}
                      </h3>
                      <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
                        {connectionNotice
                          ? connectionNotice.description
                          : loading
                            ? "Loading your brains and their knowledge."
                            : error && !hasBrain
                              ? "Your brain could not be opened. Check the connection or choose another brain in Brain settings."
                              : hasBrain
                                ? isIndexing
                                  ? "Nodes and connections appear here as the indexer discovers them."
                                  : snapshot.sources.length > 0
                                    ? "Check the connected sources below to start or retry indexing."
                                    : "Connect a GitHub repository or local folder below."
                                : "Choose a name and the CLI that will build its knowledge."}
                      </p>
                      {!hasBrain && !loading && !connectionNotice && !error && (
                        <Button variant="outline" onClick={onCreate}>
                          <PlusIcon size={14} />
                          New brain
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </section>
              {hasBrain && indexing}
              {hasBrain && children}
            </Tabs.Panel>
            <Tabs.Panel value="skills" className="space-y-4 outline-none">
              {skills ?? (
                <p className="py-8 text-sm text-muted-foreground">
                  Connect a brain to view its auto-skills.
                </p>
              )}
            </Tabs.Panel>
            <Tabs.Panel value="memories" className="space-y-4 outline-none">
              {memories ?? (
                <p className="py-8 text-sm text-muted-foreground">
                  Connect a brain to view its memories.
                </p>
              )}
            </Tabs.Panel>
          </Tabs.Root>
        </div>
      </main>
    </SidebarInset>
  );
}
