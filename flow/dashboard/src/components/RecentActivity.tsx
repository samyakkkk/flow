"use client";

import React from "react";
import Link from "next/link";
import { useProject } from "@/lib/useProject";
import { Heading } from "@/components/ui";

export interface AuditRow {
  id: number;
  classification?: string;
  action?: string;
  target?: string;
  status?: string;
  source?: string;
  ts?: number;
  detail?: string | null;
  created_at?: number;
}

function isUuid(str: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

function extractDetailName(detail: string | null | undefined): string | null {
  if (!detail) return null;
  try {
    const parsed = JSON.parse(detail) as Record<string, unknown>;
    if (typeof parsed.repo === "string") return parsed.repo;
    if (typeof parsed.name === "string") return parsed.name;
    if (typeof parsed.title === "string") return parsed.title;
    if (typeof parsed.setting === "string") return parsed.setting;
    const firstStr = Object.values(parsed).find((v) => typeof v === "string" && !isUuid(v));
    return typeof firstStr === "string" ? firstStr : null;
  } catch {
    return null;
  }
}

function humanizeActivity(row: AuditRow): string | null {
  const cls = row.classification ?? "";
  const action = row.action ?? "";
  const status = row.status ?? "";
  const detailName = extractDetailName(row.detail);
  let target = detailName ?? row.target ?? row.source ?? "";

  if (isUuid(target)) {
    target = "repository";
  }

  // Exclude noise, suppressed rows, and low-level runtime config changes
  if (cls === "noise" || action === "suppress" || status === "suppressed") return null;
  if (
    cls === "setting_change" ||
    action === "setting_change" ||
    target.includes("INDEXER_RUNTIME") ||
    target.includes("BRAIN_MODE") ||
    row.detail?.includes("INDEXER_RUNTIME") ||
    row.detail?.includes("BRAIN_MODE")
  ) {
    return null;
  }

  // Domain Milestone Mapping
  if (cls === "SOURCE_INDEXED" || ((cls === "index_job" || action === "index_repo") && status === "ok")) {
    return target && target !== "repository" ? `SOURCE_INDEXED: ${target}` : "SOURCE_INDEXED: Repository indexed";
  }
  if (cls === "index_job" || action === "index_repo") {
    return target && target !== "repository" ? `Indexing ${target}` : "Indexing repository";
  }
  if (cls === "TICKETS_SYNCED" || cls === "linear_sync" || cls === "fireflies_sync") {
    return target && target !== "repository" ? `TICKETS_SYNCED: ${target}` : "TICKETS_SYNCED: Integration tickets synced";
  }
  if (cls === "AGENT_TASK_COMPLETE" || cls === "agent_session_complete" || (cls === "agent_session" && status === "ok")) {
    return target && target !== "repository" ? `AGENT_TASK_COMPLETE: ${target}` : "AGENT_TASK_COMPLETE: Agent task finished";
  }
  if (cls === "knowledge_claim" || action === "graph_write" || action === "graphwrite") {
    return target && target !== "repository" ? `Learned fact from ${target}` : "Learned a new fact";
  }
  if (cls === "repo_added" || action === "repo_added") {
    return target && target !== "repository" ? `Connected ${target}` : "Connected new repository source";
  }
  if (action === "decision" || cls === "decision") {
    return target && target !== "repository" ? `Captured decision: ${target}` : "Captured a decision";
  }
  if (status === "ok" && target) {
    return `Updated ${target}`;
  }

  return null;
}

function timeAgo(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function RecentActivity({ rows }: { rows: AuditRow[] }) {
  const { prefix } = useProject();

  const visible = rows
    .map((r) => ({
      human: humanizeActivity(r),
      ts: r.ts ?? (r.created_at ? r.created_at * 1000 : undefined),
      id: r.id,
    }))
    .filter((r): r is { human: string; ts: number | undefined; id: number } => r.human !== null)
    .slice(0, 5);

  if (visible.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 p-4 rounded-xl border border-line bg-paper">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <Heading variant="section">Domain Milestones</Heading>
        <Link
          href={prefix("/activity")}
          className="text-[10px] text-text-muted hover:text-ink font-mono uppercase tracking-wider transition-colors"
        >
          View audit log ↗
        </Link>
      </div>

      <div className="space-y-2 mt-1">
        {visible.map((item) => (
          <div key={item.id} className="flex items-baseline justify-between gap-4 text-[12px] leading-relaxed border-b border-line/40 pb-1.5 last:border-0 last:pb-0">
            <span className="text-text">{item.human}</span>
            {item.ts && (
              <span
                className="text-[11px] text-text-muted flex-shrink-0"
              >
                {timeAgo(item.ts)}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
