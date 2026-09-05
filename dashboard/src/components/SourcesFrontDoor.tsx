"use client";
// SourcesFrontDoor — the "sources front door" on the home page. Two doors,
// never one ambiguous box: an "Add a folder" input (local mode only — point
// Flow at a project folder or a folder of docs) stacked above the GitHub
// picker (the checklist of your account's repos). Two shapes share the doors:
//   • variant="hero"  — first run (no sources yet): a calm welcome, then the
//     two doors, front and centre.
//   • variant="strip" — returning: a compact list of connected sources plus an
//     always-visible "+ Add a source" that expands the same two doors inline.
import { useEffect, useState } from "react";
import Link from "next/link";
import { useProject } from "@/lib/useProject";
import { AddFolder } from "@/components/AddFolder";
import { RepoPicker } from "@/components/RepoPicker";
import { BranchSelect } from "@/components/BranchSelect";
import { Kicker, Heading, StatusPill } from "@/components/ui";
import type { FlowMode } from "@/lib/useMode";

// Structurally compatible with the home page's RepoEntry (entries from
// /api/repos). localPath / kind are written by the sources front door when a
// local folder or docs source is registered.
export interface SourceEntry {
  name: string;
  url?: string;
  branch?: string;
  localPath?: string | null;
  kind?: string;
  lastIndexedCommit?: string;
  lastIndexedAt?: string;
}

// Per-repo indexer state machine from /api/repos/status — richer than the
// legacy !lastIndexedCommit guess, which can never show a reindex, a queued
// job, or a failure.
export interface RepoStatusEntry {
  name: string;
  branch: string;
  status: "never_indexed" | "queued" | "indexing" | "indexed" | "failed";
  lastIndexedCommit: string | null;
  lastIndexedAt: string | null;
  lastError: string | null;
}

// One row of the durable indexer trail (GET /api/index-log).
interface IndexLogRow {
  id: number;
  event: string;
  job_id: string | null;
  detail: Record<string, unknown> | null;
  created_at: number;
}

// One quiet chip per source, keyed on what the entry actually is.
function sourceChip(s: SourceEntry): string {
  if (s.kind === "docs") return "docs · ingestion pending";
  if (s.localPath) return "your folder";
  return "remote-synced";
}

function timeAgo(iso?: string): string | null {
  if (!iso) return null;
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (mins > 0) return `${mins}m ago`;
  return "just now";
}

// Live activity of the current index job for a repo (orchestrator keeps it in
// memory while the job runs; empty ticker once it finishes).
interface IndexActivity {
  status: "idle" | "running" | "done" | "failed";
  backend?: string;
  startedAt?: number;
  counts?: { toolCalls: number; filesRead: number; graphWrites: number };
  events?: { seq: number; ts: number; kind: string; label: string }[];
}

function elapsed(startedAt?: number): string {
  if (!startedAt) return "";
  const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ""}`;
}

// Polls while a job is running (or expected: first index / just-clicked
// reindex) and renders a terse ticker of what the indexer is doing. One
// initial fetch even when not expected, so externally-triggered runs (a push
// to the watched branch) surface too.
function IndexActivityStrip({ repo, active }: { repo: string; active: boolean }) {
  const { prefix } = useProject();
  const [activity, setActivity] = useState<IndexActivity | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function tick() {
      try {
        const r = await fetch(prefix(`/api/index-activity?repo=${encodeURIComponent(repo)}`));
        const d = (await r.json()) as IndexActivity;
        if (stop) return;
        setActivity(d);
        if (d.status === "running" || active) timer = setTimeout(tick, 3000);
      } catch {
        if (!stop && active) timer = setTimeout(tick, 5000);
      }
    }
    void tick();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, active]);

  if (activity?.status !== "running") return null;
  const c = activity.counts ?? { toolCalls: 0, filesRead: 0, graphWrites: 0 };
  const recent = (activity.events ?? []).slice(-8);

  return (
    <div style={{ borderTop: "1px solid var(--line)", background: "var(--paper)" }} className="px-3 py-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full text-left"
        style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-muted)", cursor: "pointer" }}
      >
        <span>{expanded ? "▾" : "▸"}</span>
        <span>
          {activity.backend} · {elapsed(activity.startedAt)} · {c.toolCalls} calls · {c.filesRead} files read ·{" "}
          {c.graphWrites} graph writes
        </span>
      </button>
      {expanded && recent.length > 0 && (
        <div className="mt-1.5 space-y-0.5 overflow-hidden">
          {recent.map((e) => (
            <div
              key={e.seq}
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                color: e.kind === "graph" ? "var(--ink)" : "var(--text-muted)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {e.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const branchSelectStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  padding: "2px 6px",
  borderRadius: 4,
  border: "1px solid var(--line)",
  background: "var(--cream)",
  color: "var(--ink)",
  outline: "none",
  cursor: "pointer",
  maxWidth: 140,
};

// The durable indexer trail for one repo — when the last index ran, what got
// queued behind what, why a job failed. Fetched once when the panel opens so
// self-deployers can debug indexing without shell access.
function IndexLogPanel({ repo }: { repo: string }) {
  const { prefix } = useProject();
  const [rows, setRows] = useState<IndexLogRow[] | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(prefix(`/api/index-log?repo=${encodeURIComponent(repo)}&limit=40`))
      .then((r) => r.json())
      .then((d) => { if (alive) setRows(((d as { rows?: IndexLogRow[] }).rows) ?? []); })
      .catch(() => { if (alive) setRows([]); });
    return () => { alive = false; };
  }, [repo, prefix]);

  const terse = (r: IndexLogRow): string => {
    if (!r.detail) return "";
    return Object.entries(r.detail)
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" ");
  };

  return (
    <div
      className="px-3 py-2 flex flex-col gap-1 max-h-56 overflow-y-auto"
      style={{ borderTop: "1px solid var(--line)", background: "var(--paper)" }}
      data-testid="index-log-panel"
    >
      {rows === null ? (
        <span style={{ fontSize: 10, color: "var(--text-muted)" }}>Loading…</span>
      ) : rows.length === 0 ? (
        <span style={{ fontSize: 10, color: "var(--text-muted)" }}>No index events yet.</span>
      ) : (
        rows.map((r) => (
          <div key={r.id} className="flex items-baseline gap-2" style={{ fontFamily: "var(--font-mono)", fontSize: 10 }}>
            <span style={{ color: "var(--text-muted)", flexShrink: 0 }}>
              {new Date(r.created_at * 1000).toLocaleString()}
            </span>
            <span style={{ color: r.event === "failed" ? "var(--danger)" : "var(--ink)", flexShrink: 0 }}>
              {r.event}
            </span>
            <span style={{ color: "var(--text-muted)" }} className="truncate" title={terse(r)}>
              {terse(r)}
            </span>
          </div>
        ))
      )}
    </div>
  );
}

function SourceRow({ s, st, onChanged }: { s: SourceEntry; st?: RepoStatusEntry; onChanged: () => void }) {
  const { prefix } = useProject();
  const chip = sourceChip(s);
  // Prefer the orchestrator's state machine; fall back to the legacy guess
  // when the status endpoint hasn't answered yet. Local-tier repos may have
  // lastIndexedAt without a commit — either one means "indexed".
  const status: RepoStatusEntry["status"] | undefined =
    s.kind === "docs" ? undefined : st?.status ?? (!s.lastIndexedCommit && !s.lastIndexedAt ? "indexing" : "indexed");
  const indexing = status === "indexing";
  const [showLog, setShowLog] = useState(false);

  const [reindexing, setReindexing] = useState(false);
  const [reindexMsg, setReindexMsg] = useState("");
  // Once a reindex is requested, keep the activity poller warm so the ticker
  // appears as soon as the job starts.
  const [watchActivity, setWatchActivity] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [editingBranch, setEditingBranch] = useState(false);
  const [pendingBranch, setPendingBranch] = useState(s.branch ?? "main");
  const [savingBranch, setSavingBranch] = useState(false);

  async function handleReindex() {
    setReindexing(true);
    setReindexMsg("");
    try {
      const res = await fetch(prefix("/api/repos"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reindex", repoName: s.name }),
      });
      const d = await res.json() as { note?: string; error?: string };
      setReindexMsg(res.ok ? (d.note ?? "Queued.") : (d.error ?? "Error"));
      if (res.ok) {
        setWatchActivity(true);
        setTimeout(() => setReindexMsg(""), 3000);
      }
    } catch {
      setReindexMsg("Network error");
    } finally {
      setReindexing(false);
    }
  }

  async function handleRemove() {
    setRemoving(true);
    try {
      const res = await fetch(prefix("/api/repos"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "remove", repoName: s.name }),
      });
      if (res.ok) onChanged();
      else {
        const d = await res.json() as { error?: string };
        alert(d.error ?? "Could not remove.");
      }
    } catch {
      alert("Network error.");
    } finally {
      setRemoving(false);
      setConfirmRemove(false);
    }
  }

  async function handleSaveBranch() {
    if (!pendingBranch.trim() || pendingBranch === s.branch) {
      setEditingBranch(false);
      return;
    }
    setSavingBranch(true);
    try {
      const res = await fetch(prefix("/api/repos"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "change_branch", repoName: s.name, branch: pendingBranch.trim() }),
      });
      if (res.ok) {
        setEditingBranch(false);
        onChanged();
      } else {
        const d = await res.json() as { error?: string };
        alert(d.error ?? "Could not update branch.");
      }
    } catch {
      alert("Network error.");
    } finally {
      setSavingBranch(false);
    }
  }

  return (
    <div
      className="rounded-lg"
      style={{ background: "var(--sand)", border: "1px solid var(--line)" }}
      data-testid="source-row"
    >
      {/* Main row */}
      <div className="flex items-center justify-between gap-3 px-3 py-2">
        <div className="flex items-center gap-3 min-w-0">
          <span
            style={{ fontFamily: "var(--font-mono)" }}
            className="text-[12px] text-text truncate"
          >
            {s.name}
          </span>
          {status === "indexing" ? (
            <span style={{ fontFamily: "var(--font-mono)" }} className="text-[10px] text-text-muted flex-shrink-0">
              indexing…
            </span>
          ) : status === "queued" ? (
            <span style={{ fontFamily: "var(--font-mono)" }} className="text-[10px] text-text-muted flex-shrink-0">
              reindex queued
            </span>
          ) : status === "failed" ? (
            <span
              style={{ fontFamily: "var(--font-mono)", color: "var(--danger)" }}
              className="text-[10px] flex-shrink-0"
              title={st?.lastError ?? undefined}
            >
              index failed
            </span>
          ) : timeAgo(s.lastIndexedAt) ? (
            <span style={{ fontFamily: "var(--font-mono)" }} className="text-[10px] text-text-muted flex-shrink-0">
              indexed {timeAgo(s.lastIndexedAt)}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span
            style={{ fontFamily: "var(--font-mono)" }}
            className="text-[9px] uppercase tracking-wider px-2 py-1 rounded-full bg-paper text-text-muted border border-line"
          >
            {chip}
          </span>
          {indexing && <StatusPill kind="live">Indexing</StatusPill>}
          {status === "queued" && <StatusPill kind="idle">Queued</StatusPill>}
          {status === "failed" && <StatusPill kind="warn">Failed</StatusPill>}

          {/* Actions — only for non-docs sources */}
          {s.kind !== "docs" && (
            <div className="flex items-center gap-1">
              {/* Branch pill / edit toggle */}
              {!editingBranch ? (
                <button
                  onClick={() => { setPendingBranch(s.branch ?? "main"); setEditingBranch(true); }}
                  title="Change base branch"
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 10,
                    padding: "2px 7px",
                    borderRadius: 4,
                    border: "1px solid var(--line)",
                    background: "var(--paper)",
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  {s.branch ?? "main"}
                </button>
              ) : null}

              {/* Index history toggle */}
              <button
                onClick={() => setShowLog((v) => !v)}
                title="Index history"
                style={{
                  fontSize: 12,
                  padding: "2px 6px",
                  borderRadius: 4,
                  border: "1px solid var(--line)",
                  background: showLog ? "var(--sand)" : "var(--paper)",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  lineHeight: 1,
                }}
                data-testid="index-log-toggle"
              >
                ≡
              </button>

              {/* Reindex button */}
              <button
                onClick={handleReindex}
                disabled={reindexing}
                title="Reindex"
                style={{
                  fontSize: 12,
                  padding: "2px 6px",
                  borderRadius: 4,
                  border: "1px solid var(--line)",
                  background: "var(--paper)",
                  color: reindexing ? "var(--text-muted)" : "var(--text-muted)",
                  cursor: reindexing ? "not-allowed" : "pointer",
                  lineHeight: 1,
                }}
              >
                {reindexing ? "…" : "↻"}
              </button>

              {/* Remove button / confirm */}
              {!confirmRemove ? (
                <button
                  onClick={() => setConfirmRemove(true)}
                  title="Remove from index"
                  style={{
                    fontSize: 11,
                    padding: "2px 6px",
                    borderRadius: 4,
                    border: "1px solid var(--line)",
                    background: "var(--paper)",
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    lineHeight: 1,
                  }}
                >
                  ×
                </button>
              ) : (
                <span className="flex items-center gap-1">
                  <span style={{ fontSize: 10, color: "var(--text-muted)" }}>Remove?</span>
                  <button
                    onClick={handleRemove}
                    disabled={removing}
                    style={{
                      fontSize: 10,
                      padding: "2px 6px",
                      borderRadius: 4,
                      border: "1px solid rgba(168,80,70,0.4)",
                      background: "rgba(168,80,70,0.07)",
                      color: "var(--danger)",
                      cursor: removing ? "not-allowed" : "pointer",
                    }}
                  >
                    {removing ? "…" : "Yes"}
                  </button>
                  <button
                    onClick={() => setConfirmRemove(false)}
                    style={{
                      fontSize: 10,
                      padding: "2px 6px",
                      borderRadius: 4,
                      border: "1px solid var(--line)",
                      background: "var(--paper)",
                      color: "var(--text-muted)",
                      cursor: "pointer",
                    }}
                  >
                    No
                  </button>
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Live indexer activity — appears while an index job runs */}
      {s.kind !== "docs" && <IndexActivityStrip repo={s.name} active={indexing || watchActivity} />}

      {/* Durable index history */}
      {showLog && s.kind !== "docs" && <IndexLogPanel repo={s.name} />}

      {/* Branch edit inline panel */}
      {editingBranch && (
        <div
          className="flex items-center gap-2 px-3 py-2"
          style={{ borderTop: "1px solid var(--line)", background: "var(--paper)" }}
        >
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Branch:</span>
          <BranchSelect
            repo={s.name}
            localPath={s.localPath ?? undefined}
            value={pendingBranch}
            fallback={s.branch ?? "main"}
            onChange={setPendingBranch}
            style={branchSelectStyle}
          />
          <button
            onClick={handleSaveBranch}
            disabled={savingBranch || !pendingBranch.trim()}
            style={{
              fontSize: 11,
              padding: "3px 10px",
              borderRadius: 4,
              border: "none",
              background: savingBranch ? "var(--sand)" : "var(--accent)",
              color: savingBranch ? "var(--text-muted)" : "var(--ink)",
              cursor: savingBranch ? "not-allowed" : "pointer",
              fontWeight: 600,
            }}
          >
            {savingBranch ? "Saving…" : "Save"}
          </button>
          <button
            onClick={() => setEditingBranch(false)}
            style={{
              fontSize: 11,
              padding: "3px 8px",
              borderRadius: 4,
              border: "1px solid var(--line)",
              background: "var(--paper)",
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
        </div>
      )}

      {/* Reindex feedback */}
      {reindexMsg && (
        <div
          className="px-3 py-1"
          style={{ borderTop: "1px solid var(--line)", fontSize: 10, color: "var(--text-muted)" }}
        >
          {reindexMsg}
        </div>
      )}
    </div>
  );
}

// ── The two doors, shared by hero and strip ─────────────────────────────────
function TwoDoors({
  repos,
  mode,
  onChanged,
}: {
  repos: SourceEntry[];
  mode: FlowMode;
  onChanged: () => void;
}) {
  const [msg, setMsg] = useState("");
  // Repos already connected — so the GitHub checklist shows them as indexed.
  const indexedUrls = new Set<string>([
    ...repos.map((r) => r.url).filter((u): u is string => !!u),
    ...repos.map((r) => r.name),
  ]);

  return (
    <div className="flex flex-col gap-4">
      {/* Folder door — local mode only. */}
      {mode !== "prod" && (
        <div
          className="rounded-xl border p-5"
          style={{ background: "var(--paper)", borderColor: "var(--line)" }}
        >
          <AddFolder mode={mode} onAdded={onChanged} />
        </div>
      )}

      {/* GitHub door — pick from your account's repos. */}
      <div
        className="rounded-xl border p-5"
        style={{ background: "var(--paper)", borderColor: "var(--line)" }}
      >
        <div
          style={{ fontFamily: "var(--font-mono)" }}
          className="text-[13px] font-medium text-ink mb-1"
        >
          GitHub repos
        </div>
        <p className="text-text-muted text-[12.5px] leading-relaxed mb-3">
          Pick repositories to understand.
        </p>
        <RepoPicker indexedUrls={indexedUrls} onMsg={setMsg} onConnected={onChanged} />
        {msg && <p className="text-[12px] text-text-muted mt-2">{msg}</p>}
      </div>
    </div>
  );
}

interface Props {
  variant: "hero" | "strip";
  repos: SourceEntry[];
  mode: FlowMode;
  onChanged: () => void;
}

export function SourcesFrontDoor({ variant, repos, mode, onChanged }: Props) {
  const [open, setOpen] = useState(false);
  const { prefix } = useProject();

  // Per-repo indexer state machine — polls faster while anything is running
  // or queued so "indexing → indexed" flips without a page refresh.
  const [statuses, setStatuses] = useState<Record<string, RepoStatusEntry>>({});
  useEffect(() => {
    if (variant !== "strip") return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      let busy = false;
      try {
        const res = await fetch(prefix("/api/repos/status"));
        const d = (await res.json()) as { repos?: RepoStatusEntry[] };
        if (!alive) return;
        const map: Record<string, RepoStatusEntry> = {};
        for (const r of d.repos ?? []) map[r.name] = r;
        setStatuses(map);
        busy = (d.repos ?? []).some((r) => r.status === "indexing" || r.status === "queued");
      } catch {
        /* orchestrator briefly unreachable — keep last statuses */
      }
      if (alive) timer = setTimeout(tick, busy ? 5000 : 30000);
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [variant, prefix]);

  // ── First run: welcome + the two doors, full width ─────────────────────────
  if (variant === "hero") {
    return (
      <section data-testid="sources-hero" className="flex flex-col gap-5">
        <div>
          <Kicker>Getting started</Kicker>
          <Heading as="h1" className="text-[34px] mt-3 mb-3">
            Connect a source.
          </Heading>
          <p className="text-text-muted text-[15px] leading-relaxed max-w-xl">
            Flow builds a knowledge graph from it, and your coding agents use it
            as their brain.
          </p>
        </div>
        <TwoDoors repos={repos} mode={mode} onChanged={onChanged} />
      </section>
    );
  }

  // ── Returning: compact strip + inline "+ Add a source" ─────────────────────
  return (
    <div className="flex flex-col gap-3" data-testid="sources-strip">
      <div className="flex items-center justify-between">
        <Kicker>Sources</Kicker>
      </div>

      {repos.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {repos.map((s, i) => (
            <SourceRow key={i} s={s} st={statuses[s.name]} onChanged={onChanged} />
          ))}
        </div>
      )}

      <div className="rounded-xl border border-line bg-paper p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-text-muted text-[12px]">
            {mode === "prod"
              ? "Pick another GitHub repo to add a source."
              : "Point Flow at a folder or pick a GitHub repo to add another source."}
          </span>
          <button
            onClick={() => setOpen((v) => !v)}
            className="flex-shrink-0 text-[10px] uppercase tracking-wider px-3 py-1.5 rounded-full border border-dashed border-line text-text-muted hover:border-ink/20 hover:text-ink transition-colors"
            style={{ fontFamily: "var(--font-mono)" }}
            data-testid="add-source-affordance"
          >
            {open ? "Close" : "+ Add a source"}
          </button>
        </div>
        {open && (
          <div className="border-t border-line pt-4">
            <TwoDoors repos={repos} mode={mode} onChanged={onChanged} />
          </div>
        )}
      </div>
    </div>
  );
}
