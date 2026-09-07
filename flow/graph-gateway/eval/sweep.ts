// Threshold sweep for the vector fallback. Embeds each query once, pulls the
// top-20 nearest nodes with distances, then scores MERGED (lexical+vector) at a
// range of cosine-distance ceilings — so we can pick the FLOW_VECTOR_MAX_DISTANCE
// that maximizes recall before noise creeps in.
//
//   OPENROUTER_API_KEY=... tsx eval/sweep.ts [--graph flow_embtest]
//
// "noise" = avg vector hits returned for the 3 unlabeled queries that have no
// good answer (git worktree / commit-push / vector-search) — those SHOULD stay
// near-empty; if they fill up, the threshold is too loose.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { run, close } from "../src/graph.js";
import { embedText, embeddingsEnabled } from "../src/embed.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const THRESHOLDS = [0.55, 0.6, 0.62, 0.65, 0.68, 0.7, 0.72, 0.75, 0.8];

function arg(flag: string, def: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : def;
}

interface Query { q: string; gold: string[] }

async function main() {
  if (!embeddingsEnabled()) { console.error("OPENROUTER_API_KEY not set."); process.exit(1); }
  const graph = arg("--graph", "flow_embtest");
  const queries: Query[] = JSON.parse(readFileSync(join(HERE, "queries.json"), "utf8"));

  // Precompute, per query: lexical ids (threshold-independent) + top-20 vector (id,d).
  type Row = { q: string; gold: string[]; lex: string[]; vec: { id: string; d: number }[] };
  const rows: Row[] = [];
  for (const { q, gold } of queries) {
    const lexRows = await run(
      graph,
      `MATCH (n) WHERE (toLower(n.id) CONTAINS $ql OR toLower(n.name) CONTAINS $ql OR toLower(coalesce(n.aliases, '')) CONTAINS $ql)
       RETURN n.id AS id LIMIT 10`,
      { ql: q.toLowerCase() },
    );
    const lex = lexRows.map((r) => String(r.id));
    const vecEmb = await embedText(q);
    let vec: { id: string; d: number }[] = [];
    if (vecEmb) {
      const vr = await run(
        graph,
        `MATCH (n) WHERE n.embedding IS NOT NULL
         WITH n, vec.cosineDistance(n.embedding, vecf32($vec)) AS d
         RETURN n.id AS id, d AS d ORDER BY d ASC LIMIT 20`,
        { vec: vecEmb },
      );
      vec = vr.map((r) => ({ id: String(r.id), d: Number(r.d) }));
    }
    rows.push({ q, gold, lex, vec });
  }

  const labeled = rows.filter((r) => r.gold.length > 0);
  const qual = rows.filter((r) => r.gold.length === 0);
  const n = labeled.length;

  const rankOf = (list: string[], gold: string[]) => {
    for (let i = 0; i < list.length; i++) if (gold.includes(list[i])) return i + 1;
    return Infinity;
  };
  const merge = (lex: string[], vec: { id: string; d: number }[], maxD: number) => {
    const seen = new Set(lex);
    const out = [...lex];
    for (const v of vec) if (v.d <= maxD && !seen.has(v.id)) { seen.add(v.id); out.push(v.id); }
    return out;
  };

  console.log(`\n=== threshold sweep (graph='${graph}', n=${n} labeled) ===`);
  console.log(`thr     hit@1  hit@3  hit@5   MRR@5   noise(avg vec hits on 3 no-answer qs)`);
  for (const thr of THRESHOLDS) {
    let h1 = 0, h3 = 0, h5 = 0, mrr = 0;
    for (const r of labeled) {
      const merged = merge(r.lex, r.vec, thr);
      const rank = rankOf(merged, r.gold);
      if (rank <= 1) h1++;
      if (rank <= 3) h3++;
      if (rank <= 5) h5++;
      if (rank <= 5) mrr += 1 / rank;
    }
    const noise = qual.reduce((s, r) => s + r.vec.filter((v) => v.d <= thr).length, 0) / (qual.length || 1);
    const pct = (x: number) => `${((x / n) * 100).toFixed(0)}%`.padEnd(6);
    console.log(`${thr.toFixed(2)}    ${pct(h1)} ${pct(h3)} ${pct(h5)}  ${(mrr / n).toFixed(3)}   ${noise.toFixed(1)}`);
  }
  console.log();
  await close();
}

main().catch((e) => { console.error(e); process.exit(1); });
