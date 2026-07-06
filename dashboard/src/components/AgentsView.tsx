"use client";
// Agents home: your installed coding agents, a task kickoff form, and the
// session history. Sessions stream live in /agents/<id>.
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Kicker, Heading, Button, Card, StatusPill } from "@/components/ui";
import { BrandIcon, type BrandName } from "@/components/BrandIcon";

interface DetectedAgent {
  id: string;
  name: string;
  installed: boolean;
  version?: string;
  installHint: string;
}
interface RepoOption {
  name: string;
  cloned: boolean;
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

// Maps orchestrator backend ids to BrandIcon names.
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
  const [agents, setAgents] = useState<DetectedAgent[]>([]);
  const [repos, setRepos] = useState<RepoOption[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [backend, setBackend] = useState("");
  const [repo, setRepo] = useState("");
  const [prompt, setPrompt] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [a, s] = await Promise.all([
        fetch("/api/agents").then((r) => r.json()),
        fetch("/api/agents/sessions").then((r) => r.json()),
      ]);
      setAgents(a.agents ?? []);
      setRepos((a.repos ?? []).filter((r: RepoOption) => r.cloned));
      setSessions(s.sessions ?? []);
      setBackend((prev) => prev || (a.agents ?? []).find((x: DetectedAgent) => x.installed)?.id || "");
      setRepo((prev) => prev || (a.repos ?? [])[0]?.name || "");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 8000);
    return () => clearInterval(iv);
  }, [refresh]);

  async function start() {
    if (!backend || !repo || !prompt.trim()) return;
    setStarting(true);
    setError("");
    try {
      const res = await fetch("/api/agents/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ backend, repo, prompt }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `status ${res.status}`);
      router.push(`/agents/${data.id}`);
    } catch (e) {
      setError((e as Error).message);
      setStarting(false);
    }
  }

  return (
    <div className="max-w-4xl">
      <Kicker>Your coding agents</Kicker>
      <Heading className="mb-2">Give the work to an agent.</Heading>
      <p className="text-text-muted text-[14px] mb-8 max-w-xl">
        Flow runs the agents already on this machine and hands each session the
        brain — read-only — so they start from what your company knows.
      </p>

      {/* Detected agents */}
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

      {/* Kickoff */}
      <Card className="p-5 mb-10">
        <Kicker>New task</Kicker>
        <div className="flex gap-3 mt-3 mb-3 flex-wrap">
          <select
            value={backend}
            onChange={(e) => setBackend(e.target.value)}
            className="rounded-lg border border-line bg-cream px-3 py-2 text-[13px] text-ink"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {agents
              .filter((a) => a.installed)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
          <select
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            className="rounded-lg border border-line bg-cream px-3 py-2 text-[13px] text-ink"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {repos.map((r) => (
              <option key={r.name} value={r.name}>
                {r.name}
              </option>
            ))}
          </select>
        </div>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="What should the agent do? It will consult the brain first, then work in the repo."
          rows={3}
          className="w-full rounded-lg border border-line bg-cream px-3.5 py-3 text-[14px] text-ink placeholder:text-text-muted/60 focus:outline-none focus:border-black/20 resize-y mb-3"
        />
        {error && <p className="text-[12px] mb-3" style={{ color: "#b3261e" }}>{error}</p>}
        <Button onClick={start} disabled={starting || !prompt.trim() || !backend || !repo} arrow>
          {starting ? "Starting…" : "Start agent"}
        </Button>
      </Card>

      {/* Sessions */}
      <Kicker>Sessions</Kicker>
      <div className="mt-3 flex flex-col gap-2">
        {sessions.length === 0 && !loading && (
          <p className="text-text-muted text-[13px]">No sessions yet — start one above.</p>
        )}
        {sessions.map((s) => (
          <button
            key={s.id}
            onClick={() => router.push(`/agents/${s.id}`)}
            className="text-left rounded-lg border border-line bg-paper px-4 py-3 hover:bg-cream transition flex items-center gap-4"
          >
            <AgentBrandIcon backend={s.backend} className="text-ink flex-shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-ink text-[13.5px] truncate" style={{ fontFamily: "var(--font-display)" }}>
                {s.title}
              </p>
              <p style={{ fontFamily: "var(--font-mono)" }} className="text-[10px] uppercase tracking-wider text-text-muted">
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
