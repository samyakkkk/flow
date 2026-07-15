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

Three modes, selected by env:

- **Full** (default): all verbs, for operators driving the gateway by hand.
- **Builder** (`GATEWAY_MCP_MODE=builder`): the indexer surface — query verbs
  plus `upsert_entity`, `upsert_relation`, `merge_entities`, and a `notify`
  tool when a job identity is present. `FLOW_ACTOR` is stamped into every
  write's provenance and `FLOW_WRITE_SCOPE` (comma-separated node ids)
  restricts writes for correction-verification jobs. Workspaces point opencode
  at this via an `mcp` entry in `opencode.json` (see
  `index-workspace/opencode.json`) — no per-workspace npm install, no
  `@opencode-ai/plugin` dependency.
- **Session** (`GATEWAY_MCP_READONLY=1`): query verbs plus the governed
  proposal verbs, injected into coding-agent sessions.

## Journal

Every mutation appends one JSON line to `data/journal.jsonl`:
`{ts, graph, actor, verb, input, status}`. The graph is a projection of this
log; tail it to watch what any agent is writing in real time.

## Deliberately skipped in v1

Auth (binds to 127.0.0.1), vector/full-text search in `find_entity` (substring
matching only), draft/review lanes (provenance + confidence instead), journal
replay, multi-graph management beyond a per-request `graph` field.
