"use client";

// "Use Flow in your own AI tools" — the column beside the agent trigger. The
// home page offers two ways to work: start agents HERE (left), or keep using
// your own tools WITH Flow (this panel). Value-first framing: the user's
// tools are listed up top so they can see "yes, mine are covered"; connecting
// a workspace is the action that makes those tools Flow-powered (installs
// hooks + MCP + skills; sessions then teach the brain). Two equivalent ways
// in, as an explicit either/or: native folder chooser, or `flow setup
// <project>` in a terminal. ChatGPT chats and claude.ai/Cowork can't work
// locally — two quiet "later" cards, not silence.

import { useCallback, useEffect, useState } from "react";
import { useProject } from "@/lib/useProject";
import { FolderPickerDialog } from "./FolderPickerDialog";
import { BrandIcon, type BrandName } from "./BrandIcon";
import { BodyText, Heading } from "./ui";

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
  mode?: "prod" | "local";
  workspaces?: { id: string; repo: string; machine: string; harnesses: string[]; configuredAt: string }[];
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
  { id: "copilot", label: "VS Code Copilot", icon: "github" },
];
const toolMeta = (id: string) => TOOLS.find((t) => t.id === id);

function ago(ts: number | null): string {
  if (!ts) return "quiet";
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
  const [remoteSetupOpen, setRemoteSetupOpen] = useState(false);
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

  // Native Finder chooser first (the server hosts it — browsers can't expose
  // real paths from their own pickers); in-page browser as the fallback.
  const pickFolder = async () => {
    if (data?.mode === "prod") { setRemoteSetupOpen(true); return; }
    setBusy(true);
    try {
      const res = await fetch(prefix("/api/fs/native-pick"), { method: "POST" });
      const json = (await res.json()) as { path?: string; canceled?: boolean; unsupported?: boolean };
      if (json.path) {
        openConfirm(json.path);
        setBusy(false);
        return;
      }
      if (json.canceled) {
        setBusy(false);
        return;
      }
    } catch {
      /* fall through to in-page picker */
    }
    setBusy(false);
    setPickerOpen(true);
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
      const json = (await res.json()) as { ok?: boolean; error?: string };
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

  const remote = data?.mode === "prod";
  const cliCommand = `flow setup ${remote && typeof window !== "undefined" ? window.location.origin + "/" : ""}${data?.project ?? "<project>"}`;
  const detected = new Set(data?.detected ?? []);

  return (
    <div className="flex flex-col gap-3.5 p-5 rounded-2xl border border-line bg-paper shadow-xs rise-in h-full">
      {/* Header — value first: your tools, Flow-powered */}
      <div className="border-b border-line pb-3">
        <Heading variant="section">
          Use Flow in your own AI tools
        </Heading>
        <BodyText className="mt-1">
          Keep working where you already work. Connect a workspace and your AI interfaces get this
          project&apos;s memory — and every session they run teaches it.
        </BodyText>
      </div>

      {/* The user's tools, up top: "yes, mine are covered" */}
      <div className="flex items-start gap-2 flex-wrap">
        {TOOLS.map((t) => {
          const on = remote || detected.has(t.id);
          return (
            <div
              key={t.id}
              title={remote ? `${t.label} — detected by the CLI on your computer during setup` : `${t.label} — ${on ? "detected on this machine; works with Flow in connected workspaces" : "not installed on this machine (still works if you install it later)"}`}
              className={`flex flex-col items-center gap-1 w-[52px] ${on ? "text-ink" : "text-ink/25"}`}
            >
              <BrandIcon name={t.icon} size={20} />
              <span className="text-[8px] uppercase tracking-wide text-center leading-tight">{t.label}</span>
            </div>
          );
        })}
      </div>

      {/* Either/or connect */}
      <div className="flex flex-col gap-1.5">
        <button
          onClick={() => void pickFolder()}
          className="w-full px-3 py-2 rounded-lg border border-ink/20 bg-cream text-sm hover:border-ink/40 transition-all font-medium"
          disabled={busy}
        >
          {busy ? "Choosing…" : "+ Connect a workspace"}
        </button>
        <div className="flex items-center gap-2 text-[11px] text-ink/45">
          <span className="h-px bg-line flex-1" />
          or, in any terminal
          <span className="h-px bg-line flex-1" />
        </div>
        <button
          className="w-full flex items-center justify-center gap-2 text-[12px] font-mono text-ink/60 hover:text-ink group py-1"
          title="Copy — run inside the workspace you want Flow to listen to"
          onClick={() => {
            void navigator.clipboard?.writeText(cliCommand);
            setMsg("Copied — run it inside the workspace.");
          }}
        >
          <span className="text-ink/35">$</span> {cliCommand}
          <span className="text-[10px] text-ink/35 group-hover:text-ink/60">⧉</span>
        </button>
      </div>

      {msg && (
        <div className="p-2 rounded-lg bg-sand border border-line text-[11px] font-mono text-ink flex items-center justify-between">
          <span>{msg}</span>
          <button onClick={() => setMsg("")}>✕</button>
        </div>
      )}

      {remote && <>
        <BodyText>Run the command inside your repository on your computer. The CLI detects your tools and opens browser approval. No remote access to your computer is enabled.</BodyText>
        <a className="text-xs underline" href="https://github.com/samyakkkk/flow#readme" target="_blank" rel="noreferrer">Install the Flow CLI</a>
        {(data?.workspaces ?? []).map(w => <div key={w.id} className="rounded-lg border border-line p-3 text-xs space-y-1">
          <div className="font-medium">{w.repo} · {w.machine}</div>
          <div>Configured: {w.harnesses.join(", ")}</div>
          <div>Knowledge connection verified at setup · Device availability not monitored</div>
          <div>Session capture: not verified here · Memory extraction: not verified here</div>
          <div>To remove: run <code>flow setup --remove</code> locally. Revoke its personal token in Access to stop cloud access.</div>
        </div>)}
      </>}
      {/* Connected workspaces */}
      {data && data.repos.length > 0 ? (
        <div className="max-h-52 overflow-y-auto rounded-xl border border-line divide-y divide-line bg-cream/50">
          {data.repos.map((r) => {
            const name = r.path.split("/").filter(Boolean).pop() ?? r.path;
            const live = r.lastSessionAt != null;
            const isOpen = openRepo === r.path;
            const deviates = r.harnesses.length !== detected.size;
            return (
              <div key={r.path}>
                <button
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-cream transition-colors"
                  onClick={() => setOpenRepo(isOpen ? null : r.path)}
                >
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${live ? "bg-green-600" : "bg-ink/20"}`} />
                  <span className="font-mono text-[12px] truncate">{name}</span>
                  {r.stale && <span className="text-[9px] px-1 rounded bg-sand border border-line text-ink/50">update</span>}
                  {deviates && (
                    <span className="flex items-center gap-1 text-ink/40">
                      {r.harnesses.slice(0, 6).map((h) => {
                        const m = toolMeta(h);
                        return m ? <BrandIcon key={h} name={m.icon} size={10} /> : null;
                      })}
                    </span>
                  )}
                  <span className="ml-auto text-[10px] text-ink/45 shrink-0">{ago(r.lastSessionAt)}</span>
                </button>
                {isOpen && (
                  <div className="px-2.5 pb-2 pt-0.5 flex items-center justify-between gap-2 flex-wrap bg-cream">
                    <div className="min-w-0">
                      <div className="font-mono text-[10px] text-ink/50 truncate">{r.path}</div>
                      <div className="flex items-center gap-1.5 mt-1 text-ink/70">
                        {r.harnesses.map((h) => {
                          const m = toolMeta(h);
                          return m ? (
                            <span key={h} title={m.label}>
                              <BrandIcon name={m.icon} size={12} />
                            </span>
                          ) : null;
                        })}
                        <span className="text-[9px] text-ink/40">{r.share ? "shared" : "personal"}</span>
                      </div>
                    </div>
                    <div className="flex gap-1.5 shrink-0">
                      {r.stale && (
                        <button
                          className="text-[10px] px-2 py-0.5 rounded border border-ink/20 hover:border-ink/40"
                          onClick={() => openConfirm(r.path)}
                          disabled={busy}
                        >
                          Update
                        </button>
                      )}
                      <button
                        className="text-[10px] px-2 py-0.5 rounded border border-ink/10 text-ink/50 hover:text-ink hover:border-ink/30"
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
      ) : !remote ? (
        <BodyText className="py-1">No workspaces connected yet — sessions there aren&apos;t reaching the brain.</BodyText>
      ) : null}

      {/* Surfaces Flow can't listen to locally — the honest "later" cards */}
      <div className="mt-auto pt-1 grid grid-cols-1 gap-1.5">
        <div className="flex items-start gap-2 p-2.5 rounded-xl border border-dashed border-line bg-sand/40">
          <span className="text-ink/50 mt-0.5"><BrandIcon name="openai" size={13} /></span>
          <div>
            <Heading as="h3" variant="card">ChatGPT chats</Heading>
            <BodyText>
              Needs a public connector — coming with your team deployment. (The desktop app&apos;s Codex view is already covered above.)
            </BodyText>
          </div>
        </div>
        <div className="flex items-start gap-2 p-2.5 rounded-xl border border-dashed border-line bg-sand/40">
          <span className="text-ink/50 mt-0.5"><BrandIcon name="anthropic" size={13} /></span>
          <div>
            <Heading as="h3" variant="card">claude.ai &amp; Cowork</Heading>
            <BodyText>
              Needs a public connector + skill upload — coming with your team deployment. Works on every plan once live.
            </BodyText>
          </div>
        </div>
      </div>

      {remoteSetupOpen && <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/45" onClick={() => setRemoteSetupOpen(false)}>
        <div role="dialog" aria-modal="true" aria-label="Connect a workspace on your computer" className="bg-paper rounded-xl p-6 max-w-xl w-[92vw] space-y-4" onClick={e => e.stopPropagation()}>
          <Heading variant="section">Connect a workspace on your computer</Heading>
          <p>In your terminal, open the repository you want to connect and run:</p>
          <button className="font-mono text-xs break-all border rounded p-3 w-full text-left" onClick={() => { void navigator.clipboard?.writeText(cliCommand); setMsg("Setup command copied."); }}>{cliCommand} ⧉</button>
          <p>The CLI detects your tools and asks you to confirm the workspace. It then opens this dashboard for approval. Check the matching code before approving.</p>
          <p className="text-sm">This enables project knowledge and session capture. It does not enable remote access to your computer.</p>
          <a className="text-sm underline block" href="https://github.com/samyakkkk/flow#install" target="_blank" rel="noreferrer">Need the Flow CLI? Installation instructions</a>
          <button className="border rounded px-3 py-2" onClick={() => setRemoteSetupOpen(false)}>Close</button>
        </div>
      </div>}
      {pickerOpen && <FolderPickerDialog onSelect={openConfirm} onClose={() => setPickerOpen(false)} />}

      {/* Confirm: which tools to install into this workspace */}
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
            <div className="text-sm font-medium">Listen to sessions in this workspace</div>
            <div className="font-mono text-[11px] text-ink/50 break-all mt-0.5">{pendingPath}</div>
            <div className="text-[11px] text-ink/55 mt-2 mb-3">
              Flow will install the capture hooks, MCP registration and the flow skill for the
              selected tools into this workspace (personal by default — nothing is committed).
            </div>
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
                {busy ? "Installing…" : `Install & listen (${chosen.size})`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
