// Semantic search support. Entities and queries are embedded by the model the
// gateway resolves from config (embedding-models.ts): the local
// EmbeddingGemma-300M by default (no API key), or an OpenAI-compatible API
// model when one is configured. The local model downloads from HuggingFace on
// first run (~300 MB) and is cached by node-llama-cpp.
//
// Deliberately non-fatal: if the active backend isn't ready (local model still
// downloading, or an API call fails), every embed function returns null. Writes
// still succeed (just without a vector) and find_entity falls back to the
// lexical CONTAINS match it always did. Once the backend is ready, reconcile.ts
// backfills all nodes written during that window.

import { isLocalEmbedReady, embedTextLocal, embedBatchLocal } from "./local-embed.js";
import {
  activeEmbeddingModel,
  embeddingApiBase,
  embeddingApiKey,
} from "./embedding-models.js";

// The long-lived HTTP gateway owns the active backend. Short-lived MCP
// processes set FLOW_EMBED_URL and borrow the gateway (whatever model it
// resolved) instead of standing up their own backend or holding API keys. The
// gateway process itself leaves this unset and embeds in-process.
const REMOTE_EMBED_URL = (process.env.FLOW_EMBED_URL ?? "").replace(/\/+$/, "");
const REMOTE_EMBED_TOKEN = process.env.FLOW_EMBED_TOKEN ?? "";

export function embeddingsEnabled(): boolean {
  if (REMOTE_EMBED_URL) return true;
  const model = activeEmbeddingModel();
  // API models are ready as soon as a key exists — no download to wait on.
  if (model.provider === "openai") return Boolean(embeddingApiKey());
  return isLocalEmbedReady();
}

// ---------------------------------------------------------------------------
// OpenAI-compatible embeddings API backend. Used when the resolved model's
// provider is "openai". Points at embeddingApiBase(), which tracks the resolved
// key's provider — so an OpenRouter key hits OpenRouter's /embeddings and an
// OpenAI key hits OpenAI. Deliberately separate from the chat LLM_BASE_URL so
// the two can diverge (e.g. OpenRouter chat + OpenAI embeddings).
async function embedApiBatch(texts: string[]): Promise<(number[] | null)[]> {
  const model = activeEmbeddingModel();
  const key = embeddingApiKey();
  if (!key) return texts.map(() => null);
  try {
    const res = await fetch(`${embeddingApiBase()}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: model.apiModel ?? model.id, input: texts }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      console.warn(`[embed] API ${model.apiModel} returned HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
      return texts.map(() => null);
    }
    const body = (await res.json()) as { data?: { index: number; embedding: number[] }[] };
    const out: (number[] | null)[] = new Array(texts.length).fill(null);
    for (const row of body.data ?? []) {
      if (typeof row.index !== "number" || !Array.isArray(row.embedding)) continue;
      if (row.embedding.length !== model.dim) {
        console.warn(`[embed] API ${model.apiModel} returned dim ${row.embedding.length}, expected ${model.dim}`);
        continue;
      }
      out[row.index] = row.embedding;
    }
    return out;
  } catch (err) {
    console.warn(`[embed] API embed failed: ${err instanceof Error ? err.message : String(err)}`);
    return texts.map(() => null);
  }
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
    if (!body.ready) return { vec: null, error: "embedding backend not yet ready" };
    if (!Array.isArray(body.vec)) return { vec: null, error: "embedding gateway returned no vector" };
    // Trust the gateway's dimension: every vector in a graph comes from the same
    // gateway, so they are self-consistent. The borrower must NOT re-check against
    // its own compiled-in dim — that reintroduces the mixed-dimension bug when the
    // gateway runs a different model than the borrower assumes. Just sanity-check
    // that vec length matches what the gateway reported.
    if (typeof body.dim === "number" && body.vec.length !== body.dim) {
      return { vec: null, error: `embedding gateway returned inconsistent vector (dim ${body.dim} vs length ${body.vec.length})` };
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
  // A when-clause trigger, if the node carries one, is a retrieval hook
  // phrased the way task prompts are phrased — it belongs right after the name.
  if (trigger) parts.push(`applies ${String(trigger)}`);
  if (description) parts.push(String(description));
  if (aliases) parts.push(`aka ${aliases}`);
  return parts.join("\n");
}

export async function embedText(text: string): Promise<number[] | null> {
  const clean = text.trim();
  if (!clean) return null;
  if (REMOTE_EMBED_URL) return (await embedRemote(clean)).vec;
  if (activeEmbeddingModel().provider === "openai") return (await embedApiBatch([clean]))[0];
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
  const model = activeEmbeddingModel();
  if (model.provider === "openai") {
    if (!embeddingApiKey()) return { vec: null, error: `model '${model.id}' needs an API key` };
    const vec = (await embedApiBatch([clean]))[0];
    return { vec, error: vec ? undefined : `API embedding (${model.apiModel}) failed` };
  }
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
  // API provider: the /embeddings endpoint is natively batched, so send the
  // whole array in one round trip (chunked to stay under request-size limits).
  if (activeEmbeddingModel().provider === "openai") {
    const out: (number[] | null)[] = [];
    const CHUNK = 256;
    for (let i = 0; i < texts.length; i += CHUNK) {
      const window = texts.slice(i, i + CHUNK).map((t) => t.trim() || " ");
      out.push(...(await embedApiBatch(window)));
    }
    return out;
  }
  return embedBatchLocal(texts.map((t) => t.trim() || " "));
}
