// embed.ts — Minimal embedding client for the orchestrator's own stores
// (branch notes). Mirrors graph-gateway/src/embed.ts (same model, same
// endpoint) but reads the key via getSetting so DB-configured keys work, and
// exposes cosine over Float32Array for in-process matching — note vectors
// live in SQLite BLOBs, matched locally without a gateway hop.
//
// Best-effort like the gateway's: no key or API error → null; callers store
// notes without vectors (they just won't be injectable until re-embedded).

import { getSetting } from "./settings.js";

const MODEL = process.env.FLOW_EMBED_MODEL ?? "openai/text-embedding-3-small";
const ENDPOINT = process.env.FLOW_EMBED_URL ?? "https://openrouter.ai/api/v1/embeddings";

function apiKey(): string {
  return getSetting("OPENROUTER_API_KEY") ?? process.env.OPENROUTER_API_KEY ?? "";
}

export async function embedText(text: string): Promise<Float32Array | null> {
  const key = apiKey();
  const clean = text.trim();
  if (!key || !clean) return null;
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: MODEL, input: clean }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.warn(`[embed] ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
      return null;
    }
    const json = (await res.json()) as { data?: { embedding: number[] }[] };
    const emb = json.data?.[0]?.embedding;
    return Array.isArray(emb) ? Float32Array.from(emb) : null;
  } catch (err) {
    console.warn(`[embed] request failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export function vecToBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function blobToVec(blob: Buffer): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}

// Cosine SIMILARITY (higher = closer), not distance — callers threshold on it.
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
