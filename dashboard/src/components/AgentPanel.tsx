"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useProject } from "@/lib/useProject";
import { Kicker, Button, StatusPill } from "@/components/ui";
import { BrandIcon, type BrandName } from "@/components/BrandIcon";
import { MentionTextarea, type FileEntry } from "@/components/MentionTextarea";

interface DetectedAgent {
  id: string;
  name: string;
  installed: boolean;
  version?: string;
}

interface RepoOption {
  name: string;
  cloned: boolean;
  surface?: "folder" | "managed";
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

export function AgentPanel({ nodeCount, selectedNodeTag, onClearNodeTag, onOpenDrawer }: AgentPanelProps) {
  const router = useRouter();
  const { prefix } = useProject();

  const [agents, setAgents] = useState<DetectedAgent[]>([]);
  const [repos, setRepos] = useState<RepoOption[]>([]);
  const [workFolders, setWorkFolders] = useState<{ path: string; repo: string | null }[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);

  const [backend, setBackend] = useState("");
  const [repo, setRepo] = useState("");
  const [workFolder, setWorkFolder] = useState("");
  const [prompt, setPrompt] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");

  const hasRepos = repos.length > 0;
  const isInputDisabled = !hasRepos;

  // Append node tag if clicked in canvas
  useEffect(() => {
    if (selectedNodeTag) {
      const tag = `@${selectedNodeTag}`;
      if (!prompt.includes(tag)) {
        setPrompt((prev) => (prev ? `${prev} ${tag}` : tag));
      }
      if (onClearNodeTag) onClearNodeTag();
    }
  }, [selectedNodeTag, prompt, onClearNodeTag]);

  const refresh = useCallback(async () => {
    try {
      const [a, s] = await Promise.all([
        fetch(prefix("/api/agents")).then((r) => (r.ok ? r.json() : {})) as Promise<{
          agents?: DetectedAgent[];
          repos?: RepoOption[];
          workFolders?: { path: string; repo: string | null }[];
        }>,
        fetch(prefix("/api/agents/sessions")).then((r) => (r.ok ? r.json() : {})) as Promise<{
          sessions?: SessionRow[];
        }>,
      ]);
      const detected = a.agents ?? [];
      setAgents(detected);
      const clonedRepos = (a.repos ?? []).filter((r: RepoOption) => r.cloned);
      setRepos(clonedRepos);
      setWorkFolders(a.workFolders ?? []);
      setSessions(s.sessions ?? []);
      setBackend((prev) => prev || detected.find((x: DetectedAgent) => x.installed)?.id || detected[0]?.id || "");
      setRepo((prev) => prev || clonedRepos[0]?.name || "");
    } catch {
      // swallow
    }
  }, [prefix]);

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 5000);
    return () => clearInterval(iv);
  }, [refresh]);

  const fetchFiles = useCallback(
    (q: string) => {
      if (!repo) return Promise.resolve([]);
      const folder = workFolder ? `&folder=${encodeURIComponent(workFolder)}` : "";
      return fetch(prefix(`/api/agents/repos/files?repo=${encodeURIComponent(repo)}&q=${encodeURIComponent(q)}${folder}`))
        .then((r) => (r.ok ? r.json() : { entries: [] }))
        .then((d: { entries?: FileEntry[] }) => d.entries ?? []);
    },
    [repo, workFolder, prefix]
  );

  async function handleStartTask(e: React.FormEvent) {
    e.preventDefault();
    if (isInputDisabled || !backend || !repo || !prompt.trim() || starting) return;

    setStarting(true);
    setError("");

    try {
      const res = await fetch(prefix("/api/agents/sessions"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          backend,
          repo,
          prompt,
          ...(workFolder ? { workFolder } : {}),
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);

      setPrompt("");
      refresh();
      if (data.id) {
        router.push(prefix(`/agents/${data.id}`));
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStarting(false);
    }
  }

  function handleQuickTemplate(templateText: string) {
    setPrompt(templateText);
  }

  return (
    <div
      className="flex flex-col gap-5 p-5 rounded-xl border border-line bg-paper h-full justify-between"
      style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}
    >
      <div className="flex flex-col gap-5">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line pb-3">
          <div>
            <Kicker>Agent Task Runner</Kicker>
            <h2
              style={{ fontFamily: "var(--font-display)" }}
              className="text-base font-semibold text-ink mt-0.5"
            >
              New Agent Task
            </h2>
          </div>
          {hasRepos && (
            <span
              style={{ fontFamily: "var(--font-mono)" }}
              className="text-[10px] uppercase font-mono px-2 py-0.5 rounded bg-sand border border-line text-ink font-medium"
            >
              {nodeCount > 0 ? `${nodeCount} nodes ready` : "Indexing"}
            </span>
          )}
        </div>

      {/* Context Status Banner */}
      {!hasRepos && (
        <div
          className="rounded-lg p-3 bg-sand border border-line flex items-center gap-2.5 text-[12px] text-text-muted"
          data-testid="agent-panel-locked-hint"
        >
          <span className="w-2 h-2 rounded-full bg-warn flex-shrink-0" />
          <span>Add a source above to unlock agent tasks</span>
        </div>
      )}

        {hasRepos && nodeCount === 0 && (
          <div className="rounded-lg p-2.5 bg-sand border border-accent/30 flex items-center gap-2 text-[12px] text-text">
            <span className="w-2 h-2 rounded-full bg-accent animate-pulse flex-shrink-0" />
            <span>Indexing codebase... Submitting tasks enabled.</span>
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleStartTask} className="flex flex-col gap-4">
          {/* Agent Engine Selector Chips */}
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-text-muted mb-1.5 font-mono">
              Agent Engine
            </label>
            <div className="grid grid-cols-3 gap-1.5">
              {agents.map((a) => {
                const isSelected = backend === a.id;
                const brand = AGENT_BRANDS[a.id];
                return (
                  <button
                    key={a.id}
                    type="button"
                    disabled={!a.installed}
                    onClick={() => setBackend(a.id)}
                    className={`flex items-center justify-center gap-1.5 p-2 rounded-lg border text-[11px] font-medium transition-all ${
                      isSelected
                        ? "bg-ink text-paper border-ink shadow-xs"
                        : "bg-cream text-ink border-line hover:border-ink/30"
                    } ${!a.installed ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}
                  >
                    {brand && <BrandIcon name={brand} size={13} className={isSelected ? "text-paper" : "text-ink"} />}
                    <span>{a.name.split(" ")[0]}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Target Repo Picker */}
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-text-muted mb-1 font-mono">
              Target Codebase
            </label>
            <select
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              disabled={!hasRepos}
              className="w-full rounded-md border border-line bg-cream px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-ink/20 disabled:opacity-50"
            >
              {repos.map((r) => (
                <option key={r.name} value={r.name}>
                  {r.name} ({r.surface === "folder" ? "local folder" : "repo"})
                </option>
              ))}
              {repos.length === 0 && <option value="">No repos connected</option>}
            </select>
          </div>

          {/* Task Prompt Input */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-[10px] uppercase tracking-wider text-text-muted font-mono">
                Task Prompt (@ to tag)
              </label>
              <span className="text-[10px] text-text-muted font-mono">Click graph node to tag</span>
            </div>
            <div className={isInputDisabled ? "opacity-50 pointer-events-none" : ""}>
              <MentionTextarea
                value={prompt}
                onChange={setPrompt}
                fetchFiles={fetchFiles}
                placeholder={
                  isInputDisabled
                    ? "Connect a source above to unlock prompt input..."
                    : "Describe what task or refactoring step to perform..."
                }
                rows={4}
              />
            </div>
          </div>

          {/* Quick Template Chips */}
          {hasRepos && !prompt && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[10px] text-text-muted font-mono uppercase">Quick:</span>
              <button
                type="button"
                onClick={() => handleQuickTemplate("Explain the architecture and main entry points")}
                className="text-[10px] font-mono px-2 py-0.5 rounded bg-sand border border-line text-text-muted hover:text-ink hover:border-ink/30 transition-colors"
              >
                Explain architecture
              </button>
              <button
                type="button"
                onClick={() => handleQuickTemplate("Audit routes and verify API contracts")}
                className="text-[10px] font-mono px-2 py-0.5 rounded bg-sand border border-line text-text-muted hover:text-ink hover:border-ink/30 transition-colors"
              >
                Audit APIs
              </button>
            </div>
          )}

          {error && <p className="text-[12px] text-warn font-medium">{error}</p>}

          <Button
            type="submit"
            variant="primary"
            disabled={isInputDisabled || !prompt.trim() || starting || !backend || !repo}
            arrow
            className="w-full justify-center py-2.5 font-medium"
          >
            {starting ? "Starting Task..." : "Run Agent Task"}
          </Button>
        </form>
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
          <p className="text-[11px] text-text-muted italic py-1 text-center">
            No agent sessions run yet.
          </p>
        ) : (
          <div className="flex flex-col gap-2 max-h-52 overflow-y-auto pr-1">
            {sessions.slice(0, 4).map((s) => (
              <Link
                key={s.id}
                href={prefix(`/agents/${s.id}`)}
                className="flex items-center justify-between p-2 rounded-lg border border-line bg-cream hover:bg-sand transition-colors text-decoration-none group"
              >
                <div className="min-w-0 flex-1 mr-2">
                  <div className="text-[12px] font-medium text-ink truncate group-hover:underline">
                    {s.title || "Untitled task"}
                  </div>
                  <div className="text-[10px] text-text-muted font-mono truncate">
                    {s.repo} · {timeAgo(s.updated_at)}
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
