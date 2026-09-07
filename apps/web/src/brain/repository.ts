export interface BrainEntity {
  id: string;
  name: string;
  kind: string;
  description: string;
  source?: string;
  x: number;
  y: number;
}
export interface BrainMemory {
  id: string;
  kind: "Decision" | "Preference" | "Gotcha";
  title: string;
  body: string;
  source: string;
  entityIds: readonly string[];
}
export interface BrainSnapshot {
  id: string;
  name: string;
  description: string;
  entities: readonly BrainEntity[];
  edges: readonly { from: string; to: string; label: string }[];
  memories: readonly BrainMemory[];
  sources: readonly { name: string; detail: string }[];
}
// Sample is a distinct mode: it must never be mistaken for an attached local brain.
// Future adapters talk to a brain backend, never directly to FalkorDB or a model.
export interface BrainRepository {
  readonly mode: "sample";
  listWorkspaces(): readonly Pick<BrainSnapshot, "id" | "name">[];
  read(workspaceId: string): BrainSnapshot;
}
export function searchMemories(snapshot: BrainSnapshot, query: string, kind: string) {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return snapshot.memories.filter(
    (memory) =>
      (kind === "All" || memory.kind === kind) &&
      terms.every((term) =>
        `${memory.title} ${memory.body} ${memory.source}`.toLowerCase().includes(term),
      ),
  );
}
