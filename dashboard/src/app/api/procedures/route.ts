import { NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth";
import { requireProject } from "@/lib/projectContext";

// GET  /api/procedures — list Procedure nodes (proposed first) for the inbox.
// POST /api/procedures {action: "approve"|"reject", id, edits?} — human review,
//      proxied to the gateway's review_procedure verb. Approval blesses exactly
//      the reviewed text; rejection deletes the node (the journal keeps it).
//
// We omit `graph` from gateway bodies so the gateway uses its configured
// default graph (same convention as /api/graph/overview).

// Explicit field list — properties(n) would drag the embedding vector along.
const LIST_CYPHER = `
MATCH (n:Procedure)
WHERE n.status IN ['proposed', 'blessed', 'retire_proposed']
RETURN n.id AS id, n.name AS name, n.description AS description, n.trigger AS trigger,
       n.steps AS steps, n.scope AS scope, n.mode AS mode, n.status AS status,
       n.repo AS repo, n.source_quote AS source_quote, n.governs_pending AS governs_pending,
       n.created_by AS created_by, n.created_at AS created_at,
       n.blessed_by AS blessed_by, n.blessed_at AS blessed_at,
       n.retire_reason AS retire_reason, n.retire_quote AS retire_quote,
       n.retire_proposed_by AS retire_proposed_by, n.retire_proposed_at AS retire_proposed_at
ORDER BY n.created_at DESC
LIMIT 200
`.trim();

interface ProcedureRow {
  id: string;
  status?: string;
  [key: string]: unknown;
}

async function gatewayVerb(name: string, body: Record<string, unknown>) {
  const project = await requireProject();
  const res = await fetch(`${project.gatewayUrl}/v1/verbs/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(project.adminToken ? { authorization: `Bearer ${project.adminToken}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  return { ok: res.ok, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

export async function GET() {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { ok, body } = await gatewayVerb("read_query", { cypher: LIST_CYPHER });
    if (!ok || body.status !== "ok") {
      return NextResponse.json({ error: (body.error as string) ?? "Gateway error", proposed: [], blessed: [] }, { status: 502 });
    }
    const rows = (body.rows ?? []) as ProcedureRow[];
    return NextResponse.json({
      proposed: rows.filter((r) => r.status === "proposed"),
      blessed: rows.filter((r) => r.status === "blessed"),
      retireProposed: rows.filter((r) => r.status === "retire_proposed"),
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Gateway unreachable", proposed: [], blessed: [] }, { status: 502 });
  }
}

export async function POST(req: Request) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const payload = (await req.json().catch(() => ({}))) as {
    action?: string;
    id?: string;
    edits?: Record<string, unknown>;
  };
  const ACTIONS = new Set(["approve", "reject", "confirm_retire", "dismiss_retire"]);
  if (!payload.id || !ACTIONS.has(payload.action ?? "")) {
    return NextResponse.json({ error: "id and action (approve|reject|confirm_retire|dismiss_retire) are required" }, { status: 400 });
  }

  try {
    const { ok, body } = await gatewayVerb("review_procedure", {
      id: payload.id,
      action: payload.action,
      ...(payload.edits ? { edits: payload.edits } : {}),
      provenance: { actor: "dashboard:review" },
    });
    if (!ok || body.status === "error") {
      return NextResponse.json({ error: (body.error as string) ?? "Gateway error" }, { status: 502 });
    }
    return NextResponse.json(body);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Gateway unreachable" }, { status: 502 });
  }
}
