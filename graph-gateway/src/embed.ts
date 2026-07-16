// Semantic search support. Entities and queries are embedded with a local
// EmbeddingGemma-300M model (768-dim) via node-llama-cpp — no API key needed.
// The model downloads from HuggingFace on first run (~300 MB) and is cached
// locally by node-llama-cpp.
//
// Deliberately non-fatal: if the model hasn't finished loading yet, every
// embed function returns null. Writes still succeed (just without a vector)
// and find_entity falls back to the lexical CONTAINS match it always did.
// Once the model is ready, reconcile.ts backfills all nodes written during
// the download window.

import { isLocalEmbedReady, embedTextLocal, embedBatchLocal, LOCAL_EMBED_DIM } from "./local-embed.js";

export const EMBED_DIM = LOCAL_EMBED_DIM; // 768

export function embeddingsEnabled(): boolean {
  return isLocalEmbedReady();
}

// Human-readable words for the schema's machine labels. Embedding "workflow:"
// or "API endpoint:" beats the raw "Workflow:" / "APIEndpoint:" token — natural
// language sits closer to how queries are phrased. Unknown types fall through
// to the raw label, so new schema types still work without a code change.
const TYPE_WORDS: Record<string, string> = {
  APIEndpoint: "API endpoint",
  Handler: "handler",
  Service: "service",
  Capability: "capability",
  UsageContract: "integration contract",
  Concept: "concept",
  Workflow: "workflow",
  Procedure: "procedure",
  Note: "note",
  ExternalService: "external service",
  Database: "database",
  DatabaseTable: "database table",
  Repository: "repository",
  Queue: "queue",
  Cache: "cache",
  S3Bucket: "S3 bucket",
  AWSResource: "AWS resource",
};

// Canonical text we embed for a node. Documents (nodes) embed type+name+desc;
// queries embed the raw phrase the caller typed. Asymmetric doc/query text is
// normal for this model. Formulation A/B-tested on the flow graph: leading with
// a natural-language type word + name, then the description, then aliases scored
// best (MRR 0.764) — dropping the type or prose-ifying it both regressed recall.
export function entityText(
  type: string,
  name: string,
  description?: string | null,
  aliases?: string | null,
  trigger?: string | null,
): string {
  const parts = [`${TYPE_WORDS[type] ?? type}: ${name}`];
  // Procedures carry a when-clause ("when adding a DB migration") — it's the
  // retrieval hook, phrased the way task prompts are phrased, so it belongs in
  // the embedded document right after the name.
  if (trigger) parts.push(`applies ${String(trigger)}`);
  if (description) parts.push(String(description));
  if (aliases) parts.push(`aka ${aliases}`);
  return parts.join("\n");
}

export async function embedText(text: string): Promise<number[] | null> {
  const clean = text.trim();
  if (!clean) return null;
  return embedTextLocal(clean);
}

// Query-path variant of embedText that reports WHY embedding failed. Retrieval
// callers (find_entity) surface this to the agent — a model not yet loaded
// must read as "semantic search unavailable", not as an empty graph. A wrong
// conclusion here is expensive: agents have filed coverage-gap flags against
// graphs that in fact held the answer.
export async function embedQuery(text: string): Promise<{ vec: number[] | null; error?: string }> {
  const clean = text.trim();
  if (!clean) return { vec: null, error: "empty query" };
  if (!isLocalEmbedReady()) return { vec: null, error: "local embedding model not yet loaded" };
  const vec = await embedTextLocal(clean);
  return { vec, error: vec ? undefined : "embedding returned null" };
}

// Batched embedding for backfill. Returns one slot per input (null where a
// chunk failed) so callers can align results with their node list.
export async function embedBatch(texts: string[]): Promise<(number[] | null)[]> {
  if (texts.length === 0) return [];
  return embedBatchLocal(texts.map((t) => t.trim() || " "));
}
