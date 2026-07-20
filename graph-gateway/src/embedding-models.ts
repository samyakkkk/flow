// Embedding model registry + resolver — the single place that decides WHICH
// embedding model this gateway uses. Everything downstream (dimension, stamp,
// which backend runs) derives from the resolved model, so nothing hardcodes
// 768 or a fixed model id anymore.
//
// The stamp is what drives re-embedding: reconcile.ts compares the resolved
// model's stamp against what's stored per graph, and a mismatch force-clears
// and re-embeds every node in the new vector space. So SWITCHING models — a
// dev picking OpenAI, or a user upgrading small→large — is the same safe
// operation as a model upgrade, and the dimension-safe clear in reconcile.ts
// makes 768↔1536↔3072 transitions survivable.
//
// Curated, NOT exhaustive: we list the handful of models worth choosing, each
// with the metadata the UI and the resolver need. Add a row to offer a model;
// do not try to mirror every provider's catalog.

import { LOCAL_EMBED_DIM } from "./local-embed.js";

export type EmbeddingProviderKind = "local" | "openai";

export interface EmbeddingModelSpec {
  // Canonical id — stable, stored as the per-graph embed stamp. Changing it
  // for an existing row would orphan stored vectors, so treat ids as frozen.
  id: string;
  // Human label for the settings dropdown.
  label: string;
  provider: EmbeddingProviderKind;
  // Vector dimension. Must match what the backend actually returns.
  dim: number;
  // Model id sent to the API (openai provider only).
  apiModel?: string;
  // Rough cost/quality tier — drives the "default vs upgrade" story in the UI.
  tier: "default" | "better" | "best";
  // Whether an API key is required. Local models need nothing.
  requiresKey: boolean;
  // One-line UI hint (cost, dimension, when to pick it).
  hint?: string;
}

export const LOCAL_MODEL_ID = "local:embeddinggemma-300M-Q8_0";

// The curated set. Order = display order in the settings dropdown.
export const EMBEDDING_MODELS: EmbeddingModelSpec[] = [
  {
    id: LOCAL_MODEL_ID,
    label: "EmbeddingGemma 300M (local, no API key)",
    provider: "local",
    dim: LOCAL_EMBED_DIM,
    tier: "default",
    requiresKey: false,
    hint: "Runs on-device, ~300 MB one-time download. Zero cost, good quality. The default for local dev.",
  },
  {
    id: "openai:text-embedding-3-small",
    label: "OpenAI text-embedding-3-small",
    provider: "openai",
    apiModel: "text-embedding-3-small",
    dim: 1536,
    tier: "better",
    requiresKey: true,
    hint: "Cheap, strong quality. The default when an OpenAI key is configured.",
  },
  {
    id: "openai:text-embedding-3-large",
    label: "OpenAI text-embedding-3-large",
    provider: "openai",
    apiModel: "text-embedding-3-large",
    dim: 3072,
    tier: "best",
    requiresKey: true,
    hint: "Highest quality, higher cost. Pick this if retrieval quality matters more than spend.",
  },
];

export const LOCAL_MODEL: EmbeddingModelSpec = EMBEDDING_MODELS.find((m) => m.id === LOCAL_MODEL_ID)!;

export function findEmbeddingModel(id: string): EmbeddingModelSpec | undefined {
  return EMBEDDING_MODELS.find((m) => m.id === id);
}

// The API embedding endpoint. Explicit overrides win; otherwise the base MUST
// track the provider of the key we actually resolved (embeddingApiKey), so we
// never send a key to a host it wasn't issued for. In particular an OpenRouter
// key (sk-or-…) goes to OpenRouter — which DOES serve /embeddings (verified
// 2026-07-20; it accepts the same model ids, e.g. text-embedding-3-small) — and
// never to api.openai.com, which 401s on a foreign key. Point EMBEDDING_API_BASE
// at any OpenAI-compatible embeddings API (Azure, a proxy, etc.) to override.
export function embeddingApiBase(): string {
  const explicit = process.env.EMBEDDING_API_BASE || process.env.OPENAI_BASE_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  if (embeddingApiKey().startsWith("sk-or-")) return "https://openrouter.ai/api/v1";
  return "https://api.openai.com/v1";
}

export function embeddingApiKey(): string {
  return (
    process.env.EMBEDDING_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.LLM_API_KEY ||
    process.env.OPENROUTER_API_KEY ||
    ""
  );
}

function hasApiKey(): boolean {
  return Boolean(embeddingApiKey());
}

// Resolve the active model from config, encoding the product rule:
//
//   1. If EMBEDDING_MODEL names a known model, use it — but if it needs a key
//      and none is set, fall back to local (with a warning) rather than 503 the
//      whole search path.
//   2. No explicit choice + an API key is present → default to the "better" API
//      model (text-embedding-3-small): the sensible paid default, upgradable.
//   3. Otherwise → the local model: the zero-config developer default.
//
// Pure w.r.t. env so callers can rely on it being cheap and side-effect-free.
export function resolveEmbeddingModel(): EmbeddingModelSpec {
  const explicit = (process.env.EMBEDDING_MODEL || "").trim();
  if (explicit) {
    const m = findEmbeddingModel(explicit);
    if (!m) {
      console.warn(`[embed] EMBEDDING_MODEL='${explicit}' is not a known model — falling back to ${LOCAL_MODEL.id}`);
      return LOCAL_MODEL;
    }
    if (m.requiresKey && !hasApiKey()) {
      console.warn(`[embed] model '${m.id}' needs an API key but none is configured — falling back to ${LOCAL_MODEL.id}`);
      return LOCAL_MODEL;
    }
    return m;
  }
  if (hasApiKey()) {
    const apiDefault = EMBEDDING_MODELS.find((m) => m.provider === "openai" && m.tier === "better");
    if (apiDefault) return apiDefault;
  }
  return LOCAL_MODEL;
}

// Convenience accessors — the stamp and dimension are just properties of the
// resolved model. Downstream code should call these instead of importing
// constants, so a config change is picked up without a code change.
export function activeEmbeddingModel(): EmbeddingModelSpec {
  return resolveEmbeddingModel();
}
export function activeEmbeddingStamp(): string {
  return resolveEmbeddingModel().id;
}
export function activeEmbeddingDim(): number {
  return resolveEmbeddingModel().dim;
}
