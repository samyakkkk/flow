import { useState } from "react";
import { BrainCircuit, Network, PlusIcon } from "lucide-react";
import { BrainGraph } from "./BrainGraph.tsx";
import type { BrainWorkspaceViewProps } from "./types.ts";

type Tab = "graph" | "docs" | "skills";

export function BrainWorkspaceView({
  snapshot,
  hasBrain,
  isIndexing,
  loading,
  connectionNotice,
  error,
  toolbar,
  indexing,
  sources,
  connectedProjects,
  docs,
  skills,
  onCreate,
}: BrainWorkspaceViewProps) {
  const [tab, setTab] = useState<Tab>("graph");
  const tabs: readonly [Tab, string][] = [
    ["graph", "Knowledge Graph"],
    ["docs", "Auto-Docs"],
    ["skills", "Auto-Skills"],
  ];
  return (
    <div className="flow-brain-experience">
      {toolbar}
      {snapshot.entities.length > 0 && connectionNotice && (
        <p role="status" className="flow-brain-notice">
          <strong>{connectionNotice.title}</strong> {connectionNotice.description}
        </p>
      )}
      {error && <p role="alert" className="flow-brain-error">{error}</p>}
      <div className="flow-brain-tabs" role="tablist" aria-label="Brain views">
        {tabs.map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            className={tab === value ? "active" : ""}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "graph" && (
        <div className="flow-brain-tab-panel" role="tabpanel">
          <section className="flow-brain-graph-card" aria-label="Brain knowledge graph">
            <header>
              <div>
                <h2><Network size={16} /> Knowledge graph</h2>
                <p>{hasBrain ? "Explore what this brain knows and where it came from." : "Connect sources to map your code and how it works."}</p>
              </div>
              {hasBrain && (
                <span>
                  {isIndexing ? "Building · " : ""}
                  {snapshot.entities.length} {snapshot.entities.length === 1 ? "entity" : "entities"} · {snapshot.edges.length} relationships
                </span>
              )}
            </header>
            {snapshot.entities.length > 0 ? (
              <BrainGraph knowledge={snapshot} />
            ) : (
              <div className="flow-brain-empty-graph" role="status">
                <BrainCircuit size={28} />
                <h3>
                  {connectionNotice?.title ?? (loading ? "Opening brain…" : error && !hasBrain ? "Brain unavailable" : !hasBrain ? "Create your first brain" : isIndexing ? "Building your knowledge graph…" : snapshot.sourceCount > 0 ? "No knowledge indexed yet" : "Map your code and its connections")}
                </h3>
                <p>
                  {connectionNotice?.description ?? (loading ? "Loading your brains and their knowledge." : error && !hasBrain ? "Your brain could not be opened. Check the connection or choose another brain in Brain settings." : hasBrain ? isIndexing ? "Nodes and connections appear here as the indexer discovers them." : snapshot.sourceCount > 0 ? "Check the connected sources below to start or retry indexing." : "Connect a GitHub repository or local folder below." : "Choose a name and the CLI that will build its knowledge.")}
                </p>
                {!hasBrain && !loading && !connectionNotice && !error && onCreate && (
                  <button type="button" className="flow-brain-button outline" onClick={onCreate}><PlusIcon size={14} /> New brain</button>
                )}
              </div>
            )}
          </section>
          {hasBrain && indexing}
          {hasBrain && sources}
          {hasBrain && connectedProjects}
        </div>
      )}
      {tab === "docs" && <div className="flow-brain-tab-panel" role="tabpanel">{docs ?? <p className="flow-brain-empty-library">Connect a brain to view its auto-docs.</p>}</div>}
      {tab === "skills" && <div className="flow-brain-tab-panel" role="tabpanel">{skills ?? <p className="flow-brain-empty-library">Connect a brain to view its auto-skills.</p>}</div>}
    </div>
  );
}
