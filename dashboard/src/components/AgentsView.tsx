"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useProject } from "@/lib/useProject";
import { Kicker, Heading, Card, StatusPill } from "@/components/ui";
import { BrandIcon, type BrandName } from "@/components/BrandIcon";
import { DiffView, type DiffFile } from "@/components/DiffView";
import { BranchSelect } from "@/components/BranchSelect";
import { AgentTaskComposer, type CopyTarget } from "@/components/AgentTaskComposer";

interface SessionRow {
  id: string;
  backend: string;
  repo: string;
  title: string;
  status: string;
  live: boolean;
  worktree_id: string | null;
  created_at: number;
  updated_at: number;
}

interface WorktreeSession {
  id: string;
  title: string;
  status: string;
  backend: string;
  updated_at: number;
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

const AGENT_BRANDS: Record<string, BrandName> = {
  claude: "anthropic",
  codex: "openai",
  opencode: "opencode",
};

const ACTIVE_STATUSES = new Set(["starting", "running", "waiting"]);

function AgentBrandIcon({ backend, className }: { backend: string; className?: string }) {
  const name = AGENT_BRANDS[backend.startsWith("ext:") ? backend.slice(4) : backend];
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

// Last touch on a copy = its most recent session activity. Copies with no
// sessions sort last.
function lastActivity(wt: Worktree): number {
  return wt.sessions.reduce((m, s) => Math.max(m, s.updated_at ?? 0), 0);
}

function hasActiveSession(wt: Worktree): boolean {
  return wt.sessions.some((s) => ACTIVE_STATUSES.has(s.status));
}

export function AgentsView() {
  const router = useRouter();
  const { prefix } = useProject();
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [trees, setTrees] = useState<Worktree[]>([]);
  const [loading, setLoading] = useState(true);
  const [treesLoaded, setTreesLoaded] = useState(false);

  // "+ New session" on a copy targets the composer at that copy.
  const [copyTarget, setCopyTarget] = useState<CopyTarget | null>(null);
  const composerRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, w] = await Promise.all([
        fetch(prefix("/api/agents/sessions")).then((r) => (r.ok ? r.json() : {})) as Promise<{ sessions?: SessionRow[] }>,
        fetch(prefix("/api/agents/worktrees")).then((r) => (r.ok ? r.json() : {})) as Promise<{ worktrees?: Worktree[] }>,
      ]);
      setSessions(s.sessions ?? []);
      if (Array.isArray(w.worktrees)) {
        setTrees(w.worktrees);
        setTreesLoaded(true);
      }
    } finally {
      setLoading(false);
    }
  }, [prefix]);

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 8000);
    return () => clearInterval(iv);
  }, [refresh]);

  const navigate = useCallback((sid: string) => router.push(prefix(`/agents/${sid}`)), [router, prefix]);

  const startInCopy = useCallback((wt: Worktree) => {
    setCopyTarget({ path: wt.path, branch: wt.branch, repo: wt.repo });
    composerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  return (
    <div className="max-w-6xl pb-16">
      <Kicker>Your coding agents</Kicker>
      <Heading className="mb-2">Give the work to an agent.</Heading>
      <p className="text-text-muted text-[14px] mb-8 max-w-xl">
        Flow runs the agents already on this machine and hands each session the
        brain — read-only — so they start from what your company knows.
      </p>

      {/* New Task Composer Box */}
      <div ref={composerRef} className="scroll-mt-4">
        <Card className="p-5 mb-10">
          <Kicker>New Agent Task</Kicker>
          <div className="mt-2 mb-4">
            <h2
              style={{ fontFamily: "var(--font-display)" }}
              className="text-base font-medium text-ink"
            >
              Start a new coding task
            </h2>
            <p className="text-text-muted text-[12.5px] mt-0.5">
              Select your engine, model, and target local folder below to launch an agent.
            </p>
          </div>

          <AgentTaskComposer
            worktreeTarget={copyTarget}
            onClearWorktreeTarget={() => setCopyTarget(null)}
          />
        </Card>
      </div>

      {/* Split view: workspaces (separate copies) left, session history right */}
      <div className="grid gap-10 lg:gap-8 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] items-start">
        <WorkspacesColumn
          trees={trees}
          loaded={treesLoaded}
          onNavigate={navigate}
          onNewSession={startInCopy}
          onChanged={refresh}
        />
        <SessionsColumn sessions={sessions} loading={loading} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sessions — recency-sorted history, capped with "show all". Sessions that ran
// on a separate copy carry a ⎇ badge so the two columns cross-reference.

const SESSIONS_SHOWN = 12;

interface SessionSearchHit extends Omit<SessionRow, "live"> {
  score: number;
  snippet: string | null;
}

function SessionCard({
  s,
  snippet,
  href,
}: {
  s: Omit<SessionRow, "live">;
  snippet?: string | null;
  href: string;
}) {
  const title = s.title?.trim() || `${s.backend.toUpperCase()} session`;
  return (
    <Link
      href={href}
      className="text-left rounded-lg border border-line bg-paper px-3.5 py-2.5 hover:bg-cream transition flex items-center gap-3 cursor-pointer"
    >
      <AgentBrandIcon backend={s.backend} className="text-ink flex-shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-ink text-[13px] truncate font-medium" style={{ fontFamily: "var(--font-display)" }}>
          {title}
        </p>
        <p style={{ fontFamily: "var(--font-mono)" }} className="text-[10px] uppercase tracking-wider text-text-muted mt-0.5 truncate">
          {s.backend} · {timeAgo(s.updated_at)}
          {s.worktree_id ? (
            <span className="normal-case" title={`Ran on separate copy ${s.worktree_id}`}>
              {" "}· ⎇ {s.worktree_id.split("/").pop()}
            </span>
          ) : null}
        </p>
        {snippet ? <p className="text-text-muted text-[11.5px] mt-1 line-clamp-2">{snippet}</p> : null}
      </div>
      <StatusPill kind={statusKind(s.status)}>{statusLabel(s.status)}</StatusPill>
    </Link>
  );
}

function SessionsColumn({
  sessions,
  loading,
}: {
  sessions: SessionRow[];
  loading: boolean;
}) {
  const { prefix } = useProject();
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState("");
  // null = not searching (show the recency list); [] = searched, no matches.
  const [results, setResults] = useState<SessionSearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const shown = showAll ? sessions : sessions.slice(0, SESSIONS_SHOWN);

  // Debounced semantic search — describe the session, not just its title.
  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    let stale = false;
    const t = setTimeout(async () => {
      try {
        const r = await fetch(prefix(`/api/agents/sessions/search?q=${encodeURIComponent(q)}`));
        const j = (r.ok ? await r.json() : {}) as { results?: SessionSearchHit[] };
        if (!stale) setResults(j.results ?? []);
      } catch {
        if (!stale) setResults([]);
      } finally {
        if (!stale) setSearching(false);
      }
    }, 300);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [query, prefix]);

  return (
    <div>
      <Kicker>Sessions</Kicker>
      <p className="text-text-muted text-[12.5px] mt-1 mb-3">
        Every agent run, newest first. ⎇ marks runs on a separate copy.
      </p>
      <input
        type="search"
        value={query}
        onChange={(e) => {
          const v = e.target.value;
          setQuery(v);
          if (v.trim()) {
            setSearching(true);
          } else {
            setResults(null);
            setSearching(false);
          }
        }}
        placeholder="Search sessions — describe what you were working on…"
        className="w-full mb-3 rounded-lg border border-line bg-paper px-3.5 py-2 text-[13px] text-ink placeholder:text-text-muted focus:outline-none focus:border-ink/40 transition"
      />
      <div className="flex flex-col gap-2">
        {results !== null ? (
          <>
            {searching && results.length === 0 && (
              <p className="text-text-muted text-[13px]">Searching…</p>
            )}
            {!searching && results.length === 0 && (
              <p className="text-text-muted text-[13px]">No sessions match that.</p>
            )}
            {results.map((s) => (
              <SessionCard key={s.id} s={s} snippet={s.snippet} href={prefix(`/agents/${s.id}`)} />
            ))}
          </>
        ) : (
          <>
            {sessions.length === 0 && !loading && (
              <p className="text-text-muted text-[13px]">No sessions yet — start one above.</p>
            )}
            {shown.map((s) => (
              <SessionCard key={s.id} s={s} href={prefix(`/agents/${s.id}`)} />
            ))}
          </>
        )}
      </div>
      {results === null && sessions.length > SESSIONS_SHOWN && (
        <button
          onClick={() => setShowAll((v) => !v)}
          className="mt-2 text-[12px] text-text-muted hover:text-ink transition cursor-pointer"
        >
          {showAll ? "Show fewer" : `Show all ${sessions.length}`}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Workspaces — the separate copies. Sorted by activity (working copies first,
// then most recently touched). Merged, settled copies fold away into a
// cleanup group with a one-click "Clear all".

function WorkspacesColumn({
  trees,
  loaded,
  onNavigate,
  onNewSession,
  onChanged,
}: {
  trees: Worktree[];
  loaded: boolean;
  onNavigate: (sessionId: string) => void;
  onNewSession: (wt: Worktree) => void;
  onChanged: () => Promise<void>;
}) {
  const { prefix } = useProject();

  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notices, setNotices] = useState<Record<string, string>>({});
  const [confirmRemove, setConfirmRemove] = useState<Record<string, boolean>>({});
  const [prUrls, setPrUrls] = useState<Record<string, string>>({});
  const [targetBranches, setTargetBranches] = useState<Record<string, string>>({});
  const [conflicts, setConflicts] = useState<Record<string, { targetBranch: string; files: string[] } | undefined>>({});
  const [openDiff, setOpenDiff] = useState<Record<string, boolean>>({});
  const [diffs, setDiffs] = useState<Record<string, { files: DiffFile[]; diff: string; truncated: boolean } | null>>({});
  const [mergedOpen, setMergedOpen] = useState(false);
  const [clearing, setClearing] = useState<{ done: number; total: number } | null>(null);

  // Settled copies (merged, clean, nothing running) fold away; everything else
  // stays visible, working copies first, then most recently touched.
  const { activeTrees, settledTrees } = useMemo(() => {
    const settled: Worktree[] = [];
    const active: Worktree[] = [];
    for (const wt of trees) {
      if (wt.health === "ok" && wt.merged && !wt.dirty && !hasActiveSession(wt)) settled.push(wt);
      else active.push(wt);
    }
    const byRecency = (a: Worktree, b: Worktree) =>
      Number(hasActiveSession(b)) - Number(hasActiveSession(a)) ||
      lastActivity(b) - lastActivity(a) ||
      (a.branch ?? "").localeCompare(b.branch ?? "");
    active.sort(byRecency);
    settled.sort(byRecency);
    return { activeTrees: active, settledTrees: settled };
  }, [trees]);

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
      await onChanged();
    } catch {
      setError(path, "Couldn't reach the server.");
    } finally {
      setBusy((b) => ({ ...b, [path]: false }));
    }
  }

  // One click clears every settled copy — sequential removes so partial
  // failures leave an accurate list behind.
  async function clearSettled() {
    const targets = settledTrees;
    setClearing({ done: 0, total: targets.length });
    try {
      for (let i = 0; i < targets.length; i++) {
        try {
          await fetch(prefix("/api/agents/worktrees/remove"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path: targets[i].path }),
          });
        } catch {
          /* keep going — the refresh below shows what's left */
        }
        setClearing({ done: i + 1, total: targets.length });
      }
      await onChanged();
    } finally {
      setClearing(null);
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
      await onChanged();
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

  function removeButton(wt: Worktree) {
    const b = busy[wt.path];
    if (confirmRemove[wt.path]) {
      return (
        <span className="inline-flex items-center gap-2">
          <span className="text-[11px] text-text-muted">Uncommitted changes — remove anyway?</span>
          <button
            onClick={() => act(wt.path, "remove", { force: true })}
            disabled={b}
            className="rounded-md border border-line bg-paper px-2 py-0.5 text-[11px] hover:bg-cream transition disabled:opacity-50 cursor-pointer"
            style={{ color: "var(--danger)" }}
          >
            Remove
          </button>
          <button
            onClick={() => setConfirmRemove((c) => ({ ...c, [wt.path]: false }))}
            className="text-[11px] text-text-muted hover:text-ink transition cursor-pointer"
          >
            Cancel
          </button>
        </span>
      );
    }
    return (
      <button
        onClick={() => (wt.dirty ? setConfirmRemove((c) => ({ ...c, [wt.path]: true })) : act(wt.path, "remove"))}
        disabled={b}
        title="Remove this copy"
        className="rounded-md px-1.5 py-0.5 text-[14px] leading-none text-text-muted hover:text-ink hover:bg-cream transition disabled:opacity-50 cursor-pointer"
      >
        ×
      </button>
    );
  }

  return (
    <div>
      <Kicker>Workspaces · Separate copies</Kicker>
      <p className="text-text-muted text-[12.5px] mt-1 mb-3">
        Isolated copies of a branch. Each holds its own sessions — start another
        agent in a copy, open a PR from it, or clear it away.
      </p>

      {loaded && trees.length === 0 && (
        <p className="text-text-muted text-[13px]">
          No separate copies yet. Flow makes one when two agents would share a
          folder — or pick “Separate copy” when starting a task.
        </p>
      )}

      <div className="flex flex-col gap-2.5">
        {activeTrees.map((wt) => {
          const b = busy[wt.path];
          const err = errors[wt.path];
          const notice = notices[wt.path];
          const compareUrl = prUrls[wt.path];
          const targetBranch = targetBranches[wt.path] ?? wt.base;
          const conflict = conflicts[wt.path];
          const touched = lastActivity(wt);

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
                    className="rounded-md border border-line bg-paper px-2.5 py-1 text-[11.5px] text-text hover:bg-cream transition disabled:opacity-50 cursor-pointer"
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
              {/* Header: branch + state, remove tucked right */}
              <div className="flex items-center gap-2.5 flex-wrap">
                <span style={{ fontFamily: "var(--font-mono)" }} className="text-[12px] text-ink truncate max-w-[240px]" title={wt.branch ?? ""}>
                  ⎇ {wt.branch ?? "(detached)"}
                </span>
                <span className="text-[10.5px] uppercase tracking-wider text-text-muted" style={{ fontFamily: "var(--font-mono)" }}>
                  {wt.repo}
                </span>
                {hasActiveSession(wt) ? (
                  <StatusPill kind="live">working</StatusPill>
                ) : wt.merged ? (
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
                {touched > 0 && (
                  <span className="text-[10.5px] text-text-muted" style={{ fontFamily: "var(--font-mono)" }}>
                    {timeAgo(touched)}
                  </span>
                )}
                <div className="flex-1" />
                {removeButton(wt)}
              </div>

              {/* Sessions inside this copy */}
              <div className="mt-2 flex flex-col gap-1">
                {wt.sessions.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => onNavigate(s.id)}
                    className="flex items-center gap-2 text-left rounded-md px-2 py-1 -mx-2 hover:bg-cream transition cursor-pointer"
                    title={s.title}
                  >
                    <AgentBrandIcon backend={s.backend} className="text-ink flex-shrink-0" />
                    <span className="text-[12px] text-ink truncate flex-1">{s.title}</span>
                    <span className="text-[10px] text-text-muted flex-shrink-0" style={{ fontFamily: "var(--font-mono)" }}>
                      {s.updated_at ? timeAgo(s.updated_at) : ""}
                    </span>
                    <StatusPill kind={statusKind(s.status)}>{statusLabel(s.status)}</StatusPill>
                  </button>
                ))}
                <button
                  onClick={() => onNewSession(wt)}
                  className="self-start text-[11.5px] text-text-muted hover:text-ink transition px-2 py-1 -mx-2 rounded-md hover:bg-cream cursor-pointer"
                  title="Start another agent session in this copy"
                >
                  + New session in this copy
                </button>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2 flex-wrap mt-2">
                <button
                  onClick={() => toggleDiff(wt.path)}
                  className="rounded-md border border-line bg-paper px-2.5 py-1 text-[11.5px] text-text hover:bg-cream transition cursor-pointer"
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
                      className="rounded-md border border-line bg-paper px-2.5 py-1 text-[11.5px] text-text hover:bg-cream transition disabled:opacity-50 cursor-pointer"
                    >
                      Open PR
                    </button>
                  </>
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
                    className="rounded-md border border-line bg-paper px-2.5 py-1 text-[11px] text-text hover:bg-cream transition disabled:opacity-50 cursor-pointer"
                  >
                    Review in VS Code
                  </button>
                  <button
                    onClick={() => resolveConflictWithAi(wt)}
                    disabled={b}
                    className="rounded-md border border-line bg-paper px-2.5 py-1 text-[11px] text-text hover:bg-cream transition disabled:opacity-50 cursor-pointer"
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

      {/* Merged, settled copies — folded away with one-click cleanup */}
      {settledTrees.length > 0 && (
        <div className="mt-4 rounded-lg border border-line bg-cream/40">
          <div className="flex items-center gap-3 px-4 py-2.5">
            <button
              onClick={() => setMergedOpen((v) => !v)}
              className="flex items-center gap-2 text-[12.5px] text-text hover:text-ink transition cursor-pointer"
            >
              <span className="text-[10px]">{mergedOpen ? "▾" : "▸"}</span>
              Merged copies ({settledTrees.length})
            </button>
            <div className="flex-1" />
            <button
              onClick={clearSettled}
              disabled={clearing !== null}
              className="rounded-md border border-line bg-paper px-2.5 py-1 text-[11.5px] text-text hover:bg-cream transition disabled:opacity-50 cursor-pointer"
            >
              {clearing ? `Clearing ${clearing.done}/${clearing.total}…` : "Clear all merged"}
            </button>
          </div>
          {mergedOpen && (
            <div className="border-t border-line px-4 py-2 flex flex-col">
              {settledTrees.map((wt) => (
                <div key={wt.path} className="flex items-center gap-2.5 py-1.5">
                  <span style={{ fontFamily: "var(--font-mono)" }} className="text-[11.5px] text-text-muted truncate max-w-[260px]" title={wt.path}>
                    ⎇ {wt.branch ?? "(detached)"}
                  </span>
                  {wt.sessions.length > 0 && (
                    <button
                      onClick={() => onNavigate(wt.sessions[0].id)}
                      className="text-[10.5px] text-text-muted hover:text-ink transition truncate max-w-[180px] cursor-pointer"
                      title={wt.sessions[0].title}
                    >
                      {wt.sessions[0].title}
                    </button>
                  )}
                  <div className="flex-1" />
                  <span className="text-[10px] text-text-muted" style={{ fontFamily: "var(--font-mono)" }}>
                    {lastActivity(wt) > 0 ? timeAgo(lastActivity(wt)) : ""}
                  </span>
                  <button
                    onClick={() => act(wt.path, "remove")}
                    disabled={busy[wt.path] || clearing !== null}
                    className="text-[11px] text-text-muted hover:text-ink transition disabled:opacity-50 cursor-pointer"
                  >
                    Remove
                  </button>
                  {errors[wt.path] && (
                    <span className="text-[10.5px]" style={{ color: "var(--danger)" }}>{errors[wt.path]}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
