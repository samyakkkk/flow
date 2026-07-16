// embed.ts — Minimal embedding client for the orchestrator's own stores
// (branch notes). Embeds through the gateway's shared local model
// (POST /v1/embed) rather than owning a second copy — the gateway is the
// single owner of Gemma, so one model instance serves both graph nodes and
// note vectors, in the same 768-dim space. Note vectors live in SQLite BLOBs,
// matched locally (cosine below) without a further gateway hop.
//
// Best-effort: if the model is still downloading, the gateway is unreachable,
// or the request errors, we return null. Callers store notes without a vector
// (they just won't be injectable until re-embedded on a later write).
//
// Dimension note: notes embedded before this switch carry OpenAI 1536-dim
// vectors; new queries are 768-dim Gemma. cosine() returns 0 on a length
// mismatch, so stale-dimension notes simply stop matching and age out via
// the normal note decay — no migration needed.

import { createLogger } from "@flow/logger";

const log = createLogger("embed");
const GATEWAY_URL = (process.env.GATEWAY_URL ?? "http://127.0.0.1:7433").replace(/\/+$/, "");

function gatewayToken(): string {
  return process.env.GATEWAY_TOKEN || process.env.FLOW_ADMIN_TOKEN || "";
}

export async function embedText(text: string): Promise<Float32Array | null> {
  const clean = text.trim();
  if (!clean) return null;
  const token = gatewayToken();
  try {
    const res = await fetch(`${GATEWAY_URL}/v1/embed`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ text: clean }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      log.warn("gateway error", { status: res.status, body: (await res.text().catch(() => "")).slice(0, 200) });
      return null;
    }
    const json = (await res.json()) as { vec?: number[] | null; ready?: boolean };
    if (!json.ready) return null; // model still loading — store without a vector
    return Array.isArray(json.vec) ? Float32Array.from(json.vec) : null;
  } catch (err) {
    log.warn("gateway request failed", { err: err instanceof Error ? err.message : String(err) });
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
