"use client";

// CodingToolsPanel — home-page section: connect local repos to this project
// (dashboard-run `flow setup`), see what's connected, and what each cloud/
// desktop surface needs. The terminal path (`flow setup <project>`) is shown
// prominently — it's the canonical habit; this panel is the clickable twin.

import { useCallback, useEffect, useState } from "react";
import { useProject } from "@/lib/useProject";
import { FolderPickerDialog } from "./FolderPickerDialog";

interface ConnectedRepo {
  path: string;
  repo: string;
  harnesses: string[];
  version: number;
  share: boolean;
  at: string;
  stale: boolean;
}

interface IntegrationsData {
  project: string;
  repos: ConnectedRepo[];
  detected: string[];
  all: string[];
  version: number;
}

const TOOL_LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "opencode",
  gemini: "Gemini CLI",
  cursor: "Cursor",
  antigravity: "Antigravity",
};

const CLOUD_SURFACES = [
  {
    name: "claude.ai / Cowork",
    state: "Needs a public deployment URL",
    detail: "Then: Settings → Connectors → paste your Flow MCP URL (works on every plan, incl. Free) + upload the flow skill ZIP. Auto-appears in Claude Code too.",
  },
  {
    name: "ChatGPT (web + desktop chat)",
    state: "Needs a public deployment URL",
    detail: "Then: enable Developer mode (Plus+) → add custom connector with your Flow MCP URL. No marketplace listing needed.",
  },
  {
    name: "ChatGPT desktop — Codex view",
    state: "Works now",
    detail: "Uses the same ~/.codex hooks + MCP as Codex CLI — connecting a repo here covers it.",
  },
  {
    name: "VS Code Copilot / Copilot CLI",
    state: "Works via Claude Code files",
    detail: "Reads .claude/settings.json hooks and shared skills — connecting a repo with Claude Code selected covers it.",
  },
];

export function CodingToolsPanel() {
  const { prefix } = useProject();
  const [data, setData] = useState<IntegrationsData | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const res = await fetch(prefix("/api/integrations"));
      if (res.ok) setData((await res.json()) as IntegrationsData);
    } catch {
      /* orchestrator down — section stays minimal */
    }
  }, [prefix]);

  useEffect(() => {
    void load();
  }, [load]);

  const openConfirm = (path: string) => {
    setPendingPath(path);
    setChosen(new Set(data?.detected ?? []));
    setPickerOpen(false);
  };

  const connect = async () => {
    if (!pendingPath) return;
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch(prefix("/api/integrations"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: pendingPath, harnesses: [...chosen] }),
      });
      const json = (await res.json()) as { ok?: boolean; repoDir?: string; error?: string; harnesses?: string[] };
      if (res.ok && json.ok) {
        setMsg(`Connected ${json.repoDir} — ${json.harnesses?.map((h) => TOOL_LABELS[h] ?? h).join(", ")}`);
        setPendingPath(null);
        void load();
      } else {
        setMsg(json.error ?? "Setup failed.");
      }
    } catch {
      setMsg("Network error running setup.");
    }
    setBusy(false);
  };

  const remove = async (path: string) => {
    setBusy(true);
    try {
      await fetch(prefix("/api/integrations"), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      setMsg(`Removed Flow integrations from ${path}`);
      void load();
    } catch {
      setMsg("Network error removing.");
    }
    setBusy(false);
  };

  const cliCommand = `flow setup ${data?.project ?? "<project>"}`;

  return (
    <div className="flex flex-col gap-4 p-5 rounded-2xl border border-line bg-paper shadow-xs rise-in">
      <div className="flex items-end justify-between border-b border-line pb-3">
        <div>
          <div className="text-[11px] uppercase tracking-widest text-ink/50">Your coding tools</div>
          <h2 className="text-[20px] mt-0.5" style={{ fontFamily: "var(--font-display)" }}>
            Every session in a connected repo feeds the brain
          </h2>
        </div>
        <button
          onClick={() => setPickerOpen(true)}
          className="px-3 py-1.5 rounded-lg border border-ink/20 bg-cream text-sm hover:border-ink/40 transition-all"
          disabled={busy}
        >
          + Connect a repo
        </button>
      </div>

      {msg && (
        <div className="p-2.5 rounded-lg bg-sand border border-line text-xs font-mono text-ink flex items-center justify-between">
          <span>{msg}</span>
          <button onClick={() => setMsg("")}>✕</button>
        </div>
      )}

      {/* The canonical habit, front and center */}
      <div className="p-3 rounded-lg bg-sand/60 border border-line text-sm flex items-center justify-between flex-wrap gap-2">
        <span>
          Starting work in a new repo? Run{" "}
          <code className="px-1.5 py-0.5 rounded bg-cream border border-line font-mono text-[12px]">{cliCommand}</code>{" "}
          in it — or pick the folder here. Both do the same thing.
        </span>
        <button
          className="text-xs underline text-ink/60 hover:text-ink"
          onClick={() => {
            void navigator.clipboard?.writeText(cliCommand);
            setMsg("Command copied.");
          }}
        >
          copy
        </button>
      </div>

      {/* Connected repos */}
      {data && data.repos.length > 0 && (
        <div className="flex flex-col gap-2">
          {data.repos.map((r) => (
            <div
              key={r.path}
              className="flex items-center justify-between gap-3 p-3 rounded-xl border border-line bg-cream flex-wrap"
            >
              <div className="min-w-0">
                <div className="font-mono text-[13px] truncate">{r.path}</div>
                <div className="text-xs text-ink/60 mt-0.5">
                  {r.harnesses.map((h) => TOOL_LABELS[h] ?? h).join(" · ")}
                  {r.share ? " · shared with team" : " · personal"}
                  {r.stale ? " · needs refresh" : ""}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {r.stale && (
                  <button
                    className="text-xs px-2 py-1 rounded border border-ink/20 hover:border-ink/40"
                    onClick={() => openConfirm(r.path)}
                    disabled={busy}
                  >
                    Refresh
                  </button>
                )}
                <button
                  className="text-xs px-2 py-1 rounded border border-ink/10 text-ink/50 hover:text-ink hover:border-ink/30"
                  onClick={() => void remove(r.path)}
                  disabled={busy}
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {data && data.repos.length === 0 && (
        <div className="text-sm text-ink/50 italic">
          No repos connected on this machine yet — sessions there aren&apos;t reaching the brain.
        </div>
      )}

      {/* Cloud & desktop apps */}
      <div className="mt-1">
        <div className="text-[11px] uppercase tracking-widest text-ink/50 mb-2">Cloud &amp; desktop apps</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {CLOUD_SURFACES.map((s) => (
            <div key={s.name} className="p-3 rounded-xl border border-line bg-cream">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{s.name}</span>
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded-full border ${
                    s.state === "Works now" || s.state.startsWith("Works")
                      ? "border-green-700/30 text-green-800 bg-green-50"
                      : "border-line text-ink/50 bg-sand"
                  }`}
                >
                  {s.state}
                </span>
              </div>
              <div className="text-xs text-ink/60 mt-1">{s.detail}</div>
            </div>
          ))}
        </div>
      </div>

      {pickerOpen && <FolderPickerDialog onSelect={openConfirm} onClose={() => setPickerOpen(false)} />}

      {/* Confirm modal: which tools */}
      {pendingPath && (
        <div
          className="fixed inset-0 z-[1000] flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.45)" }}
          onClick={() => setPendingPath(null)}
        >
          <div
            className="bg-paper border border-line rounded-xl w-[480px] max-w-[92vw] p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm font-medium mb-1">Connect to project {data?.project}</div>
            <div className="font-mono text-xs text-ink/60 break-all mb-3">{pendingPath}</div>
            <div className="flex flex-col gap-1.5 mb-4">
              {(data?.all ?? []).map((h) => {
                const detected = data?.detected.includes(h);
                return (
                  <label key={h} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={chosen.has(h)}
                      onChange={(e) => {
                        const next = new Set(chosen);
                        if (e.target.checked) next.add(h);
                        else next.delete(h);
                        setChosen(next);
                      }}
                    />
                    <span>{TOOL_LABELS[h] ?? h}</span>
                    {!detected && <span className="text-[10px] text-ink/40">(not detected on this machine)</span>}
                  </label>
                );
              })}
            </div>
            <div className="flex justify-end gap-2">
              <button className="text-sm px-3 py-1.5 rounded border border-line" onClick={() => setPendingPath(null)}>
                Cancel
              </button>
              <button
                className="text-sm px-3 py-1.5 rounded bg-ink text-paper disabled:opacity-50"
                onClick={() => void connect()}
                disabled={busy || chosen.size === 0}
              >
                {busy ? "Connecting…" : "Connect"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
