"use client";

import React, { useEffect, useState } from "react";
import { BrainGraph } from "@/components/BrainGraph";
import { useProject } from "@/lib/useProject";

interface ActivityEvent {
  seq: number;
  ts: number;
  kind: "file" | "graph" | "bash" | "tool";
  label: string;
}

interface IndexActivityData {
  status?: string;
  counts?: {
    filesRead?: number;
    graphWrites?: number;
    toolCalls?: number;
  };
  events?: ActivityEvent[];
}

interface BrainCanvasProps {
  nodeCount: number;
  edgeCount: number;
  isIndexing: boolean;
  pollInterval?: number;
  height?: number;
  onConnectFirstSource?: () => void;
  onNodeClick?: (nodeName: string) => void;
  onGraphStats?: (stats: { nodeCount: number; edgeCount: number; error?: string }) => void;
  sources?: Array<{ source: string; catching_up: boolean; last_poll_at: number }>;
  repos?: Array<{ name: string; lastIndexedCommit?: string; kind?: string }>;
}

export function BrainCanvas({
  nodeCount,
  isIndexing,
  pollInterval = 0,
  height = 420,
  onConnectFirstSource,
  onNodeClick,
  onGraphStats,
  sources = [],
  repos = [],
}: BrainCanvasProps) {
  const { prefix } = useProject();
  const [activity, setActivity] = useState<IndexActivityData | null>(null);
  const [showLogs, setShowLogs] = useState(false);

  const [statusRepo, setStatusRepo] = useState("");

  // The status endpoint knows which repo is actually indexing (or queued) —
  // repos[0] is just whichever source was added first and is usually idle in
  // multi-repo projects. Fallback: first indexable repo with no indexed commit
  // (docs entries never get one, so they'd wedge the guess).
  const guessRepo =
    repos.find((r) => r.kind !== "docs" && !r.lastIndexedCommit)?.name ?? repos[0]?.name ?? "";
  const activeRepo = statusRepo || guessRepo;

  // Resolve the actively-indexing repo while indexing
  useEffect(() => {
    if (!isIndexing) return;

    function fetchStatus() {
      fetch(prefix("/api/repos/status"))
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { repos?: Array<{ name: string; status: string }> } | null) => {
          const rows = d?.repos ?? [];
          const active =
            rows.find((r) => r.status === "indexing") ?? rows.find((r) => r.status === "queued");
          if (active) setStatusRepo(active.name);
        })
        .catch(() => {});
    }

    fetchStatus();
    const iv = setInterval(fetchStatus, 5000);
    return () => clearInterval(iv);
  }, [isIndexing, prefix]);

  // Poll live index activity when indexing
  useEffect(() => {
    if (!isIndexing || !activeRepo) return;

    function fetchActivity() {
      fetch(prefix(`/api/index-activity?repo=${encodeURIComponent(activeRepo)}`))
        .then((r) => (r.ok ? r.json() : null))
        .then((d: IndexActivityData | null) => setActivity(d))
        .catch(() => {});
    }

    fetchActivity();
    const iv = setInterval(fetchActivity, 2000);
    return () => clearInterval(iv);
  }, [isIndexing, activeRepo, prefix]);

  const hasSources = repos.length > 0 || sources.length > 0;
  const stage = !hasSources && nodeCount === 0 && !isIndexing ? 0 : isIndexing ? 1 : 2;

  function handleEmptyClick() {
    if (onConnectFirstSource) {
      onConnectFirstSource();
    } else {
      const el = document.getElementById("sources-section");
      if (el) {
        el.scrollIntoView({ behavior: "smooth" });
      }
    }
  }

  // ── Stage 0: Empty Brain Canvas ──────────────────────────────────────────────
  if (stage === 0) {
    return (
      <div
        onClick={handleEmptyClick}
        className="rounded-2xl border border-line p-8 text-white flex flex-col items-center justify-center text-center relative overflow-hidden cursor-pointer group hover:border-accent/50 transition-all shadow-sm"
        style={{ background: "rgb(54, 55, 38)", height: height, maxHeight: height }}
      >
        <div className="max-w-md flex flex-col items-center gap-3.5 z-10 rise-in">
          <div className="w-12 h-12 rounded-full border border-white/20 bg-white/5 flex items-center justify-center text-accent group-hover:scale-105 group-hover:border-accent transition-all shadow-md">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="3" fill="currentColor" />
              <circle cx="5" cy="7" r="1.6" fill="currentColor" opacity="0.6" />
              <circle cx="19" cy="7" r="1.6" fill="currentColor" opacity="0.6" />
              <circle cx="5" cy="17" r="1.6" fill="currentColor" opacity="0.6" />
              <circle cx="19" cy="17" r="1.6" fill="currentColor" opacity="0.6" />
              <path d="M12 12L5 7M12 12L19 7M12 12L19 17" stroke="currentColor" strokeWidth="1" opacity="0.4" />
            </svg>
          </div>

          <div
            style={{ fontFamily: "var(--font-display)" }}
            className="text-white text-xl font-medium tracking-tight group-hover:text-accent transition-colors"
          >
            Connect sources to get started
          </div>

          <p className="text-white/50 text-xs leading-relaxed max-w-xs">
            Flow maps your codebase, APIs, and business rules into an interactive Knowledge Graph.
          </p>

          <div className="mt-2 flex items-center gap-1.5 text-accent text-xs font-mono font-medium group-hover:translate-y-0.5 transition-transform">
            <span>Click to select sources</span>
            <span>↓</span>
          </div>
        </div>

        <div className="absolute bottom-3 left-4 right-4 flex items-center justify-between text-[10px] font-mono text-white/30 border-t border-white/10 pt-2">
          <span>THE BRAIN</span>
          <span>0 NODES · DISCONNECTED</span>
        </div>
      </div>
    );
  }

  // Live activity events
  const events = activity?.events ?? [];

  // ── Stage 1 & 2: Interactive Brain Canvas with Hard-Bounded Height ──────────
  return (
    <div
      className="rounded-2xl border border-line overflow-hidden flex flex-col relative w-full"
      style={{ background: "rgb(54, 55, 38)", height: `${height}px`, maxHeight: `${height}px`, minHeight: `${height}px`, overflow: "hidden" }}
    >
      {/* Brain 3D Canvas */}
      <div className="relative w-full overflow-hidden" style={{ height: `${height}px`, maxHeight: `${height}px`, minHeight: `${height}px` }}>
        <BrainGraph
          pollInterval={pollInterval}
          height={height}
          isIndexing={isIndexing}
          onNodeClick={onNodeClick}
          onStats={onGraphStats}
        />

        {/* Embedded Ingestion Overlay directly inside Brain Container */}
        {stage === 1 && (
          <div
            className="absolute bottom-3 left-3 right-3 p-3 rounded-xl border border-accent/30 bg-black/85 text-white flex flex-col gap-2 z-20 shadow-xl rise-in"
            style={{ backdropFilter: "blur(8px)" }}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-accent animate-pulse flex-shrink-0" />
                <span style={{ fontFamily: "var(--font-display)" }} className="text-white text-xs font-medium">
                  Flow is building your Knowledge Graph...
                </span>
              </div>
              <div className="flex items-center gap-3">
                {nodeCount > 0 && (
                  <span style={{ fontFamily: "var(--font-mono)" }} className="text-[10px] text-white/60">
                    {nodeCount} nodes mapped
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => setShowLogs((v) => !v)}
                  style={{ fontFamily: "var(--font-mono)" }}
                  className="text-[10px] uppercase font-mono text-accent hover:underline bg-white/10 px-2 py-0.5 rounded cursor-pointer"
                >
                  {showLogs ? "Hide logs ▲" : `Logs (${events.length}) ▼`}
                </button>
              </div>
            </div>

            {/* Embedded Scrollable Progress Logs Stream */}
            {showLogs && (
              <div
                className="mt-1 p-3 rounded-lg border border-white/15 bg-black/95 font-mono text-[11px] text-white/90 flex flex-col gap-1.5 max-h-36 overflow-y-auto w-full break-all whitespace-pre-wrap leading-relaxed shadow-inner"
                style={{ scrollbarWidth: "thin" }}
              >
                {events.length === 0 ? (
                  <div className="text-white/40 italic py-1">Waiting for indexer output stream...</div>
                ) : (
                  events.slice(-15).map((ev, i) => (
                    <div key={i} className="flex items-start gap-2 w-full font-mono text-[10.5px]">
                      <span className="text-accent flex-shrink-0 font-bold">›</span>
                      <span className="text-white/85 break-all overflow-wrap-anywhere">{ev.label}</span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
