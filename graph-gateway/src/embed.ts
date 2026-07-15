// Semantic search support. Entities and queries are embedded through any
// OpenAI-compatible embeddings endpoint (default OpenRouter,
// openai/text-embedding-3-small, 1536-dim) so find_entity can match on
// meaning, not just substrings — e.g. "worktree" surfacing the
// agent-session / repo-checkout nodes even though the word appears nowhere.
//
// Deliberately non-fatal: if no API key is set (LLM_API_KEY or
// OPENROUTER_API_KEY) or the API errors, we log and return null. Writes still
// succeed (just without a vector) and find_entity falls back to the lexical
// CONTAINS match it always did.

const MODEL = process.env.FLOW_EMBED_MODEL ?? "openai/text-embedding-3-small";
export const EMBED_DIM = Number(process.env.FLOW_EMBED_DIM ?? 1536);
const BASE_URL = (process.env.LLM_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/+$/, "");
const ENDPOINT = process.env.FLOW_EMBED_URL ?? `${BASE_URL}/embeddings`;

function apiKey(): string {
  return process.env.LLM_API_KEY ?? process.env.OPENROUTER_API_KEY ?? "";
}

export function embeddingsEnabled(): boolean {
  return apiKey().length > 0;
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

async function callOpenRouter(input: string | string[]): Promise<{ vecs: number[][] | null; error?: string }> {
  const key = apiKey();
  if (!key) return { vecs: null, error: "OPENROUTER_API_KEY not configured" };
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: MODEL, input }),
    });
    if (!res.ok) {
      console.warn(`[embed] ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
      return { vecs: null, error: `embeddings API returned ${res.status}` };
    }
    const json = (await res.json()) as { data?: { embedding: number[]; index: number }[] };
    const data = json.data ?? [];
    const n = Array.isArray(input) ? input.length : 1;
    if (data.length !== n) {
      console.warn(`[embed] expected ${n} embeddings, got ${data.length}`);
      return { vecs: null, error: `embeddings API returned ${data.length} vectors for ${n} inputs` };
    }
    // The API returns an `index` per row; sort to guarantee input alignment.
    return { vecs: [...data].sort((a, b) => a.index - b.index).map((d) => d.embedding) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[embed] request failed: ${msg}`);
    return { vecs: null, error: `embeddings request failed: ${msg}` };
  }
}

export async function embedText(text: string): Promise<number[] | null> {
  const clean = text.trim();
  if (!clean) return null;
  return (await callOpenRouter(clean)).vecs?.[0] ?? null;
}

// Query-path variant of embedText that reports WHY embedding failed. Retrieval
// callers (find_entity) surface this to the agent — a dead key or API outage
// must read as "semantic search unavailable", not as an empty graph. A wrong
// conclusion here is expensive: agents have filed coverage-gap flags against
// graphs that in fact held the answer.
export async function embedQuery(text: string): Promise<{ vec: number[] | null; error?: string }> {
  const clean = text.trim();
  if (!clean) return { vec: null, error: "empty query" };
  const { vecs, error } = await callOpenRouter(clean);
  return { vec: vecs?.[0] ?? null, error };
}

// Batched embedding for backfill. Returns one slot per input (null where a
// chunk failed) so callers can align results with their node list.
export async function embedBatch(texts: string[]): Promise<(number[] | null)[]> {
  if (texts.length === 0) return [];
  const CHUNK = 96;
  const results: (number[] | null)[] = [];
  for (let i = 0; i < texts.length; i += CHUNK) {
    const chunk = texts.slice(i, i + CHUNK).map((t) => t.trim() || " ");
    const { vecs } = await callOpenRouter(chunk);
    for (let j = 0; j < chunk.length; j++) results.push(vecs ? vecs[j] : null);
  }
  return results;
}
