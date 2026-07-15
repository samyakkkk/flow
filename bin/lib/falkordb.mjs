// FalkorDB lifecycle helpers used by the Flow CLI.

import { FalkorDB } from "falkordb";

/**
 * Delete one project's named graph and its graph-scoped bookkeeping.
 *
 * FalkorDB is shared by every Flow project, so this deliberately deletes only
 * the requested graph. Missing graphs are treated as already clean, which
 * keeps `flow rm` safe to retry after a partially completed removal.
 */
export async function deleteProjectGraph({ graph, host = "localhost", port = 6379 }) {
  const db = await FalkorDB.connect({
    socket: {
      host,
      port: Number(port),
      connectTimeout: 3000,
      reconnectStrategy: false,
    },
  });

  try {
    const graphs = await db.list();
    const existed = graphs.includes(graph);
    if (existed) await db.selectGraph(graph).delete();

    // Gateway migrations live in a plain Redis key rather than in the graph.
    const connection = await db.connection;
    await connection.del(`flow:graph-version:${graph}`);
    return { existed };
  } finally {
    await db.close();
  }
}
