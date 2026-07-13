# graph-gateway

The single write path for the memory graph. Wraps FalkorDB with typed verbs
(schema-validated, provenance-required, dedup-checked), records every mutation
in an append-only journal, and exposes the same verbs three ways:

- **HTTP** — for the orchestrator and the OpenCode code-file tools
- **MCP (stdio)** — for MCP-capable clients (Claude Code, etc.)
- **OpenCode tools** — code files in `opencode-tools/` that call the HTTP API

Raw Cypher writes are never exposed; agents mutate the graph only through the
verbs, which is what keeps a multi-writer setup (orchestrator + N OpenCode
sessions) from rotting the ontology.

## Run

Requires a local FalkorDB (e.g. the `flow-falkordb` container) and Node 20+.

```bash
npm install
npm run dev          # HTTP on http://127.0.0.1:7433
```

Env vars: `FALKOR_HOST` / `FALKOR_PORT` (default localhost:6379),
`GRAPH_NAME` (default `memory`), `GATEWAY_PORT` (default 7433),
`JOURNAL_PATH` (default `data/journal.jsonl`).

## Verbs

| verb | what it does |
|---|---|
| `find_entity` | lookup by id/name/alias — check before creating |
| `upsert_entity` | create/update node; blocks near-duplicates until `confirm` |
| `upsert_relation` | create/update typed edge; both ends must exist |
| `get_entity` | node + all incoming/outgoing edges |
| `read_query` | read-only Cypher escape hatch (writes rejected) |
| `list_schema` | allowed node/edge types |

Writes require `provenance: { actor, evidence?, confidence? }` and are journaled.

```bash
curl -s localhost:7433/v1/verbs/upsert_entity -d '{
  "type": "Service", "id": "svc:users", "name": "users",
  "description": "Accounts, credits, billing, rate limits.",
  "provenance": { "actor": "manual", "evidence": "users repo", "confidence": "high" }
}'
curl -s localhost:7433/v1/journal
```

## MCP

```bash
npm run mcp    # stdio server, e.g. `claude mcp add graph-gateway -- npm run mcp`
```

## OpenCode

Copy or symlink `opencode-tools/graph.ts` into your workspace's
`.opencode/tools/`, and add a `.opencode/package.json` that depends on
`@opencode-ai/plugin` (same version as your `opencode` / `opencode-ai`
install). Tools appear as `graph_find`, `graph_upsert`,
`graph_relate`, `graph_get`, `graph_read`, `graph_schema`, and stamp the
calling session's identity into provenance automatically. Point
`GRAPH_GATEWAY_URL` at the gateway if it isn't on the default port.

## Journal

Every mutation appends one JSON line to `data/journal.jsonl`:
`{ts, graph, actor, verb, input, status}`. The graph is a projection of this
log; tail it to watch what any agent is writing in real time.

## Deliberately skipped in v1

Auth (binds to 127.0.0.1), vector/full-text search in `find_entity` (substring
matching only), draft/review lanes (provenance + confidence instead), journal
replay, multi-graph management beyond a per-request `graph` field.
