import { NextRequest, NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth";
import { FLOW_ADMIN_TOKEN, GATEWAY_URL } from "@/lib/config";

// GET /api/graph/neighborhood?nodeId=xxx[&graph=yyy]
// Calls graph-gateway POST /v1/verbs/get_entity ({id, graph?}) and flattens
// its {node, outgoing, incoming} reply into cytoscape-ready nodes+edges,
// with the anchor node flagged `cited`.

interface GatewayEdge {
  rel: string;
  type: string;
  id: string;
  name?: string;
  props?: Record<string, unknown>;
}

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const nodeId = searchParams.get("nodeId");
  const graph = searchParams.get("graph") ?? undefined;
  if (!nodeId) return NextResponse.json({ error: "nodeId is required" }, { status: 400 });

  try {
    const res = await fetch(`${GATEWAY_URL}/v1/verbs/get_entity`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(FLOW_ADMIN_TOKEN ? { authorization: `Bearer ${FLOW_ADMIN_TOKEN}` } : {}) },
      body: JSON.stringify(graph ? { id: nodeId, graph } : { id: nodeId }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: `Gateway responded ${res.status}`, nodes: [], edges: [] },
        { status: 502 }
      );
    }

    const entity = (await res.json()) as {
      status: string;
      node?: { type: string; props: Record<string, unknown> };
      outgoing?: GatewayEdge[];
      incoming?: GatewayEdge[];
    };

    if (entity.status !== "found" || !entity.node) {
      return NextResponse.json({ nodes: [], edges: [], error: "not_found" });
    }

    // Shape matches the ask page: nodes {id, data:{name,...}, cited}, edges {source, target, label}
    const nodes = new Map<string, Record<string, unknown>>();
    nodes.set(nodeId, {
      id: nodeId,
      data: { name: entity.node.props.name ?? nodeId, type: entity.node.type, description: entity.node.props.description ?? null },
      cited: true,
    });

    const edges: Record<string, unknown>[] = [];
    for (const e of entity.outgoing ?? []) {
      if (!nodes.has(e.id)) nodes.set(e.id, { id: e.id, data: { name: e.name ?? e.id, type: e.type }, cited: false });
      edges.push({ source: nodeId, target: e.id, label: e.rel });
    }
    for (const e of entity.incoming ?? []) {
      if (!nodes.has(e.id)) nodes.set(e.id, { id: e.id, data: { name: e.name ?? e.id, type: e.type }, cited: false });
      edges.push({ source: e.id, target: nodeId, label: e.rel });
    }

    return NextResponse.json({ nodes: [...nodes.values()], edges });
  } catch (e) {
    // Gateway not available — return empty graph (graceful degradation)
    return NextResponse.json({ error: (e as Error).message, nodes: [], edges: [] });
  }
}
