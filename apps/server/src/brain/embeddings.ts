// @effect-diagnostics nodeBuiltinImport:off - Native database/CLI adapter owns Node lifecycle and filesystem I/O.
// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from Flow's graph-gateway/src/local-embed.ts: same model and vector space.
import * as NodeFSP from "node:fs/promises";
import type { Llama, LlamaModel, LlamaEmbeddingContext } from "node-llama-cpp";

export class BrainEmbeddings {
  status: "idle" | "loading" | "ready" | "error" = "idle";
  message = "EmbeddingGemma loads once when the first repository is indexed.";
  private loading: Promise<void> | undefined;
  private context: LlamaEmbeddingContext | undefined;
  private model: LlamaModel | undefined;
  private llama: Llama | undefined;
  private readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
  }
  private async load() {
    if (this.context) return;
    if (!this.loading) {
      this.status = "loading";
      this.message = "Preparing EmbeddingGemma (about 300 MB on first use)…";
      this.loading = (async () => {
        const { getLlama, createModelDownloader } = await import("node-llama-cpp");
        await NodeFSP.mkdir(this.directory, { recursive: true, mode: 0o700 });
        const downloader = await createModelDownloader({
          modelUri: "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf",
          dirPath: this.directory,
        });
        const modelPath = await downloader.download();
        this.llama ??= await getLlama({ gpu: "auto" });
        this.model ??= await this.llama.loadModel({ modelPath });
        this.context = await this.model.createEmbeddingContext();
        this.status = "ready";
        this.message = "EmbeddingGemma · 768 dimensions · shared across workspaces";
      })()
        .catch((error: unknown) => {
          this.status = "error";
          this.message =
            "Could not prepare the embedding model. Check your connection and retry indexing.";
          throw error;
        })
        .finally(() => {
          this.loading = undefined;
        });
    }
    await this.loading;
  }
  async embed(text: string): Promise<number[]> {
    await this.load();
    return Array.from((await this.context!.getEmbeddingFor(text)).vector);
  }
  async close() {
    await this.loading?.catch(() => {});
    await this.context?.dispose();
    await this.model?.dispose();
    await this.llama?.dispose();
  }
}
