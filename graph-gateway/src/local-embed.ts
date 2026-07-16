import { createLogger } from "@flow/logger";

// Local embedding via node-llama-cpp + EmbeddingGemma-300M (768-dim).
//
// Singleton loader — call startLocalModel() early (server.ts startup) to kick
// off the HuggingFace download in the background. node-llama-cpp caches the
// GGUF file under ~/.cache/node-llama-cpp/ so subsequent starts skip the
// download. isLocalEmbedReady() flips to true once the model is loaded;
// callers (embed.ts, reconcile.ts) poll this before using embed functions.

// Model identifier stamped in Redis so a changed model triggers a full
// re-embed of all graph nodes (different dim = stale vectors are useless).
export const MODEL_STAMP = "local:embeddinggemma-300M-Q8_0";
export const LOCAL_EMBED_DIM = 768;

const HF_MODEL = "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";

const log = createLogger("local-embed");

// Minimal interface — avoids importing node-llama-cpp types at module scope
// (the dep may not be installed yet during tsc on a fresh checkout).
interface EmbCtx {
  getEmbeddingFor(text: string): Promise<{ vector: Float32Array }>;
}

let _ctx: EmbCtx | null = null;
let _ready = false;
let _promise: Promise<void> | null = null;

export function isLocalEmbedReady(): boolean {
  return _ready;
}

// Call once at startup — idempotent, returns the same promise on repeated calls.
export function startLocalModel(): Promise<void> {
  if (!_promise) {
    _promise = _init().catch((err) => {
      log.error("failed to load model", { err: err instanceof Error ? err.message : String(err) });
    });
  }
  return _promise;
}

async function _init(): Promise<void> {
  const { getLlama, createModelDownloader } = await import("node-llama-cpp");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const { mkdirSync } = await import("node:fs");

  const dir = join(homedir(), ".cache", "flow", "models");
  mkdirSync(dir, { recursive: true });

  log.info("loading EmbeddingGemma-300M (~300 MB download on first run)…");
  const downloader = await createModelDownloader({ modelUri: HF_MODEL, dirPath: dir });
  if (downloader.totalSize > 0) {
    log.info("downloading model", { mb: Math.round(downloader.totalSize / 1_000_000) });
  }
  const modelPath = await downloader.download();

  const llama = await getLlama({ gpu: "auto" });
  const model = await llama.loadModel({ modelPath });
  _ctx = (await model.createEmbeddingContext()) as unknown as EmbCtx;
  _ready = true;
  log.info("EmbeddingGemma-300M ready (768-dim)");
}

export async function embedTextLocal(text: string): Promise<number[] | null> {
  if (!_ctx) return null;
  try {
    const { vector } = await _ctx.getEmbeddingFor(text);
    return Array.from(vector);
  } catch (err) {
    log.warn("embed error", { err: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

export async function embedBatchLocal(texts: string[]): Promise<(number[] | null)[]> {
  const out: (number[] | null)[] = [];
  for (const t of texts) out.push(await embedTextLocal(t));
  return out;
}
