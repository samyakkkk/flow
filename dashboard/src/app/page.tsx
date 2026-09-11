"use client";

import React, { useEffect, useState, useCallback, useMemo } from "react";
import { Shell } from "@/components/Shell";
import { KeyGate } from "@/components/KeyGate";
import { BrainCanvas } from "@/components/BrainCanvas";
import { AgentPanel } from "@/components/AgentPanel";
import { IntegrationCatalog } from "@/components/IntegrationCatalog";
import { CodingToolsPanel } from "@/components/CodingToolsPanel";
import { SourceDrawer, type RepoEntry, type SettingItem } from "@/components/SourceDrawer";
import { RecentActivity, type AuditRow } from "@/components/RecentActivity";
import { Kicker, Heading, StatusPill } from "@/components/ui";
import { useMode } from "@/lib/useMode";
import { useProject } from "@/lib/useProject";

interface IngestSource {
  source: string;
  resource: string;
  catching_up: boolean;
  lag_seconds: number | null;
  last_poll_at: number;
  status: string;
}

type RepoIndexStatus = "never_indexed" | "queued" | "indexing" | "indexed" | "failed";

interface RepoStatusEntry {
  name: string;
  branch: string;
  status: RepoIndexStatus;
  lastIndexedCommit: string | null;
  lastIndexedAt: string | null;
  lastError: string | null;
  runningJobId: string | null;
  queuedJobId: string | null;
}

type HomeState = "loading" | "engine-down" | "no-brain" | "ready";

function hasBrainSettings(settings: SettingItem[]): boolean {
  return settings.some(
    (s) => (s.key === "OPENROUTER_API_KEY" || s.key === "LLM_API_KEY" || s.key === "BRAIN_MODE") && s.set
  );
}

function statusMap(rows: RepoStatusEntry[]): Record<string, RepoStatusEntry> {
  const map: Record<string, RepoStatusEntry> = {};
  for (const row of rows) map[row.name] = row;
  return map;
}

export default function HomePage() {
  const [state, setState] = useState<HomeState>("loading");
  const [settings, setSettings] = useState<SettingItem[]>([]);
  const [sources, setSources] = useState<IngestSource[]>([]);
  const [repos, setRepos] = useState<RepoEntry[]>([]);
  const [repoStatuses, setRepoStatuses] = useState<Record<string, RepoStatusEntry>>({});
  const [operationalLoaded, setOperationalLoaded] = useState(false);
  const [auditRows, setAuditRows] = useState<AuditRow[]>([]);
  const [graphNodeCount, setGraphNodeCount] = useState(0);
  const [graphEdgeCount, setGraphEdgeCount] = useState(0);

  // Drawer state
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);

  // Tagged node state passed to AgentPanel when a node in BrainCanvas is clicked
  const [selectedNodeTag, setSelectedNodeTag] = useState<string | null>(null);

  const { mode } = useMode();
  const { prefix } = useProject();

  const hasBrain = hasBrainSettings(settings);

  const reposWithStatus = useMemo<RepoEntry[]>(
    () =>
      repos.map((repo) => {
        const status = repoStatuses[repo.name];
        if (!status) return repo;
        return {
          ...repo,
          indexStatus: status.status,
          lastIndexedCommit: status.lastIndexedCommit ?? repo.lastIndexedCommit,
          lastIndexedAt: status.lastIndexedAt ?? repo.lastIndexedAt,
          lastError: status.lastError,
        };
      }),
    [repoStatuses, repos]
  );

  const hasSources = !operationalLoaded || reposWithStatus.length > 0;
  const isRepoIndexing = Object.values(repoStatuses).some((r) => r.status === "indexing" || r.status === "queued");
  const isIndexing = sources.some((s) => s.catching_up || s.status === "catching_up") || isRepoIndexing;

  const refreshOperationalData = useCallback(async () => {
    const [ingestRes, reposRes, repoStatusRes, auditRes] = await Promise.allSettled([
      fetch(prefix("/api/ingest/status")).then((r) => (r.ok ? r.json() : { sources: [] })) as Promise<{ sources: IngestSource[] }>,
      fetch(prefix("/api/repos")).then((r) => (r.ok ? r.json() : { repos: [] })) as Promise<{ repos: RepoEntry[] }>,
      fetch(prefix("/api/repos/status")).then((r) => (r.ok ? r.json() : { repos: [] })) as Promise<{ repos: RepoStatusEntry[] }>,
      fetch(prefix("/api/audit?limit=20")).then((r) => (r.ok ? r.json() : { rows: [] })) as Promise<{ rows: AuditRow[] }>,
    ]);

    if (ingestRes.status === "fulfilled") setSources(ingestRes.value.sources ?? []);
    if (reposRes.status === "fulfilled") setRepos(reposRes.value.repos ?? []);
    if (repoStatusRes.status === "fulfilled") setRepoStatuses(statusMap(repoStatusRes.value.repos ?? []));
    if (auditRes.status === "fulfilled") setAuditRows(auditRes.value.rows ?? []);
    setOperationalLoaded(true);
  }, [prefix]);

  const refreshSettings = useCallback(async () => {
    try {
      const settingsResp = await fetch(prefix("/api/settings"));
      if (settingsResp.status === 401) {
        window.location.href = "/login?from=%2F";
        return;
      }
      if (!settingsResp.ok) {
        setState("engine-down");
        return;
      }

      const s: unknown = await settingsResp.json();
      if (!Array.isArray(s) || !s.every(
        (item) => item !== null && typeof item === "object"
          && typeof item.key === "string" && typeof item.set === "boolean"
          && (item.value === undefined || item.value === null || typeof item.value === "string")
      )) {
        setState("engine-down");
        return;
      }
      setSettings(s);

      if (!hasBrainSettings(s)) {
        setState("no-brain");
        return;
      }

      setState("ready");
    } catch {
      setState("engine-down");
    }
  }, [prefix]);

  const loadAll = useCallback(async () => {
    const operational = refreshOperationalData();
    await refreshSettings();
    await operational;
  }, [refreshOperationalData, refreshSettings]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadAll();
    }, 0);
    return () => clearTimeout(timer);
  }, [loadAll]);

  // Engine down retry
  useEffect(() => {
    if (state !== "engine-down") return;
    const iv = setInterval(() => {
      void loadAll();
    }, 3000);
    return () => clearInterval(iv);
  }, [state, loadAll]);

  // Background refresh poll
  useEffect(() => {
    if (state !== "ready") return;
    const interval = isIndexing ? 5000 : 30000;
    const iv = setInterval(() => {
      void refreshOperationalData();
    }, interval);
    return () => clearInterval(iv);
  }, [state, isIndexing, refreshOperationalData]);

  const scrollToSources = useCallback(() => {
    const el = document.getElementById("sources-section");
    if (el) {
      el.scrollIntoView({ behavior: "smooth" });
    } else {
      setIsDrawerOpen(true);
    }
  }, []);

  const handleNodeClick = useCallback((nodeName: string) => {
    setSelectedNodeTag(nodeName);
    const agentEl = document.getElementById("agent-runner-section");
    if (agentEl) {
      agentEl.scrollIntoView({ behavior: "smooth" });
    }
  }, []);

  const handleGraphStats = useCallback(({ nodeCount, edgeCount }: { nodeCount: number; edgeCount: number }) => {
    setGraphNodeCount(nodeCount);
    setGraphEdgeCount(edgeCount);
  }, []);

  if (state === "loading") {
    return <div className="min-h-screen bg-cream" />;
  }

  if (state === "engine-down") {
    return (
      <div className="min-h-screen flex items-center justify-center px-6 bg-cream">
        <div className="w-full max-w-lg rise-in text-center">
          <div className="inline-block w-2.5 h-2.5 rounded-full bg-accent animate-pulse mb-6" />
          <h1 className="font-display font-medium text-[32px] leading-tight mb-3">
            Flow&apos;s engine isn&apos;t reachable.
          </h1>
          <p className="text-text-muted text-[15px] leading-relaxed mb-6">
            The dashboard is running, but this project&apos;s orchestrator isn&apos;t answering.
          </p>
          <div className="text-left inline-block bg-paper border border-line rounded-lg px-5 py-4 font-mono text-[13px] leading-loose">
            <div>flow doctor</div>
            <div>flow up</div>
          </div>
        </div>
      </div>
    );
  }

  if (state === "no-brain" || !hasBrain) {
    return <KeyGate onReady={() => void loadAll()} />;
  }

  return (
    <Shell>
      <div className="flex flex-col gap-6 rise-in">
        {/* Top Header */}
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div>
            <Kicker>{mode === "prod" ? "Production" : "Local mode"}</Kicker>
            <Heading as="h1" className="text-[30px] mt-1 font-medium">
              {isIndexing ? "Flow is learning." : "Flow builds your memory."}
            </Heading>
          </div>
          {hasSources && graphNodeCount > 0 && (
            <div className="flex items-center gap-2 pt-2">
              <StatusPill kind={isIndexing ? "live" : "ok"}>
                {isIndexing ? "Indexing" : `${graphNodeCount.toLocaleString()} facts mapped`}
              </StatusPill>
            </div>
          )}
        </div>

        {/* 1. TOP HERO: THE BRAIN CANVAS (Full Width) */}
        <div className="w-full">
          <BrainCanvas
            nodeCount={graphNodeCount}
            edgeCount={graphEdgeCount}
            isIndexing={isIndexing}
            pollInterval={isIndexing ? 15000 : 60000}
            height={hasSources ? 480 : 360}
            onConnectFirstSource={scrollToSources}
            onNodeClick={handleNodeClick}
            onGraphStats={handleGraphStats}
            sources={sources}
            repos={reposWithStatus}
          />
        </div>

        {/* 2. MIDDLE SECTION: CONNECT SOURCES & INTEGRATIONS */}
        <div id="sources-section" className="w-full">
          <IntegrationCatalog
            repos={reposWithStatus}
            settings={settings}
            mode={mode}
            onChanged={() => void loadAll()}
          />
        </div>

        {/* 3. THE INTERFACE DECISION: use Flow in your own AI tools (left) —
            or drive it from Flow's own interface (right). Same brain either
            way. The section header + the "or" badge in the gap make the
            either/or legible before any card text is read. */}
        <div className="flex items-center gap-4 w-full pt-2">
          <span className="h-px bg-line flex-1" />
          <span className="text-[11px] uppercase tracking-widest text-ink/50">
            Two ways to use Flow — pick your interface
          </span>
          <span className="h-px bg-line flex-1" />
        </div>
        <div id="agent-runner-section" className="grid grid-cols-1 lg:grid-cols-12 gap-6 w-full">
          {/* Your AI tools: workspace connection column */}
          <div id="coding-tools-section" className="lg:col-span-5 flex flex-col">
            <CodingToolsPanel />
          </div>

          {/* Flow's interface: agent trigger + activity */}
          <div className="lg:col-span-7 flex flex-col gap-6">
            <AgentPanel
              nodeCount={graphNodeCount}
              selectedNodeTag={selectedNodeTag}
              onClearNodeTag={() => setSelectedNodeTag(null)}
              onOpenDrawer={() => setIsDrawerOpen(true)}
            />
            <RecentActivity rows={auditRows} />
          </div>
        </div>
      </div>

      {/* Slide-Over Source Drawer */}
      <SourceDrawer
        isOpen={isDrawerOpen}
        onClose={() => setIsDrawerOpen(false)}
        repos={reposWithStatus}
        settings={settings}
        mode={mode}
        onChanged={() => void loadAll()}
      />
    </Shell>
  );
}
