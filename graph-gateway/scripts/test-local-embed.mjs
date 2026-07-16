// Quick smoke test for the local embedding model.
// Run from graph-gateway/: node scripts/test-local-embed.mjs
// First run downloads ~300 MB; subsequent runs are instant (cached).

import { startLocalModel, isLocalEmbedReady, embedTextLocal, LOCAL_EMBED_DIM } from "../src/local-embed.ts";

console.log("Starting local model (downloads on first run)…");
const start = Date.now();
await startLocalModel();

if (!isLocalEmbedReady()) {
  console.error("Model failed to load — check logs above");
  process.exit(1);
}

console.log(`Model ready in ${((Date.now() - start) / 1000).toFixed(1)}s`);

const tests = [
  "find entity by name",
  "git worktree checkout",
  "database migration",
];

for (const text of tests) {
  const vec = await embedTextLocal(text);
  if (!vec) { console.error(`FAIL: got null for "${text}"`); process.exit(1); }
  if (vec.length !== LOCAL_EMBED_DIM) {
    console.error(`FAIL: expected ${LOCAL_EMBED_DIM} dims, got ${vec.length}`);
    process.exit(1);
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)).toFixed(4);
  console.log(`OK  [${vec.length}-dim, norm=${norm}] "${text}"`);
}

console.log("\nAll good.");
