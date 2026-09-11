// anchor-provider.ts — the PRODUCTION NodeAnchorProvider. Anchor resolution
// needs graph node anchor PATHS (a node's `evidence` = 'file:line' prop), which
// live in FalkorDB behind the gateway. The orchestrator reaches them over HTTP
// via the gateway's read_query verb (POST /v1/verbs/read_query) — the same
// service boundary the gateway uses to reach us for search/notes/corrections.
//
// flow.db stays PRIMARY: this provider only READS the projection to infer edges;
// the edges themselves are stored in flow.db's anchors table. When the gateway
// is unreachable, nodesForFiles returns [] and items fall back to repo-level —
// anchoring is enrichment, never a hard dependency. Tests never use this file;
// they inject a stub provider (see anchors.setNodeAnchorProvider).
//
// NOTE: read_query takes only {cypher} (no bound params) and rejects write
// keywords. So we inline SANITIZED basenames (path chars only: [A-Za-z0-9._/-])
// — never raw model text — into a CONTAINS filter. Correctness lives in
// rankAnchors (which re-checks the full path); this query only needs to be a
// safe superset.

import type { NodeAnchor, NodeAnchorProvider } from "./anchors.js";

function gatewayUrl(): string | null {
  const base = process.env.FLOW_GATEWAY_URL || process.env.GRAPH_GATEWAY_URL || "";
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/v1/verbs/read_query`;
}

// Keep only path-safe chars, then lower-case for the CONTAINS compare. Anything
// else (quotes, spaces, cypher syntax) is stripped — no injection surface.
function sanitizeBasename(f: string): string {
  const base = f.replace(/\\/g, "/").split("/").pop() ?? f;
  return base.replace(/[^A-Za-z0-9._-]/g, "").toLowerCase();
}

// Query the graph for nodes whose `evidence` path matches any candidate file.
// Returns node ids with their evidence path; the ranker re-checks the full path
// and derives specificity (deeper id = more specific; endpoints beat services).
export function makeGatewayAnchorProvider(): NodeAnchorProvider {
  return {
    async nodesForFiles(_repo, files) {
      const url = gatewayUrl();
      if (!url || files.length === 0) return [];
      const token = process.env.FLOW_ADMIN_TOKEN || process.env.FLOW_ACTIVITY_TOKEN || "";
      const basenames = [...new Set(files.map(sanitizeBasename))].filter((b) => b.length >= 2);
      if (basenames.length === 0) return [];
      const orClause = basenames.map((b) => `toLower(n.evidence) CONTAINS '${b}'`).join(" OR ");
      const cypher = `MATCH (n) WHERE n.evidence IS NOT NULL AND (${orClause})
        RETURN n.id AS id, n.evidence AS evidence LIMIT 200`;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ cypher }),
          signal: AbortSignal.timeout(4000),
        });
        if (!res.ok) return [];
        const body = (await res.json().catch(() => ({}))) as { rows?: Array<{ id?: string; evidence?: string }> };
        const rows = body.rows ?? [];
        const out: NodeAnchor[] = [];
        for (const r of rows) {
          if (!r.id || !r.evidence) continue;
          // evidence 'file:line' → path.
          const path = String(r.evidence).replace(/:\d+(-\d+)?$/, "");
          out.push({ node_id: String(r.id), paths: [path] });
        }
        return out;
      } catch {
        return [];
      }
    },
  };
}
