// Manual entry point for the embeddings reconciler. The gateway already runs
// this automatically at boot (src/reconcile.ts) — reach for the script when you
// want it NOW without a restart, or need --force after changing the embedding
// text/model.
//
//   OPENROUTER_API_KEY=... tsx scripts/backfill-embeddings.ts [--graph <name>] [--force]
//
// --graph  target named graph (default: $GRAPH_NAME or 'memory')
// --force  re-embed every node, not just those missing an embedding

import { close } from "../src/graph.js";
import { embeddingsEnabled } from "../src/embed.js";
import { reconcileEmbeddings } from "../src/reconcile.js";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const graph = arg("--graph") ?? process.env.GRAPH_NAME ?? "memory";
  const force = process.argv.includes("--force");

  if (!embeddingsEnabled()) {
    console.error("No LLM API key set (LLM_API_KEY or OPENROUTER_API_KEY) — nothing to do.");
    process.exit(1);
  }

  const { total, embedded, failed } = await reconcileEmbeddings(graph, { force });
  if (total === 0) console.log(`[backfill] graph='${graph}' — nothing to embed`);
  else console.log(`[backfill] graph='${graph}' — done: embedded ${embedded}/${total}, failed ${failed}`);
  await close();
  if (failed > 0) process.exit(2);
}

main().catch((err) => {
  console.error("[backfill] fatal:", err);
  process.exit(1);
});
