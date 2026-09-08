import { BRAND } from "@t3tools/shared/branding";
import {
  isToolLifecycleItemType,
  type AssetResource,
  type RuntimeItemStatus,
  type ThreadId,
  type ToolActivitySource,
  type ToolLifecycleItemType,
} from "@t3tools/contracts";
import { classifyMarkdownImageSource } from "@t3tools/client-runtime/markdown-images";
import { resolveMediaSource } from "@t3tools/client-runtime/media-source";
import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";
import {
  flowBrainMcpToolNameFromData,
  flowBrainMcpToolNameFromLabel,
} from "@t3tools/shared/flowBrainMcp";

export function isWorktreeSetupActivity(kind: string): boolean {
  return kind === "setup-script.requested" || kind === "setup-script.started";
}

export type WorkLogToolLifecycleStatus = RuntimeItemStatus | "stopped";

export interface WorkLogPresentationEntry {
  readonly label: string;
  readonly toolTitle?: string;
  readonly toolData?: unknown;
  readonly tone: "thinking" | "tool" | "info" | "error";
  readonly command?: string;
  readonly detail?: string;
  readonly viewedImagePath?: string;
  readonly changedFiles?: ReadonlyArray<string>;
  readonly itemType?: ToolLifecycleItemType;
  readonly requestKind?: string;
  readonly turnId?: string | null;
  readonly toolCallId?: string;
  readonly toolLifecycleStatus?: string;
  readonly sourceActivityKind?: string;
  readonly taskId?: string;
  readonly toolSource?: ToolActivitySource;
}

export type ToolGroupAction =
  | "read"
  | "edit"
  | "command"
  | "brain"
  | "browser"
  | "code-search"
  | "search"
  | "other"
  | "update";

export type ToolGroupSummaryKind =
  | ToolGroupAction
  | "dynamic-tool"
  | "agent-tool"
  | "tone-tool"
  | "mixed";

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

const T3_MCP_TOOL_LABELS: Record<
  string,
  readonly [action: string, running: string, completed: string, detail: string]
> = {
  orchestrator_capabilities: ["Get", "Getting", "Got", "orchestration capabilities"],
  delegate_task: ["Delegate", "Delegating", "Delegated", "a child task"],
  task_status: ["Get", "Getting", "Got", "delegated task status"],
  task_cancel: ["Cancel", "Canceling", "Canceled", "delegated task"],
  schedule_task: ["Schedule", "Scheduling", "Scheduled", "a recurring task"],
  list_scheduled_tasks: ["List", "Listing", "Listed", "scheduled tasks"],
  update_scheduled_task: ["Update", "Updating", "Updated", "a scheduled task"],
  delete_scheduled_task: ["Delete", "Deleting", "Deleted", "a scheduled task"],
  create_threads: ["Create", "Creating", "Created", `${BRAND.shortName} threads`],
  t3_thread_start: ["Start", "Starting", "Started", `a ${BRAND.shortName} thread`],
  t3_thread_list: ["List", "Listing", "Listed", `${BRAND.shortName} threads`],
  t3_thread_read: ["Read", "Reading", "Read", `a ${BRAND.shortName} thread`],
  t3_thread_send: ["Send", "Sending", "Sent", `to a ${BRAND.shortName} thread`],
  t3_thread_wait: ["Wait", "Waiting", "Waited", `for a ${BRAND.shortName} thread`],
  t3_thread_interrupt: ["Interrupt", "Interrupting", "Interrupted", `a ${BRAND.shortName} thread`],
  t3_worktree_handoff: ["Hand off", "Handing off", "Handed off", "thread to a git worktree"],
  t3_worktree_status: ["Get", "Getting", "Got", "thread worktree status"],
  preview_status: ["Get", "Getting", "Got", "preview browser status"],
  preview_open: ["Open", "Opening", "Opened", "a page in the preview browser"],
  preview_navigate: ["Navigate", "Navigating", "Navigated", "the preview browser"],
  preview_snapshot: [
    "Take a snapshot of",
    "Taking a snapshot of",
    "Took a snapshot of",
    "the preview page",
  ],
  preview_click: ["Click", "Clicking", "Clicked", "in the preview browser"],
  preview_press: ["Press", "Pressing", "Pressed", "a key in the preview browser"],
  preview_type: ["Type", "Typing", "Typed", "in the preview browser"],
  preview_scroll: ["Scroll", "Scrolling", "Scrolled", "the preview browser"],
  preview_resize: ["Resize", "Resizing", "Resized", "the preview browser"],
  preview_evaluate: ["Evaluate", "Evaluating", "Evaluated", "script in the preview browser"],
  preview_wait_for: ["Wait", "Waiting", "Waited", "for the preview page"],
  preview_set_appearance: ["Set", "Setting", "Set", "preview browser appearance"],
  preview_recording_start: ["Start", "Starting", "Started", "recording the preview browser"],
  preview_recording_stop: ["Stop", "Stopping", "Stopped", "recording the preview browser"],
};

export interface FlowBrainToolCallDetails {
  readonly tool: string;
  readonly toolLabel: string;
  readonly request: unknown;
  readonly response: unknown;
}

export interface FlowBrainDisplayField {
  readonly label: string;
  readonly value: string | ReadonlyArray<string>;
  readonly code?: boolean;
}

export interface FlowBrainDisplayItem {
  readonly title: string;
  readonly eyebrow?: string;
  readonly id?: string;
  readonly description?: string;
  readonly fields?: ReadonlyArray<FlowBrainDisplayField>;
  readonly tags?: ReadonlyArray<string>;
  readonly tone?: "default" | "muted" | "warning" | "danger";
}

export interface FlowBrainDisplaySection {
  readonly title: string;
  readonly subtitle?: string;
  readonly items?: ReadonlyArray<FlowBrainDisplayItem>;
  readonly fields?: ReadonlyArray<FlowBrainDisplayField>;
  readonly tags?: ReadonlyArray<string>;
  readonly text?: string;
  readonly code?: boolean;
  readonly tone?: "default" | "muted" | "warning" | "danger";
}

export interface FlowBrainConsultationDisplay {
  readonly tool: string;
  readonly toolLabel: string;
  readonly requestFields: ReadonlyArray<FlowBrainDisplayField>;
  readonly responseSummary: string;
  readonly responseSections: ReadonlyArray<FlowBrainDisplaySection>;
}

function flowBrainToolLabel(tool: string): string {
  const words = tool.replace(/[-_]+/g, " ").trim();
  return words.length > 0 ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : "Brain query";
}

function resolveFlowBrainMcpToolPresentation(tool: string, status: string | undefined) {
  const verb =
    status === undefined || status === "inProgress"
      ? "Consulting the brain"
      : status === "failed"
        ? "Couldn't consult the brain"
        : status === "declined"
          ? "Declined to consult the brain"
          : status === "stopped"
            ? "Stopped consulting the brain"
            : "Consulted the brain";
  return {
    displayName: `${verb} · ${flowBrainToolLabel(tool)}`,
    icon: "brain" as const,
  };
}

function resolveT3McpToolPresentation(value: string | undefined, status: string | undefined) {
  if (!value) return null;
  const name = normalizeCompactToolLabel(value).replace(
    /^(?:mcp__(?:t3-code|t3_code|t3code)__|(?:t3-code|t3_code|t3code)(?:[.:/]|\s*·\s*))/i,
    "",
  );
  if (!Object.hasOwn(T3_MCP_TOOL_LABELS, name)) return null;

  const [action, running, completed, detail] = T3_MCP_TOOL_LABELS[name]!;
  const verb =
    status === "inProgress"
      ? running
      : status === "completed"
        ? completed
        : status === "failed"
          ? `Failed to ${action.toLowerCase()}`
          : status === "declined"
            ? `Declined to ${action.toLowerCase()}`
            : status === "stopped"
              ? `Stopped ${running.toLowerCase()}`
              : running;

  return {
    displayName: `${verb} ${detail}`,
    icon: name.startsWith("preview_") ? ("browser" as const) : ("t3-code" as const),
  };
}

/** Latest live activity stays present-tense unless the call itself failed, declined, or stopped. */
export function liveActivityToolStatus(status: string | undefined, presentTense: boolean) {
  if (status === "failed" || status === "declined" || status === "stopped") return status;
  if (presentTense || status === "inProgress") return "inProgress";
  return "completed";
}

/** Resolves tool identity before choosing labels or icons in either client. */
export function resolveWorkEntryToolPresentation(
  entry: Pick<WorkLogPresentationEntry, "label" | "toolTitle" | "toolData" | "toolLifecycleStatus">,
  fallbackStatus?: "inProgress" | "completed",
) {
  const status = entry.toolLifecycleStatus ?? fallbackStatus;
  const data = entry.toolData;
  const structuredBrainTool = flowBrainMcpToolNameFromData(data);
  if (structuredBrainTool) {
    return resolveFlowBrainMcpToolPresentation(structuredBrainTool, status);
  }
  if (data !== null && typeof data === "object") {
    if (
      "server" in data &&
      typeof data.server === "string" &&
      "tool" in data &&
      typeof data.tool === "string"
    ) {
      return resolveT3McpToolPresentation(`${data.server}.${data.tool}`, status);
    }
    if ("toolName" in data && typeof data.toolName === "string") {
      return resolveT3McpToolPresentation(data.toolName, status);
    }
  }

  const titledBrainTool = flowBrainMcpToolNameFromLabel(entry.toolTitle);
  if (titledBrainTool) {
    return resolveFlowBrainMcpToolPresentation(titledBrainTool, status);
  }
  const labeledBrainTool = flowBrainMcpToolNameFromLabel(entry.label);
  if (labeledBrainTool) {
    return resolveFlowBrainMcpToolPresentation(labeledBrainTool, status);
  }

  return (
    resolveT3McpToolPresentation(entry.toolTitle, status) ??
    resolveT3McpToolPresentation(entry.label, status)
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function parseJsonValue(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function unwrapMcpResult(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current === "string") {
      const parsed = parseJsonValue(current);
      if (parsed === current) return current;
      current = parsed;
      continue;
    }
    if (Array.isArray(current)) {
      const text = current
        .map((entry) => nonEmptyString(asRecord(entry)?.text))
        .filter((entry): entry is string => entry !== null);
      if (text.length !== current.length || text.length === 0) return current;
      current = text.join("\n");
      continue;
    }
    const record = asRecord(current);
    if (!record) return current;
    if (record.structuredContent !== undefined && record.structuredContent !== null) {
      current = record.structuredContent;
      continue;
    }
    const keys = Object.keys(record);
    const looksLikeMcpResult = keys.every((key) =>
      ["content", "isError", "_meta", "structuredContent"].includes(key),
    );
    if (looksLikeMcpResult && record.content !== undefined) {
      current = record.content;
      continue;
    }
    return current;
  }
  return current;
}

/** Extracts the user-relevant request/response from provider-specific Flow MCP payloads. */
export function resolveFlowBrainToolCallDetails(
  entry: Pick<WorkLogPresentationEntry, "label" | "toolTitle" | "toolData" | "detail">,
): FlowBrainToolCallDetails | null {
  const data = asRecord(entry.toolData);
  const item = asRecord(data?.item) ?? data;
  const tool =
    flowBrainMcpToolNameFromData(entry.toolData) ??
    flowBrainMcpToolNameFromLabel(entry.toolTitle) ??
    flowBrainMcpToolNameFromLabel(entry.label);
  if (!tool) return null;

  const request = item?.arguments ?? item?.input ?? data?.input;
  const result = item?.result ?? data?.result;
  const error = item?.error ?? data?.error;
  return {
    tool,
    toolLabel: flowBrainToolLabel(tool),
    request,
    response: unwrapMcpResult(result ?? error ?? entry.detail),
  };
}

/** Pretty-prints structured MCP values while leaving prose responses readable. */
export function formatFlowBrainToolCallValue(value: unknown, emptyLabel: string): string {
  if (value === undefined || value === null) return emptyLabel;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return emptyLabel;
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return JSON.stringify(JSON.parse(trimmed), null, 2);
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

const FLOW_BRAIN_FIELD_LABELS: Readonly<Record<string, string>> = {
  q: "Query",
  qs: "Queries",
  query: "Query",
  queries: "Queries",
  id: "Entity",
  ids: "Entities",
  type: "Entity type",
  graph: "Graph",
  repo: "Repository",
  branch: "Branch",
  path: "File",
  revision: "Revision",
  start_line: "Start line",
  end_line: "End line",
  limit: "Result limit",
  cypher: "Graph query",
  text: "Memory",
  target_ids: "Entities",
  reason: "Reason",
  evidence: "Evidence",
};

function titleCase(value: string): string {
  const words = value.replace(/[-_]+/g, " ").trim();
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : value;
}

function displayField(key: string, value: unknown): FlowBrainDisplayField | null {
  if (value === undefined || value === null || value === "") return null;
  const label = FLOW_BRAIN_FIELD_LABELS[key] ?? titleCase(key);
  if (
    Array.isArray(value) &&
    value.every((entry) => ["string", "number", "boolean"].includes(typeof entry))
  ) {
    return { label, value: value.map(String) };
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return {
      label,
      value: String(value),
      ...(key === "cypher" || key === "path" || key === "revision" || key === "evidence"
        ? { code: true }
        : {}),
    };
  }
  return { label, value: formatFlowBrainToolCallValue(value, ""), code: true };
}

function displayFields(value: unknown, excluded = new Set<string>()): FlowBrainDisplayField[] {
  const record = asRecord(value);
  if (!record) return value === undefined ? [] : [{ label: "Value", value: String(value) }];
  return Object.entries(record).flatMap(([key, entry]) => {
    if (excluded.has(key)) return [];
    const field = displayField(key, entry);
    return field ? [field] : [];
  });
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => (nonEmptyString(entry) ? [String(entry)] : []))
    : [];
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const record = asRecord(entry);
        return record ? [record] : [];
      })
    : [];
}

function compactCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function memoryLineItem(line: string): FlowBrainDisplayItem {
  const findEntity = line.match(
    /^\[Memory:([^\]]+)\]\s+([\s\S]*?)\s+\(([^)]+)\)\s+\[mem:([^\]]+)\]$/i,
  );
  if (findEntity) {
    return {
      eyebrow: `Memory · ${titleCase(findEntity[1]!)} · ${titleCase(findEntity[3]!)}`,
      title: findEntity[2]!,
      id: `mem:${findEntity[4]}`,
    };
  }
  const searchMemory = line.match(
    /^[-•]\s+([\s\S]*?)\s+\[([^/\]]+)\/([^\]]+)\]\s+\((?:memory|ticket|thread)\s+([^)]+)\)$/i,
  );
  if (searchMemory) {
    return {
      eyebrow: `Memory · ${titleCase(searchMemory[2]!)} · ${titleCase(searchMemory[3]!)}`,
      title: searchMemory[1]!,
      id: searchMemory[4]!,
    };
  }
  return { eyebrow: "Memory", title: line.replace(/^[-•]\s+/, "") };
}

function entityItem(value: unknown): FlowBrainDisplayItem {
  const record = asRecord(value) ?? {};
  const props = asRecord(record.props) ?? record;
  const id = nonEmptyString(record.id) ?? nonEmptyString(props.id) ?? undefined;
  const name = nonEmptyString(record.name) ?? nonEmptyString(props.name);
  const type = nonEmptyString(record.type) ?? nonEmptyString(props.type);
  const note = nonEmptyString(record.note);
  const anchor = nonEmptyString(record.anchor) ?? nonEmptyString(props.anchor);
  const evidence = nonEmptyString(props.evidence);
  const via = nonEmptyString(record.via);
  return {
    title: name ?? id ?? "Unnamed entity",
    ...(type ? { eyebrow: titleCase(type) } : {}),
    ...(name && id ? { id } : {}),
    ...((nonEmptyString(record.description) ?? nonEmptyString(props.description) ?? note)
      ? {
          description:
            nonEmptyString(record.description) ?? nonEmptyString(props.description) ?? note!,
        }
      : {}),
    ...(anchor || evidence
      ? {
          fields: [
            ...(anchor ? [{ label: "Code", value: anchor, code: true as const }] : []),
            ...(evidence ? [{ label: "Evidence", value: evidence, code: true as const }] : []),
          ],
        }
      : {}),
    ...(via ? { tags: [via === "vector" ? "Semantic match" : "Exact text match"] } : {}),
    ...(note ? { tone: "muted" as const } : {}),
  };
}

function findEntityDisplay(
  response: Record<string, unknown>,
  request: Record<string, unknown> | null,
): Pick<FlowBrainConsultationDisplay, "responseSummary" | "responseSections"> {
  const groups = response.status === "batch" ? records(response.groups) : [response];
  let entityCount = 0;
  let memoryCount = 0;
  const sections = groups.map((group, index): FlowBrainDisplaySection => {
    const matches = Array.isArray(group.matches) ? group.matches : [];
    const memoryHits = strings(group.memory_hits);
    entityCount += matches.length;
    memoryCount += memoryHits.length;
    const requestQueries = strings(request?.qs);
    const query =
      nonEmptyString(group.query) ??
      nonEmptyString(request?.q) ??
      requestQueries[index] ??
      "Entity lookup";
    const status = nonEmptyString(group.status);
    const error = nonEmptyString(group.error);
    const warning = nonEmptyString(group.warning);
    return {
      title: query,
      ...(status ? { subtitle: titleCase(status) } : {}),
      items: [...matches.map(entityItem), ...memoryHits.map(memoryLineItem)],
      ...(error || warning ? { text: error ?? warning!, tone: error ? "danger" : "warning" } : {}),
    };
  });
  const counts = [
    compactCount(entityCount, "entity", "entities"),
    ...(memoryCount > 0 ? [compactCount(memoryCount, "memory", "memories")] : []),
    ...(groups.length > 1 ? [compactCount(groups.length, "query", "queries")] : []),
  ];
  return { responseSummary: counts.join(" · "), responseSections: sections };
}

function parseKnowledgeSearch(text: string): FlowBrainDisplaySection[] {
  const sections: Array<{ title: string; items: FlowBrainDisplayItem[]; lines: string[] }> = [];
  let current = { title: "Matches", items: [] as FlowBrainDisplayItem[], lines: [] as string[] };
  let category = "Memory";
  const flush = () => {
    if (current.items.length > 0 || current.lines.length > 0) sections.push(current);
  };
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    const queryHeading = line.match(/^===\s+q\d+:\s*([\s\S]*?)\s*===$/i);
    if (queryHeading) {
      flush();
      current = { title: queryHeading[1]!, items: [], lines: [] };
      category = "Memory";
      continue;
    }
    if (/^[A-Z][A-Z /_-]+:$/.test(line)) {
      category = titleCase(line.slice(0, -1).toLowerCase());
      continue;
    }
    if (/^[-•]\s+/.test(line)) {
      const item = memoryLineItem(line);
      current.items.push({
        ...item,
        ...(item.eyebrow ? { eyebrow: item.eyebrow.replace(/^Memory/, category) } : {}),
      });
    } else if (line) {
      current.lines.push(line);
    }
  }
  flush();
  return sections.map((section) => ({
    title: section.title,
    ...(section.items.length > 0 ? { items: section.items } : {}),
    ...(section.lines.length > 0 ? { text: section.lines.join("\n") } : {}),
  }));
}

function getEntityResultItem(value: unknown): FlowBrainDisplayItem {
  const result = asRecord(value) ?? {};
  if (result.status === "not_found") {
    return {
      eyebrow: "Not found",
      title: nonEmptyString(result.id) ?? "Unknown entity",
      tone: "warning",
    };
  }
  if (result.status === "error") {
    const error = nonEmptyString(result.error);
    return {
      eyebrow: "Error",
      title: nonEmptyString(result.id) ?? "Entity lookup failed",
      ...(error ? { description: error } : {}),
      tone: "danger",
    };
  }
  const card = asRecord(result.card);
  if (card) {
    const kind = nonEmptyString(card.kind) ?? nonEmptyString(result.card_type) ?? "context";
    const title =
      nonEmptyString(card.claim) ??
      nonEmptyString(card.title) ??
      nonEmptyString(card.text) ??
      nonEmptyString(card.root_text) ??
      nonEmptyString(card.identifier) ??
      nonEmptyString(result.id) ??
      "Brain context";
    const description = nonEmptyString(card.description);
    const strength = asRecord(card.strength);
    const tags = [
      nonEmptyString(card.memory_kind),
      nonEmptyString(strength?.tier),
      ...strings(card.anchors),
      ...strings(card.anchored_nodes),
    ].filter((entry): entry is string => entry !== null);
    return {
      eyebrow: titleCase(kind),
      title,
      ...(nonEmptyString(result.id) ? { id: nonEmptyString(result.id)! } : {}),
      ...(description ? { description } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      fields: displayFields(
        card,
        new Set([
          "kind",
          "claim",
          "title",
          "text",
          "root_text",
          "identifier",
          "description",
          "strength",
          "memory_kind",
          "anchors",
          "anchored_nodes",
          "evidence",
          "messages",
        ]),
      ).slice(0, 6),
    };
  }
  const node = asRecord(result.node);
  if (node) {
    const item = entityItem(node);
    const outgoing = records(result.outgoing);
    const incoming = records(result.incoming);
    const connections = [...outgoing, ...incoming].slice(0, 10).map((relation) => {
      const rel = nonEmptyString(relation.rel) ?? "RELATED";
      const target = nonEmptyString(relation.name) ?? nonEmptyString(relation.id) ?? "entity";
      return `${titleCase(rel)} · ${target}`;
    });
    return {
      ...item,
      tags: [
        ...(item.tags ?? []),
        ...connections,
        ...(outgoing.length + incoming.length > connections.length
          ? [`+${outgoing.length + incoming.length - connections.length} connections`]
          : []),
      ],
    };
  }
  return entityItem(result);
}

function getEntityDisplay(
  response: Record<string, unknown>,
): Pick<FlowBrainConsultationDisplay, "responseSummary" | "responseSections"> {
  const results = response.status === "batch" ? records(response.results) : [response];
  const found =
    typeof response.found === "number"
      ? response.found
      : results.filter((result) => result.status !== "not_found" && result.status !== "error")
          .length;
  const missing = results.length - found;
  return {
    responseSummary: [
      compactCount(found, "result"),
      ...(missing > 0 ? [`${missing} missing`] : []),
    ].join(" · "),
    responseSections: [{ title: "Retrieved context", items: results.map(getEntityResultItem) }],
  };
}

function genericObjectDisplay(
  response: Record<string, unknown>,
): Pick<FlowBrainConsultationDisplay, "responseSummary" | "responseSections"> {
  const status = nonEmptyString(response.status);
  const error = nonEmptyString(response.error);
  const fields = displayFields(response, new Set(["status", "error"]));
  return {
    responseSummary: error
      ? "The consultation failed"
      : status
        ? titleCase(status)
        : "Response received",
    responseSections: [
      {
        title: error ? "Error" : "Response",
        ...(error ? { text: error, tone: "danger" as const } : {}),
        ...(fields.length > 0 ? { fields } : {}),
      },
    ],
  };
}

function responseDisplay(
  tool: string,
  request: unknown,
  responseValue: unknown,
  waiting: boolean,
): Pick<FlowBrainConsultationDisplay, "responseSummary" | "responseSections"> {
  if (responseValue === undefined || responseValue === null) {
    return {
      responseSummary: waiting ? "Waiting for the brain…" : "No response body",
      responseSections: [],
    };
  }
  const response = asRecord(responseValue);
  const requestRecord = asRecord(request);
  if (tool === "find_entity" && response) return findEntityDisplay(response, requestRecord);
  if (tool === "get_entity" && response) return getEntityDisplay(response);
  if (tool === "search_knowledge" && response) {
    const text = nonEmptyString(response.results) ?? nonEmptyString(response.lines);
    if (text) {
      const sections = parseKnowledgeSearch(text);
      const resultCount = sections.reduce(
        (count, section) => count + (section.items?.length ?? 0),
        0,
      );
      return {
        responseSummary:
          resultCount > 0 ? compactCount(resultCount, "memory", "memories") : "Search complete",
        responseSections: sections,
      };
    }
  }
  if (tool === "list_schema" && response) {
    const nodeTypes = strings(response.nodeTypes);
    const edgeTypes = strings(response.edgeTypes);
    return {
      responseSummary: `${compactCount(nodeTypes.length, "node type")} · ${compactCount(edgeTypes.length, "relationship")}`,
      responseSections: [
        { title: "Node types", tags: nodeTypes },
        { title: "Relationships", tags: edgeTypes.map(titleCase) },
      ],
    };
  }
  if (tool === "read_query" && response && Array.isArray(response.rows)) {
    const rows = records(response.rows);
    return {
      responseSummary: compactCount(rows.length, "row"),
      responseSections: [
        {
          title: "Query results",
          items: rows.map((row, index) => ({
            title: `Row ${index + 1}`,
            fields: displayFields(row),
          })),
        },
      ],
    };
  }
  if (tool === "source_search" && response && Array.isArray(response.matches)) {
    const matches = records(response.matches);
    return {
      responseSummary: compactCount(matches.length, "source match"),
      responseSections: [
        {
          title: "Source matches",
          items: matches.map((match) => {
            const description = nonEmptyString(match.text);
            return {
              eyebrow: nonEmptyString(response.repo) ?? "Repository",
              title: `${nonEmptyString(match.path) ?? "Unknown file"}:${String(match.line ?? "?")}`,
              ...(description ? { description } : {}),
            };
          }),
        },
      ],
    };
  }
  if (tool === "source_read" && response && nonEmptyString(response.content)) {
    const subtitle = nonEmptyString(response.repo);
    return {
      responseSummary: `${nonEmptyString(response.path) ?? "Source file"} · lines ${String(response.start_line ?? "?")}–${String(response.end_line ?? "?")}`,
      responseSections: [
        {
          title: nonEmptyString(response.path) ?? "Source",
          ...(subtitle ? { subtitle } : {}),
          text: nonEmptyString(response.content)!,
          code: true,
        },
      ],
    };
  }
  if (tool === "orient" && typeof responseValue === "string") {
    const blocks = responseValue
      .split(/\n\s*\n/)
      .map((block) => block.trim())
      .filter(Boolean);
    return {
      responseSummary: "Project context loaded",
      responseSections: blocks.map((block, index) => {
        const [first, ...rest] = block.split("\n");
        const heading = first?.match(/^([A-Z][A-Z ]+):\s*(.*)$/);
        return heading
          ? {
              title: titleCase(heading[1]!.toLowerCase()),
              text: [heading[2], ...rest].filter(Boolean).join("\n"),
            }
          : { title: index === 0 ? "Project" : "Context", text: block };
      }),
    };
  }
  if (response) return genericObjectDisplay(response);
  return {
    responseSummary: "Response received",
    responseSections: [{ title: "Response", text: String(responseValue) }],
  };
}

/** Projects known Flow graph schemas into a compact UI model shared by all clients. */
export function resolveFlowBrainConsultationDisplay(
  entry: Pick<
    WorkLogPresentationEntry,
    "label" | "toolTitle" | "toolData" | "detail" | "toolLifecycleStatus"
  >,
): FlowBrainConsultationDisplay | null {
  const details = resolveFlowBrainToolCallDetails(entry);
  if (!details) return null;
  const requestFields = displayFields(details.request);
  const response = responseDisplay(
    details.tool,
    details.request,
    details.response,
    entry.toolLifecycleStatus === "inProgress",
  );
  return { ...details, requestFields, ...response };
}

function commandResultContent(value: unknown): string | null {
  const direct = nonEmptyString(value);
  if (direct) return direct;

  const directContent = Array.isArray(value) ? value : null;
  const record = asRecord(value);
  const content = record?.content;
  const contentText = nonEmptyString(content);
  if (contentText) return contentText;
  const blocks = directContent ?? (Array.isArray(content) ? content : null);
  if (!blocks) return null;

  const chunks = blocks.flatMap((entry) => {
    const text = nonEmptyString(entry) ?? nonEmptyString(asRecord(entry)?.text);
    return text ? [text] : [];
  });
  return chunks.length > 0 ? chunks.join("\n") : null;
}

/** Returns provider command output before it is formatted for a work-log row. */
export function extractCommandOutputText(dataValue: unknown): string | null {
  const data = asRecord(dataValue);
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  const rawOutput = asRecord(data?.rawOutput);
  const outputStreams = [
    nonEmptyString(rawOutput?.stdout),
    nonEmptyString(rawOutput?.stderr),
  ].filter((value): value is string => value !== null);
  const acpContent = Array.isArray(data?.content)
    ? data.content
        .flatMap((entryValue) => {
          const entry = asRecord(entryValue);
          const content = asRecord(entry?.content);
          const text = entry?.type === "content" ? nonEmptyString(content?.text) : null;
          return text ? [text] : [];
        })
        .join("\n")
    : null;

  const candidates = [
    item?.aggregatedOutput,
    itemResult?.content,
    data?.rawOutput,
    rawOutput?.content,
    outputStreams.length > 0 ? outputStreams.join("\n") : null,
    rawOutput?.output,
    acpContent,
    data?.result,
  ];
  for (const candidate of candidates) {
    const text = commandResultContent(candidate);
    if (text) return text;
  }
  return null;
}

/**
 * Ingestion caps tool details at 180 chars and appends "...", so a long command
 * echo no longer equals the command it repeats. Treat a truncated prefix of the
 * command as the same echo.
 */
function textRepeatsCommand(text: string, commands: ReadonlyArray<string | null>): boolean {
  const truncated = text.endsWith("...")
    ? text.slice(0, -3)
    : text.endsWith("\u2026")
      ? text.slice(0, -1)
      : null;
  return commands.some((candidate) => {
    const command = candidate?.trim();
    if (!command) return false;
    if (command === text) return true;
    return (
      truncated !== null &&
      truncated.length > 0 &&
      command.length > truncated.length &&
      command.startsWith(truncated)
    );
  });
}

/**
 * Decides whether a command row's `detail` is a synthetic echo of the command
 * rather than real output. OpenCode stores completed output in `detail` with no
 * other output channel, so plain equality is only treated as synthetic when the
 * payload shape shows the detail came from the command: Codex item metadata,
 * an ACP tool call (`data.toolCallId`, `kind: "execute"`), a Claude tool-name
 * prefix, or no structured command at all.
 */
export function commandDetailRepeatsCommand(input: {
  readonly detail: string;
  readonly command: string | null;
  readonly rawCommand: string | null;
  readonly toolName: unknown;
  readonly data: unknown;
}): boolean {
  const toolName = nonEmptyString(input.toolName)?.trim();
  const detail = input.detail.trim();
  const commands = [input.command, input.rawCommand];
  if (toolName) {
    const prefix = `${toolName}:`;
    if (detail.toLowerCase().startsWith(prefix.toLowerCase())) {
      const unprefixed = detail.slice(prefix.length).trim();
      if (textRepeatsCommand(unprefixed, commands)) return true;
    }
  }

  if (!textRepeatsCommand(detail, commands)) return false;

  const data = asRecord(input.data);
  const item = asRecord(data?.item);
  const itemInput = asRecord(item?.input);
  const itemResult = asRecord(item?.result);
  const hasStructuredCommand = [
    item?.command,
    itemInput?.command,
    itemResult?.command,
    data?.command,
  ].some((value) =>
    Array.isArray(value)
      ? value.some((part) => nonEmptyString(part) !== null)
      : nonEmptyString(value) !== null,
  );
  return (
    !hasStructuredCommand ||
    item !== null ||
    data?.toolCallId !== undefined ||
    nonEmptyString(data?.kind)?.toLowerCase() === "execute"
  );
}

export function workLogEntryIsToolLike(entry: WorkLogPresentationEntry): boolean {
  if (entry.tone === "tool" || entry.tone === "thinking" || entry.tone === "error") return true;
  if (entry.command !== undefined && entry.command.trim().length > 0) return true;
  if (entry.requestKind !== undefined) return true;
  return entry.itemType !== undefined && isToolLifecycleItemType(entry.itemType);
}

/** Maps item and task status to the status shown on a work-log row. */
export function extractWorkLogToolLifecycleStatus(
  payloadValue: unknown,
): WorkLogToolLifecycleStatus | undefined {
  const payload = asRecord(payloadValue);
  switch (payload?.status) {
    case "pending":
    case "running":
    case "waiting":
      return "inProgress";
    case "cancelled":
    case "interrupted":
      return "stopped";
    case "idle":
      // A batch becomes idle when its parent turn ends. Other idle tasks can resume.
      return payload.taskType === "subagent_batch" ? "stopped" : undefined;
    case "inProgress":
    case "completed":
    case "failed":
    case "declined":
    case "stopped":
      return payload.status;
    default:
      return undefined;
  }
}

// Some providers report completion even when the output describes a failure.
function toolDetailTextLooksLikeFailure(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("file not found") ||
    normalized.includes("no files found") ||
    normalized.includes("enoent") ||
    normalized.includes("no such file or directory") ||
    normalized.includes("no such file") ||
    normalized.includes("commandnotfoundexception") ||
    normalized.includes("command not found") ||
    (normalized.includes("cannot find path") && normalized.includes("because it does not exist")) ||
    (normalized.includes("is not recognized") && normalized.includes("the term '")) ||
    normalized.includes("is not recognized as the name of a cmdlet") ||
    normalized.includes("a parameter cannot be found that matches parameter name") ||
    /<exited with exit code\s+[1-9]\d*\s*>/i.test(text) ||
    /exit(?:ed)? with exit code\s+[1-9]\d*/i.test(text) ||
    /exit code\s*[:\s]\s*[1-9]\d*\b/i.test(text)
  );
}

function workEntryIndicatesToolFailureFromOutput(
  entry: WorkLogPresentationEntry,
  includeCommand: boolean,
): boolean {
  if (
    entry.tone === "error" ||
    entry.toolLifecycleStatus === "failed" ||
    entry.toolLifecycleStatus === "declined"
  ) {
    return true;
  }
  if (!workLogEntryIsToolLike(entry)) return false;
  const output = includeCommand
    ? [entry.detail, entry.command].filter(Boolean).join("\n")
    : (entry.detail ?? "");
  return output.length > 0 && toolDetailTextLooksLikeFailure(output);
}

/** Includes legacy activities that stored error output in the command field. */
export function workEntryIndicatesToolFailure(entry: WorkLogPresentationEntry): boolean {
  return workEntryIndicatesToolFailureFromOutput(entry, true);
}

/** Checks rendered output without treating the user's command as an error. */
export function workEntryDisplayIndicatesToolFailure(entry: WorkLogPresentationEntry): boolean {
  return workEntryIndicatesToolFailureFromOutput(entry, false);
}

/** Decides whether the row can show a success marker. */
export function workEntryIndicatesToolSuccess(entry: WorkLogPresentationEntry): boolean {
  return (
    workLogEntryIsToolLike(entry) &&
    !workEntryIndicatesToolFailure(entry) &&
    entry.tone !== "thinking" &&
    entry.toolLifecycleStatus !== "inProgress" &&
    entry.toolLifecycleStatus !== "stopped"
  );
}

function workLogEntryIsLocalCodeSearch(entry: WorkLogPresentationEntry): boolean {
  return (
    entry.itemType === "web_search" &&
    /\bgrep\b/i.test(normalizeCompactToolLabel(entry.toolTitle ?? entry.label))
  );
}

export function toolGroupAction(entry: WorkLogPresentationEntry): ToolGroupAction {
  if (
    entry.sourceActivityKind === "approval.requested" ||
    entry.sourceActivityKind === "approval.resolved" ||
    entry.sourceActivityKind === "provider.approval.respond.failed"
  ) {
    return "update";
  }
  const toolPresentationIcon = resolveWorkEntryToolPresentation(entry)?.icon;
  if (toolPresentationIcon === "brain") return "brain";
  if (toolPresentationIcon === "browser") return "browser";
  if (
    entry.requestKind === "file-read" ||
    entry.itemType === "image_view" ||
    entry.viewedImagePath !== undefined ||
    (entry.itemType === "dynamic_tool_call" &&
      entry.toolTitle?.trim().toLowerCase() === "read file")
  ) {
    return "read";
  }
  if (
    entry.requestKind === "file-change" ||
    entry.itemType === "file_change" ||
    (entry.changedFiles?.length ?? 0) > 0
  ) {
    return "edit";
  }
  if (entry.requestKind === "command" || entry.itemType === "command_execution" || entry.command) {
    return "command";
  }
  if (workLogEntryIsLocalCodeSearch(entry)) return "code-search";
  if (entry.itemType === "web_search") return "search";
  return workLogEntryIsToolLike(entry) ? "other" : "update";
}

export function workEntryViewedImagePath(entry: WorkLogPresentationEntry): string | null {
  const viewedImagePath = entry.viewedImagePath?.trim();
  if (
    viewedImagePath !== undefined &&
    !/[\r\n]/.test(viewedImagePath) &&
    isWorkspaceImagePreviewPath(viewedImagePath)
  ) {
    return viewedImagePath;
  }
  const detail = entry.detail?.trim();
  return toolGroupAction(entry) === "read" &&
    detail !== undefined &&
    !/[\r\n]/.test(detail) &&
    isWorkspaceImagePreviewPath(detail)
    ? detail
    : null;
}

export interface ViewedImageAsset {
  readonly resource: Extract<AssetResource, { readonly _tag: "media-file" }>;
  readonly alt: string;
  readonly srcFragment: string;
}

export function resolveViewedImageAsset(
  source: string,
  input: {
    readonly threadId: ThreadId;
    readonly workspaceRoot?: string | null | undefined;
  },
): ViewedImageAsset | null {
  // A relative path with no known workspace still names a media-file relative
  // to the thread's workspace, so classify against "." and drop the prefix.
  const imageSource = classifyMarkdownImageSource(source, input.workspaceRoot ?? ".");
  if (imageSource._tag !== "WorkspaceFile") return null;
  const resolvedFilePath =
    input.workspaceRoot == null && imageSource.path.startsWith("./")
      ? imageSource.path.slice(2)
      : imageSource.path;

  const media = resolveMediaSource(source, {
    threadId: input.threadId,
    workspaceRoot: input.workspaceRoot,
    resolvedFilePath,
  });
  if (media === null || media.access !== "environment") return null;
  return { resource: media.resource, alt: media.name, srcFragment: media.srcFragment };
}

function toolGroupActionCount(
  action: ToolGroupAction,
  entries: ReadonlyArray<WorkLogPresentationEntry>,
): number {
  if (action !== "edit") return entries.length;

  const changedFiles = new Set<string>();
  let editsWithoutFileDetails = 0;
  for (const entry of entries) {
    if (!entry.changedFiles || entry.changedFiles.length === 0) {
      editsWithoutFileDetails += 1;
      continue;
    }
    for (const file of entry.changedFiles) changedFiles.add(file);
  }
  return changedFiles.size + editsWithoutFileDetails;
}

function toolGroupActionLabel(action: ToolGroupAction, count: number): string {
  switch (action) {
    case "read":
      return `Read ${count} ${count === 1 ? "file" : "files"}`;
    case "edit":
      return `Changed ${count} ${count === 1 ? "file" : "files"}`;
    case "command":
      return `Ran ${count} ${count === 1 ? "command" : "commands"}`;
    case "brain":
      return count === 1 ? "Consulted the brain" : `Consulted the brain ${count} times`;
    case "browser":
      return `Used browser ${count} ${count === 1 ? "time" : "times"}`;
    case "search":
      return `Searched the web ${count} ${count === 1 ? "time" : "times"}`;
    case "code-search":
      return `Searched code ${count} ${count === 1 ? "time" : "times"}`;
    case "other":
      return `Used ${count} ${count === 1 ? "tool" : "tools"}`;
    case "update":
      return `Received ${count} ${count === 1 ? "update" : "updates"}`;
  }
}

export function summarizeToolGroup(entries: ReadonlyArray<WorkLogPresentationEntry>): string {
  const summaryEntries = omitSupersededLifecycleMarkers(entries, (entry) => entry);
  const sources = new Map<string, ToolActivitySource>();
  const groupedEntries = new Map<ToolGroupAction, WorkLogPresentationEntry[]>();
  for (const entry of summaryEntries) {
    const action = toolGroupAction(entry);
    if (entry.toolSource && action !== "brain") {
      sources.set(entry.toolSource.key, entry.toolSource);
      continue;
    }
    const group = groupedEntries.get(action);
    if (group) group.push(entry);
    else groupedEntries.set(action, [entry]);
  }
  const labels = [...groupedEntries].map(([action, actionEntries]) =>
    toolGroupActionLabel(action, toolGroupActionCount(action, actionEntries)),
  );
  if (sources.size > 0) {
    const sourceValues = [...sources.values()];
    const sourceNames = sourceValues.map((source) => source.name);
    const formattedNames =
      sourceNames.length < 2
        ? sourceNames[0]!
        : sourceNames.length === 2
          ? sourceNames.join(" and ")
          : `${sourceNames.slice(0, -1).join(", ")}, and ${sourceNames.at(-1)}`;
    const allIntegrations = sourceValues.every((source) => source.kind === "integration");
    labels.unshift(
      `Used ${formattedNames}${allIntegrations ? ` ${sources.size === 1 ? "integration" : "integrations"}` : ""}`,
    );
  }
  const sentenceLabels = labels.map((label, index) =>
    index === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1),
  );
  if (sentenceLabels.length < 2) return sentenceLabels[0] ?? "";
  if (sentenceLabels.length === 2) return sentenceLabels.join(" and ");
  return `${sentenceLabels.slice(0, -1).join(", ")}, and ${sentenceLabels.at(-1)}`;
}

export function omitSupersededLifecycleMarkers<T>(
  entries: readonly T[],
  workEntryFor: (entry: T) => WorkLogPresentationEntry,
): T[] {
  const laterTerminalIdentities = new Set<string>();
  const reversedEntries: T[] = [];

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    const workEntry = workEntryFor(entry);
    const normalizedLabel = normalizeCompactToolLabel(workEntry.toolTitle ?? workEntry.label);
    const identity = [
      workEntry.turnId ?? "no-turn",
      workEntry.itemType ?? "",
      normalizedLabel,
    ].join("\u001f");
    const activityKind = workEntry.sourceActivityKind;
    const isStatuslessIdlessMarker =
      workEntry.toolCallId === undefined &&
      workEntry.toolLifecycleStatus === undefined &&
      (activityKind === "tool.started" || activityKind === "tool.updated");
    if (isStatuslessIdlessMarker && laterTerminalIdentities.has(identity)) continue;

    reversedEntries.push(entry);
    if (
      activityKind === "tool.completed" ||
      (workEntry.toolLifecycleStatus !== undefined &&
        workEntry.toolLifecycleStatus !== "inProgress")
    ) {
      laterTerminalIdentities.add(identity);
    }
  }

  return reversedEntries.toReversed();
}

export function toolGroupSummaryKind(
  entries: ReadonlyArray<WorkLogPresentationEntry>,
): ToolGroupSummaryKind {
  const actions = new Set(entries.map(toolGroupAction));
  if (actions.size !== 1) return "mixed";

  const action = actions.values().next().value!;
  if (action !== "other") return action;

  const fallbackKinds = new Set(
    entries.map((entry): ToolGroupSummaryKind => {
      if (entry.itemType === "mcp_tool_call") return "other";
      if (entry.itemType === "dynamic_tool_call") return "dynamic-tool";
      if (entry.itemType === "collab_agent_tool_call" || entry.taskId) return "agent-tool";
      if (entry.tone === "thinking") return "agent-tool";
      if (entry.tone === "tool") return "tone-tool";
      return "other";
    }),
  );
  return fallbackKinds.size === 1 ? fallbackKinds.values().next().value! : "mixed";
}
