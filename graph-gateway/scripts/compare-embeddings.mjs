// Embedding quality comparison: OpenAI text-embedding-3-small (1536-dim, via the
// existing gateway vectors) vs local EmbeddingGemma-300M (768-dim, freshly computed).
//
// Fetches real nodes from the running flow graph, re-embeds them with Gemma,
// then runs 7 real agent-style queries against both sets and ranks results.
//
// Usage: npx tsx scripts/compare-embeddings.mjs

import { getLlama, createModelDownloader } from "node-llama-cpp";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

const GATEWAY = "http://localhost:7463";
const TOKEN = "2cdae464918e6db94be90080247b03c99a3321c7bc9f4902";
const GRAPH = "flow";
const HF_MODEL = "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";

// ---------------------------------------------------------------------------
// Queries that a real agent would ask — covering different node types and
// levels of semantic indirection (the hard cases that lexical search misses).
const QUERIES = [
  "how does git worktree checkout work",
  "embed graph nodes for semantic search",
  "add a new versioned database migration",
  "where are branch notes stored and matched",
  "CLI startup sequence when running flow up",
  "who can write to the graph and how is it gated",
  "reconcile missing vectors at boot time",
];

// ---------------------------------------------------------------------------
// Gateway helpers

async function gw(verb, body) {
  const res = await fetch(`${GATEWAY}/v1/verbs/${verb}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ ...body, graph: GRAPH }),
  });
  return res.json();
}

// ---------------------------------------------------------------------------
// Fetch a diverse sample of nodes WITH their existing OpenAI embeddings.
// read_query returns raw Cypher results; embeddings come back as arrays.

async function fetchNodesWithEmbeddings() {
  // Fetch in batches of 100 to avoid any payload limits.
  const all = [];
  let skip = 0;
  while (true) {
    const result = await gw("read_query", {
      cypher: `MATCH (n) WHERE n.embedding IS NOT NULL
               RETURN labels(n)[0] AS type, n.id AS id, n.name AS name,
                      n.description AS description, n.aliases AS aliases,
                      n.trigger AS trigger, n.embedding AS embedding
               SKIP ${skip} LIMIT 100`,
    });
    const rows = (result.rows ?? []).filter((r) => r.embedding && r.name);
    all.push(...rows);
    if (rows.length < 100) break;
    skip += 100;
  }
  return all;
}

// ---------------------------------------------------------------------------
// Reconstruct entity text exactly as embed.ts does it.

const TYPE_WORDS = {
  APIEndpoint: "API endpoint", Handler: "handler", Service: "service",
  Capability: "capability", UsageContract: "integration contract",
  Concept: "concept", Workflow: "workflow", Procedure: "procedure",
  Note: "note", ExternalService: "external service", Database: "database",
  DatabaseTable: "database table", Repository: "repository",
};

function entityText(type, name, description, aliases, trigger) {
  const parts = [`${TYPE_WORDS[type] ?? type}: ${name}`];
  if (trigger) parts.push(`applies ${trigger}`);
  if (description) parts.push(String(description));
  if (aliases) parts.push(`aka ${aliases}`);
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Cosine similarity (higher = closer).

function cosine(a, b) {
  if (a.length !== b.length) throw new Error(`dim mismatch: ${a.length} vs ${b.length}`);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ---------------------------------------------------------------------------
// Rank nodes for a query vector, return top-k with scores.

function rank(queryVec, nodes, vecKey, k = 5) {
  return nodes
    .map((n) => ({ n, score: cosine(queryVec, n[vecKey]) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

// ---------------------------------------------------------------------------

async function main() {
  // 1. Load Gemma model
  console.log("\n=== Loading EmbeddingGemma-300M (downloads ~300 MB on first run) ===\n");
  const t0 = Date.now();
  const dir = join(homedir(), ".cache", "flow", "models");
  mkdirSync(dir, { recursive: true });
  const downloader = await createModelDownloader({ modelUri: HF_MODEL, dirPath: dir });
  if (downloader.totalSize > 0) {
    console.log(`Downloading ${Math.round(downloader.totalSize / 1_000_000)} MB…`);
  }
  const modelPath = await downloader.download();
  const llama = await getLlama({ gpu: "auto" });
  const model = await llama.loadModel({ modelPath });
  const ctx = await model.createEmbeddingContext();
  console.log(`Model ready in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  async function gemmaEmbed(text) {
    const { vector } = await ctx.getEmbeddingFor(text);
    return Array.from(vector);
  }

  // 2. Fetch nodes with OpenAI vectors
  console.log("=== Fetching all nodes from the live flow graph ===\n");
  const rawNodes = await fetchNodesWithEmbeddings();
  if (rawNodes.length === 0) {
    console.error("No embedded nodes found. Is the gateway running with the flow graph indexed?");
    process.exit(1);
  }
  console.log(`Fetched ${rawNodes.length} nodes with existing OpenAI embeddings.\n`);

  // 3. Re-embed every node with Gemma
  process.stdout.write(`Re-embedding ${rawNodes.length} nodes with EmbeddingGemma-300M `);
  const nodes = [];
  for (const r of rawNodes) {
    const text = entityText(r.type, r.name, r.description, r.aliases, r.trigger);
    const gemmaVec = await gemmaEmbed(text);
    nodes.push({
      id: r.id, type: r.type, name: r.name,
      openaiVec: Array.isArray(r.embedding) ? r.embedding : Object.values(r.embedding),
      gemmaVec,
    });
    if (nodes.length % 25 === 0) process.stdout.write(".");
  }
  console.log(` done\n  ${nodes[0].gemmaVec.length}-dim Gemma  vs  ${nodes[0].openaiVec.length}-dim OpenAI\n`);

  // 4. Run queries
  console.log("=== Query comparison (all 286 nodes, same corpus) ===\n");
  const K = 6;

  // Also embed query with OpenAI vectors for a fair local cosine comparison.
  // We use the stored node vectors to rank — same as gateway's find_entity
  // vector path but local (no API call needed for the query side, since
  // find_entity already returns ranked matches with scores via the gateway).

  for (const q of QUERIES) {
    console.log(`Query: "${q}"`);
    console.log("─".repeat(80));

    const gemmaQ = await gemmaEmbed(q);

    // OpenAI: use gateway find_entity (which embeds q with OpenAI and cosine-ranks)
    const openaiResult = await gw("find_entity", { q, limit: K });
    const openaiHits = (openaiResult.matches ?? []).slice(0, K);

    // Gemma: local cosine rank over our re-embedded corpus
    const gemmaHits = rank(gemmaQ, nodes, "gemmaVec", K);

    const col = 38;
    console.log(`  ${"OpenAI text-embedding-3-small".padEnd(col)}  Gemma-300M (local)`);
    console.log(`  ${"─".repeat(col)}  ${"─".repeat(col)}`);
    const maxLen = Math.max(openaiHits.length, gemmaHits.length);
    for (let i = 0; i < maxLen; i++) {
      const oh = openaiHits[i];
      const gh = gemmaHits[i];
      const left = oh
        ? `${(oh.name ?? oh.id).slice(0, col - 10).padEnd(col - 10)} [${oh.distance != null ? (1 - oh.distance).toFixed(3) : "via:" + oh.via}]`
        : "";
      const right = gh ? `${gh.n.name.slice(0, col - 8)} (${gh.score.toFixed(3)})` : "";
      console.log(`  ${left.padEnd(col)}  ${right}`);
    }

    const openaiIds = new Set(openaiHits.map((h) => h.id));
    const gemmaIds = new Set(gemmaHits.map(({ n }) => n.id));
    const overlap = [...openaiIds].filter((id) => gemmaIds.has(id)).length;
    console.log(`  → overlap: ${overlap}/${K}\n`);
  }

  console.log("Done.");
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
