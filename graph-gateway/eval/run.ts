// Retrieval eval for find_entity: does adding semantic (vector) matching beat
// the current lexical-substring-only search, without regressing the queries
// lexical already handles?
//
//   OPENROUTER_API_KEY=... tsx eval/run.ts [--graph flow_embtest] [--limit 5]
//
// Reports hit@1/@3/@5 and MRR@5 for LEXICAL-only (today) vs MERGED (lexical then
// vector, what find_entity now returns), lists the wins vector unlocks and any
// regressions, and dumps raw top-k for the unlabeled qualitative queries.
// Reads eval/queries.json (labeled) and eval/nodes.json (to validate gold ids).
// Threshold is read from FLOW_VECTOR_MAX_DISTANCE (default 0.6) to match verbs.ts.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { run, close } from "../src/graph.js";
import { embedText, embeddingsEnabled } from "../src/embed.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MAX_D = Number(process.env.FLOW_VECTOR_MAX_DISTANCE ?? 0.6);

function arg(flag: string, def: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : def;
}

interface Query { q: string; gold: string[] }

async function lexical(graph: string, q: string, k: number): Promise<string[]> {
  const rows = await run(
    graph,
    `MATCH (n) WHERE (toLower(n.id) CONTAINS $ql OR toLower(n.name) CONTAINS $ql OR toLower(coalesce(n.aliases, '')) CONTAINS $ql)
     RETURN n.id AS id LIMIT ${k}`,
    { ql: q.toLowerCase() },
  );
  return rows.map((r) => String(r.id));
}

async function vector(graph: string, q: string, k: number): Promise<{ id: string; d: number }[]> {
  const vec = await embedText(q);
  if (!vec) return [];
  const rows = await run(
    graph,
    `MATCH (n) WHERE n.embedding IS NOT NULL
     WITH n, vec.cosineDistance(n.embedding, vecf32($vec)) AS d
     WHERE d <= $maxD
     RETURN n.id AS id, d AS d ORDER BY d ASC LIMIT ${k}`,
    { vec, maxD: MAX_D },
  );
  return rows.map((r) => ({ id: String(r.id), d: Math.round(Number(r.d) * 1000) / 1000 }));
}

// lexical hits first (dedup), then vector hits not already present.
function merge(lex: string[], vec: { id: string; d: number }[]): string[] {
  const seen = new Set(lex);
  const out = [...lex];
  for (const v of vec) if (!seen.has(v.id)) { seen.add(v.id); out.push(v.id); }
  return out;
}

const rankOf = (list: string[], gold: string[]) => {
  for (let i = 0; i < list.length; i++) if (gold.includes(list[i])) return i + 1;
  return Infinity;
};

async function main() {
  if (!embeddingsEnabled()) { console.error("OPENROUTER_API_KEY not set."); process.exit(1); }
  const graph = arg("--graph", "flow_embtest");
  const K = 10; // retrieve up to 10, score hit@1/3/5

  const queries: Query[] = JSON.parse(readFileSync(join(HERE, "queries.json"), "utf8"));
  const nodeIds = new Set<string>(
    JSON.parse(readFileSync(join(HERE, "nodes.json"), "utf8")).map((n: { id: string }) => n.id),
  );

  // Validate gold ids exist so a typo doesn't look like a retrieval miss.
  for (const item of queries) {
    for (const g of item.gold) if (!nodeIds.has(g)) console.warn(`  ! gold id not in graph: "${g}" (query: ${item.q})`);
  }

  const labeled = queries.filter((x) => x.gold.length > 0);
  const qualitative = queries.filter((x) => x.gold.length === 0);

  const agg = {
    lex: { h1: 0, h3: 0, h5: 0, mrr: 0 },
    merged: { h1: 0, h3: 0, h5: 0, mrr: 0 },
  };
  const wins: string[] = [];
  const regressions: string[] = [];

  console.log(`\n=== find_entity retrieval eval  (graph='${graph}', threshold=${MAX_D}, ${labeled.length} labeled queries) ===\n`);

  for (const { q, gold } of labeled) {
    const lex = await lexical(graph, q, K);
    const vec = await vector(graph, q, K);
    const merged = merge(lex, vec);

    const rl = rankOf(lex, gold);
    const rm = rankOf(merged, gold);
    for (const [name, r] of [["lex", rl], ["merged", rm]] as const) {
      if (r <= 1) agg[name].h1++;
      if (r <= 3) agg[name].h3++;
      if (r <= 5) agg[name].h5++;
      if (r <= 5) agg[name].mrr += 1 / r;
    }
    if (rl === Infinity && rm !== Infinity) wins.push(`  + "${q}"  → ${gold.find((g) => merged.includes(g))} @${rm} (lexical missed)`);
    if (rl !== Infinity && rm > rl) regressions.push(`  - "${q}"  lex@${rl} → merged@${rm}`);

    const tag = rm <= 5 ? (rl <= 5 ? "both " : "VEC  ") : "MISS ";
    const vtop = vec.slice(0, 3).map((v) => `${v.id.replace(/^(api:|svc:|cap:|concept:|workflow:|contract:|ext:)/, "")}(${v.d})`).join(", ");
    console.log(`[${tag}] lex@${rl === Infinity ? "-" : rl} merged@${rm === Infinity ? "-" : rm}  q="${q}"`);
    console.log(`         vec: ${vtop || "(none under threshold)"}`);
  }

  const n = labeled.length;
  const pct = (x: number) => `${((x / n) * 100).toFixed(0)}%`;
  console.log(`\n--- SUMMARY (n=${n}) ---`);
  console.log(`             hit@1    hit@3    hit@5    MRR@5`);
  console.log(`  lexical    ${pct(agg.lex.h1).padEnd(8)} ${pct(agg.lex.h3).padEnd(8)} ${pct(agg.lex.h5).padEnd(8)} ${(agg.lex.mrr / n).toFixed(3)}`);
  console.log(`  merged     ${pct(agg.merged.h1).padEnd(8)} ${pct(agg.merged.h3).padEnd(8)} ${pct(agg.merged.h5).padEnd(8)} ${(agg.merged.mrr / n).toFixed(3)}`);

  console.log(`\n  wins (lexical missed, vector found): ${wins.length}`);
  wins.forEach((w) => console.log(w));
  console.log(`  regressions: ${regressions.length}`);
  regressions.forEach((r) => console.log(r));

  console.log(`\n--- QUALITATIVE (unlabeled — eyeball) ---`);
  for (const { q } of qualitative) {
    const vec = await vector(graph, q, 5);
    console.log(`  q="${q}"`);
    vec.forEach((v) => console.log(`     ${v.d}  ${v.id}`));
    if (!vec.length) console.log(`     (nothing under threshold ${MAX_D})`);
  }

  console.log();
  await close();
}

main().catch((e) => { console.error(e); process.exit(1); });
