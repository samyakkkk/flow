# Index Workspace

This workspace exists to build and maintain a service-context knowledge graph
from the repositories cloned under `repos/` (prod branches, read-only).

- The graph lives in FalkorDB behind the graph-gateway. All graph access goes
  through the `graph_*` MCP tools (the gateway's MCP server in builder mode,
  wired via `opencode.json`) — never talk to FalkorDB directly and never run
  `docker exec ... GRAPH.QUERY` for writes.
- The gateway must be running at http://127.0.0.1:7433 (check `/health`). If it
  is down, stop and say so instead of working around it.
- Use the `graph-builder` agent for indexing work.
- Repositories are evidence, not workspace: do not modify them, do not read
  `.env` or credentials, do not query live services.
