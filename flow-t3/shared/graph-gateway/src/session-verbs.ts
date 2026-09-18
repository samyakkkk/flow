// Shared tool surface for external coding agents, regardless of transport.
// These names are a contract with installed apps, Cloud Brains and users' permission
// files (FLOW_READ_TOOLS in bin/lib/materialize.mjs): never rename one; add instead.
export const SESSION_VERBS = new Set([
  "orient", "find_entity", "get_entity", "read_query", "list_schema",
  "correct_graph", "remember", "search_knowledge",
  "source_read", "source_search",
]);
