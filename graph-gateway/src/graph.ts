import { FalkorDB } from "falkordb";

const host = process.env.FALKOR_HOST ?? "localhost";
const port = Number(process.env.FALKOR_PORT ?? 6379);

export const DEFAULT_GRAPH = process.env.GRAPH_NAME ?? "memory";

let db: FalkorDB | null = null;

async function connect(): Promise<FalkorDB> {
  if (!db) {
    db = await FalkorDB.connect({ socket: { host, port } });
    // A FalkorDB/redis socket can close unexpectedly (server restart, network
    // blip). node-redis auto-reconnects — but it EMITS an 'error' event, and an
    // 'error' event with NO listener is rethrown by Node, crashing this process
    // (the gateway, or an indexer's MCP subprocess). Observed on the box as
    // "Emitted 'error' event on FalkorDB instance … Unhandled 'error' event".
    // Attach listeners so a blip is logged, not fatal. Best-effort across
    // falkordb client shapes (the instance re-emits; the raw connection is the
    // source). See memory: users-service Redis silent wedge (missing listener).
    const attach = (emitter: unknown) => {
      const e = emitter as { on?: (ev: string, cb: (err: unknown) => void) => void } | null;
      try {
        e?.on?.("error", (err) =>
          console.error("[falkordb] client error (auto-reconnecting):", (err as Error)?.message ?? err),
        );
      } catch {
        /* not an event emitter on this falkordb version — ignore */
      }
    };
    attach(db);
    attach((db as { connection?: unknown }).connection);
  }
  return db;
}

// All Cypher goes through here, always with bound params — never string
// interpolation of user input.
export async function run(
  graphName: string,
  cypher: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>[]> {
  const conn = await connect();
  const graph = conn.selectGraph(graphName);
  const reply = await graph.query(cypher, { params: params as never });
  return (reply.data ?? []) as Record<string, unknown>[];
}

// Raw redis connection (FalkorDB is a redis module). Used for gateway
// bookkeeping like the per-graph migration version stamp — plain keys, so
// nothing leaks into graph query results.
export async function raw() {
  const conn = await connect();
  return conn.connection;
}

// Deleted-graph tombstone (set by `flow rm`, cleared by `flow up`). FalkorDB
// auto-creates a graph on first query, so without this check any surviving
// writer (an in-flight indexer CLI holding this module in its MCP subprocess)
// would silently resurrect a deleted graph as an untracked orphan. Returns
// the refusal message, or null when the graph is writable.
export async function deletedGraphError(graphName: string): Promise<string | null> {
  const conn = await raw();
  const tombstone = await conn.get(`flow:graph-deleted:${graphName}`);
  if (!tombstone) return null;
  return `graph '${graphName}' was deleted (${tombstone}) — refusing to write; if this graph should live again, run \`flow up\` for its project`;
}

export async function close(): Promise<void> {
  if (db) {
    await db.close();
    db = null;
  }
}
