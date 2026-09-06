"use client";

import React, { useState } from "react";
import { BrandIcon } from "@/components/BrandIcon";
import { RepoPicker } from "@/components/RepoPicker";
import { AddFolder } from "@/components/AddFolder";
import { SlackBotCard } from "@/components/SlackBotCard";
import { BodyText, Button, Heading } from "@/components/ui";
import { useProject } from "@/lib/useProject";
import { FlowMode } from "@/lib/useMode";

export interface RepoEntry {
  name: string;
  url: string;
  branch: string;
  lastIndexedAt?: string;
  lastIndexedCommit?: string;
  addedAt?: string;
  localPath?: string | null;
  kind?: string;
}

export interface SettingItem {
  key: string;
  set: boolean;
  value?: string | null;
}

interface IntegrationCatalogProps {
  repos: RepoEntry[];
  settings: SettingItem[];
  mode: FlowMode;
  onChanged: () => void;
}

type ModalKind = "none" | "github" | "folder" | "linear" | "fireflies" | "notes" | "slack";

export function IntegrationCatalog({
  repos,
  settings,
  mode,
  onChanged,
}: IntegrationCatalogProps) {
  const { prefix } = useProject();
  const [activeModal, setActiveModal] = useState<ModalKind>("none");
  const [msg, setMsg] = useState("");

  // Input states for modals
  const [linearKey, setLinearKey] = useState("");
  const [firefliesKey, setFirefliesKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);

  const [notesTitle, setNotesTitle] = useState("");
  const [notesText, setNotesText] = useState("");
  const [ingestingNotes, setIngestingNotes] = useState(false);

  // Slack agent: connected when both tokens are set (managed on Connections)
  const slackConnected =
    settings.some((s) => s.key === "SLACK_BOT_TOKEN" && s.set) &&
    settings.some((s) => s.key === "SLACK_APP_TOKEN" && s.set);

  const indexedUrls = new Set(repos.map((r) => r.url || r.name));
  const linearSet = settings.some((s) => s.key === "LINEAR_API_KEY" && s.set);
  const firefliesSet = settings.some((s) => s.key === "FIREFLIES_API_KEY" && s.set);

  async function handleSaveKey(keyName: string, val: string) {
    if (!val.trim()) return;
    setSavingKey(true);
    try {
      await fetch(prefix("/api/settings"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [keyName]: val.trim() }),
      });
      setLinearKey("");
      setFirefliesKey("");
      setActiveModal("none");
      onChanged();
    } catch {
      // swallow
    } finally {
      setSavingKey(false);
    }
  }

  async function handleIngestNotes(e: React.FormEvent) {
    e.preventDefault();
    if (!notesText.trim()) return;
    setIngestingNotes(true);
    try {
      await fetch(prefix("/api/connections"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "meeting_notes",
          title: notesTitle || "Manual upload",
          text: notesText,
        }),
      });
      setNotesTitle("");
      setNotesText("");
      setActiveModal("none");
      onChanged();
    } catch {
      // swallow
    } finally {
      setIngestingNotes(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 p-5 rounded-2xl border border-line bg-paper shadow-xs rise-in">
      <div className="flex items-center justify-between border-b border-line pb-3">
        <Heading variant="section">Connect code and business context</Heading>
      </div>

      {msg && (
        <div className="p-2.5 rounded-lg bg-sand border border-line text-xs font-mono text-ink flex items-center justify-between">
          <span>{msg}</span>
          <button onClick={() => setMsg("")} className="text-text-muted hover:text-ink text-xs">✕</button>
        </div>
      )}

      {/* Compact Grid of Small Integration Cards: Centered Naked Icon, Name, Description, Connect Button */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        {/* 1. GitHub Repositories */}
        <div className="rounded-xl border border-line bg-cream p-4 flex flex-col items-center text-center justify-between hover:border-ink/30 transition-all gap-2 min-h-[195px]">
          <div className="flex items-center justify-center pt-1 text-ink">
            <BrandIcon name="opencode" size={32} />
          </div>

          <div className="flex flex-col items-center gap-0.5">
            <Heading as="h3" variant="card">
              GitHub Repos
            </Heading>
            <BodyText>
              Sync remote git repos & branches
            </BodyText>
          </div>

          <Button
            onClick={() => setActiveModal("github")}
            variant={repos.length > 0 ? "secondary" : "primary"}
            className="w-full justify-center text-[11px] py-1 font-medium"
          >
            {repos.length > 0 ? `${repos.length} Repos ✓` : "Connect"}
          </Button>
        </div>

        {/* 2. Local Folder */}
        <div className="rounded-xl border border-line bg-cream p-4 flex flex-col items-center text-center justify-between hover:border-ink/30 transition-all gap-2 min-h-[195px]">
          <div className="flex items-center justify-center pt-1 text-ink">
            <svg width="30" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          </div>

          <div className="flex flex-col items-center gap-0.5">
            <Heading as="h3" variant="card">
              Local Folder
            </Heading>
            <BodyText>
              Connect local folder or checkout
            </BodyText>
          </div>

          <Button
            onClick={() => setActiveModal("folder")}
            variant="secondary"
            className="w-full justify-center text-[11px] py-1 font-medium"
          >
            Connect
          </Button>
        </div>

        {/* 3. Linear */}
        <div className="rounded-xl border border-line bg-cream p-4 flex flex-col items-center text-center justify-between hover:border-ink/30 transition-all gap-2 min-h-[195px]">
          <div className="flex items-center justify-center pt-1 text-ink">
            <BrandIcon name="linear" size={32} />
          </div>

          <div className="flex flex-col items-center gap-0.5">
            <Heading as="h3" variant="card">
              Linear
            </Heading>
            <BodyText>
              Sync issues, specs & tickets
            </BodyText>
          </div>

          <Button
            onClick={() => setActiveModal("linear")}
            variant={linearSet ? "secondary" : "primary"}
            className="w-full justify-center text-[11px] py-1 font-medium"
          >
            {linearSet ? "Connected ✓" : "Connect"}
          </Button>
        </div>

        {/* 4. Fireflies.ai */}
        <div className="rounded-xl border border-line bg-cream p-4 flex flex-col items-center text-center justify-between hover:border-ink/30 transition-all gap-2 min-h-[195px]">
          <div className="flex items-center justify-center pt-1 text-ink">
            <BrandIcon name="fireflies" size={32} />
          </div>

          <div className="flex flex-col items-center gap-0.5">
            <Heading as="h3" variant="card">
              Fireflies.ai
            </Heading>
            <BodyText>
              Import meeting transcripts
            </BodyText>
          </div>

          <Button
            onClick={() => setActiveModal("fireflies")}
            variant={firefliesSet ? "secondary" : "primary"}
            className="w-full justify-center text-[11px] py-1 font-medium"
          >
            {firefliesSet ? "Connected ✓" : "Connect"}
          </Button>
        </div>

        {/* 5. Meeting Notes */}
        <div className="rounded-xl border border-line bg-cream p-4 flex flex-col items-center text-center justify-between hover:border-ink/30 transition-all gap-2 min-h-[195px]">
          <div className="flex items-center justify-center pt-1 text-2xl">
            📝
          </div>

          <div className="flex flex-col items-center gap-0.5">
            <Heading as="h3" variant="card">
              Meeting Notes
            </Heading>
            <BodyText>
              Paste raw transcript or notes
            </BodyText>
          </div>

          <Button
            onClick={() => setActiveModal("notes")}
            variant="secondary"
            className="w-full justify-center text-[11px] py-1 font-medium"
          >
            Upload
          </Button>
        </div>

        {/* 6. Slack Bot — the Q&A agent; works in local and prod (Socket Mode) */}
        <div className="rounded-xl border border-line bg-paper p-4 flex flex-col items-center text-center justify-between transition-all gap-2 min-h-[195px] relative">
          <div className="flex items-center justify-center pt-1 text-ink">
            <BrandIcon name="slack" size={32} />
          </div>

          <div className="flex flex-col items-center gap-0.5">
            <Heading as="h3" variant="card">
              Slack Bot
            </Heading>
            <BodyText>
              Ask Flow questions in Slack
            </BodyText>
          </div>

          <button
            onClick={() => setActiveModal("slack")}
            className="w-full py-1 text-center text-[9px] font-mono uppercase tracking-wider bg-sand border border-line rounded text-text-muted hover:text-ink transition-colors cursor-pointer"
          >
            {slackConnected ? "Connected ↗" : "Set up ↗"}
          </button>
        </div>
      </div>

      {/* ── DEDICATED FOCUSED MODALS ─────────────────────────────────────────── */}

      {/* 1. GitHub Repos Modal */}
      {activeModal === "github" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4">
          <div className="bg-paper border border-line rounded-2xl w-full max-w-xl max-h-[85vh] flex flex-col overflow-hidden shadow-2xl rise-in">
            <div className="p-4 border-b border-line flex items-center justify-between bg-sand">
              <div className="flex items-center gap-2">
                <BrandIcon name="opencode" size={20} />
                <span className="font-medium text-ink text-sm">Connect GitHub Repositories</span>
              </div>
              <button onClick={() => setActiveModal("none")} className="text-text-muted hover:text-ink text-lg">✕</button>
            </div>
            <div className="p-5 overflow-y-auto flex-1">
              <RepoPicker
                indexedUrls={indexedUrls}
                onMsg={(m) => setMsg(m)}
                onConnected={() => { setActiveModal("none"); onChanged(); }}
              />
            </div>
          </div>
        </div>
      )}

      {/* 2. Local Folder Modal */}
      {activeModal === "folder" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4">
          <div className="bg-paper border border-line rounded-2xl w-full max-w-lg p-5 shadow-2xl rise-in flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <span className="font-medium text-ink text-sm">Connect Local Folder</span>
              <button onClick={() => setActiveModal("none")} className="text-text-muted hover:text-ink text-lg">✕</button>
            </div>
            <AddFolder mode={mode} onAdded={() => { setActiveModal("none"); onChanged(); }} />
          </div>
        </div>
      )}

      {/* 3. Linear Modal */}
      {/* Slack Bot Modal — same wizard as the Connections page card */}
      {activeModal === "slack" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4">
          <div className="bg-paper border border-line rounded-2xl w-full max-w-md p-5 shadow-2xl rise-in flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <div className="flex items-center gap-2">
                <BrandIcon name="slack" size={20} />
                <span className="font-medium text-ink text-sm">Slack bot</span>
              </div>
              <button
                onClick={() => {
                  setActiveModal("none");
                  onChanged();
                }}
                className="text-text-muted hover:text-ink text-lg"
              >
                ✕
              </button>
            </div>
            <SlackBotCard />
          </div>
        </div>
      )}

      {activeModal === "linear" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4">
          <div className="bg-paper border border-line rounded-2xl w-full max-w-md p-5 shadow-2xl rise-in flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <div className="flex items-center gap-2">
                <BrandIcon name="linear" size={20} />
                <span className="font-medium text-ink text-sm">Connect Linear</span>
              </div>
              <button onClick={() => setActiveModal("none")} className="text-text-muted hover:text-ink text-lg">✕</button>
            </div>
            <p className="text-xs text-text-muted">Enter your Linear API key to sync issues and project specs.</p>
            <input
              type="password"
              value={linearKey}
              onChange={(e) => setLinearKey(e.target.value)}
              placeholder="lin_api_..."
              className="w-full rounded-md border border-line bg-cream px-3 py-2 text-xs text-ink outline-none"
            />
            <div className="flex justify-end gap-2 mt-2">
              <Button onClick={() => setActiveModal("none")} variant="secondary" className="text-xs">Cancel</Button>
              <Button
                onClick={() => handleSaveKey("LINEAR_API_KEY", linearKey)}
                disabled={!linearKey.trim() || savingKey}
                variant="primary"
                className="text-xs"
              >
                Save & Sync
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 4. Fireflies Modal */}
      {activeModal === "fireflies" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4">
          <div className="bg-paper border border-line rounded-2xl w-full max-w-md p-5 shadow-2xl rise-in flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <div className="flex items-center gap-2">
                <BrandIcon name="fireflies" size={20} />
                <span className="font-medium text-ink text-sm">Connect Fireflies.ai</span>
              </div>
              <button onClick={() => setActiveModal("none")} className="text-text-muted hover:text-ink text-lg">✕</button>
            </div>
            <p className="text-xs text-text-muted">Enter your Fireflies API key to import meeting transcripts.</p>
            <input
              type="password"
              value={firefliesKey}
              onChange={(e) => setFirefliesKey(e.target.value)}
              placeholder="ff_..."
              className="w-full rounded-md border border-line bg-cream px-3 py-2 text-xs text-ink outline-none"
            />
            <div className="flex justify-end gap-2 mt-2">
              <Button onClick={() => setActiveModal("none")} variant="secondary" className="text-xs">Cancel</Button>
              <Button
                onClick={() => handleSaveKey("FIREFLIES_API_KEY", firefliesKey)}
                disabled={!firefliesKey.trim() || savingKey}
                variant="primary"
                className="text-xs"
              >
                Save & Sync
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 5. Meeting Notes Modal */}
      {activeModal === "notes" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4">
          <form onSubmit={handleIngestNotes} className="bg-paper border border-line rounded-2xl w-full max-w-lg p-5 shadow-2xl rise-in flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <span className="font-medium text-ink text-sm">Upload Meeting Notes</span>
              <button type="button" onClick={() => setActiveModal("none")} className="text-text-muted hover:text-ink text-lg">✕</button>
            </div>
            <input
              type="text"
              value={notesTitle}
              onChange={(e) => setNotesTitle(e.target.value)}
              placeholder="Meeting Title (e.g. Architecture Sync)"
              className="w-full rounded-md border border-line bg-cream px-3 py-2 text-xs text-ink outline-none"
            />
            <textarea
              value={notesText}
              onChange={(e) => setNotesText(e.target.value)}
              placeholder="Paste transcript or decision notes..."
              rows={6}
              className="w-full rounded-md border border-line bg-cream px-3 py-2 text-xs text-ink outline-none resize-y"
            />
            <div className="flex justify-end gap-2 mt-2">
              <Button type="button" onClick={() => setActiveModal("none")} variant="secondary" className="text-xs">Cancel</Button>
              <Button
                type="submit"
                disabled={!notesText.trim() || ingestingNotes}
                variant="primary"
                arrow
                className="text-xs"
              >
                {ingestingNotes ? "Ingesting..." : "Ingest Transcript"}
              </Button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
