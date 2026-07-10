// Semantic search support. Entities and queries are embedded with OpenRouter's
// embeddings endpoint (openai/text-embedding-3-small, 1536-dim) so find_entity
// can match on meaning, not just substrings — e.g. "worktree" surfacing the
// agent-session / repo-checkout nodes even though the word appears nowhere.
//
// Deliberately non-fatal: if OPENROUTER_API_KEY is unset or the API errors, we
// log and return null. Writes still succeed (just without a vector) and
// find_entity falls back to the lexical CONTAINS match it always did.

const MODEL = process.env.FLOW_EMBED_MODEL ?? "openai/text-embedding-3-small";
export const EMBED_DIM = Number(process.env.FLOW_EMBED_DIM ?? 1536);
const ENDPOINT = process.env.FLOW_EMBED_URL ?? "https://openrouter.ai/api/v1/embeddings";

function apiKey(): string {
  return process.env.OPENROUTER_API_KEY ?? "";
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

async function callOpenRouter(input: string | string[]): Promise<number[][] | null> {
  const key = apiKey();
  if (!key) return null;
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: MODEL, input }),
    });
    if (!res.ok) {
      console.warn(`[embed] ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
      return null;
    }
    const json = (await res.json()) as { data?: { embedding: number[]; index: number }[] };
    const data = json.data ?? [];
    const n = Array.isArray(input) ? input.length : 1;
    if (data.length !== n) {
      console.warn(`[embed] expected ${n} embeddings, got ${data.length}`);
      return null;
    }
    // The API returns an `index` per row; sort to guarantee input alignment.
    return [...data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
  } catch (err) {
    console.warn(`[embed] request failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export async function embedText(text: string): Promise<number[] | null> {
  const clean = text.trim();
  if (!clean) return null;
  const out = await callOpenRouter(clean);
  return out?.[0] ?? null;
}

// Batched embedding for backfill. Returns one slot per input (null where a
// chunk failed) so callers can align results with their node list.
export async function embedBatch(texts: string[]): Promise<(number[] | null)[]> {
  if (texts.length === 0) return [];
  const CHUNK = 96;
  const results: (number[] | null)[] = [];
  for (let i = 0; i < texts.length; i += CHUNK) {
    const chunk = texts.slice(i, i + CHUNK).map((t) => t.trim() || " ");
    const embs = await callOpenRouter(chunk);
    for (let j = 0; j < chunk.length; j++) results.push(embs ? embs[j] : null);
  }
  return results;
}
