import { NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth";
import { requireProject } from "@/lib/projectContext";

// GET /api/graph/overview
// Calls the graph-gateway POST /v1/verbs/read_query with safe read-only Cypher
// and returns cytoscape-ready nodes + edges — the complete graph, fetched as
// two queries (all nodes, then all relationships). A single joined
// `MATCH (n) OPTIONAL MATCH (n)-[r]->(m)` query multiplies rows by out-degree,
// so any row LIMIT silently drops whole subgraphs once the graph grows.
// We omit `graph` from the body so the gateway uses its configured default graph.

const NODES_CYPHER = `MATCH (n) RETURN n`;
const EDGES_CYPHER = `MATCH ()-[r]->() RETURN r`;

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

export async function GET() {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const project = await requireProject();
  try {
    const runQuery = async (cypher: string): Promise<Record<string, unknown>[]> => {
      const res = await fetch(`${project.gatewayUrl}/v1/verbs/read_query`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(project.adminToken ? { authorization: `Bearer ${project.adminToken}` } : {}) },
        body: JSON.stringify({ cypher }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`Gateway responded ${res.status}`);
      const result = (await res.json()) as GatewayQueryResult;
      if (result.status !== "ok" && result.status !== "success") {
        throw new Error(result.error ?? result.status);
      }
      return result.rows ?? [];
    };

    const [nodeRows, edgeRows] = await Promise.all([
      runQuery(NODES_CYPHER),
      runQuery(EDGES_CYPHER),
    ]);

    const nodesMap = new Map<string, CyNode>();          // display id → node
    const internalToDisplay = new Map<number, string>(); // FalkorDB int id → display id

    const displayId = (nd: GwNode): string =>
      String(nd.properties?.id ?? nd.properties?.name ?? `node-${nd.id}`);

    for (const row of nodeRows) {
      const nd = row.n as GwNode | null | undefined;
      if (!nd) continue;
      const did = displayId(nd);
      internalToDisplay.set(nd.id, did);
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
    }

    const edgesSet = new Set<string>();
    const edges: CyEdge[] = [];
    for (const row of edgeRows) {
      const r = row.r as GwRel | null | undefined;
      if (!r) continue;
      const s = internalToDisplay.get(r.sourceId);
      const t = internalToDisplay.get(r.destinationId);
      if (!s || !t) continue;
      const label = r.relationshipType ?? r.type ?? "";
      const key = `${s}→${label}→${t}`;
      if (!edgesSet.has(key)) {
        edgesSet.add(key);
        edges.push({ source: s, target: t, label });
      }
    }

    return NextResponse.json({
      nodes: Array.from(nodesMap.values()),
      edges,
      total: nodesMap.size,
    });
  } catch (e) {
    // Gateway not available — return empty gracefully
    return NextResponse.json({ error: (e as Error).message, nodes: [], edges: [] });
  }
}
