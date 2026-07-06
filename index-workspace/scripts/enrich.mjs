// Question-driven graph enrichment:
//   node scripts/enrich.mjs "how are credits deducted when a scrape runs?"
// Runs a graph-builder session focused on one question or known gap. This is
// the loop that improves the graph over time: unanswered/thin questions come
// in, the builder investigates across all connected repos, and the findings
// become permanent graph structure.

import { assertGatewayUp, runBuilder } from "./lib.mjs";

const question = process.argv.slice(2).join(" ").trim();
if (!question) {
  console.error('usage: node scripts/enrich.mjs "<question or gap to investigate>"');
  process.exit(1);
}

await assertGatewayUp();

const prompt = `You are enriching an existing knowledge graph, not building one from scratch. Investigate this specific question or gap:

${question}

Method:
1. Start from the graph: graph_find / graph_get / graph_read to see how this area is currently modeled and where it is thin, wrong, or too coarse.
2. Then establish the truth in code: read the relevant repos under repos/ (all connected repos are available — cross-repo paths are usually the point).
3. Fix the graph: add the missing fine-grained capabilities, usage contracts (with uses / does_not_use / sensitive_to / triage_note), and edges; enrich or correct descriptions; tighten evidence.
4. If you find the same real-world thing modeled as two nodes (e.g. an ExternalService placeholder from before its repo was indexed, alongside the real Service), consolidate with graph_merge — keep the richer canonical node.

Every write needs evidence (repo file:line) and honest confidence. Finish with a summary: what the answer to the question is, what you changed in the graph, and anything you could not verify.`;

const ok = runBuilder(prompt);
process.exit(ok ? 0 : 1);
