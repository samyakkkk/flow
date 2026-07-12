"use client";
// SourcesFrontDoor — the "sources front door" on the home page. Two doors,
// never one ambiguous box: an "Add a folder" input (local mode only — point
// Flow at a project folder or a folder of docs) stacked above the GitHub
// picker (the checklist of your account's repos). Two shapes share the doors:
//   • variant="hero"  — first run (no sources yet): a calm welcome, then the
//     two doors, front and centre.
//   • variant="strip" — returning: a compact list of connected sources plus an
//     always-visible "+ Add a source" that expands the same two doors inline.
import { useState } from "react";
import Link from "next/link";
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

// One quiet chip per source, keyed on what the entry actually is.
function sourceChip(s: SourceEntry): string {
  if (s.kind === "docs") return "docs · ingestion pending";
  if (s.localPath) return "your folder";
  return "GitHub-synced";
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

function SourceRow({ s, onChanged }: { s: SourceEntry; onChanged: () => void }) {
  const chip = sourceChip(s);
  const indexing = s.kind !== "docs" && !s.lastIndexedCommit;

  const [reindexing, setReindexing] = useState(false);
  const [reindexMsg, setReindexMsg] = useState("");
  const [removing, setRemoving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [editingBranch, setEditingBranch] = useState(false);
  const [pendingBranch, setPendingBranch] = useState(s.branch ?? "main");
  const [savingBranch, setSavingBranch] = useState(false);

  async function handleReindex() {
    setReindexing(true);
    setReindexMsg("");
    try {
      const res = await fetch("/api/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reindex", repoName: s.name }),
      });
      const d = await res.json() as { note?: string; error?: string };
      setReindexMsg(res.ok ? (d.note ?? "Queued.") : (d.error ?? "Error"));
      if (res.ok) setTimeout(() => setReindexMsg(""), 3000);
    } catch {
      setReindexMsg("Network error");
    } finally {
      setReindexing(false);
    }
  }

  async function handleRemove() {
    setRemoving(true);
    try {
      const res = await fetch("/api/repos", {
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
      const res = await fetch("/api/repos", {
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
        <span
          style={{ fontFamily: "var(--font-mono)" }}
          className="text-[12px] text-text truncate"
        >
          {s.name}
        </span>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span
            style={{ fontFamily: "var(--font-mono)" }}
            className="text-[9px] uppercase tracking-wider px-2 py-1 rounded-full bg-paper text-text-muted border border-line"
          >
            {chip}
          </span>
          {indexing && <StatusPill kind="live">Indexing</StatusPill>}

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
          className="text-[13px] font-semibold text-ink mb-1"
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
            <SourceRow key={i} s={s} onChanged={onChanged} />
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
