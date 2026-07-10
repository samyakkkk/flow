"use client";
// SourcesFrontDoor — puts the "sources front door" (AddSource) on the home page.
// Two shapes share one component so the paste-a-URL-or-folder flow is reachable
// the moment someone lands, not buried on /connections:
//   • variant="hero"  — first run (no sources yet): a calm welcome + AddSource
//     mounted full width, front and centre.
//   • variant="strip" — returning: a compact list of connected sources plus an
//     always-visible "+ Add a source" that expands the same AddSource inline.
import { useState } from "react";
import Link from "next/link";
import { AddSource } from "@/components/AddSource";
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

function SourceRow({ s }: { s: SourceEntry }) {
  const chip = sourceChip(s);
  // A registered code source with no commit recorded yet is still being read.
  const indexing = s.kind !== "docs" && !s.lastIndexedCommit;
  return (
    <div
      className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg"
      style={{ background: "var(--sand)", border: "1px solid var(--line)" }}
      data-testid="source-row"
    >
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

  // ── First run: welcome + the front door, full width ────────────────────────
  if (variant === "hero") {
    return (
      <section data-testid="sources-hero" className="flex flex-col gap-5">
        <div>
          <Kicker>Getting started</Kicker>
          <Heading as="h1" className="text-[34px] mt-3 mb-3">
            Connect a source.
          </Heading>
          <p className="text-text-muted text-[15px] leading-relaxed max-w-xl">
            Connect a source — Flow builds a knowledge graph from it and your coding
            agents use it as their brain.
          </p>
        </div>
        <div
          className="rounded-xl border p-5"
          style={{ background: "var(--paper)", borderColor: "var(--line)" }}
        >
          <AddSource mode={mode} onAdded={onChanged} />
        </div>
      </section>
    );
  }

  // ── Returning: compact strip + inline "+ Add a source" ─────────────────────
  return (
    <div className="flex flex-col gap-3" data-testid="sources-strip">
      <div className="flex items-center justify-between">
        <Kicker>Sources</Kicker>
        <Link
          href="/connections"
          className="text-[10px] text-text-muted hover:text-ink transition-colors"
          style={{ fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.08em" }}
        >
          Manage all ↗
        </Link>
      </div>

      {repos.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {repos.map((s, i) => (
            <SourceRow key={i} s={s} />
          ))}
        </div>
      )}

      <div className="rounded-xl border border-line bg-paper p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-text-muted text-[12px]">
            Paste a GitHub URL or a local folder path to add another source.
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
            <AddSource
              mode={mode}
              onAdded={() => {
                onChanged();
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
