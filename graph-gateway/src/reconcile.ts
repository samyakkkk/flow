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
//      also catches nodes written while a dependency (say, the local model)
//      was missing. Never block startup, never crash the gateway.
//
// Only the long-lived HTTP gateway runs this — the per-session MCP subprocess
// (mcp.ts) is read-only and short-lived; running convergence there would race
// across concurrent agent sessions.

import { run, raw } from "./graph.js";
import { embedBatch, entityText } from "./embed.js";
import { startLocalModel } from "./local-embed.js";
import { activeEmbeddingModel, activeEmbeddingStamp } from "./embedding-models.js";

const versionKey = (graph: string) => `flow:graph-version:${graph}`;
// Tracks which embed model's vectors are stored in the graph. When this
// stamp changes (model upgrade or switch from OpenRouter), we force-re-embed
// all nodes so query and document vectors stay in the same space.
const embedStampKey = (graph: string) => `flow:embed-stamp:${graph}`;

interface GraphMigration {
  id: number;
  name: string;
  up: (graph: string) => Promise<void>;
}

// Append-only, next integer id.
const GRAPH_MIGRATIONS: GraphMigration[] = [
  {
    id: 1,
    name: "clear-stale-embeddings-for-model-upgrade",
    async up(graph: string): Promise<void> {
      // The embedding model changed dimension (e.g. OpenAI 1536-dim → local
      // EmbeddingGemma-300M 768-dim). FalkorDB throws on cosineDistance when
      // stored vectors mix dimensions. Wipe everything so the embed-stamp
      // reconciler re-embeds all nodes cleanly in the correct space.
      await run(graph, `MATCH (n) WHERE n.embedding IS NOT NULL SET n.embedding = NULL`);
      const conn = await raw();
      await conn.del(embedStampKey(graph));
      console.log(`[graph] migration 1 applied to '${graph}': cleared all embeddings for dimension-safe re-embed`);
    },
  },
];

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
// feature (or while the local model was loading / an embed call failed) have
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
// Called after the active embedding backend is ready. Checks whether the
// stored embed-model stamp matches the resolved model's stamp — if not (first
// run, model upgrade, or a switch between local and an API model), clears every
// vector and re-embeds so all vectors share one space and dimension. On match,
// only backfills nodes written during the ready-up window (embedding IS NULL).
// Saves the stamp after a force run.
export async function reconcileAfterModelReady(graph: string): Promise<void> {
  try {
    const conn = await raw();
    const saved = await conn.get(embedStampKey(graph));
    const stamp = activeEmbeddingStamp();
    const force = saved !== stamp;
    if (force) {
      console.log(`[reconcile] embed model changed (${saved ?? "none"} → ${stamp}) — clearing old embeddings before re-embed`);
      // Null out ALL stored embeddings before re-embedding. This prevents
      // mixed-dimension state in FalkorDB (cosineDistance throws when stored
      // vectors have a different length than the query). During the re-embed
      // window, find_entity falls back to lexical search — acceptable.
      await run(graph, `MATCH (n) WHERE n.embedding IS NOT NULL SET n.embedding = NULL`);
    }
    const { total, embedded, failed } = await reconcileEmbeddings(graph, { force });
    if (total === 0) {
      console.log(`[reconcile] graph='${graph}': all nodes already embedded`);
    } else {
      console.log(`[reconcile] graph='${graph}': embedded ${embedded}/${total}${failed ? `, failed ${failed}` : ""}`);
    }
    if (force) await conn.set(embedStampKey(graph), stamp);
  } catch (err) {
    console.warn(`[reconcile] post-model reconcile failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Boot entry point. Migrations first (ordering-sensitive, blocking), then
// fire-and-forget: wait for the local embedding model (downloading if needed),
// then reconcile embeddings. Any failure is logged, never fatal — a gateway
// that can't converge is still a working gateway.
export function runBootTasks(graph: string): void {
  void (async () => {
    try {
      await runGraphMigrations(graph);
    } catch (err) {
      console.warn(`[graph] migrations for '${graph}' failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      // Only wait on the local model download when the active provider is
      // local. An API model (OpenAI) is ready as soon as a key is set — there's
      // nothing to download, so skip straight to reconcile.
      if (activeEmbeddingModel().provider === "local") {
        // startLocalModel() is a singleton — safe to call here even though
        // server.ts already called it; the same promise is returned.
        await startLocalModel();
      }
      await reconcileAfterModelReady(graph);
    } catch (err) {
      console.warn(`[reconcile] embeddings for '${graph}' failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
}
