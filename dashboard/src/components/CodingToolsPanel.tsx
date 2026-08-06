"use client";

// CodingToolsPanel — answers three questions, in the order a user asks them:
//   1. "Is my coding activity feeding this brain?"  → repo chips with a
//      liveness dot + when the last session landed. Names only; detail on click.
//   2. "Which of my tools are covered?"             → ONE machine-level icon
//      row (detected = ink, absent = faded). Tools are a machine fact — they
//      are not repeated per folder; per-folder deviations live in the detail.
//   3. "How do I add the next repo?"                → one button + the CLI
//      one-liner. Cloud surfaces are a quiet chip row, not four paragraphs.

import { useCallback, useEffect, useState } from "react";
import { useProject } from "@/lib/useProject";
import { FolderPickerDialog } from "./FolderPickerDialog";
import { BrandIcon, type BrandName } from "./BrandIcon";

interface ConnectedRepo {
  path: string;
  repo: string;
  harnesses: string[];
  version: number;
  share: boolean;
  at: string;
  stale: boolean;
  lastSessionAt: number | null;
}

interface IntegrationsData {
  project: string;
  repos: ConnectedRepo[];
  detected: string[];
  all: string[];
  version: number;
}

const TOOLS: Array<{ id: string; label: string; icon: BrandName }> = [
  { id: "claude", label: "Claude Code", icon: "anthropic" },
  { id: "codex", label: "Codex", icon: "openai" },
  { id: "cursor", label: "Cursor", icon: "cursor" },
  { id: "gemini", label: "Gemini CLI", icon: "gemini" },
  { id: "opencode", label: "opencode", icon: "opencode" },
  { id: "antigravity", label: "Antigravity", icon: "antigravity" },
];
const toolMeta = (id: string) => TOOLS.find((t) => t.id === id);

function ago(ts: number | null): string {
  if (!ts) return "no sessions yet";
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function CodingToolsPanel() {
  const { prefix } = useProject();
  const [data, setData] = useState<IntegrationsData | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [openRepo, setOpenRepo] = useState<string | null>(null);

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
    const t = setInterval(() => void load(), 15000);
    return () => clearInterval(t);
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
      const json = (await res.json()) as { ok?: boolean; repoDir?: string; error?: string };
      if (res.ok && json.ok) {
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
      setOpenRepo(null);
      void load();
    } catch {
      setMsg("Network error removing.");
    }
    setBusy(false);
  };

  const cliCommand = `flow setup ${data?.project ?? "<project>"}`;
  const detected = new Set(data?.detected ?? []);

  return (
    <div className="flex flex-col gap-4 p-5 rounded-2xl border border-line bg-paper shadow-xs rise-in">
      {/* Header */}
      <div className="flex items-end justify-between border-b border-line pb-3 gap-3 flex-wrap">
        <div>
          <div className="text-[11px] uppercase tracking-widest text-ink/50">Coding tools</div>
          <h2 className="text-[20px] mt-0.5" style={{ fontFamily: "var(--font-display)" }}>
            Sessions in connected repos feed the brain
          </h2>
        </div>
        <button
          onClick={() => setPickerOpen(true)}
          className="px-3 py-1.5 rounded-lg border border-ink/20 bg-cream text-sm hover:border-ink/40 transition-all shrink-0"
          disabled={busy}
        >
          + Connect repo
        </button>
      </div>

      {msg && (
        <div className="p-2.5 rounded-lg bg-sand border border-line text-xs font-mono text-ink flex items-center justify-between">
          <span>{msg}</span>
          <button onClick={() => setMsg("")}>✕</button>
        </div>
      )}

      {/* Machine-level tool coverage: one row of marks */}
      <div className="flex items-center gap-5 flex-wrap">
        {TOOLS.map((t) => {
          const on = detected.has(t.id);
          return (
            <div
              key={t.id}
              title={`${t.label} — ${on ? "detected; captured in connected repos" : "not installed on this machine"}`}
              className={`flex flex-col items-center gap-1 w-14 ${on ? "text-ink" : "text-ink/25"}`}
            >
              <BrandIcon name={t.icon} size={22} />
              <span className="text-[9px] uppercase tracking-wide text-center leading-tight">{t.label}</span>
            </div>
          );
        })}
        <div className="text-[11px] text-ink/40 ml-auto self-center">
          {detected.size}/{TOOLS.length} detected on this machine
        </div>
      </div>

      {/* Connected repos: names + liveness, scrollable */}
      {data && data.repos.length > 0 ? (
        <div className="max-h-56 overflow-y-auto rounded-xl border border-line divide-y divide-line bg-cream/50">
          {data.repos.map((r) => {
            const name = r.path.split("/").filter(Boolean).pop() ?? r.path;
            const live = r.lastSessionAt != null;
            const isOpen = openRepo === r.path;
            const deviates = r.harnesses.length !== detected.size;
            return (
              <div key={r.path}>
                <button
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-cream transition-colors"
                  onClick={() => setOpenRepo(isOpen ? null : r.path)}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${live ? "bg-green-600" : "bg-ink/20"}`}
                  />
                  <span className="font-mono text-[13px] truncate">{name}</span>
                  {r.stale && <span className="text-[9px] px-1 rounded bg-sand border border-line text-ink/50">update</span>}
                  {deviates && (
                    <span className="flex items-center gap-1 text-ink/40">
                      {r.harnesses.slice(0, 6).map((h) => {
                        const m = toolMeta(h);
                        return m ? <BrandIcon key={h} name={m.icon} size={11} /> : null;
                      })}
                    </span>
                  )}
                  <span className="ml-auto text-[11px] text-ink/45 shrink-0">{ago(r.lastSessionAt)}</span>
                </button>
                {isOpen && (
                  <div className="px-3 pb-2.5 pt-0.5 flex items-center justify-between gap-3 flex-wrap bg-cream">
                    <div className="min-w-0">
                      <div className="font-mono text-[11px] text-ink/50 truncate">{r.path}</div>
                      <div className="flex items-center gap-2 mt-1.5 text-ink/70">
                        {r.harnesses.map((h) => {
                          const m = toolMeta(h);
                          return m ? (
                            <span key={h} title={m.label}>
                              <BrandIcon name={m.icon} size={14} />
                            </span>
                          ) : null;
                        })}
                        <span className="text-[10px] text-ink/40">{r.share ? "shared with team" : "personal"}</span>
                      </div>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      {r.stale && (
                        <button
                          className="text-[11px] px-2 py-1 rounded border border-ink/20 hover:border-ink/40"
                          onClick={() => openConfirm(r.path)}
                          disabled={busy}
                        >
                          Update
                        </button>
                      )}
                      <button
                        className="text-[11px] px-2 py-1 rounded border border-ink/10 text-ink/50 hover:text-ink hover:border-ink/30"
                        onClick={() => void remove(r.path)}
                        disabled={busy}
                      >
                        Disconnect
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="text-sm text-ink/50 py-2">
          No repos connected yet — sessions there aren&apos;t reaching the brain. Connect one, or run{" "}
          <code className="px-1 py-0.5 rounded bg-cream border border-line font-mono text-[12px]">{cliCommand}</code>{" "}
          inside it.
        </div>
      )}

      {/* Footer: the habit + cloud surfaces, one quiet line each */}
      <div className="flex items-center justify-between gap-3 flex-wrap pt-1 border-t border-line">
        <button
          className="flex items-center gap-2 text-[12px] font-mono text-ink/60 hover:text-ink group"
          title="Copy — run in any repo you work on"
          onClick={() => {
            void navigator.clipboard?.writeText(cliCommand);
            setMsg("Copied — run it inside any repo you work on.");
          }}
        >
          <span className="text-ink/35">$</span> {cliCommand}
          <span className="text-[10px] text-ink/35 group-hover:text-ink/60">⧉</span>
        </button>
        <div className="flex items-center gap-2">
          <span
            className="flex items-center gap-1.5 text-[10px] px-2 py-1 rounded-full border border-line text-ink/45 bg-sand/60"
            title="claude.ai & Cowork connect via a remote connector once your deployment has a public URL"
          >
            <BrandIcon name="anthropic" size={10} /> claude.ai · needs public URL
          </span>
          <span
            className="flex items-center gap-1.5 text-[10px] px-2 py-1 rounded-full border border-line text-ink/45 bg-sand/60"
            title="ChatGPT web connects via Developer-mode connector once public; the desktop app's Codex view is covered by Codex today"
          >
            <BrandIcon name="openai" size={10} /> ChatGPT · needs public URL
          </span>
        </div>
      </div>

      {pickerOpen && <FolderPickerDialog onSelect={openConfirm} onClose={() => setPickerOpen(false)} />}

      {/* Confirm: which tools for this repo (detected pre-checked) */}
      {pendingPath && (
        <div
          className="fixed inset-0 z-[1000] flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.45)" }}
          onClick={() => setPendingPath(null)}
        >
          <div
            className="bg-paper border border-line rounded-xl w-[440px] max-w-[92vw] p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm font-medium">Connect to {data?.project}</div>
            <div className="font-mono text-[11px] text-ink/50 break-all mt-0.5 mb-3">{pendingPath}</div>
            <div className="grid grid-cols-2 gap-1.5 mb-4">
              {TOOLS.map((t) => {
                const isDetected = detected.has(t.id);
                const checked = chosen.has(t.id);
                return (
                  <label
                    key={t.id}
                    className={`flex items-center gap-2 text-sm p-2 rounded-lg border cursor-pointer ${
                      checked ? "border-ink/30 bg-cream" : "border-line bg-paper"
                    } ${isDetected ? "" : "opacity-45"}`}
                    title={isDetected ? t.label : `${t.label} — not detected on this machine`}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={checked}
                      onChange={(e) => {
                        const next = new Set(chosen);
                        if (e.target.checked) next.add(t.id);
                        else next.delete(t.id);
                        setChosen(next);
                      }}
                    />
                    <BrandIcon name={t.icon} size={16} />
                    <span className="text-[12px]">{t.label}</span>
                    {checked && <span className="ml-auto text-[11px]">✓</span>}
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
                {busy ? "Connecting…" : `Connect ${chosen.size} tool${chosen.size === 1 ? "" : "s"}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
