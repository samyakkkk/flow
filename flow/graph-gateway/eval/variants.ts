// A/B different entity-text formulations for embedding. Re-embeds isolated
// graph copies (flow_v0..v3) with each formulation, then scores the labelled
// set at a fixed threshold and reports the 3 known-hard probe distances. Goal:
// find the doc-text that pulls true matches to lower cosine distance (better
// recall + ranking) without loosening the threshold.
//
//   OPENROUTER_API_KEY=... tsx eval/variants.ts
//
// Requires the flow_v0..v3 copies to exist (GRAPH.COPY flow flow_vN).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { run, close } from "../src/graph.js";
import { embedBatch, embedText, embeddingsEnabled } from "../src/embed.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const THR = Number(process.env.FLOW_VECTOR_MAX_DISTANCE ?? 0.65);

const HUMAN: Record<string, string> = {
  APIEndpoint: "API endpoint", Handler: "handler", Service: "service",
  Capability: "capability", UsageContract: "integration contract", Concept: "concept",
  Workflow: "workflow", ExternalService: "external service", Database: "database",
  DatabaseTable: "database table", Repository: "repository", Queue: "queue", Cache: "cache",
};

type Fmt = (type: string, name: string, desc: string, aliases: string) => string;
const FORMULATIONS: { graph: string; label: string; fmt: Fmt }[] = [
  { graph: "flow_v0", label: "v0 current  (type: name / desc / aka)", fmt: (t, n, d, a) => [`${t}: ${n}`, d, a && `aka ${a}`].filter(Boolean).join("\n") },
  { graph: "flow_v1", label: "v1 name+desc (drop type & aliases)", fmt: (_t, n, d) => [n, d].filter(Boolean).join("\n") },
  { graph: "flow_v2", label: "v2 name. desc  aka x", fmt: (_t, n, d, a) => `${n}. ${d}${a ? ` (aka ${a})` : ""}` },
  { graph: "flow_v3", label: "v3 humanType name: desc", fmt: (t, n, d, a) => [`${HUMAN[t] ?? t}: ${n}`, d, a && `aka ${a}`].filter(Boolean).join("\n") },
];

interface Query { q: string; gold: string[] }
const PROBES = [
  { q: "catch up on missed events after the service was down", gold: "concept:poll-since-cursor" },
  { q: "how the dashboard talks to the brain", gold: "contract:dashboard->graph-gateway" },
];

async function reembed(graph: string, fmt: Fmt) {
  const rows = await run(graph, `MATCH (n) RETURN n.id AS id, labels(n)[0] AS type, n.name AS name, n.description AS description, n.aliases AS aliases`);
  const texts = rows.map((r) => fmt(String(r.type), String(r.name ?? ""), String(r.description ?? ""), String(r.aliases ?? "")));
  const vecs = await embedBatch(texts);
  for (let i = 0; i < rows.length; i++) if (vecs[i]) await run(graph, `MATCH (n {id:$id}) SET n.embedding = vecf32($v)`, { id: rows[i].id, v: vecs[i] });
}

async function evalGraph(graph: string, queries: Query[]) {
  const labeled = queries.filter((x) => x.gold.length > 0);
  let h1 = 0, h3 = 0, h5 = 0, mrr = 0;
  for (const { q, gold } of labeled) {
    const lex = (await run(graph, `MATCH (n) WHERE (toLower(n.id) CONTAINS $ql OR toLower(n.name) CONTAINS $ql OR toLower(coalesce(n.aliases,'')) CONTAINS $ql) RETURN n.id AS id LIMIT 10`, { ql: q.toLowerCase() })).map((r) => String(r.id));
    const vec = await embedText(q);
    const vr = vec ? (await run(graph, `MATCH (n) WHERE n.embedding IS NOT NULL WITH n, vec.cosineDistance(n.embedding, vecf32($v)) AS d WHERE d <= $thr RETURN n.id AS id ORDER BY d ASC LIMIT 10`, { v: vec, thr: THR })).map((r) => String(r.id)) : [];
    const seen = new Set(lex); const merged = [...lex]; for (const id of vr) if (!seen.has(id)) { seen.add(id); merged.push(id); }
    let rank = Infinity; for (let i = 0; i < merged.length; i++) if (gold.includes(merged[i])) { rank = i + 1; break; }
    if (rank <= 1) h1++; if (rank <= 3) h3++; if (rank <= 5) h5++; if (rank <= 5) mrr += 1 / rank;
  }
  const n = labeled.length; const pct = (x: number) => `${((x / n) * 100).toFixed(0)}%`.padEnd(5);
  return { line: `hit@1 ${pct(h1)} hit@3 ${pct(h3)} hit@5 ${pct(h5)} MRR ${(mrr / n).toFixed(3)}` };
}

async function probeDist(graph: string) {
  const out: string[] = [];
  for (const { q, gold } of PROBES) {
    const v = await embedText(q);
    const g = await run(graph, `MATCH (n {id:$id}) WHERE n.embedding IS NOT NULL RETURN vec.cosineDistance(n.embedding, vecf32($v)) AS d`, { id: gold, v });
    out.push(`${gold.split(":").pop()}=${g[0] ? Number(g[0].d).toFixed(3) : "NA"}`);
  }
  return out.join("  ");
}

async function main() {
  if (!embeddingsEnabled()) { console.error("OPENROUTER_API_KEY not set."); process.exit(1); }
  const queries: Query[] = JSON.parse(readFileSync(join(HERE, "queries.json"), "utf8"));
  console.log(`\n=== entityText variants (threshold ${THR}) ===\n`);
  for (const { graph, label, fmt } of FORMULATIONS) {
    await reembed(graph, fmt);
    const { line } = await evalGraph(graph, queries);
    const probes = await probeDist(graph);
    console.log(`${label}`);
    console.log(`   ${line}   | ${probes}\n`);
  }
  await close();
}

main().catch((e) => { console.error(e); process.exit(1); });
