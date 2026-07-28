"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useProject } from "@/lib/useProject";
import { Kicker, Heading, Card, StatusPill } from "@/components/ui";
import { BrandIcon, type BrandName } from "@/components/BrandIcon";
import { DiffView, type DiffFile } from "@/components/DiffView";
import { BranchSelect } from "@/components/BranchSelect";
import { AgentTaskComposer } from "@/components/AgentTaskComposer";

interface DetectedAgent {
  id: string;
  name: string;
  installed: boolean;
  version?: string;
  source?: "explicit" | "local" | "bundled";
  installHint: string;
}

interface SessionRow {
  id: string;
  backend: string;
  repo: string;
  title: string;
  status: string;
  live: boolean;
  created_at: number;
  updated_at: number;
}

const AGENT_BRANDS: Record<string, BrandName> = {
  claude: "anthropic",
  codex: "openai",
  opencode: "opencode",
};

function AgentBrandIcon({ backend, className }: { backend: string; className?: string }) {
  const name = AGENT_BRANDS[backend];
  if (!name) return <span aria-hidden>○</span>;
  return <BrandIcon name={name} size={16} className={className} />;
}

function statusKind(status: string): "live" | "ok" | "warn" | "idle" {
  if (status === "running" || status === "starting") return "live";
  if (status === "waiting") return "warn";
  if (status === "idle") return "ok";
  if (status === "error") return "warn";
  return "idle";
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    starting: "Starting",
    running: "Working",
    waiting: "Needs approval",
    idle: "Done — steerable",
    error: "Error",
    closed: "Closed",
  };
  return map[status] ?? status;
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function AgentsView() {
  const router = useRouter();
  const { prefix } = useProject();
  const [agents, setAgents] = useState<DetectedAgent[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [a, s] = await Promise.all([
        fetch(prefix("/api/agents")).then((r) => (r.ok ? r.json() : {})) as Promise<{ agents?: DetectedAgent[] }>,
        fetch(prefix("/api/agents/sessions")).then((r) => (r.ok ? r.json() : {})) as Promise<{ sessions?: SessionRow[] }>,
      ]);
      setAgents(a.agents ?? []);
      setSessions(s.sessions ?? []);
    } finally {
      setLoading(false);
    }
  }, [prefix]);

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 8000);
    return () => clearInterval(iv);
  }, [refresh]);

  return (
    <div className="max-w-4xl pb-16">
      <Kicker>Your coding agents</Kicker>
      <Heading className="mb-2">Give the work to an agent.</Heading>
      <p className="text-text-muted text-[14px] mb-8 max-w-xl">
        Flow runs the agents already on this machine and hands each session the
        brain — read-only — so they start from what your company knows.
      </p>

      {/* Installed Agents Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-8">
        {agents.map((a) => (
          <Card key={a.id} className={`p-4 ${!a.installed ? "opacity-60" : ""}`}>
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-2">
                <AgentBrandIcon backend={a.id} className="text-ink" />
                <span
                  style={{ fontFamily: "var(--font-display)", fontSize: 15 }}
                  className="text-ink font-medium"
                >
                  {a.name}
                </span>
              </div>
              <StatusPill kind={a.installed ? "ok" : "idle"}>
                {a.installed ? "Ready" : "Not installed"}
              </StatusPill>
            </div>
            <p
              style={{ fontFamily: "var(--font-mono)" }}
              className="text-[10px] text-text-muted truncate"
            >
              {a.installed ? a.version : a.installHint}
            </p>
          </Card>
        ))}
        {loading && agents.length === 0 && (
          <p className="text-text-muted text-[13px] col-span-3">Looking for agents on this machine…</p>
        )}
      </div>

      {/* New Task Composer Box */}
      <Card className="p-5 mb-10">
        <Kicker>New Agent Task</Kicker>
        <div className="mt-2 mb-4">
          <h2
            style={{ fontFamily: "var(--font-display)" }}
            className="text-base font-semibold text-ink"
          >
            Start a new coding task
          </h2>
          <p className="text-text-muted text-[12.5px] mt-0.5">
            Select your engine, model, and target local folder below to launch an agent.
          </p>
        </div>

        <AgentTaskComposer />
      </Card>

      {/* Separate copies (worktrees) */}
      <SeparateCopies onNavigate={(sid) => router.push(prefix(`/agents/${sid}`))} />

      {/* Sessions History */}
      <Kicker>Sessions</Kicker>
      <div className="mt-3 flex flex-col gap-2">
        {sessions.length === 0 && !loading && (
          <p className="text-text-muted text-[13px]">No sessions yet — start one above.</p>
        )}
        {sessions.map((s) => (
          <button
            key={s.id}
            onClick={() => router.push(prefix(`/agents/${s.id}`))}
            className="text-left rounded-lg border border-line bg-paper px-4 py-3 hover:bg-cream transition flex items-center gap-4 cursor-pointer"
          >
            <AgentBrandIcon backend={s.backend} className="text-ink flex-shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-ink text-[13.5px] truncate font-medium" style={{ fontFamily: "var(--font-display)" }}>
                {s.title}
              </p>
              <p style={{ fontFamily: "var(--font-mono)" }} className="text-[10px] uppercase tracking-wider text-text-muted mt-0.5">
                {s.backend} · {s.repo} · {timeAgo(s.updated_at)}
              </p>
            </div>
            <StatusPill kind={statusKind(s.status)}>{statusLabel(s.status)}</StatusPill>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Separate copies — isolated branch checkouts
interface WorktreeSession {
  id: string;
  title: string;
  status: string;
}
interface Worktree {
  repo: string;
  path: string;
  branch: string | null;
  base: string;
  aheadCount: number;
  dirty: boolean;
  merged: boolean;
  health: "ok" | "broken";
  sessions: WorktreeSession[];
  github: boolean;
}

function SeparateCopies({ onNavigate }: { onNavigate: (sessionId: string) => void }) {
  const { prefix } = useProject();
  const [trees, setTrees] = useState<Worktree[]>([]);
  const [loaded, setLoaded] = useState(false);

  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notices, setNotices] = useState<Record<string, string>>({});
  const [confirmRemove, setConfirmRemove] = useState<Record<string, boolean>>({});
  const [prUrls, setPrUrls] = useState<Record<string, string>>({});
  const [targetBranches, setTargetBranches] = useState<Record<string, string>>({});
  const [conflicts, setConflicts] = useState<Record<string, { targetBranch: string; files: string[] } | undefined>>({});
  const [openDiff, setOpenDiff] = useState<Record<string, boolean>>({});
  const [diffs, setDiffs] = useState<Record<string, { files: DiffFile[]; diff: string; truncated: boolean } | null>>({});

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(prefix("/api/agents/worktrees"));
      const d = await r.json();
      if (Array.isArray(d.worktrees)) setTrees(d.worktrees);
    } catch {
      /* leave last known */
    } finally {
      setLoaded(true);
    }
  }, [prefix]);

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 8000);
    return () => clearInterval(iv);
  }, [refresh]);

  const setError = (path: string, msg: string) => setErrors((e) => ({ ...e, [path]: msg }));
  const clearError = (path: string) => setErrors((e) => ({ ...e, [path]: "" }));
  const setNotice = (path: string, msg: string) => setNotices((n) => ({ ...n, [path]: msg }));
  const clearNotice = (path: string) => setNotices((n) => ({ ...n, [path]: "" }));

  async function act(path: string, action: "remove", body: Record<string, unknown> = {}) {
    setBusy((b) => ({ ...b, [path]: true }));
    clearError(path);
    clearNotice(path);
    try {
      const res = await fetch(prefix(`/api/agents/worktrees/${action}`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, ...body }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(path, data.error ?? `Couldn't ${action} — status ${res.status}`);
        return;
      }
      if (action === "remove") setConfirmRemove((c) => ({ ...c, [path]: false }));
      await refresh();
    } catch {
      setError(path, "Couldn't reach the server.");
    } finally {
      setBusy((b) => ({ ...b, [path]: false }));
    }
  }

  async function openPr(path: string, targetBranch: string) {
    setBusy((b) => ({ ...b, [path]: true }));
    clearError(path);
    clearNotice(path);
    setConflicts((c) => ({ ...c, [path]: undefined }));
    try {
      const res = await fetch(prefix("/api/agents/worktrees/pr"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, targetBranch }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && data.conflict) {
        setConflicts((c) => ({
          ...c,
          [path]: {
            targetBranch: String(data.targetBranch ?? targetBranch),
            files: Array.isArray(data.files) ? data.files.map(String) : [],
          },
        }));
        return;
      }
      if (!res.ok) {
        setError(path, data.error ?? `Couldn't open PR — status ${res.status}`);
        return;
      }
      if (data.compareUrl) {
        setPrUrls((p) => ({ ...p, [path]: data.compareUrl }));
        window.open(data.compareUrl, "_blank", "noopener,noreferrer");
      }
      await refresh();
    } catch {
      setError(path, "Couldn't reach the server.");
    } finally {
      setBusy((b) => ({ ...b, [path]: false }));
    }
  }

  async function openCopyInVsCode(path: string) {
    setBusy((b) => ({ ...b, [path]: true }));
    clearError(path);
    try {
      const res = await fetch(prefix("/api/agents/worktrees/open"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, target: "vscode" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setError(path, data.error ?? `Couldn't open VS Code — status ${res.status}`);
    } catch {
      setError(path, "Couldn't reach the server.");
    } finally {
      setBusy((b) => ({ ...b, [path]: false }));
    }
  }

  async function resolveConflictWithAi(wt: Worktree) {
    const session = wt.sessions.find((s) => s.status !== "closed" && s.status !== "error") ?? wt.sessions[0];
    if (!session) {
      setError(wt.path, "No session is attached to this copy. Open it in VS Code to resolve manually.");
      return;
    }
    const target = conflicts[wt.path]?.targetBranch ?? targetBranches[wt.path] ?? wt.base;
    setBusy((b) => ({ ...b, [wt.path]: true }));
    clearError(wt.path);
    clearNotice(wt.path);
    try {
      const text =
        `Resolve the merge conflicts blocking this worktree from opening a PR into ${target}.\n\n` +
        `Work in the current checkout only. Fetch the target branch, inspect the conflict, edit the conflicting files, commit the resolution, and then tell me when it is ready to open the PR again.`;
      const res = await fetch(prefix(`/api/agents/sessions/${session.id}/prompt`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(wt.path, data.error ?? `Couldn't ask the agent — status ${res.status}`);
        return;
      }
      setNotice(wt.path, "Asked the agent to resolve the conflicts in this copy.");
      onNavigate(session.id);
    } catch {
      setError(wt.path, "Couldn't reach the server.");
    } finally {
      setBusy((b) => ({ ...b, [wt.path]: false }));
    }
  }

  async function toggleDiff(path: string) {
    const next = !openDiff[path];
    setOpenDiff((o) => ({ ...o, [path]: next }));
    if (next && diffs[path] === undefined) {
      try {
        const r = await fetch(prefix(`/api/agents/worktrees/diff?path=${encodeURIComponent(path)}`));
        const d = r.ok ? await r.json() : null;
        setDiffs((m) => ({ ...m, [path]: d && Array.isArray(d.files) ? d : null }));
      } catch {
        setDiffs((m) => ({ ...m, [path]: null }));
      }
    }
  }

  if (!loaded || trees.length === 0) return null;

  return (
    <div className="mb-10">
      <Kicker>Separate copies</Kicker>
      <p className="text-text-muted text-[12.5px] mt-1 mb-3 max-w-xl">
        Isolated copies of a branch, made when two agents would otherwise share one folder. Open a PR
        from the copy, review conflicts, or clear the copy away.
      </p>
      <div className="flex flex-col gap-2">
        {trees.map((wt) => {
          const b = busy[wt.path];
          const err = errors[wt.path];
          const notice = notices[wt.path];
          const compareUrl = prUrls[wt.path];
          const targetBranch = targetBranches[wt.path] ?? wt.base;
          const conflict = conflicts[wt.path];

          if (wt.health === "broken") {
            return (
              <div key={wt.path} className="rounded-lg border border-line bg-paper px-4 py-3">
                <div className="flex items-center gap-3 flex-wrap">
                  <span style={{ fontFamily: "var(--font-mono)" }} className="text-[12px] text-text-muted line-through">
                    {wt.branch ?? "(unknown branch)"}
                  </span>
                  <span className="text-[11.5px] text-text-muted">folder missing — clean up</span>
                  <div className="flex-1" />
                  <button
                    onClick={() => act(wt.path, "remove", { force: true })}
                    disabled={b}
                    className="rounded-md border border-line bg-paper px-2.5 py-1 text-[11.5px] text-text hover:bg-cream transition disabled:opacity-50"
                  >
                    Remove
                  </button>
                </div>
                {err && <p className="text-[11.5px] mt-2" style={{ color: "var(--danger)" }}>{err}</p>}
              </div>
            );
          }

          return (
            <div key={wt.path} className="rounded-lg border border-line bg-paper px-4 py-3">
              <div className="flex items-center gap-3 flex-wrap">
                <span style={{ fontFamily: "var(--font-mono)" }} className="text-[12px] text-ink truncate max-w-[240px]" title={wt.branch ?? ""}>
                  {wt.branch ?? "(detached)"}
                </span>
                <span className="text-[11px] uppercase tracking-wider text-text-muted" style={{ fontFamily: "var(--font-mono)" }}>
                  {wt.repo}
                </span>
                {wt.merged ? (
                  <StatusPill kind="ok">merged</StatusPill>
                ) : (
                  <StatusPill kind="idle">
                    {wt.aheadCount} {wt.aheadCount === 1 ? "commit ahead" : "commits ahead"}
                  </StatusPill>
                )}
                {wt.dirty && (
                  <span className="inline-flex items-center gap-1 text-[11px] text-text-muted" title="Uncommitted changes in this copy">
                    <span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--warn)" }} />
                    uncommitted
                  </span>
                )}
                <div className="flex-1" />
                {wt.sessions.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => onNavigate(s.id)}
                    className="text-[11px] text-text-muted hover:text-ink transition truncate max-w-[180px]"
                    title={s.title}
                  >
                    {s.title}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-2 flex-wrap mt-2.5">
                <button
                  onClick={() => toggleDiff(wt.path)}
                  className="rounded-md border border-line bg-paper px-2.5 py-1 text-[11.5px] text-text hover:bg-cream transition"
                >
                  {openDiff[wt.path] ? "Hide changes" : "View changes"}
                </button>
                {wt.github && (
                  <>
                    <label className="inline-flex items-center gap-1.5 text-[11px] text-text-muted">
                      PR to
                      <BranchSelect
                        repo={wt.repo}
                        value={targetBranch}
                        fallback={wt.base}
                        onChange={(branch) => setTargetBranches((m) => ({ ...m, [wt.path]: branch }))}
                        className="w-[132px] rounded-md border border-line bg-paper px-2 py-1 text-[11.5px] text-ink"
                      />
                    </label>
                    <button
                      onClick={() => openPr(wt.path, targetBranch)}
                      disabled={b || !targetBranch.trim()}
                      className="rounded-md border border-line bg-paper px-2.5 py-1 text-[11.5px] text-text hover:bg-cream transition disabled:opacity-50"
                    >
                      Open PR to {targetBranch || wt.base}
                    </button>
                  </>
                )}
                {confirmRemove[wt.path] ? (
                  <span className="inline-flex items-center gap-2">
                    <span className="text-[11.5px] text-text-muted">
                      This copy has uncommitted changes. Remove anyway?
                    </span>
                    <button
                      onClick={() => act(wt.path, "remove", { force: true })}
                      disabled={b}
                      className="rounded-md border border-line bg-paper px-2.5 py-1 text-[11.5px] hover:bg-cream transition disabled:opacity-50"
                      style={{ color: "var(--danger)" }}
                    >
                      Remove anyway
                    </button>
                    <button
                      onClick={() => setConfirmRemove((c) => ({ ...c, [wt.path]: false }))}
                      className="text-[11px] text-text-muted hover:text-ink transition"
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    onClick={() => (wt.dirty ? setConfirmRemove((c) => ({ ...c, [wt.path]: true })) : act(wt.path, "remove"))}
                    disabled={b}
                    className="rounded-md border border-line bg-paper px-2.5 py-1 text-[11.5px] text-text-muted hover:bg-cream transition disabled:opacity-50"
                  >
                    Remove
                  </button>
                )}
              </div>

              {compareUrl && (
                <a
                  href={compareUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block text-[11.5px] mt-2 text-ink underline hover:opacity-80"
                >
                  Pull request page opened ↗
                </a>
              )}
              {conflict && (
                <div className="flex items-center gap-2 flex-wrap mt-2">
                  <span className="text-[11.5px]" style={{ color: "var(--danger)" }}>
                    Merge conflicts against {conflict.targetBranch}
                    {conflict.files.length ? `: ${conflict.files.slice(0, 3).join(", ")}${conflict.files.length > 3 ? "…" : ""}` : "."}
                  </span>
                  <button
                    onClick={() => openCopyInVsCode(wt.path)}
                    disabled={b}
                    className="rounded-md border border-line bg-paper px-2.5 py-1 text-[11px] text-text hover:bg-cream transition disabled:opacity-50"
                  >
                    Review in VS Code
                  </button>
                  <button
                    onClick={() => resolveConflictWithAi(wt)}
                    disabled={b}
                    className="rounded-md border border-line bg-paper px-2.5 py-1 text-[11px] text-text hover:bg-cream transition disabled:opacity-50"
                  >
                    Resolve using AI
                  </button>
                </div>
              )}
              {notice && <p className="text-[11.5px] mt-2" style={{ color: "var(--ok)" }}>{notice}</p>}
              {err && <p className="text-[11.5px] mt-2" style={{ color: "var(--danger)" }}>{err}</p>}

              {openDiff[wt.path] && (
                <div className="mt-3 max-h-[45vh] overflow-y-auto">
                  {diffs[wt.path] === undefined ? (
                    <p className="text-text-muted text-[12px]">Loading changes…</p>
                  ) : diffs[wt.path] && diffs[wt.path]!.files.length > 0 ? (
                    <DiffView diff={diffs[wt.path]!.diff} truncated={diffs[wt.path]!.truncated} />
                  ) : (
                    <p className="text-text-muted text-[12px]">No changes against {wt.base}.</p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
