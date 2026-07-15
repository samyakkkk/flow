// job-activity.ts — live, in-memory activity feed for indexer jobs.
//
// Each backend CLI streams JSONL while it works; the job runner feeds every
// line here and a per-backend extractor turns tool calls into terse labels
// ("read src/auth.ts", "graph_upsert svc:api"). The feed is deliberately
// ephemeral (ring buffer, cleared when the job ends): the dashboard shows it
// live while a repo indexes; the persisted transcript in job-logs/ remains
// the debugging artifact. Labels are built from tool INPUTS only — never
// prompt text, never tool outputs.

export type ActivityKind = "file" | "graph" | "bash" | "tool";

export interface ActivityEvent {
  seq: number;
  ts: number;
  kind: ActivityKind;
  label: string;
}

export interface JobActivity {
  jobId: string;
  repo: string;
  backend: string;
  status: "running" | "done" | "failed";
  startedAt: number;
  finishedAt?: number;
  counts: { toolCalls: number; filesRead: number; graphWrites: number };
  events: ActivityEvent[];
}

const MAX_EVENTS = 200;
const MAX_LABEL = 120;

const byJob = new Map<string, JobActivity>();
const latestJobByRepo = new Map<string, string>();

export function startActivity(jobId: string, repo: string, backend: string): void {
  if (!repo) return; // chat jobs have no repo and no dashboard surface
  byJob.set(jobId, {
    jobId,
    repo,
    backend,
    status: "running",
    startedAt: Date.now(),
    counts: { toolCalls: 0, filesRead: 0, graphWrites: 0 },
    events: [],
  });
  latestJobByRepo.set(repo, jobId);
  console.log(`[indexer] ${repo} · ${backend} run started (job ${jobId})`);
}

export function finishActivity(jobId: string, status: "done" | "failed"): void {
  const a = byJob.get(jobId);
  if (!a) return;
  a.status = status;
  a.finishedAt = Date.now();
  const secs = Math.round((a.finishedAt - a.startedAt) / 1000);
  console.log(
    `[indexer] ${a.repo} · ${status} after ${secs}s — ${a.counts.toolCalls} calls, ${a.counts.filesRead} files read, ${a.counts.graphWrites} graph writes`
  );
  // Live-only feed: keep the counts summary, drop the ticker.
  a.events = [];
}

export function recordActivityLine(jobId: string, backend: string, line: string): void {
  const a = byJob.get(jobId);
  if (!a) return;
  const extracted = extract(backend, line);
  if (!extracted) return;
  a.counts.toolCalls++;
  if (extracted.kind === "file") a.counts.filesRead++;
  if (extracted.kind === "graph") a.counts.graphWrites += isGraphWrite(extracted.tool) ? 1 : 0;
  const seq = (a.events[a.events.length - 1]?.seq ?? 0) + 1;
  a.events.push({ seq, ts: Date.now(), kind: extracted.kind, label: extracted.label });
  if (a.events.length > MAX_EVENTS) a.events.splice(0, a.events.length - MAX_EVENTS);
  // Mirror to the orchestrator log so `tail -f` shows the run live and a
  // killed job still leaves a trace (the transcript file lands only at exit).
  console.log(`[indexer] ${a.repo} · ${extracted.label}`);
}

export function activityForRepo(repo: string): JobActivity | null {
  const jobId = latestJobByRepo.get(repo);
  return jobId ? byJob.get(jobId) ?? null : null;
}

// ------------------------------------------------------------------
// Per-backend extractors. Every CLI emits JSONL; each extractor pulls
// (tool name, terse arg) out of its tool-call events and ignores the rest.
// All are defensive: a malformed or unrecognized line yields null.
// ------------------------------------------------------------------

interface Extracted {
  tool: string;
  kind: ActivityKind;
  label: string;
}

function extract(backend: string, line: string): Extracted | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (backend === "opencode") return extractOpencode(obj);
  if (backend === "claude") return extractClaude(obj);
  if (backend === "codex") return extractCodex(obj);
  return null;
}

// opencode --format json: {"type":"tool_use","part":{"tool":"read","state":{"status":"completed","input":{...}}}}
function extractOpencode(obj: Record<string, unknown>): Extracted | null {
  if (obj.type !== "tool_use") return null;
  const part = obj.part as { tool?: string; state?: { status?: string; input?: Record<string, unknown> } } | undefined;
  if (!part?.tool || part.state?.status !== "completed") return null;
  return build(part.tool, part.state.input ?? {});
}

// claude -p --output-format stream-json: {"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{...}}]}}
function extractClaude(obj: Record<string, unknown>): Extracted | null {
  if (obj.type !== "assistant") return null;
  const content = (obj.message as { content?: Array<Record<string, unknown>> } | undefined)?.content;
  if (!Array.isArray(content)) return null;
  const tu = content.find((c) => c.type === "tool_use");
  if (!tu || typeof tu.name !== "string") return null;
  return build(tu.name, (tu.input as Record<string, unknown>) ?? {});
}

// codex exec --json: {"type":"item.completed","item":{"type":"command_execution","command":"..."}} and
// mcp_tool_call / file_read item shapes. Written against docs — codex is not
// installed here, so verify with the first live codex run.
function extractCodex(obj: Record<string, unknown>): Extracted | null {
  if (obj.type !== "item.completed" && obj.type !== "item.started") return null;
  if (obj.type === "item.started") return null; // count each item once
  const item = obj.item as Record<string, unknown> | undefined;
  if (!item) return null;
  const itemType = String(item.type ?? item.item_type ?? "");
  if (itemType === "command_execution") return build("bash", { command: item.command });
  if (itemType === "mcp_tool_call") return build(String(item.tool ?? "mcp"), (item.arguments as Record<string, unknown>) ?? {});
  if (itemType === "file_read" || itemType === "file_change") return build("read", { filePath: item.path });
  return null;
}

// ------------------------------------------------------------------
// Label building — one terse line from a tool name + its input.
// ------------------------------------------------------------------

const FILE_TOOLS = new Set(["read", "glob", "grep", "list", "ls"]);

function isGraphTool(tool: string): boolean {
  return tool.startsWith("graph_") || tool.startsWith("mcp__flow-graph__") || tool.startsWith("flow-graph_");
}

function isGraphWrite(tool: string): boolean {
  const verb = tool.replace(/^(mcp__flow-graph__|flow-graph_|graph_)/, "");
  return ["upsert", "upsert_entity", "relate", "upsert_relation", "merge", "merge_entities"].includes(verb);
}

function build(tool: string, input: Record<string, unknown>): Extracted {
  const t = tool.toLowerCase();
  const kind: ActivityKind = isGraphTool(t)
    ? "graph"
    : FILE_TOOLS.has(t)
    ? "file"
    : t === "bash" || t === "shell"
    ? "bash"
    : "tool";
  const arg = terseArg(input);
  const name = t.replace(/^mcp__flow-graph__/, "graph_").replace(/^flow-graph_/, "graph_");
  const label = (arg ? `${name} ${arg}` : name).slice(0, MAX_LABEL);
  return { tool: t, kind, label };
}

// Pick the single most human-meaningful field from a tool input. Paths are
// shortened to their workspace-relative tail; anything else is truncated.
function terseArg(input: Record<string, unknown>): string {
  const candidate =
    input.id ?? input.filePath ?? input.path ?? input.pattern ?? input.command ?? input.query ?? input.name ?? input.type;
  if (candidate === undefined || candidate === null) return "";
  let s = String(candidate);
  const reposIdx = s.indexOf("repos/");
  if (reposIdx > 0) s = s.slice(reposIdx);
  return s.slice(0, 80);
}
