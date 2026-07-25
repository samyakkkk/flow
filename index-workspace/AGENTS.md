# Index Workspace

This workspace exists to build and maintain a service-context knowledge graph
from the repositories cloned under `repos/` (prod branches, read-only).

- The graph lives in FalkorDB behind the graph-gateway. All graph access goes
  through the `graph_*` MCP tools (the gateway's MCP server in builder mode,
  wired via `opencode.json`) — never talk to FalkorDB directly and never run
  `docker exec ... GRAPH.QUERY` for writes.
- If the `graph_*` tools are missing or their calls error, stop and say so
  instead of working around it. Do not probe gateway ports with curl — the
  tools talk to the graph directly and ports differ per project.
- Use the `graph-builder` agent for indexing work.
- Repositories are evidence, not workspace: do not modify them, do not read
  `.env` or credentials, do not query live services.
