import { isElectron } from "../../env";
import { useState } from "react";
import {
  BrainCircuit,
  Search,
  Network,
  BookOpen,
  Database,
  ArrowUpRight,
  GitBranch,
  MessageSquare,
  Layers,
} from "lucide-react";
import { sampleBrainRepository } from "../../brain/sampleData";
import { searchMemories } from "../../brain/repository";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import "./brain.css";

export function BrainPage() {
  const [workspaceId, setWorkspaceId] = useState("sample-flow");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("All");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const snapshot = sampleBrainRepository.read(workspaceId);
  const selected = snapshot.entities.find((entity) => entity.id === selectedId);
  const memories = searchMemories(snapshot, query, kind);
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <WorkspacePageHeader electron={isElectron} className="border-b border-border/50">
        <BrainCircuit size={16} className="text-muted-foreground" />
        <span className="text-sm">Brain</span>
        <span className="ml-auto text-xs text-muted-foreground">Workspace knowledge</span>
      </WorkspacePageHeader>
      <main className="flow-brain min-h-0 flex-1 overflow-y-auto">
        <div className="brain-content">
          <div className="brain-toolbar">
            <span className="brain-eyebrow">FLOW / BRAIN</span>
            <label className="brain-workspace">
              Workspace{" "}
              <select
                aria-label="Brain workspace"
                value={workspaceId}
                onChange={(event) => {
                  setWorkspaceId(event.target.value);
                  setSelectedId(null);
                  setQuery("");
                  setKind("All");
                }}
              >
                {sampleBrainRepository.listWorkspaces().map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="brain-intro">
            <div>
              <h1>
                A little context.
                <br />
                <span>A lot less starting over.</span>
              </h1>
              <p>{snapshot.description}</p>
            </div>
            <div className="brain-emblem">
              <BrainCircuit size={44} strokeWidth={1.25} />
            </div>
          </div>
          <div className="brain-sample">
            <span className="brain-dot" />
            <strong>Sample workspace</strong>
            <span>Explore example data. Your real brain is not connected.</span>
          </div>
          <div className="brain-stats">
            {[
              { label: "Knowledge entities", value: snapshot.entities.length, icon: Network },
              { label: "Durable memories", value: snapshot.memories.length, icon: BookOpen },
              { label: "Knowledge sources", value: snapshot.sources.length, icon: Layers },
            ].map(({ label, value, icon: Icon }) => (
              <div key={label}>
                <Icon size={17} />
                <strong>{value.toString().padStart(2, "0")}</strong>
                <span>{label}</span>
              </div>
            ))}
          </div>
          <div className="brain-grid">
            <section className="brain-card brain-map">
              <div className="brain-card-heading">
                <div>
                  <h2>
                    <Network size={16} />
                    Knowledge map
                  </h2>
                  <p>Follow the connections behind {snapshot.name}.</p>
                </div>
                <span className="brain-small-label">{snapshot.edges.length} relationships</span>
              </div>
              <div className="brain-graph" aria-label="Workspace knowledge graph">
                <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                  {snapshot.edges.map((edge) => {
                    const from = snapshot.entities.find((entity) => entity.id === edge.from)!;
                    const to = snapshot.entities.find((entity) => entity.id === edge.to)!;
                    return (
                      <line
                        key={`${edge.from}-${edge.to}`}
                        x1={from.x}
                        y1={from.y}
                        x2={to.x}
                        y2={to.y}
                      />
                    );
                  })}
                </svg>
                {snapshot.entities.map((entity, index) => (
                  <button
                    key={entity.id}
                    className={`brain-node ${index === 0 ? "brain-node-root" : ""} ${selectedId === entity.id ? "brain-node-selected" : ""}`}
                    style={{ left: `${entity.x}%`, top: `${entity.y}%` }}
                    aria-pressed={selectedId === entity.id}
                    onClick={() => setSelectedId(selectedId === entity.id ? null : entity.id)}
                  >
                    <span className="brain-node-symbol">
                      {index === 0 ? <BrainCircuit size={19} /> : <span />}
                    </span>
                    <strong>{entity.name}</strong>
                    <small>{entity.kind}</small>
                  </button>
                ))}
              </div>
              <div className="brain-map-caption">
                <span>
                  <i />
                  System
                </span>
                <span>
                  <i />
                  Connected knowledge
                </span>
                <span className="ml-auto">Select an entity to explore</span>
              </div>
            </section>
            <aside className="brain-card brain-inspector">
              <div className="brain-card-heading">
                <h2>{selected ? "Entity details" : "Inside this brain"}</h2>
                {selected && (
                  <button aria-label="Close entity details" onClick={() => setSelectedId(null)}>
                    ×
                  </button>
                )}
              </div>
              {selected ? (
                <>
                  <span className="brain-kind">{selected.kind}</span>
                  <h3>{selected.name}</h3>
                  <p>{selected.description}</p>
                  <h4>Connected memories</h4>
                  {snapshot.memories
                    .filter((memory) => memory.entityIds.includes(selected.id))
                    .map((memory) => (
                      <div className="brain-related" key={memory.id}>
                        <BookOpen size={14} />
                        <span>
                          {memory.title}
                          <small>{memory.source}</small>
                        </span>
                      </div>
                    ))}
                  <h4>Relationships</h4>
                  {snapshot.edges
                    .filter((edge) => edge.from === selected.id || edge.to === selected.id)
                    .map((edge) => (
                      <p className="brain-edge" key={`${edge.from}-${edge.to}`}>
                        {snapshot.entities.find((entity) => entity.id === edge.from)?.name} →{" "}
                        {edge.label} →{" "}
                        {snapshot.entities.find((entity) => entity.id === edge.to)?.name}
                      </p>
                    ))}
                </>
              ) : (
                <>
                  <div className="brain-inspector-icon">
                    <Database size={24} />
                  </div>
                  <h3>
                    Knowledge that stays
                    <br />
                    with the workspace.
                  </h3>
                  <p>
                    Code gives your agents the what. Your brain keeps the why: decisions, lessons,
                    and the connections between them.
                  </p>
                  <div className="brain-runtime">
                    <span className="brain-dot" />
                    <div>
                      <strong>Preview mode</strong>
                      <small>Example data · no brain service connected</small>
                    </div>
                  </div>
                  <p className="brain-future">
                    Next: connect the app-managed local brain, with one shared database and
                    embedding model.
                  </p>
                </>
              )}
            </aside>
          </div>
          <section className="brain-card brain-memories">
            <div className="brain-card-heading">
              <div>
                <h2>
                  <BookOpen size={16} />
                  Memory
                </h2>
                <p>The things your next session should already know.</p>
              </div>
              <span className="brain-small-label">
                {memories.length} of {snapshot.memories.length}
              </span>
            </div>
            <div className="brain-memory-tools">
              <div className="brain-filters" aria-label="Filter memories">
                {["All", "Decision", "Preference", "Gotcha"].map((filter) => (
                  <button
                    key={filter}
                    aria-pressed={kind === filter}
                    onClick={() => setKind(filter)}
                  >
                    {filter === "All" ? "All memories" : `${filter}s`}
                  </button>
                ))}
              </div>
              <label className="brain-search">
                <Search size={15} />
                <input
                  aria-label="Search memories"
                  placeholder="Search this brain…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
            </div>
            <div className="brain-memory-list">
              {memories.map((memory) => (
                <article key={memory.id}>
                  <span className={`brain-kind brain-kind-${memory.kind.toLowerCase()}`}>
                    {memory.kind}
                  </span>
                  <div>
                    <h3>{memory.title}</h3>
                    <p>{memory.body}</p>
                    <small>
                      <MessageSquare size={12} />
                      {memory.source}
                    </small>
                  </div>
                </article>
              ))}
              {memories.length === 0 && (
                <div className="brain-empty">
                  <Search size={22} />
                  <h3>No matching memories</h3>
                  <p>Try another search or filter.</p>
                  <button
                    onClick={() => {
                      setQuery("");
                      setKind("All");
                    }}
                  >
                    Clear filters
                  </button>
                </div>
              )}
            </div>
          </section>
          <section className="brain-card brain-sources">
            <div className="brain-card-heading">
              <div>
                <h2>
                  <GitBranch size={16} />
                  Sources & connectors
                </h2>
                <p>Where your brain gets its context.</p>
              </div>
              <span className="brain-small-label">Sample sources</span>
            </div>
            <div className="brain-source-grid">
              {snapshot.sources.map((source) => (
                <div key={source.name}>
                  <GitBranch size={18} />
                  <div>
                    <strong>{source.name}</strong>
                    <small>{source.detail}</small>
                  </div>
                  <span className="brain-kind">Example</span>
                </div>
              ))}
            </div>
            <div className="brain-connector-note">
              <Layers size={16} />
              <span>Slack, Linear & more</span>
              <span className="ml-auto">
                Connector setup comes next <ArrowUpRight size={13} />
              </span>
            </div>
          </section>
          <footer className="brain-bottom">
            One workspace. One brain.<span>Local first. Ready for a remote home.</span>
          </footer>
        </div>
      </main>
    </SidebarInset>
  );
}
