// adapters.ts — normalize harness hook dialects into the SessionEvent shapes
// the distiller already consumes (created / user_prompt / agent_message_chunk).
//
// Version-tolerant BY POLICY: transcript/hook formats are unstable by vendor
// statement (Claude Code, Codex) and by observed churn (Cursor, opencode), so
// unknown event names and missing fields degrade to an activity timestamp —
// never an error. A harness update must not break capture.

export type NormalizedEvent = {
  kind: "created" | "user_prompt" | "update" | "error";
  data: unknown;
};

export interface NormalizedHook {
  externalId: string | null; // the harness's own session/conversation id
  cwd: string | null;
  eventName: string; // raw hook event name (feeds the dedupe key)
  events: NormalizedEvent[];
  closed: boolean; // end-of-session signal → distill now, not on idle sweep
  title: string | null; // first-prompt head, used once at row creation
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

// Text fields ride into JSONL transcripts and LLM prompts — cap so a pasted
// megabyte of tool output can't bloat either. Conclusions matter most, so
// truncation keeps the END of the text.
const TEXT_CAP = 16000;
function cap(text: string): string {
  return text.length > TEXT_CAP ? "…[truncated]…" + text.slice(text.length - TEXT_CAP) : text;
}

function userPrompt(text: string): NormalizedEvent {
  return { kind: "user_prompt", data: { text: cap(text) } };
}

function agentChunk(text: string): NormalizedEvent {
  return {
    kind: "update",
    data: { sessionUpdate: "agent_message_chunk", content: { text: cap(text) } },
  };
}

function created(harness: string, repo: string | null, title: string | null): NormalizedEvent {
  return {
    kind: "created",
    data: { repo: repo ?? "", backend: `ext:${harness}`, title: title ?? "" },
  };
}

// Session id and cwd live under different names per harness; probe all of them
// so one adapter survives dialect drift between tools.
function extractId(p: Record<string, unknown>): string | null {
  return (
    str(p.session_id) ??
    str(p.sessionId) ??
    str(p.conversation_id) ??
    str(p.conversationId) ??
    str(p["thread-id"]) ??
    null
  );
}

function extractCwd(p: Record<string, unknown>): string | null {
  const roots = p.workspace_roots ?? p.workspacePaths;
  if (Array.isArray(roots) && typeof roots[0] === "string") return roots[0];
  return str(p.cwd) ?? null;
}

function extractPrompt(p: Record<string, unknown>): string | null {
  return str(p.prompt) ?? null;
}

function extractAssistant(p: Record<string, unknown>): string | null {
  return (
    str(p.last_assistant_message) ??
    str(p["last-assistant-message"]) ??
    str(p.prompt_response) ??
    str(p.response) ??
    str(p.text) ??
    null
  );
}

const START_EVENTS = new Set(["SessionStart", "sessionStart"]);
const END_EVENTS = new Set(["SessionEnd", "sessionEnd"]);
// Turn-conclusion events that carry the assistant's final message.
const STOP_EVENTS = new Set(["Stop", "stop", "afterAgentResponse", "AfterAgent"]);

export function normalizeHook(
  harness: string,
  payload: Record<string, unknown>,
  repo: string | null
): NormalizedHook {
  const eventName = str(payload.hook_event_name) ?? str(payload.hookEventName) ?? "unknown";
  const externalId = extractId(payload);
  const cwd = extractCwd(payload);
  const events: NormalizedEvent[] = [];
  let closed = false;
  let title: string | null = null;

  if (START_EVENTS.has(eventName)) {
    events.push(created(harness, repo, cwd));
  } else if (END_EVENTS.has(eventName)) {
    closed = true;
  } else if (eventName === "UserPromptSubmit" || eventName === "beforeSubmitPrompt") {
    const prompt = extractPrompt(payload);
    if (prompt) {
      events.push(userPrompt(prompt));
      title = prompt.slice(0, 80);
    }
  } else if (STOP_EVENTS.has(eventName)) {
    // Gemini's AfterAgent carries BOTH the prompt and the response — emit the
    // pair so the transcript reads as a full turn without a separate
    // UserPromptSubmit event (Gemini has none).
    const prompt = extractPrompt(payload);
    const answer = extractAssistant(payload);
    if (prompt && eventName === "AfterAgent") {
      events.push(userPrompt(prompt));
      title = prompt.slice(0, 80);
    }
    if (answer) events.push(agentChunk(answer));
    // Antigravity has no SessionEnd hook — its Stop is the strongest
    // end-of-turn signal it offers; the idle sweep handles final distill.
  } else {
    // Unknown/uninteresting event (PreToolUse, Notification, …): capture
    // nothing, but the caller still bumps updated_at so the idle sweep sees
    // life. Failed tool calls are worth keeping when a harness marks them.
    const status = str(payload.status);
    const err = str(payload.error) ?? (status === "failed" ? JSON.stringify(payload).slice(0, 400) : null);
    if (err && (eventName === "PostToolUse" || eventName === "postToolUse")) {
      events.push({ kind: "error", data: { text: cap(err), source: eventName } });
    }
  }

  return { externalId, cwd, eventName, events, closed, title };
}

// opencode's plugin doesn't get lifecycle hooks with payloads — it POSTs the
// full message list on session.idle. Map SDK messages (role + parts[]) to the
// same event shapes; the routes layer dedupes by message id.
export interface OpencodeMessage {
  id?: string;
  role?: string;
  parts?: Array<{ type?: string; text?: string }>;
  [k: string]: unknown;
}

export function normalizeOpencodeMessage(msg: OpencodeMessage): NormalizedEvent | null {
  const text = (msg.parts ?? [])
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("")
    .trim();
  if (!text) return null;
  if (msg.role === "user") return userPrompt(text);
  if (msg.role === "assistant") return agentChunk(text);
  return null;
}
