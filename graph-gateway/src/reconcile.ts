// Boot-time convergence for a named graph. Runs when the HTTP gateway starts
// (server.ts) — which `flow up` restarts — so shipping a change that needs
// per-graph work is automatic: update the checkout, `flow up`, done.
//
// Two tiers (mirrors orchestrator/src/migrations.ts for SQLite):
//
//   1. GRAPH_MIGRATIONS — versioned, one-way, blocking. For destructive shape
//      changes (rename a property across nodes, split a label). Tracked with a
//      plain redis key per graph — NOT a graph node, so nothing pollutes
//      find_entity / read_query results. Append-only ids, same rules as the
//      SQLite list.
//
//   2. RECONCILERS — unversioned, convergent, idempotent, run in the
//      background on every boot. For enrichment where "check what's missing
//      and fill it" is cheap and safe to re-run. They self-heal: a reconciler
//      also catches nodes written while a dependency (say, the OpenRouter key)
//      was missing. Never block startup, never crash the gateway.
//
// Only the long-lived HTTP gateway runs this — the per-session MCP subprocess
// (mcp.ts) is read-only and short-lived; running convergence there would race
// across concurrent agent sessions.

import { run, raw } from "./graph.js";
import { embedBatch, embeddingsEnabled, entityText } from "./embed.js";

const versionKey = (graph: string) => `flow:graph-version:${graph}`;

interface GraphMigration {
  id: number;
  name: string;
  up: (graph: string) => Promise<void>;
}

// Append-only, next integer id. None yet — the embeddings rollout is a
// reconciler (convergent), not a migration (one-way).
const GRAPH_MIGRATIONS: GraphMigration[] = [];

const LATEST = GRAPH_MIGRATIONS.reduce((m, x) => Math.max(m, x.id), 0);

export async function runGraphMigrations(graph: string): Promise<void> {
  const conn = await raw();
  const current = Number((await conn.get(versionKey(graph))) ?? 0);
  for (const m of GRAPH_MIGRATIONS) {
    if (m.id <= current) continue;
    await m.up(graph);
    await conn.set(versionKey(graph), String(m.id));
    console.log(`[graph] migration ${m.id} applied to '${graph}': ${m.name}`);
  }
  if (GRAPH_MIGRATIONS.length === 0 && current < LATEST) {
    await conn.set(versionKey(graph), String(LATEST));
  }
}

// ---------------------------------------------------------------------------
// Reconciler: semantic embeddings. Nodes written before the embeddings
// feature (or while OPENROUTER_API_KEY was unset / an embed call failed) have
// no vector; find_entity's semantic fallback can't see them. Converge here.
// Returns counts so the manual script (scripts/backfill-embeddings.ts) can
// report; `force` re-embeds everything (after an embed-text or model change).
export async function reconcileEmbeddings(
  graph: string,
  opts: { force?: boolean; log?: (msg: string) => void } = {},
): Promise<{ total: number; embedded: number; failed: number }> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const filter = opts.force ? "" : "WHERE n.embedding IS NULL";
  const rows = await run(
    graph,
    `MATCH (n) ${filter}
     RETURN n.id AS id, labels(n)[0] AS type, n.name AS name, n.description AS description, n.aliases AS aliases, n.trigger AS trigger`,
  );
  if (rows.length === 0) return { total: 0, embedded: 0, failed: 0 };

  log(`[reconcile] graph='${graph}': embedding ${rows.length} node(s)${opts.force ? " (force)" : ""}`);
  const texts = rows.map((r) =>
    entityText(String(r.type), String(r.name ?? ""), r.description as string, r.aliases as string, r.trigger as string),
  );
  const vectors = await embedBatch(texts);

  let embedded = 0;
  let failed = 0;
  for (let i = 0; i < rows.length; i++) {
    const vec = vectors[i];
    if (!vec) {
      failed++;
      continue;
    }
    await run(graph, `MATCH (n {id: $id}) SET n.embedding = vecf32($vec)`, { id: rows[i].id, vec });
    embedded++;
    if (embedded % 50 === 0) log(`[reconcile] ${embedded}/${rows.length}`);
  }
  log(`[reconcile] graph='${graph}': embedded ${embedded}, failed ${failed}`);
  return { total: rows.length, embedded, failed };
}

// ---------------------------------------------------------------------------
// Boot entry point. Migrations first (they're ordering-sensitive), then
// reconcilers fire-and-forget. Any failure is logged, never fatal — a gateway
// that can't converge is still a working gateway.
export function runBootTasks(graph: string): void {
  void (async () => {
    try {
      await runGraphMigrations(graph);
    } catch (err) {
      console.warn(`[graph] migrations for '${graph}' failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (embeddingsEnabled()) {
      try {
        await reconcileEmbeddings(graph);
      } catch (err) {
        console.warn(`[reconcile] embeddings for '${graph}' failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      console.log(`[reconcile] OPENROUTER_API_KEY not set — semantic search disabled for '${graph}'`);
    }
  })();
}
