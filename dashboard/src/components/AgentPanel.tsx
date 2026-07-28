"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useProject } from "@/lib/useProject";
import { Kicker, StatusPill } from "@/components/ui";
import { BrandIcon, type BrandName } from "@/components/BrandIcon";
import { AgentTaskComposer } from "@/components/AgentTaskComposer";

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

interface AgentPanelProps {
  nodeCount: number;
  selectedNodeTag?: string | null;
  onClearNodeTag?: () => void;
  onOpenDrawer?: () => void;
}

const AGENT_BRANDS: Record<string, BrandName> = {
  claude: "anthropic",
  codex: "openai",
  opencode: "opencode",
};

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

export function AgentPanel({ nodeCount, selectedNodeTag, onClearNodeTag }: AgentPanelProps) {
  const { prefix } = useProject();
  const [sessions, setSessions] = useState<SessionRow[]>([]);

  const refreshSessions = useCallback(async () => {
    try {
      const res = await fetch(prefix("/api/agents/sessions"));
      if (res.ok) {
        const data = await res.json();
        setSessions(data.sessions ?? []);
      }
    } catch {
      // swallow
    }
  }, [prefix]);

  useEffect(() => {
    refreshSessions();
    const iv = setInterval(refreshSessions, 5000);
    return () => clearInterval(iv);
  }, [refreshSessions]);

  return (
    <div
      className="flex flex-col gap-5 p-5 rounded-xl border border-line bg-paper h-full justify-between"
      style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}
    >
      <div className="flex flex-col gap-4">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line pb-3">
          <div>
            <Kicker>Agent Task Command Center</Kicker>
            <h2
              style={{ fontFamily: "var(--font-display)" }}
              className="text-base font-semibold text-ink mt-0.5"
            >
              New Agent Task
            </h2>
          </div>
          <span
            style={{ fontFamily: "var(--font-mono)" }}
            className="text-[10px] uppercase font-mono px-2 py-0.5 rounded bg-sand border border-line text-ink font-medium"
          >
            {nodeCount > 0 ? `${nodeCount} nodes mapped` : "Brain Ready"}
          </span>
        </div>

        {/* Task Composer Box */}
        <AgentTaskComposer
          nodeCount={nodeCount}
          selectedNodeTag={selectedNodeTag}
          onClearNodeTag={onClearNodeTag}
          compact
        />
      </div>

      {/* Recent Sessions */}
      <div className="flex flex-col gap-2.5 border-t border-line pt-4 mt-2">
        <div className="flex items-center justify-between">
          <Kicker>Recent Sessions</Kicker>
          <Link
            href={prefix("/agents")}
            className="text-[10px] text-text-muted hover:text-ink font-mono uppercase tracking-wider transition-colors"
          >
            View all ({sessions.length}) ↗
          </Link>
        </div>

        {sessions.length === 0 ? (
          <p className="text-[11px] text-text-muted italic py-1 text-center font-mono">
            No agent sessions run yet.
          </p>
        ) : (
          <div className="flex flex-col gap-2 max-h-52 overflow-y-auto pr-1">
            {sessions.slice(0, 4).map((s) => (
              <Link
                key={s.id}
                href={prefix(`/agents/${s.id}`)}
                className="flex items-center justify-between p-2.5 rounded-lg border border-line bg-cream hover:bg-sand transition-colors text-decoration-none group"
              >
                <div className="min-w-0 flex-1 mr-2">
                  <div className="text-[12.5px] font-medium text-ink truncate group-hover:underline">
                    {s.title || "Untitled task"}
                  </div>
                  <div className="text-[10px] text-text-muted font-mono truncate flex items-center gap-1.5 mt-0.5">
                    <BrandIcon
                      name={AGENT_BRANDS[s.backend] || "opencode"}
                      size={12}
                      className="text-text-muted"
                    />
                    <span>{s.backend}</span>
                    <span>·</span>
                    <span>{s.repo}</span>
                    <span>·</span>
                    <span>{timeAgo(s.updated_at)}</span>
                  </div>
                </div>
                <StatusPill kind={statusKind(s.status)}>
                  {statusLabel(s.status)}
                </StatusPill>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
