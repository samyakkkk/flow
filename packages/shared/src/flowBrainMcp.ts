const FLOW_BRAIN_MCP_TOOLS = new Set([
  "correct_graph",
  "find_entity",
  "get_chat_memories",
  "get_entity",
  "list_schema",
  "list_skills",
  "orient",
  "read_query",
  "read_skill",
  "read_document",
  "remember",
  "search_knowledge",
  "source_read",
  "source_search",
]);

interface McpToolIdentity {
  readonly server: string | null;
  readonly tool: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function normalizeMcpServerName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseMcpToolIdentity(value: string | null): McpToolIdentity | null {
  if (!value) return null;
  const normalized = value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
  const prefixed = normalized.match(/^mcp__(.+)__([^_].*)$/i);
  if (prefixed?.[1] && prefixed[2]) {
    return { server: prefixed[1], tool: prefixed[2].trim().toLowerCase() };
  }

  const qualified = normalized.match(/^(.+?)(?:\s*·\s*|[.:/])\s*([a-z0-9_-]+)$/i);
  if (qualified?.[1] && qualified[2]) {
    return { server: qualified[1], tool: qualified[2].trim().toLowerCase() };
  }

  const tool = normalized.toLowerCase();
  return /^[a-z0-9_-]+$/.test(tool) ? { server: null, tool } : null;
}

function flowBrainToolFromIdentity(identity: McpToolIdentity | null): string | null {
  if (!identity) return null;
  const server = identity.server ? normalizeMcpServerName(identity.server) : null;
  if (server === "flowgraph") return identity.tool;
  if ((server === null || server === "t3code") && FLOW_BRAIN_MCP_TOOLS.has(identity.tool)) {
    return identity.tool;
  }
  return null;
}

/** Recognizes a Flow-brain MCP tool from provider-qualified names and labels. */
export function flowBrainMcpToolNameFromLabel(value: string | null | undefined): string | null {
  return flowBrainToolFromIdentity(parseMcpToolIdentity(value ?? null));
}

/** Recognizes Codex (`item.server/tool`) and Claude/OpenCode (`toolName`) MCP payloads. */
export function flowBrainMcpToolNameFromData(value: unknown): string | null {
  const data = asRecord(value);
  if (!data) return null;
  const item = asRecord(data.item) ?? data;
  const server = nonEmptyString(item.server);
  const tool = nonEmptyString(item.tool);
  if (tool) return flowBrainToolFromIdentity({ server, tool: tool.toLowerCase() });
  return flowBrainMcpToolNameFromLabel(
    nonEmptyString(data.toolName) ?? nonEmptyString(item.toolName),
  );
}
