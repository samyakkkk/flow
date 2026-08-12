"use client";

import React, { useState } from "react";
import { BrandIcon } from "@/components/BrandIcon";
import { RepoPicker } from "@/components/RepoPicker";
import { AddFolder } from "@/components/AddFolder";
import { Button, StatusPill, Kicker } from "@/components/ui";
import { useProject } from "@/lib/useProject";
import { FlowMode } from "@/lib/useMode";
import { useViewer } from "@/lib/useViewer";

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
  const viewer = useViewer();
  const [activeModal, setActiveModal] = useState<ModalKind>("none");
  const [msg, setMsg] = useState("");

  // Input states for modals
  const [linearKey, setLinearKey] = useState("");
  const [firefliesKey, setFirefliesKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);

  const [notesTitle, setNotesTitle] = useState("");
  const [notesText, setNotesText] = useState("");
  const [ingestingNotes, setIngestingNotes] = useState(false);

  // Slack tooltip popover (local mode) + config inputs (prod)
  const [slackPopover, setSlackPopover] = useState(false);
  const [slackBotToken, setSlackBotToken] = useState("");
  const [slackAppToken, setSlackAppToken] = useState("");

  async function handleSaveSlack() {
    if (!slackBotToken.trim() || !slackAppToken.trim()) return;
    setSavingKey(true);
    try {
      await fetch(prefix("/api/settings"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          SLACK_BOT_TOKEN: slackBotToken.trim(),
          SLACK_APP_TOKEN: slackAppToken.trim(),
        }),
      });
      setSlackBotToken("");
      setSlackAppToken("");
      setActiveModal("none");
      onChanged();
    } catch {
      // swallow
    } finally {
      setSavingKey(false);
    }
  }

  const indexedUrls = new Set(repos.map((r) => r.url || r.name));
  const linearSet = settings.some((s) => s.key === "LINEAR_API_KEY" && s.set);
  const firefliesSet = settings.some((s) => s.key === "FIREFLIES_API_KEY" && s.set);
  const slackSet = settings.some((s) => s.key === "SLACK_BOT_TOKEN" && (s.set || s.value));

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

  // While the viewer's role is still resolving, show a neutral header (no edit
  // controls) so a member never flashes owner-only buttons before we know they
  // can't use them. Resolves within one fetch.
  if (viewer.loading) {
    return (
      <div className="flex flex-col gap-4 p-5 rounded-2xl border border-line bg-paper shadow-xs">
        <div className="border-b border-line pb-3">
          <Kicker>Integrations & Sources</Kicker>
          <h2 style={{ fontFamily: "var(--font-display)" }} className="text-lg font-semibold text-ink mt-0.5">
            Connect code and business context
          </h2>
        </div>
        <div className="text-xs text-text-muted py-6 text-center">Loading…</div>
      </div>
    );
  }

  // Members (prod, non-owner) don't manage team integrations — mirrors the
  // server-side 403 from canManageIntegrations(). Rather than show Connect
  // buttons that would fail, give them an honest read-only view of what the
  // owner has wired up. Local mode and owners fall through to the full editor.
  if (viewer.mode === "prod" && !viewer.canManageIntegrations) {
    const roItems: Array<{ name: string; icon: React.ReactNode; on: boolean; detail: string }> = [
      { name: "GitHub Repos", icon: <BrandIcon name="opencode" size={22} />, on: repos.length > 0, detail: repos.length > 0 ? `${repos.length} repo${repos.length !== 1 ? "s" : ""} indexed` : "none yet" },
      { name: "Slack Bot", icon: <BrandIcon name="slack" size={22} />, on: slackSet, detail: slackSet ? "connected" : "not connected" },
      { name: "Linear", icon: <BrandIcon name="linear" size={22} />, on: linearSet, detail: linearSet ? "connected" : "not connected" },
      { name: "Fireflies.ai", icon: <BrandIcon name="fireflies" size={22} />, on: firefliesSet, detail: firefliesSet ? "connected" : "not connected" },
    ];
    return (
      <div className="flex flex-col gap-4 p-5 rounded-2xl border border-line bg-paper shadow-xs rise-in">
        <div className="flex items-center justify-between border-b border-line pb-3">
          <div>
            <Kicker>Integrations & Sources</Kicker>
            <h2 style={{ fontFamily: "var(--font-display)" }} className="text-lg font-semibold text-ink mt-0.5">
              What feeds this project&apos;s brain
            </h2>
          </div>
          <span className="text-[10px] font-mono uppercase tracking-wider px-2 py-1 rounded bg-sand border border-line text-text-muted whitespace-nowrap">
            🔒 Owner-managed
          </span>
        </div>
        <p className="text-xs text-text-muted -mt-1">
          Your workspace owner connects code and business sources. You can still connect
          your own coding tools to this project below.
        </p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {roItems.map((it) => (
            <div key={it.name} className={`rounded-xl border border-line bg-cream p-3 flex flex-col items-center text-center gap-1.5 ${it.on ? "" : "opacity-60"}`}>
              <div className="text-ink pt-1">{it.icon}</div>
              <h3 style={{ fontFamily: "var(--font-display)" }} className="text-xs font-semibold text-ink">{it.name}</h3>
              <span className={`text-[10px] font-medium ${it.on ? "text-[color:var(--success,#16a34a)]" : "text-text-muted"}`}>
                {it.on ? `✓ ${it.detail}` : it.detail}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-5 rounded-2xl border border-line bg-paper shadow-xs rise-in">
      <div className="flex items-center justify-between border-b border-line pb-3">
        <div>
          <Kicker>Integrations & Sources</Kicker>
          <h2
            style={{ fontFamily: "var(--font-display)" }}
            className="text-lg font-semibold text-ink mt-0.5"
          >
            Connect code and business context
          </h2>
        </div>
      </div>

      {msg && (
        <div className="p-2.5 rounded-lg bg-sand border border-line text-xs font-mono text-ink flex items-center justify-between">
          <span>{msg}</span>
          <button onClick={() => setMsg("")} className="text-text-muted hover:text-ink text-xs">✕</button>
        </div>
      )}

      {/* Compact Grid of Small Integration Cards: Centered Naked Icon, Name, Description, Connect Button */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {/* 1. GitHub Repositories */}
        <div className="rounded-xl border border-line bg-cream p-4 flex flex-col items-center text-center justify-between hover:border-ink/30 transition-all gap-2 min-h-[195px]">
          <div className="flex items-center justify-center pt-1 text-ink">
            <BrandIcon name="opencode" size={32} />
          </div>

          <div className="flex flex-col items-center gap-0.5">
            <h3 style={{ fontFamily: "var(--font-display)" }} className="text-xs font-semibold text-ink">
              GitHub Repos
            </h3>
            <p className="text-text-muted text-[10px] leading-tight line-clamp-2">
              Sync remote git repos & branches
            </p>
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
            <h3 style={{ fontFamily: "var(--font-display)" }} className="text-xs font-semibold text-ink">
              Local Folder
            </h3>
            <p className="text-text-muted text-[10px] leading-tight line-clamp-2">
              Connect local folder or checkout
            </p>
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
            <h3 style={{ fontFamily: "var(--font-display)" }} className="text-xs font-semibold text-ink">
              Linear
            </h3>
            <p className="text-text-muted text-[10px] leading-tight line-clamp-2">
              Sync issues, specs & tickets
            </p>
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
            <h3 style={{ fontFamily: "var(--font-display)" }} className="text-xs font-semibold text-ink">
              Fireflies.ai
            </h3>
            <p className="text-text-muted text-[10px] leading-tight line-clamp-2">
              Import meeting transcripts
            </p>
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
            <h3 style={{ fontFamily: "var(--font-display)" }} className="text-xs font-semibold text-ink">
              Meeting Notes
            </h3>
            <p className="text-text-muted text-[10px] leading-tight line-clamp-2">
              Paste raw transcript or notes
            </p>
          </div>

          <Button
            onClick={() => setActiveModal("notes")}
            variant="secondary"
            className="w-full justify-center text-[11px] py-1 font-medium"
          >
            Upload
          </Button>
        </div>

        {/* 6. Slack Bot — locked in local mode (needs a deployment); connectable
            in prod. The old card was hardcoded "Locked" and never checked the
            mode, so it wrongly showed "requires production mode" ON a prod
            deployment. */}
        {mode === "prod" ? (
          (() => {
            const connected = settings.some(
              (s) => s.key === "SLACK_BOT_TOKEN" && s.value,
            );
            return (
              <div className="rounded-xl border border-line bg-paper p-4 flex flex-col items-center text-center justify-between transition-all gap-2 min-h-[195px]">
                <div className="flex items-center justify-center pt-1 text-ink">
                  <BrandIcon name="slack" size={32} />
                </div>
                <div className="flex flex-col items-center gap-0.5">
                  <h3 style={{ fontFamily: "var(--font-display)" }} className="text-xs font-semibold text-ink">
                    Slack Bot
                  </h3>
                  <p className="text-text-muted text-[10px] leading-tight line-clamp-2">
                    Ambient listening — @mention Flow in your workspace
                  </p>
                </div>
                <button
                  onClick={() => setActiveModal("slack")}
                  className="w-full py-1 text-center text-[9px] font-mono uppercase tracking-wider bg-sand border border-line rounded text-ink hover:bg-line transition-colors cursor-pointer"
                >
                  {connected ? "Connected ✓ · Edit" : "Connect"}
                </button>
              </div>
            );
          })()
        ) : (
          <div className="rounded-xl border border-line bg-paper/60 p-4 flex flex-col items-center text-center justify-between opacity-60 transition-all gap-2 min-h-[195px] relative">
            <div className="flex items-center justify-center pt-1 text-ink">
              <BrandIcon name="slack" size={32} />
            </div>
            <div className="flex flex-col items-center gap-0.5">
              <h3 style={{ fontFamily: "var(--font-display)" }} className="text-xs font-semibold text-ink">
                Slack Bot
              </h3>
              <p className="text-text-muted text-[10px] leading-tight line-clamp-2">
                Ambient listening in cloud
              </p>
            </div>
            <button
              onClick={() => setSlackPopover((v) => !v)}
              className="w-full py-1 text-center text-[9px] font-mono uppercase tracking-wider bg-sand border border-line rounded text-text-muted hover:text-ink transition-colors cursor-pointer"
            >
              Locked ↗
            </button>
            {slackPopover && (
              <div className="absolute bottom-full mb-2 right-0 left-0 p-2.5 rounded-lg border border-line bg-paper shadow-xl text-[10px] text-ink z-50 rise-in text-left">
                <div className="font-semibold mb-0.5">Slack needs a deployment</div>
                <p className="text-text-muted text-[9px] leading-tight">
                  Slack&apos;s ambient bot runs on an always-on server. Deploy Flow (prod mode) to connect a workspace.
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── DEDICATED FOCUSED MODALS ─────────────────────────────────────────── */}

      {/* 1. GitHub Repos Modal */}
      {activeModal === "github" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4">
          <div className="bg-paper border border-line rounded-2xl w-full max-w-xl max-h-[85vh] flex flex-col overflow-hidden shadow-2xl rise-in">
            <div className="p-4 border-b border-line flex items-center justify-between bg-sand">
              <div className="flex items-center gap-2">
                <BrandIcon name="opencode" size={20} />
                <span className="font-semibold text-ink text-sm">Connect GitHub Repositories</span>
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
              <span className="font-semibold text-ink text-sm">Connect Local Folder</span>
              <button onClick={() => setActiveModal("none")} className="text-text-muted hover:text-ink text-lg">✕</button>
            </div>
            <AddFolder mode={mode} onAdded={() => { setActiveModal("none"); onChanged(); }} />
          </div>
        </div>
      )}

      {/* 3. Linear Modal */}
      {activeModal === "linear" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4">
          <div className="bg-paper border border-line rounded-2xl w-full max-w-md p-5 shadow-2xl rise-in flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <div className="flex items-center gap-2">
                <BrandIcon name="linear" size={20} />
                <span className="font-semibold text-ink text-sm">Connect Linear</span>
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

      {/* Slack Modal (prod) — bot + app token, stored as deployment settings */}
      {activeModal === "slack" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4">
          <div className="bg-paper border border-line rounded-2xl w-full max-w-md p-5 shadow-2xl rise-in flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <div className="flex items-center gap-2">
                <BrandIcon name="slack" size={20} />
                <span className="font-semibold text-ink text-sm">Connect Slack</span>
              </div>
              <button onClick={() => setActiveModal("none")} className="text-text-muted hover:text-ink text-lg">✕</button>
            </div>
            <p className="text-xs text-text-muted">
              Flow&apos;s Slack bot listens ambiently and answers when @mentioned. Create a Slack app with Socket Mode,
              then paste its bot &amp; app tokens.
            </p>
            <input
              type="password"
              value={slackBotToken}
              onChange={(e) => setSlackBotToken(e.target.value)}
              placeholder="Bot token — xoxb-..."
              className="w-full rounded-md border border-line bg-cream px-3 py-2 text-xs text-ink outline-none"
            />
            <input
              type="password"
              value={slackAppToken}
              onChange={(e) => setSlackAppToken(e.target.value)}
              placeholder="App-level token — xapp-..."
              className="w-full rounded-md border border-line bg-cream px-3 py-2 text-xs text-ink outline-none"
            />
            <div className="flex justify-end gap-2 mt-2">
              <Button onClick={() => setActiveModal("none")} variant="secondary" className="text-xs">Cancel</Button>
              <Button
                onClick={handleSaveSlack}
                disabled={!slackBotToken.trim() || !slackAppToken.trim() || savingKey}
                variant="primary"
                className="text-xs"
              >
                Save &amp; Connect
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
                <span className="font-semibold text-ink text-sm">Connect Fireflies.ai</span>
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
              <span className="font-semibold text-ink text-sm">Upload Meeting Notes</span>
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
