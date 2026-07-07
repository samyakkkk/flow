"use client";
// Live agent session: streaming transcript (messages, thoughts, tool calls,
// plan), steering input, stop, permission prompts — and the brain graph
// beside it, highlighting the exact nodes the agent queries as it works.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BrainGraph } from "@/components/BrainGraph";
import { Kicker, Button, StatusPill } from "@/components/ui";

// ---------------------------------------------------------------------------
// Event → transcript reduction

interface SessionEvent {
  seq: number;
  ts: number;
  kind: string;
  data: Record<string, unknown>;
}

interface ToolCallRow {
  toolCallId: string;
  title: string;
  status: string;
  isGraph: boolean;
}

type Block =
  | { type: "user"; text: string; key: string }
  | { type: "agent"; text: string; key: string }
  | { type: "thought"; text: string; key: string }
  | { type: "tools"; calls: ToolCallRow[]; key: string }
  | { type: "graph"; verb: string; nodeIds: string[]; key: string }
  | { type: "plan"; entries: Array<{ content: string; status: string }>; key: string }
  | { type: "error"; text: string; key: string };

interface PermissionReq {
  requestId: string;
  toolCall?: { title?: string; rawInput?: unknown };
  options: Array<{ optionId: string; name: string; kind: string }>;
}

// ACP session config option — the model selector (category "model") and any
// thought/reasoning-level toggles the agent advertises. Select-type only in
// the UI for now (models are select); boolean options are passed through but
// not yet rendered.
interface ConfigSelectValue {
  value: string;
  name: string;
}
interface ConfigOption {
  id: string;
  name: string;
  type?: string;
  category?: string;
  currentValue?: string | boolean;
  options?: ConfigSelectValue[];
}

// Options may arrive flat or grouped ({group, options}); flatten to leaves.
function flattenConfigValues(raw: unknown): ConfigSelectValue[] {
  if (!Array.isArray(raw)) return [];
  const out: ConfigSelectValue[] = [];
  for (const item of raw as Array<Record<string, unknown>>) {
    if (item && Array.isArray(item.options)) {
      out.push(...flattenConfigValues(item.options));
    } else if (item && typeof item.value === "string") {
      out.push({ value: item.value, name: String(item.name ?? item.value) });
    }
  }
  return out;
}

function normalizeConfigOptions(raw: unknown): ConfigOption[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Array<Record<string, unknown>>).map((o) => ({
    id: String(o.id),
    name: String(o.name ?? o.id),
    type: o.type as string | undefined,
    category: o.category as string | undefined,
    currentValue: o.currentValue as string | boolean | undefined,
    options: flattenConfigValues(o.options),
  }));
}

function contentText(c: unknown): string {
  if (!c) return "";
  if (typeof c === "string") return c;
  const obj = c as { text?: string };
  return obj.text ?? "";
}

function reduceEvents(events: SessionEvent[]): {
  blocks: Block[];
  status: string;
  stopReason?: string;
  error?: string;
  permissions: PermissionReq[];
  graphNodeIds: string[];
  modes: { currentModeId?: string; availableModes?: Array<{ id: string; name: string }> } | null;
  configOptions: ConfigOption[];
} {
  const blocks: Block[] = [];
  let status = "starting";
  let stopReason: string | undefined;
  let error: string | undefined;
  let modes: ReturnType<typeof reduceEvents>["modes"] = null;
  let configOptions: ConfigOption[] = [];
  const permissions = new Map<string, PermissionReq>();
  const graphIds: string[] = [];

  const last = () => blocks[blocks.length - 1];

  for (const ev of events) {
    const d = ev.data ?? {};
    switch (ev.kind) {
      case "user_prompt": {
        const text = String(d.text ?? "");
        // Hide the injected graph preamble — show only the human part.
        const idx = text.indexOf("\n\n");
        const shown = text.startsWith("You have access to") && idx > 0 ? text.slice(idx + 2) : text;
        blocks.push({ type: "user", text: shown, key: `u${ev.seq}` });
        break;
      }
      case "status": {
        if (typeof d.status === "string") status = d.status;
        if (typeof d.stopReason === "string") stopReason = d.stopReason;
        if (typeof d.error === "string" && d.error) {
          error = d.error;
          blocks.push({ type: "error", text: d.error, key: `e${ev.seq}` });
        }
        if (d.modes && typeof d.modes === "object") {
          const m = d.modes as { currentModeId?: string; availableModes?: Array<{ id: string; name: string }> };
          modes = m;
        }
        if (Array.isArray(d.configOptions)) {
          configOptions = normalizeConfigOptions(d.configOptions);
        }
        break;
      }
      case "permission_request": {
        permissions.set(String(d.requestId), d as unknown as PermissionReq);
        break;
      }
      case "permission_result": {
        permissions.delete(String(d.requestId));
        break;
      }
      case "graph": {
        const nodeIds = (d.nodeIds as string[]) ?? [];
        graphIds.push(...nodeIds);
        blocks.push({ type: "graph", verb: String(d.verb ?? ""), nodeIds, key: `g${ev.seq}` });
        break;
      }
      case "update": {
        const u = d as {
          sessionUpdate?: string;
          content?: unknown;
          toolCallId?: string;
          title?: string;
          status?: string;
          entries?: Array<{ content: string; status: string }>;
          currentModeId?: string;
        };
        switch (u.sessionUpdate) {
          case "agent_message_chunk": {
            const t = contentText(u.content);
            const l = last();
            if (l?.type === "agent") l.text += t;
            else blocks.push({ type: "agent", text: t, key: `a${ev.seq}` });
            break;
          }
          case "agent_thought_chunk": {
            const t = contentText(u.content);
            const l = last();
            if (l?.type === "thought") l.text += t;
            else blocks.push({ type: "thought", text: t, key: `t${ev.seq}` });
            break;
          }
          case "tool_call": {
            const call: ToolCallRow = {
              toolCallId: String(u.toolCallId ?? ev.seq),
              title: String(u.title ?? "tool"),
              status: String(u.status ?? "pending"),
              isGraph: String(u.title ?? "").includes("flow-graph"),
            };
            const l = last();
            if (l?.type === "tools") l.calls.push(call);
            else blocks.push({ type: "tools", calls: [call], key: `c${ev.seq}` });
            break;
          }
          case "tool_call_update": {
            for (const b of blocks) {
              if (b.type === "tools") {
                const c = b.calls.find((x) => x.toolCallId === String(u.toolCallId));
                if (c) {
                  if (u.status) c.status = String(u.status);
                  if (u.title) c.title = String(u.title);
                }
              }
            }
            break;
          }
          case "plan": {
            const entries = (u.entries ?? []).map((e) => ({
              content: String(e.content),
              status: String(e.status),
            }));
            // Replace previous plan block — plans arrive as full snapshots.
            const i = blocks.findIndex((b) => b.type === "plan");
            if (i >= 0) blocks[i] = { type: "plan", entries, key: blocks[i].key };
            else blocks.push({ type: "plan", entries, key: `p${ev.seq}` });
            break;
          }
          case "current_mode_update": {
            if (modes) modes.currentModeId = String(u.currentModeId ?? "");
            break;
          }
          case "config_option_update": {
            const co = (u as { configOptions?: unknown }).configOptions;
            if (Array.isArray(co)) configOptions = normalizeConfigOptions(co);
            break;
          }
          default:
            break;
        }
        break;
      }
      default:
        break;
    }
  }

  return {
    blocks,
    status,
    stopReason,
    error,
    permissions: [...permissions.values()],
    graphNodeIds: [...new Set(graphIds)].slice(-40),
    modes,
    configOptions,
  };
}

// ---------------------------------------------------------------------------

function statusPill(status: string): { kind: "live" | "ok" | "warn" | "idle"; label: string } {
  if (status === "running" || status === "starting") return { kind: "live", label: status === "starting" ? "Starting" : "Working" };
  if (status === "waiting") return { kind: "warn", label: "Needs approval" };
  if (status === "idle") return { kind: "ok", label: "Done — steerable" };
  if (status === "error") return { kind: "warn", label: "Error" };
  return { kind: "idle", label: status };
}

const AGENT_NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode" };

// Selector order in the header: model, then mode, then reasoning effort, then rest.
function configRank(category?: string): number {
  if (category === "model") return 0;
  if (category === "mode") return 1;
  if (category === "thought_level" || category === "model_config") return 2;
  return 3;
}

export function AgentSession({ id }: { id: string }) {
  const router = useRouter();
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [archived, setArchived] = useState(false);
  const [meta, setMeta] = useState<{ backend?: string; repo?: string; title?: string; cwd?: string } | null>(null);
  const [openHint, setOpenHint] = useState("");
  const [input, setInput] = useState("");
  const [sendError, setSendError] = useState("");
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  // Metadata once
  useEffect(() => {
    fetch(`/api/agents/sessions/${id}`)
      .then((r) => {
        if (r.status === 401) {
          window.location.href = `/login?from=${encodeURIComponent(`/agents/${id}`)}`;
          return null;
        }
        return r.json();
      })
      .then((d) => d && setMeta({ backend: d.backend, repo: d.repo, title: d.title, cwd: d.cwd }))
      .catch(() => {});
  }, [id]);

  // SSE stream (replay + live). Events are buffered and flushed at most every
  // ~90ms — replaying hundreds of chunk events one render at a time froze the
  // page on long sessions.
  useEffect(() => {
    const es = new EventSource(`/api/agents/sessions/${id}/events`);
    const buffer: SessionEvent[] = [];
    const flush = () => {
      if (buffer.length === 0) return;
      const batch = buffer.splice(0, buffer.length);
      setEvents((prev) => {
        const lastSeq = prev.length ? prev[prev.length - 1].seq : 0;
        const fresh = batch.filter((e) => e.seq > lastSeq);
        return fresh.length ? [...prev, ...fresh] : prev;
      });
    };
    const iv = setInterval(flush, 90);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (m) => {
      try {
        const ev = JSON.parse(m.data) as SessionEvent;
        if (ev.kind === "eof") {
          // Replay-only: the orchestrator restarted since this session ran.
          flush();
          setArchived(true);
          es.close();
          setConnected(true); // not an error — just a finished recording
          return;
        }
        buffer.push(ev);
      } catch {
        /* skip */
      }
    };
    return () => {
      clearInterval(iv);
      es.close();
    };
  }, [id]);

  const view = useMemo(() => reduceEvents(events), [events]);

  // Recent graph highlights: last 45s of graph events light up the brain.
  const [now, setNow] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(iv);
  }, []);
  const recentGraphIds = useMemo(() => {
    const cutoff = (now || Date.now()) - 45_000;
    const ids = new Set<string>();
    for (const ev of events) {
      if (ev.kind === "graph" && ev.ts >= cutoff) {
        for (const n of (ev.data.nodeIds as string[]) ?? []) ids.add(n);
      }
    }
    // Fall back to all-session highlights when nothing is recent, so the
    // panel still shows what the agent used after it finishes.
    return ids.size > 0 ? [...ids] : view.graphNodeIds;
  }, [events, now, view.graphNodeIds]);

  // Autoscroll while pinned to bottom
  useEffect(() => {
    const el = transcriptRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [events]);

  const act = useCallback(
    async (action: string, body: unknown = {}) => {
      setBusy(true);
      try {
        await fetch(`/api/agents/sessions/${id}/${action}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      } finally {
        setBusy(false);
      }
    },
    [id]
  );

  // Open the agent's repo checkout in Finder/Explorer or VS Code. Only works
  // when the orchestrator is on this machine (local mode); surfaces a hint if
  // the tool (e.g. the `code` CLI) isn't available.
  const openIn = useCallback(
    async (target: "finder" | "vscode") => {
      setOpenHint("");
      try {
        const res = await fetch(`/api/agents/sessions/${id}/open`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ target }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          setOpenHint(d.error ?? "Couldn't open — is Flow running on this machine?");
        }
      } catch {
        setOpenHint("Couldn't reach the server.");
      }
    },
    [id]
  );

  async function send() {
    const text = input.trim();
    if (!text) return;
    setInput("");
    setSendError("");
    setBusy(true);
    try {
      const res = await fetch(`/api/agents/sessions/${id}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        // A dead adapter process is retried transparently server-side (via
        // ACP session/load) before this fails — so an error here means the
        // backend genuinely can't resume, not just a hiccup.
        setSendError(d.error ?? "Couldn't send message.");
        setInput(text);
      }
    } catch {
      setSendError("Couldn't reach the server.");
      setInput(text);
    } finally {
      setBusy(false);
    }
  }

  const pill = archived ? { kind: "idle" as const, label: "Archived" } : statusPill(view.status);
  const running = !archived && (view.status === "running" || view.status === "starting");

  // Live "what's the agent doing right now" label, derived from the latest
  // activity — so you always know it's alive and whether it's thinking, running
  // a tool, consulting the graph, or writing the answer.
  const liveLabel = (() => {
    if (!running) return null;
    if (view.status === "starting") return "Starting up…";
    const activeTool = [...view.blocks]
      .reverse()
      .flatMap((b) => (b.type === "tools" ? b.calls : []))
      .find((c) => c.status !== "completed" && c.status !== "failed");
    if (activeTool) {
      const t = activeTool.title.replace(/^mcp__|^flow-graph[_-]?/i, "");
      return activeTool.isGraph ? "Consulting the brain…" : `Running ${t}…`;
    }
    const last = view.blocks[view.blocks.length - 1];
    if (last?.type === "graph") return "Consulting the brain…";
    if (last?.type === "agent") return "Writing the answer…";
    if (last?.type === "plan") return "Planning…";
    return "Thinking…";
  })();

  return (
    <div className="flex flex-col" style={{ height: "calc(100vh - 140px)" }}>
      {/* Header */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <button
          onClick={() => router.push("/agents")}
          className="text-text-muted hover:text-ink transition text-[13px]"
          aria-label="Back to agents"
        >
          ←
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-ink text-[15px] truncate" style={{ fontFamily: "var(--font-display)" }}>
            {meta?.title ?? "Session"}
          </p>
          <p style={{ fontFamily: "var(--font-mono)" }} className="text-[10px] uppercase tracking-wider text-text-muted">
            {AGENT_NAMES[meta?.backend ?? ""] ?? meta?.backend} · {meta?.repo}
            {!connected && !archived && " · reconnecting…"}
          </p>
          {/* Where the agent is working — the cloned repo folder — with quick
              openers so you can inspect the changes it's making. */}
          {meta?.cwd && (
            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
              <button
                onClick={() => openIn("finder")}
                className="inline-flex items-center gap-1 rounded-md border border-line bg-paper px-2 py-1 text-[10.5px] text-text hover:bg-cream transition"
                style={{ fontFamily: "var(--font-mono)" }}
                title={meta.cwd}
              >
                📁 Finder
              </button>
              <button
                onClick={() => openIn("vscode")}
                className="inline-flex items-center gap-1 rounded-md border border-line bg-paper px-2 py-1 text-[10.5px] text-text hover:bg-cream transition"
                style={{ fontFamily: "var(--font-mono)" }}
                title={meta.cwd}
              >
                VS Code
              </button>
              <button
                onClick={() => { navigator.clipboard?.writeText(meta.cwd ?? ""); setOpenHint("Path copied"); }}
                className="text-[10px] text-text-muted hover:text-ink transition truncate max-w-[280px]"
                style={{ fontFamily: "var(--font-mono)" }}
                title={`Copy path — ${meta.cwd}`}
              >
                {meta.cwd.replace(/^.*\/repos\//, "…/repos/")}
              </button>
              {openHint && <span className="text-[10px]" style={{ color: openHint.includes("copied") ? "var(--ok)" : "var(--danger)" }}>{openHint}</span>}
            </div>
          )}
        </div>
        {/* Model + other config selectors (model first) — the agent advertises
            these on session create; changing one calls setSessionConfigOption. */}
        {/* Config-driven selectors (model, mode, effort) — the modern unified
            mechanism. Model first, then mode, then reasoning effort. */}
        {[...view.configOptions]
          .filter((o) => o.type !== "boolean" && (o.options?.length ?? 0) > 0)
          .sort((a, b) => configRank(a.category) - configRank(b.category))
          .map((o) => (
            <select
              key={o.id}
              value={typeof o.currentValue === "string" ? o.currentValue : ""}
              onChange={(e) => act("config", { configId: o.id, value: e.target.value })}
              disabled={archived || busy}
              className="rounded-lg border border-line bg-paper px-2.5 py-1.5 text-[11px] text-ink disabled:opacity-50"
              style={{ fontFamily: "var(--font-mono)" }}
              title={o.name}
            >
              {o.options!.map((v) => (
                <option key={v.value} value={v.value}>
                  {o.category === "model" ? v.name : `${o.name}: ${v.name}`}
                </option>
              ))}
            </select>
          ))}
        {/* Fallback: agents that expose modes but not configOptions. */}
        {view.configOptions.length === 0 && view.modes?.availableModes && view.modes.availableModes.length > 0 && (
          <select
            value={view.modes.currentModeId ?? ""}
            onChange={(e) => act("mode", { modeId: e.target.value })}
            disabled={archived}
            className="rounded-lg border border-line bg-paper px-2.5 py-1.5 text-[11px] text-ink disabled:opacity-50"
            style={{ fontFamily: "var(--font-mono)" }}
            title="Agent mode"
          >
            {view.modes.availableModes.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        )}
        <StatusPill kind={pill.kind}>{pill.label}</StatusPill>
        {running && (
          <Button variant="secondary" onClick={() => act("cancel")} disabled={busy}>
            Stop
          </Button>
        )}
      </div>

      <div className="flex gap-4 flex-1 min-h-0">
        {/* Transcript */}
        <div className="flex-1 min-w-0 flex flex-col rounded-lg border border-line bg-paper overflow-hidden">
          <div
            ref={transcriptRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
            }}
            className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-3"
          >
            {view.blocks.length === 0 && (
              <p className="text-text-muted text-[13px]">Waking the agent…</p>
            )}
            {view.blocks.map((b) => {
              switch (b.type) {
                case "user":
                  return (
                    <div key={b.key} className="self-end max-w-[85%] rounded-lg px-3.5 py-2.5" style={{ background: "var(--accent)" }}>
                      <p className="text-ink text-[13.5px] whitespace-pre-wrap break-words">{b.text}</p>
                    </div>
                  );
                case "agent":
                  return (
                    <div key={b.key} className="max-w-[92%]">
                      <p className="text-ink text-[13.5px] whitespace-pre-wrap break-words leading-relaxed">{b.text}</p>
                    </div>
                  );
                case "thought":
                  return (
                    <details key={b.key} className="max-w-[92%]">
                      <summary
                        style={{ fontFamily: "var(--font-mono)" }}
                        className="text-[10px] uppercase tracking-wider text-text-muted cursor-pointer select-none"
                      >
                        Thinking…
                      </summary>
                      <p className="text-text-muted text-[12px] italic whitespace-pre-wrap break-words mt-1">{b.text}</p>
                    </details>
                  );
                case "tools":
                  return (
                    <div key={b.key} className="flex flex-col gap-1 max-w-[92%]">
                      {b.calls.map((c) => (
                        <div
                          key={c.toolCallId}
                          className="flex items-center gap-2 rounded-md border border-line px-2.5 py-1.5"
                          style={{ background: c.isGraph ? "rgba(255,247,129,0.25)" : "var(--cream)" }}
                        >
                          <span
                            className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
                            style={{
                              background:
                                c.status === "completed"
                                  ? "var(--ok)"
                                  : c.status === "failed"
                                  ? "#b3261e"
                                  : "var(--warn)",
                            }}
                          />
                          <span style={{ fontFamily: "var(--font-mono)" }} className="text-[11px] text-text truncate">
                            {c.isGraph ? "🧠 " : ""}
                            {c.title}
                          </span>
                        </div>
                      ))}
                    </div>
                  );
                case "graph":
                  return (
                    <div key={b.key} className="max-w-[92%]">
                      <p style={{ fontFamily: "var(--font-mono)" }} className="text-[10.5px] uppercase tracking-wider" >
                        <span className="text-ink px-1.5 py-0.5 rounded" style={{ background: "var(--accent)" }}>
                          consulted the brain
                        </span>{" "}
                        <span className="text-text-muted">
                          {b.verb}
                          {b.nodeIds.length > 0 ? ` → ${b.nodeIds.slice(0, 3).join(", ")}${b.nodeIds.length > 3 ? ` +${b.nodeIds.length - 3}` : ""}` : ""}
                        </span>
                      </p>
                    </div>
                  );
                case "plan":
                  return (
                    <div key={b.key} className="max-w-[92%] rounded-md border border-line bg-cream px-3 py-2">
                      <p style={{ fontFamily: "var(--font-mono)" }} className="text-[10px] uppercase tracking-wider text-text-muted mb-1">
                        Plan
                      </p>
                      {b.entries.map((e, i) => (
                        <p key={i} className="text-[12.5px] text-text flex items-center gap-2">
                          <span>{e.status === "completed" ? "✓" : e.status === "in_progress" ? "→" : "·"}</span>
                          <span className={e.status === "completed" ? "line-through opacity-60" : ""}>{e.content}</span>
                        </p>
                      ))}
                    </div>
                  );
                case "error":
                  return (
                    <p key={b.key} className="text-[12.5px]" style={{ color: "#b3261e" }}>
                      {b.text}
                    </p>
                  );
                default:
                  return null;
              }
            })}

            {/* Permission prompts */}
            {view.permissions.map((p) => (
              <div key={p.requestId} className="rounded-lg border px-4 py-3" style={{ borderColor: "var(--warn)", background: "rgba(184,134,60,0.06)" }}>
                <p style={{ fontFamily: "var(--font-mono)" }} className="text-[10px] uppercase tracking-wider mb-1" >
                  <span style={{ color: "var(--warn)" }}>Agent asks permission</span>
                </p>
                <p className="text-ink text-[13px] mb-2.5">{p.toolCall?.title ?? "Run a tool"}</p>
                <div className="flex gap-2 flex-wrap">
                  {p.options.map((o) => (
                    <button
                      key={o.optionId}
                      onClick={() => act("permission", { requestId: p.requestId, optionId: o.optionId })}
                      className="rounded-full border border-line bg-paper px-3.5 py-1.5 text-[11.5px] hover:bg-cream transition"
                      style={{ fontFamily: "var(--font-mono)" }}
                    >
                      {o.name}
                    </button>
                  ))}
                </div>
              </div>
            ))}

            {/* Live activity — you always know when the agent is working, and
                what it's doing right now. Shown while running and not blocked
                on a permission prompt. */}
            {liveLabel && view.permissions.length === 0 && (
              <div className="flex items-center gap-2.5 py-1" aria-live="polite">
                <span className="flex gap-1" aria-hidden>
                  <span className="w-1.5 h-1.5 rounded-full bg-[color:var(--warn)] animate-pulse" style={{ animationDelay: "0ms" }} />
                  <span className="w-1.5 h-1.5 rounded-full bg-[color:var(--warn)] animate-pulse" style={{ animationDelay: "150ms" }} />
                  <span className="w-1.5 h-1.5 rounded-full bg-[color:var(--warn)] animate-pulse" style={{ animationDelay: "300ms" }} />
                </span>
                <span style={{ fontFamily: "var(--font-mono)" }} className="text-[11px] uppercase tracking-wider text-text-muted">
                  {liveLabel}
                </span>
              </div>
            )}
          </div>

          {/* Steer bar */}
          {sendError && (
            <p className="px-4 pt-2 text-[11px]" style={{ color: "var(--danger)" }}>
              {sendError}
            </p>
          )}
          <div className="border-t border-line px-4 py-3 flex gap-2 items-end" style={{ background: "var(--cream)" }}>
            <textarea
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                if (sendError) setSendError("");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={
                archived
                  ? "This session ended before the last restart — start a new one to continue."
                  : running
                  ? "Steer the agent — this interrupts and redirects it…"
                  : "Send a follow-up…"
              }
              rows={1}
              disabled={archived}
              className="flex-1 rounded-lg border border-line bg-paper px-3 py-2 text-[13.5px] text-ink placeholder:text-text-muted/60 focus:outline-none resize-none disabled:opacity-50"
            />
            <Button onClick={send} disabled={archived || !input.trim() || busy}>
              {running ? "Steer" : "Send"}
            </Button>
          </div>
        </div>

        {/* Brain panel — nodes light up as the agent queries them */}
        <div className="w-[380px] flex-shrink-0 hidden lg:flex flex-col gap-2">
          <BrainGraph
            citedNodeIds={recentGraphIds}
            height={420}
            mode="overview"
            pollInterval={0}
          />
          <p style={{ fontFamily: "var(--font-mono)" }} className="text-[10px] uppercase tracking-wider text-text-muted px-1">
            {recentGraphIds.length > 0
              ? `${recentGraphIds.length} nodes consulted by this session`
              : "The brain lights up when the agent consults it"}
          </p>
        </div>
      </div>
    </div>
  );
}
