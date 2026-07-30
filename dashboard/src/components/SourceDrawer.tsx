"use client";

import React, { useState, FormEvent, useMemo } from "react";
import { useProject } from "@/lib/useProject";
import { FlowMode } from "@/lib/useMode";
import { BrandIcon } from "@/components/BrandIcon";
import { AddFolder } from "@/components/AddFolder";
import { AddRepoUrl } from "@/components/AddRepoUrl";
import { RepoPicker } from "@/components/RepoPicker";
import { Button, Kicker, StatusPill } from "@/components/ui";

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

interface SourcesPillStripProps {
  repos: RepoEntry[];
  settings: SettingItem[];
  mode: FlowMode;
  onOpenDrawer: () => void;
}

export function SourcesPillStrip({ repos, settings, mode, onOpenDrawer }: SourcesPillStripProps) {
  const linearSet = settings.some((s) => s.key === "LINEAR_API_KEY" && s.set);
  const firefliesSet = settings.some((s) => s.key === "FIREFLIES_API_KEY" && s.set);
  const [showSlackPopover, setShowSlackPopover] = useState(false);

  return (
    <div
      className="flex items-center justify-between gap-3 p-3 rounded-xl border border-line bg-paper overflow-x-auto"
      style={{ boxShadow: "0 1px 2px rgba(0,0,0,0.03)" }}
    >
      <div className="flex items-center gap-2 overflow-x-auto py-0.5 no-scrollbar flex-1 min-w-0">
        <span
          style={{ fontFamily: "var(--font-mono)" }}
          className="text-[10px] uppercase tracking-wider text-text-muted flex-shrink-0 mr-1"
        >
          Sources:
        </span>

        {/* Repos pills */}
        {repos.map((r) => (
          <div
            key={r.name}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-sand border border-line text-[12px] text-ink flex-shrink-0"
          >
            <BrandIcon name="opencode" size={14} className="text-ink opacity-70" />
            <span className="font-medium truncate max-w-[140px]">{r.name}</span>
            <span className="text-[10px] text-text-muted font-mono">({r.branch})</span>
            {r.lastIndexedCommit ? (
              <span className="w-1.5 h-1.5 rounded-full bg-ok" title="Indexed" />
            ) : (
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" title="Indexing" />
            )}
          </div>
        ))}

        {/* Linear pill */}
        {linearSet && (
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-sand border border-line text-[12px] text-ink flex-shrink-0">
            <BrandIcon name="linear" size={14} />
            <span>Linear</span>
            <span className="w-1.5 h-1.5 rounded-full bg-ok" />
          </div>
        )}

        {/* Fireflies pill */}
        {firefliesSet && (
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-sand border border-line text-[12px] text-ink flex-shrink-0">
            <BrandIcon name="fireflies" size={14} />
            <span>Fireflies</span>
            <span className="w-1.5 h-1.5 rounded-full bg-ok" />
          </div>
        )}

        {/* Slack Pill with deployment popover */}
        <div className="relative flex-shrink-0">
          <button
            onClick={() => setShowSlackPopover((v) => !v)}
            onMouseEnter={() => setShowSlackPopover(true)}
            onMouseLeave={() => setShowSlackPopover(false)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-paper border border-line text-[12px] text-text-muted opacity-60 hover:opacity-100 transition-opacity cursor-pointer"
            data-testid="slack-pill-trigger"
          >
            <BrandIcon name="slack" size={14} />
            <span>Slack</span>
            <span
              style={{ fontFamily: "var(--font-mono)" }}
              className="text-[9px] uppercase tracking-wider px-1.5 py-0.2 rounded bg-sand text-text-muted border border-line"
            >
              Locked
            </span>
          </button>

          {/* Popover */}
          {showSlackPopover && (
            <div
              className="absolute bottom-full mb-2 left-0 w-64 p-3 rounded-lg border border-line bg-paper shadow-lg text-[12px] text-ink z-50 rise-in"
              style={{ fontFamily: "var(--font-sans)" }}
            >
              <div className="font-medium mb-1 flex items-center gap-1.5">
                <BrandIcon name="slack" size={14} />
                Slack Integration Locked
              </div>
              <p className="text-text-muted text-[11px] leading-relaxed mb-2">
                Slack requires Flow running in production mode (<code className="font-mono text-ink">flow up --mode prod</code>) with persistent socket connection.
              </p>
              <div className="text-[10px] font-mono text-accent font-semibold uppercase tracking-wider">
                Run: flow up --mode prod
              </div>
            </div>
          )}
        </div>

        {repos.length === 0 && !linearSet && !firefliesSet && (
          <span className="text-[12px] text-text-muted italic">No sources connected yet</span>
        )}
      </div>

      {/* Add Source CTA Button */}
      <Button
        variant="primary"
        onClick={onOpenDrawer}
        arrow
        className="flex-shrink-0 text-xs px-3 py-1.5"
      >
        + Add Source
      </Button>
    </div>
  );
}

// ── Slide-Over Source Drawer ──────────────────────────────────────────────────

interface SourceDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  repos: RepoEntry[];
  settings: SettingItem[];
  mode: FlowMode;
  onChanged: () => void;
}

export function SourceDrawer({
  isOpen,
  onClose,
  repos,
  settings,
  mode,
  onChanged,
}: SourceDrawerProps) {
  const { prefix } = useProject();
  const [activeTab, setActiveTab] = useState<"code" | "integrations" | "notes">("code");

  // Integration inputs
  const [linearKey, setLinearKey] = useState("");
  const [firefliesKey, setFirefliesKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);

  // Notes
  const [notesTitle, setNotesTitle] = useState("");
  const [notesText, setNotesText] = useState("");
  const [ingestingNotes, setIngestingNotes] = useState(false);
  const [notesDone, setNotesDone] = useState(false);

  const linearSet = settings.some((s) => s.key === "LINEAR_API_KEY" && s.set);
  const firefliesSet = settings.some((s) => s.key === "FIREFLIES_API_KEY" && s.set);

  if (!isOpen) return null;

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
      onChanged();
    } catch {
      // swallow
    } finally {
      setSavingKey(false);
    }
  }

  async function handleIngestNotes(e: FormEvent) {
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
      setNotesDone(true);
      setTimeout(() => {
        setNotesDone(false);
        setNotesTitle("");
        setNotesText("");
        onChanged();
      }, 1000);
    } catch {
      // swallow
    } finally {
      setIngestingNotes(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-xs transition-opacity">
      {/* Backdrop click to close */}
      <div className="absolute inset-0" onClick={onClose} />

      {/* Drawer content */}
      <div className="relative w-full max-w-lg bg-paper h-full shadow-2xl flex flex-col z-10 border-l border-line rise-in">
        {/* Drawer Header */}
        <div className="p-5 border-b border-line flex items-center justify-between bg-sand">
          <div>
            <Kicker>Slide-Over Drawer</Kicker>
            <h2 style={{ fontFamily: "var(--font-display)" }} className="text-lg font-medium text-ink">
              Source Management
            </h2>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full border border-line bg-paper flex items-center justify-center text-text-muted hover:text-ink transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Tab switcher */}
        <div className="flex border-b border-line px-5 pt-3 gap-4">
          <button
            onClick={() => setActiveTab("code")}
            className={`pb-2.5 text-[13px] font-medium transition-colors border-b-2 ${
              activeTab === "code"
                ? "border-ink text-ink font-semibold"
                : "border-transparent text-text-muted hover:text-ink"
            }`}
          >
            Codebase (Git & Local)
          </button>
          <button
            onClick={() => setActiveTab("integrations")}
            className={`pb-2.5 text-[13px] font-medium transition-colors border-b-2 ${
              activeTab === "integrations"
                ? "border-ink text-ink font-semibold"
                : "border-transparent text-text-muted hover:text-ink"
            }`}
          >
            Integrations
          </button>
          <button
            onClick={() => setActiveTab("notes")}
            className={`pb-2.5 text-[13px] font-medium transition-colors border-b-2 ${
              activeTab === "notes"
                ? "border-ink text-ink font-semibold"
                : "border-transparent text-text-muted hover:text-ink"
            }`}
          >
            Meeting Notes
          </button>
        </div>

        {/* Drawer Body */}
        <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-6">
          {/* Tab 1: Code */}
          {activeTab === "code" && (
            <div className="flex flex-col gap-6">
              {/* GitHub Repos checklist search */}
              <div className="rounded-xl border border-line p-4 bg-cream flex flex-col gap-3">
                <Kicker>GitHub Account Repositories</Kicker>
                <RepoPicker
                  indexedUrls={new Set(repos.map((r) => r.url || r.name))}
                  onMsg={() => {}}
                  onConnected={onChanged}
                />
              </div>

              {/* Local folder picker */}
              <div className="rounded-xl border border-line p-4 bg-cream">
                <AddFolder mode={mode} onAdded={onChanged} />
              </div>

              {/* GitHub URL picker */}
              <div className="rounded-xl border border-line p-4 bg-cream">
                <label className="block text-xs font-semibold text-ink mb-1">
                  Connect via GitHub URL
                </label>
                <AddRepoUrl onAdded={onChanged} />
              </div>

              {/* Connected Repos list */}
              {repos.length > 0 && (
                <div>
                  <Kicker>Connected Codebases ({repos.length})</Kicker>
                  <div className="mt-2 space-y-2">
                    {repos.map((r) => (
                      <div
                        key={r.name}
                        className="p-3 rounded-lg border border-line bg-sand flex items-center justify-between gap-3 text-[13px]"
                      >
                        <div>
                          <div className="font-medium text-ink">{r.name}</div>
                          <div className="text-[11px] font-mono text-text-muted">
                            Branch: {r.branch} {r.localPath ? `· ${r.localPath}` : ""}
                          </div>
                        </div>
                        <StatusPill kind={r.lastIndexedCommit ? "ok" : "live"}>
                          {r.lastIndexedCommit ? "Indexed" : "Indexing"}
                        </StatusPill>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Tab 2: Integrations */}
          {activeTab === "integrations" && (
            <div className="flex flex-col gap-4">
              {/* Linear */}
              <div className="p-4 rounded-xl border border-line bg-cream flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <BrandIcon name="linear" size={18} />
                    <span className="font-medium text-ink text-sm">Linear</span>
                  </div>
                  {linearSet && <StatusPill kind="ok">Connected</StatusPill>}
                </div>
                <p className="text-text-muted text-[12px]">
                  Sync issues, projects, and ticket discussions into the Knowledge Graph.
                </p>
                {!linearSet && (
                  <div className="flex gap-2">
                    <input
                      type="password"
                      value={linearKey}
                      onChange={(e) => setLinearKey(e.target.value)}
                      placeholder="lin_api_..."
                      className="flex-1 rounded-md border border-line bg-paper px-3 py-1.5 text-xs text-ink outline-none"
                    />
                    <Button
                      onClick={() => handleSaveKey("LINEAR_API_KEY", linearKey)}
                      disabled={!linearKey.trim() || savingKey}
                      variant="primary"
                      className="text-xs"
                    >
                      Connect
                    </Button>
                  </div>
                )}
              </div>

              {/* Fireflies */}
              <div className="p-4 rounded-xl border border-line bg-cream flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <BrandIcon name="fireflies" size={18} />
                    <span className="font-medium text-ink text-sm">Fireflies</span>
                  </div>
                  {firefliesSet && <StatusPill kind="ok">Connected</StatusPill>}
                </div>
                <p className="text-text-muted text-[12px]">
                  Import automated meeting transcripts and decision notes.
                </p>
                {!firefliesSet && (
                  <div className="flex gap-2">
                    <input
                      type="password"
                      value={firefliesKey}
                      onChange={(e) => setFirefliesKey(e.target.value)}
                      placeholder="ff_..."
                      className="flex-1 rounded-md border border-line bg-paper px-3 py-1.5 text-xs text-ink outline-none"
                    />
                    <Button
                      onClick={() => handleSaveKey("FIREFLIES_API_KEY", firefliesKey)}
                      disabled={!firefliesKey.trim() || savingKey}
                      variant="primary"
                      className="text-xs"
                    >
                      Connect
                    </Button>
                  </div>
                )}
              </div>

              {/* Slack Card - Locked */}
              <div className="p-4 rounded-xl border border-line bg-cream opacity-75 flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <BrandIcon name="slack" size={18} />
                    <span className="font-medium text-ink text-sm">Slack</span>
                  </div>
                  <span
                    style={{ fontFamily: "var(--font-mono)" }}
                    className="text-[9px] uppercase tracking-wider px-2 py-0.5 rounded bg-sand border border-line text-text-muted font-semibold"
                  >
                    Locked
                  </span>
                </div>
                <p className="text-text-muted text-[12px] leading-relaxed">
                  Slack integration requires Flow running in cloud / production mode (<code className="font-mono text-ink">flow up --mode prod</code>).
                </p>
              </div>
            </div>
          )}

          {/* Tab 3: Notes */}
          {activeTab === "notes" && (
            <form onSubmit={handleIngestNotes} className="flex flex-col gap-3">
              <Kicker>Manual Transcript Ingestion</Kicker>
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
                placeholder="Paste transcript or decisions text here..."
                rows={8}
                className="w-full rounded-md border border-line bg-cream px-3 py-2 text-xs text-ink outline-none resize-y"
              />
              {notesDone && (
                <p className="text-xs text-ok font-medium">Transcript ingested! Flow is extracting decisions.</p>
              )}
              <Button
                type="submit"
                disabled={!notesText.trim() || ingestingNotes}
                variant="primary"
                arrow
              >
                {ingestingNotes ? "Ingesting..." : "Ingest Transcript"}
              </Button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
