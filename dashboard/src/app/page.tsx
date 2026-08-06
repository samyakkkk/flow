"use client";

import React, { useEffect, useState, useCallback } from "react";
import { Shell } from "@/components/Shell";
import { KeyGate } from "@/components/KeyGate";
import { BrainCanvas } from "@/components/BrainCanvas";
import { AgentPanel } from "@/components/AgentPanel";
import { IntegrationCatalog } from "@/components/IntegrationCatalog";
import { CodingToolsPanel } from "@/components/CodingToolsPanel";
import { SourcesPillStrip, SourceDrawer, type RepoEntry, type SettingItem } from "@/components/SourceDrawer";
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

type HomeState = "loading" | "engine-down" | "no-brain" | "ready";

export default function HomePage() {
  const [state, setState] = useState<HomeState>("loading");
  const [settings, setSettings] = useState<SettingItem[]>([]);
  const [sources, setSources] = useState<IngestSource[]>([]);
  const [repos, setRepos] = useState<RepoEntry[]>([]);
  const [auditRows, setAuditRows] = useState<AuditRow[]>([]);
  const [graphNodeCount, setGraphNodeCount] = useState(0);
  const [graphEdgeCount, setGraphEdgeCount] = useState(0);

  // Drawer state
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);

  // Tagged node state passed to AgentPanel when a node in BrainCanvas is clicked
  const [selectedNodeTag, setSelectedNodeTag] = useState<string | null>(null);

  const { mode } = useMode();
  const { prefix } = useProject();

  const hasBrain = settings.some(
    (s) => (s.key === "OPENROUTER_API_KEY" || s.key === "LLM_API_KEY" || s.key === "BRAIN_MODE") && s.set
  );

  const hasSources = repos.length > 0;
  const isAnyRepoIndexing = repos.some((r) => !r.lastIndexedCommit);
  const isIndexing = sources.some((s) => s.catching_up) || isAnyRepoIndexing;

  const loadAll = useCallback(async () => {
    try {
      const settingsResp = await fetch(prefix("/api/settings"));
      if (settingsResp.status === 401) {
        window.location.href = "/login?from=%2F";
        return;
      }
      if (settingsResp.status >= 500) {
        setState("engine-down");
        return;
      }

      const [settingsRes, ingestRes, reposRes, auditRes, graphRes] = await Promise.allSettled([
        settingsResp.json() as Promise<SettingItem[]>,
        fetch(prefix("/api/ingest/status")).then((r) => r.json()) as Promise<{ sources: IngestSource[] }>,
        fetch(prefix("/api/repos")).then((r) => r.json()) as Promise<{ repos: RepoEntry[] }>,
        fetch(prefix("/api/audit?limit=20")).then((r) => r.json()) as Promise<{ rows: AuditRow[] }>,
        fetch(prefix("/api/graph/overview")).then((r) => r.json()) as Promise<{ nodes: unknown[]; edges: unknown[] }>,
      ]);

      const s = settingsRes.status === "fulfilled" ? (Array.isArray(settingsRes.value) ? settingsRes.value : []) : [];
      const ingest = ingestRes.status === "fulfilled" ? (ingestRes.value.sources ?? []) : [];
      const rps = reposRes.status === "fulfilled" ? (reposRes.value.repos ?? []) : [];
      const audit = auditRes.status === "fulfilled" ? (auditRes.value.rows ?? []) : [];
      const graph = graphRes.status === "fulfilled" ? graphRes.value : { nodes: [], edges: [] };

      setSettings(s);
      setSources(ingest);
      setRepos(rps);
      setAuditRows(audit);
      setGraphNodeCount((graph.nodes ?? []).length);
      setGraphEdgeCount((graph.edges ?? []).length);

      const brainSet = s.some(
        (item) => (item.key === "OPENROUTER_API_KEY" || item.key === "LLM_API_KEY" || item.key === "BRAIN_MODE") && item.set
      );
      if (!brainSet) {
        setState("no-brain");
        return;
      }

      setState("ready");
    } catch {
      setState("engine-down");
    }
  }, [prefix]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // Engine down retry
  useEffect(() => {
    if (state !== "engine-down") return;
    const iv = setInterval(() => {
      loadAll();
    }, 3000);
    return () => clearInterval(iv);
  }, [state, loadAll]);

  // Background refresh poll
  useEffect(() => {
    if (state !== "ready") return;
    const interval = isIndexing ? 3000 : 10000;
    const iv = setInterval(() => {
      fetch(prefix("/api/graph/overview"))
        .then((r) => r.json())
        .then((d: { nodes: unknown[]; edges: unknown[] }) => {
          setGraphNodeCount((d.nodes ?? []).length);
          setGraphEdgeCount((d.edges ?? []).length);
        })
        .catch(() => {});
      fetch(prefix("/api/repos"))
        .then((r) => r.json())
        .then((d: { repos: RepoEntry[] }) => setRepos(d.repos ?? []))
        .catch(() => {});
    }, interval);
    return () => clearInterval(iv);
  }, [state, isIndexing, prefix]);

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

  if (state === "loading") {
    return <div className="min-h-screen bg-cream" />;
  }

  if (state === "engine-down") {
    return (
      <div className="min-h-screen flex items-center justify-center px-6 bg-cream">
        <div className="w-full max-w-lg rise-in text-center">
          <div className="inline-block w-2.5 h-2.5 rounded-full bg-accent animate-pulse mb-6" />
          <h1 className="font-display text-[32px] leading-tight mb-3">
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
    return <KeyGate onReady={() => loadAll()} />;
  }

  return (
    <Shell>
      <div className="flex flex-col gap-6 rise-in">
        {/* Top Header */}
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div>
            <Kicker>{mode === "prod" ? "Production" : "Local mode"}</Kicker>
            <Heading as="h1" className="text-[30px] mt-1 font-medium">
              {isIndexing ? "Flow is learning." : "Flow builds your brain."}
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
            height={hasSources ? 480 : 360}
            onConnectFirstSource={scrollToSources}
            onNodeClick={handleNodeClick}
            sources={sources}
            repos={repos}
          />
        </div>

        {/* 2. MIDDLE SECTION: CONNECT SOURCES & INTEGRATIONS */}
        <div id="sources-section" className="w-full">
          <IntegrationCatalog
            repos={repos}
            settings={settings}
            mode={mode}
            onChanged={() => loadAll()}
          />
        </div>

        {/* 3. THE INTERFACE DECISION: use Flow in your own AI interfaces (left)
            — or drive it from Flow's own interface (right). Same brain either way. */}
        <div id="agent-runner-section" className="grid grid-cols-1 lg:grid-cols-12 gap-6 w-full">
          {/* Your AI interfaces: workspace connection column */}
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
        repos={repos}
        settings={settings}
        mode={mode}
        onChanged={() => loadAll()}
      />
    </Shell>
  );
}
