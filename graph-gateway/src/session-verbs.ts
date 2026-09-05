// Shared tool surface for external coding agents, regardless of transport.
export const SESSION_VERBS = new Set([
  "orient", "find_entity", "get_entity", "read_query", "list_schema",
  "correct_graph", "remember", "search_knowledge",
  "source_read", "source_search",
]);
