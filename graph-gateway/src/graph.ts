import { FalkorDB } from "falkordb";

const host = process.env.FALKOR_HOST ?? "localhost";
const port = Number(process.env.FALKOR_PORT ?? 6379);

export const DEFAULT_GRAPH = process.env.GRAPH_NAME ?? "memory";

let db: FalkorDB | null = null;

async function connect(): Promise<FalkorDB> {
  if (!db) {
    db = await FalkorDB.connect({ socket: { host, port } });
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

export async function close(): Promise<void> {
  if (db) {
    await db.close();
    db = null;
  }
}
