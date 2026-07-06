import { NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth";
import { GATEWAY_URL } from "@/lib/config";

// GET /api/graph/overview
// Calls the graph-gateway POST /v1/verbs/read_query with a safe read-only Cypher
// and returns cytoscape-ready nodes + edges (up to LIMIT).
// We omit `graph` from the body so the gateway uses its configured default graph.

const LIMIT = 300;

const CYPHER = `
MATCH (n)
OPTIONAL MATCH (n)-[r]->(m)
RETURN n, r, m
LIMIT ${LIMIT}
`.trim();

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
interface GatewayRow {
  n?: GwNode | null;
  r?: GwRel | null;
  m?: GwNode | null;
}

interface GatewayQueryResult {
  status: string;
  rows?: GatewayRow[];
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

  try {
    const res = await fetch(`${GATEWAY_URL}/v1/verbs/read_query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cypher: CYPHER }),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: `Gateway responded ${res.status}`, nodes: [], edges: [] },
        { status: 502 }
      );
    }

    const result = (await res.json()) as GatewayQueryResult;

    if (result.status !== "ok" && result.status !== "success") {
      return NextResponse.json({ nodes: [], edges: [], error: result.error ?? result.status });
    }

    const rows = result.rows ?? [];

    const nodesMap = new Map<string, CyNode>();          // display id → node
    const internalToDisplay = new Map<number, string>(); // FalkorDB int id → display id
    const edgesSet = new Set<string>();
    const edges: CyEdge[] = [];

    const displayId = (nd: GwNode): string =>
      String(nd.properties?.id ?? nd.properties?.name ?? `node-${nd.id}`);

    const addNode = (nd?: GwNode | null): string | null => {
      if (!nd) return null;
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
      return did;
    };

    for (const row of rows) {
      const s = addNode(row.n);
      const t = addNode(row.m);
      const r = row.r;
      if (s && t && r) {
        const label = r.relationshipType ?? r.type ?? "";
        const key = `${s}→${label}→${t}`;
        if (!edgesSet.has(key)) {
          edgesSet.add(key);
          edges.push({ source: s, target: t, label });
        }
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
