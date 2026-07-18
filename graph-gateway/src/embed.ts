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

// The long-lived HTTP gateway owns the local model. Short-lived MCP processes
// set FLOW_EMBED_URL and borrow that model instead of loading another ~300 MB
// copy. The gateway process itself leaves this unset and embeds in-process.
const REMOTE_EMBED_URL = (process.env.FLOW_EMBED_URL ?? "").replace(/\/+$/, "");
const REMOTE_EMBED_TOKEN = process.env.FLOW_EMBED_TOKEN ?? "";

export function embeddingsEnabled(): boolean {
  return Boolean(REMOTE_EMBED_URL) || isLocalEmbedReady();
}

async function embedRemote(text: string): Promise<{ vec: number[] | null; error?: string }> {
  try {
    const res = await fetch(REMOTE_EMBED_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(REMOTE_EMBED_TOKEN ? { authorization: `Bearer ${REMOTE_EMBED_TOKEN}` } : {}),
      },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      return { vec: null, error: `embedding gateway returned HTTP ${res.status}${detail ? `: ${detail}` : ""}` };
    }
    const body = (await res.json()) as { vec?: number[] | null; dim?: number; ready?: boolean };
    if (!body.ready) return { vec: null, error: "local embedding model not yet loaded" };
    if (!Array.isArray(body.vec)) return { vec: null, error: "embedding gateway returned no vector" };
    if (body.dim !== EMBED_DIM || body.vec.length !== EMBED_DIM) {
      return { vec: null, error: `embedding gateway dimension mismatch (expected ${EMBED_DIM}, got ${body.dim ?? "unknown"}/${body.vec.length})` };
    }
    return { vec: body.vec };
  } catch (err) {
    return { vec: null, error: `embedding gateway unavailable: ${err instanceof Error ? err.message : String(err)}` };
  }
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
  if (REMOTE_EMBED_URL) return (await embedRemote(clean)).vec;
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
  if (REMOTE_EMBED_URL) return embedRemote(clean);
  if (!isLocalEmbedReady()) return { vec: null, error: "local embedding model not yet loaded" };
  const vec = await embedTextLocal(clean);
  return { vec, error: vec ? undefined : "embedding returned null" };
}

// Batched embedding for backfill. Returns one slot per input (null where a
// chunk failed) so callers can align results with their node list.
// Remote path runs a bounded window of concurrent requests — serial round
// trips make big backfills crawl, unbounded fan-out floods the gateway.
const REMOTE_BATCH_CONCURRENCY = 8;

export async function embedBatch(texts: string[]): Promise<(number[] | null)[]> {
  if (texts.length === 0) return [];
  if (REMOTE_EMBED_URL) {
    const out: (number[] | null)[] = new Array(texts.length).fill(null);
    for (let i = 0; i < texts.length; i += REMOTE_BATCH_CONCURRENCY) {
      const window = texts.slice(i, i + REMOTE_BATCH_CONCURRENCY);
      const vecs = await Promise.all(window.map((text) => embedRemote(text.trim() || " ").then((r) => r.vec)));
      for (let j = 0; j < vecs.length; j++) out[i + j] = vecs[j];
    }
    return out;
  }
  return embedBatchLocal(texts.map((t) => t.trim() || " "));
}
