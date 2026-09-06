import { NextRequest, NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth";
import { requireProject } from "@/lib/projectContext";

// GET /api/graph/overview
// Calls the graph-gateway POST /v1/verbs/read_query with safe read-only Cypher
// and returns cytoscape-ready nodes + edges — the complete graph, fetched as
// two queries (all nodes, then all relationships). A single joined
// `MATCH (n) OPTIONAL MATCH (n)-[r]->(m)` query multiplies rows by out-degree,
// so any row LIMIT silently drops whole subgraphs once the graph grows.
// By default the gateway uses its configured graph; callers may pass ?graph=
// for explicit graph selection.

const NODES_CYPHER = `MATCH (n) RETURN n`;
const EDGES_CYPHER = `MATCH (a)-[r]->(b) RETURN a, r, b`;
const NODE_COUNT_CYPHER = `MATCH (n) RETURN count(n) AS count`;
const EDGE_COUNT_CYPHER = `MATCH ()-[r]->() RETURN count(r) AS count`;
const DEFAULT_PAGE_LIMIT = 500;
const MAX_PAGE_LIMIT = 1000;

function pageCypher(base: string, offset: number, limit: number): string {
  return `${base} SKIP ${offset} LIMIT ${limit}`;
}

// FalkorDB's native node/edge shape as the gateway returns it: `id` is an
// INTERNAL integer, the real id + name live in `properties`, the label in
// `labels[0]`. Edges reference nodes by internal sourceId/destinationId.
interface GwNode {
  id: number;
  labels?: string[];
  properties?: Record<string, unknown>;
}
interface GwRel {
  id: number;
  sourceId: number;
  destinationId: number;
  relationshipType?: string;
  type?: string;
  properties?: Record<string, unknown>;
}
interface GatewayQueryResult {
  status: string;
  rows?: Record<string, unknown>[];
  columns?: string[];
  error?: string;
}

interface CyNode {
  id: string;
  data: { name: string; type: string; description?: string };
}

interface CyEdge {
  source: string;
  target: string;
  label: string;
}

function intParam(raw: string | null, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function countFromRows(rows: Record<string, unknown>[]): number {
  const row = rows[0] ?? {};
  const val = row.count ?? row.total ?? Object.values(row)[0] ?? 0;
  return Number(val) || 0;
}

function buildGraphRows(nodeRows: Record<string, unknown>[], edgeRows: Record<string, unknown>[]) {
  const nodesMap = new Map<string, CyNode>();          // display id -> node
  const internalToDisplay = new Map<number, string>(); // FalkorDB int id -> display id

  const displayId = (nd: GwNode): string =>
    String(nd.properties?.id ?? nd.properties?.name ?? `node-${nd.id}`);

  const addNode = (nd: GwNode | null | undefined): string | null => {
    if (!nd) return null;
    const did = displayId(nd);
    if (typeof nd.id === "number") internalToDisplay.set(nd.id, did);
    if (!nodesMap.has(did)) {
      nodesMap.set(did, {
        id: did,
        data: {
          name: String(nd.properties?.name ?? nd.properties?.title ?? did),
          type: nd.labels?.[0] ?? "node",
          description: nd.properties?.description ? String(nd.properties.description) : undefined,
        },
      });
    }
    return did;
  };

  for (const row of nodeRows) {
    addNode(row.n as GwNode | null | undefined);
  }

  const edgesSet = new Set<string>();
  const edges: CyEdge[] = [];
  for (const row of edgeRows) {
    const sourceFromRow = addNode(row.a as GwNode | null | undefined);
    const targetFromRow = addNode(row.b as GwNode | null | undefined);
    const r = row.r as GwRel | null | undefined;
    if (!r) continue;
    const s = sourceFromRow ?? internalToDisplay.get(r.sourceId);
    const t = targetFromRow ?? internalToDisplay.get(r.destinationId);
    if (!s || !t) continue;
    const label = r.relationshipType ?? r.type ?? "";
    const key = `${s}->${label}->${t}`;
    if (!edgesSet.has(key)) {
      edgesSet.add(key);
      edges.push({ source: s, target: t, label });
    }
  }

  return {
    nodes: Array.from(nodesMap.values()),
    edges,
  };
}

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const part = searchParams.get("part");
  const graph = searchParams.get("graph") ?? undefined;
  const offset = intParam(searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = intParam(searchParams.get("limit"), DEFAULT_PAGE_LIMIT, 1, MAX_PAGE_LIMIT);

  const project = await requireProject();
  try {
    const runQuery = async (cypher: string): Promise<Record<string, unknown>[]> => {
      const res = await fetch(`${project.gatewayUrl}/v1/verbs/read_query`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(project.adminToken ? { authorization: `Bearer ${project.adminToken}` } : {}) },
        body: JSON.stringify(graph ? { cypher, graph } : { cypher }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`Gateway responded ${res.status}`);
      const result = (await res.json()) as GatewayQueryResult;
      if (result.status !== "ok" && result.status !== "success") {
        throw new Error(result.error ?? result.status);
      }
      return result.rows ?? [];
    };

    if (part === "summary") {
      const [nodeCountRows, edgeCountRows] = await Promise.all([
        runQuery(NODE_COUNT_CYPHER),
        runQuery(EDGE_COUNT_CYPHER),
      ]);
      const nodeTotal = countFromRows(nodeCountRows);
      const edgeTotal = countFromRows(edgeCountRows);
      return NextResponse.json({
        nodes: [],
        edges: [],
        total: nodeTotal,
        nodeTotal,
        edgeTotal,
        partial: true,
      });
    }

    if (part === "nodes") {
      const nodeRows = await runQuery(pageCypher("MATCH (n) RETURN n", offset, limit));
      const data = buildGraphRows(nodeRows, []);
      return NextResponse.json({
        ...data,
        partial: nodeRows.length === limit,
        page: {
          part,
          offset,
          limit,
          nextOffset: nodeRows.length === limit ? offset + nodeRows.length : null,
        },
      });
    }

    if (part === "edges") {
      const edgeRows = await runQuery(pageCypher("MATCH (a)-[r]->(b) RETURN a, r, b", offset, limit));
      const data = buildGraphRows([], edgeRows);
      return NextResponse.json({
        ...data,
        partial: edgeRows.length === limit,
        page: {
          part,
          offset,
          limit,
          nextOffset: edgeRows.length === limit ? offset + edgeRows.length : null,
        },
      });
    }

    const [nodeRows, edgeRows] = await Promise.all([
      runQuery(NODES_CYPHER),
      runQuery(EDGES_CYPHER),
    ]);
    const data = buildGraphRows(nodeRows, edgeRows);

    return NextResponse.json({
      ...data,
      total: data.nodes.length,
      nodeTotal: data.nodes.length,
      edgeTotal: data.edges.length,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message, nodes: [], edges: [] }, { status: 502 });
  }
}
