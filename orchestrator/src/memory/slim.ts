// slim.ts — reduce a Flow agent-session transcript to the durable-signal parts
// before the distiller LLM call. Adapted from
// flow-benchmarks/memory-evals/distiller/slim.mjs.
//
// Keeps: full user_prompt texts (minus the MCP orientation preamble), error
// events, FAILED tool_call titles + error heads, and the concluding agent
// message of each turn-run. Caps CAP chars, preserving the END on truncation
// (conclusions matter most).
//
// Operates on the SessionEvent[] the runtime already persists (kind/data shape),
// not raw JSONL — so it needs no file access and is trivially unit-testable.

export interface SlimEvent {
  kind: string;
  data: unknown;
}

const CAP = 20000;
const AGENT_RUN_TAIL = 1400;

function getUpdate(e: SlimEvent): Record<string, unknown> {
  const d = (e.data ?? {}) as Record<string, unknown>;
  const u = (d.update ?? d) as Record<string, unknown>;
  return u ?? {};
}

// The MCP orientation preamble is prepended to the first real user prompt.
// Strip it so we keep the user's actual ask.
export function stripPreamble(text: string): string {
  const marker = "Consult it FIRST to orient yourself";
  if (text.includes("flow-graph") && text.includes(marker)) {
    const idx = text.indexOf("\n\n");
    const lower = text.toLowerCase();
    const endMarkers = ["when you hit an unexpected failure", "before diving into files"];
    let cut = 0;
    for (const m of endMarkers) {
      const p = lower.indexOf(m);
      if (p >= 0) cut = Math.max(cut, p);
    }
    if (cut > 0) {
      const after = text.indexOf("\n", cut);
      if (after >= 0 && text.length - after > 30) {
        return "[preamble stripped] " + text.slice(after).trim();
      }
    }
    if (idx > 0 && text.length - idx > 40) {
      return "[preamble stripped] " + text.slice(idx).trim();
    }
  }
  return text;
}

type TimelineItem =
  | { t: "meta"; repo?: string; backend?: string; title?: string; branch?: string }
  | { t: "user"; text: string }
  | { t: "agent_run"; text: string }
  | { t: "tool_fail"; id?: string; err: string }
  | { t: "error"; text: string };

export function slimTranscript(events: SlimEvent[]): string {
  const timeline: TimelineItem[] = [];
  let agentBuf = "";
  const titleById: Record<string, string> = {};

  const flush = () => {
    if (agentBuf.trim()) {
      timeline.push({ t: "agent_run", text: agentBuf.trim() });
      agentBuf = "";
    }
  };

  for (const e of events) {
    if (e.kind === "created") {
      const d = (e.data ?? {}) as Record<string, string>;
      timeline.push({ t: "meta", repo: d.repo, backend: d.backend, title: d.title, branch: d.branch });
    } else if (e.kind === "user_prompt") {
      flush();
      const d = (e.data ?? {}) as Record<string, string>;
      timeline.push({ t: "user", text: stripPreamble(d.text || "") });
    } else if (e.kind === "error") {
      flush();
      timeline.push({ t: "error", text: JSON.stringify(e.data).slice(0, 600) });
    } else if (e.kind === "update") {
      const u = getUpdate(e);
      const su = u.sessionUpdate;
      if (su === "agent_message_chunk") {
        const content = u.content as { text?: string } | undefined;
        agentBuf += content?.text || "";
      } else if (su === "tool_call" && typeof u.toolCallId === "string") {
        const meta = (u._meta as { claudeCode?: { toolName?: string } } | undefined)?.claudeCode?.toolName;
        titleById[u.toolCallId] = (u.title as string) || meta || "tool";
      } else if (su === "tool_call_update" && u.status === "failed") {
        const content = (u.content as Array<{ content?: { text?: string } }> | undefined)?.[0]?.content?.text || "";
        timeline.push({ t: "tool_fail", id: u.toolCallId as string | undefined, err: content.slice(0, 400) });
      }
    }
  }
  flush();

  const parts: string[] = [];
  const meta = timeline.find((x): x is Extract<TimelineItem, { t: "meta" }> => x.t === "meta");
  if (meta) {
    parts.push(`### SESSION META\nrepo: ${meta.repo ?? ""}\nbackend: ${meta.backend ?? ""}\ntitle: ${meta.title ?? ""}\n`);
  }

  for (const ev of timeline) {
    if (ev.t === "user") {
      parts.push(`\n### USER PROMPT\n${ev.text}`);
    } else if (ev.t === "agent_run") {
      let txt = ev.text;
      if (txt.length > AGENT_RUN_TAIL) txt = "…[mid omitted]…\n" + txt.slice(txt.length - AGENT_RUN_TAIL);
      parts.push(`\n### AGENT (turn conclusion)\n${txt}`);
    } else if (ev.t === "tool_fail") {
      parts.push(`\n### TOOL FAILED: ${(ev.id && titleById[ev.id]) || "tool"}\n${ev.err}`);
    } else if (ev.t === "error") {
      parts.push(`\n### ERROR EVENT\n${ev.text}`);
    }
  }

  let out = parts.join("\n");
  if (out.length > CAP) {
    out = "…[BEGINNING TRUNCATED]…\n" + out.slice(out.length - CAP);
  }
  return out;
}
