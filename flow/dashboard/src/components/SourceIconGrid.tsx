"use client";

import React, { useState, FormEvent, useMemo } from "react";
import { BrandIcon } from "@/components/BrandIcon";
import { AddFolder } from "@/components/AddFolder";
import { AddRepoUrl } from "@/components/AddRepoUrl";
import { RepoPicker } from "@/components/RepoPicker";
import { Button, StatusPill, Kicker } from "@/components/ui";
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

interface SourceIconGridProps {
  repos: RepoEntry[];
  settings: SettingItem[];
  mode: FlowMode;
  onChanged: () => void;
  onOpenDrawer?: () => void;
}

export function SourceIconGrid({
  repos,
  settings,
  mode,
  onChanged,
  onOpenDrawer,
}: SourceIconGridProps) {
  const { prefix } = useProject();
  const [activeForm, setActiveTabForm] = useState<"none" | "code_folder" | "code_github" | "linear" | "fireflies" | "notes">("none");
  const [msg, setMsg] = useState("");

  // Key state
  const [linearKey, setLinearKey] = useState("");
  const [firefliesKey, setFirefliesKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);

  // Notes state
  const [notesTitle, setNotesTitle] = useState("");
  const [notesText, setNotesText] = useState("");
  const [ingestingNotes, setIngestingNotes] = useState(false);

  // Slack popover
  const [slackPopover, setSlackPopover] = useState(false);

  const indexedUrls = useMemo(
    () => new Set(repos.map((r) => r.url || r.name)),
    [repos]
  );

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
      setActiveTabForm("none");
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
      setNotesTitle("");
      setNotesText("");
      setActiveTabForm("none");
      onChanged();
    } catch {
      // swallow
    } finally {
      setIngestingNotes(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 p-6 rounded-2xl border border-line bg-paper shadow-sm rise-in">
      <div className="flex items-center justify-between border-b border-line pb-4">
        <div>
          <Kicker>Step 1 · Connect Context</Kicker>
          <h2
            style={{ fontFamily: "var(--font-display)" }}
            className="text-xl font-medium text-ink mt-0.5"
          >
            Connect your sources to build the Knowledge Graph
          </h2>
          <p className="text-text-muted text-[13px] mt-1">
            Flow indexes git repositories, tickets, and meeting decisions into a unified graph.
          </p>
        </div>
        {onOpenDrawer && (
          <Button onClick={onOpenDrawer} variant="primary" arrow className="text-xs px-4 py-2 font-medium">
            Open Source Drawer
          </Button>
        )}
      </div>

      {msg && (
        <div className="p-3 rounded-lg bg-sand border border-line text-xs font-mono text-ink flex items-center justify-between">
          <span>{msg}</span>
          <button onClick={() => setMsg("")} className="text-text-muted hover:text-ink text-xs">✕</button>
        </div>
      )}

      {/* Grid of Big Source Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mt-1">
        {/* 1. Codebase (Git / Local) */}
        <div
          className={`rounded-xl border p-4 flex flex-col justify-between transition-all ${
            repos.length > 0
              ? "bg-sand border-accent/40 shadow-2xs"
              : "bg-cream border-line hover:border-ink/20"
          }`}
        >
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div className="w-10 h-10 rounded-lg bg-paper border border-line flex items-center justify-center text-ink shadow-2xs">
                <BrandIcon name="opencode" size={22} />
              </div>
              {repos.length > 0 ? (
                <StatusPill kind="ok">{repos.length} Connected</StatusPill>
              ) : (
                <span className="text-[10px] font-mono text-text-muted uppercase">Primary</span>
              )}
            </div>

            <div>
              <h3 style={{ fontFamily: "var(--font-display)" }} className="text-sm font-medium text-ink">
                Codebase
              </h3>
              <p className="text-text-muted text-[11px] mt-0.5 leading-relaxed">
                GitHub repos & local folders. Search account repos or select local path.
              </p>
            </div>

            {/* Connected Repos list */}
            {repos.length > 0 && (
              <div className="flex flex-col gap-1.5 pt-2 border-t border-line/50">
                {repos.slice(0, 3).map((r) => (
                  <div
                    key={r.name}
                    className="flex items-center justify-between text-[11px] font-mono text-ink bg-paper px-2 py-1 rounded border border-line"
                  >
                    <span className="truncate max-w-[120px] font-medium">{r.name}</span>
                    <span className="text-text-muted text-[10px]">({r.branch})</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="mt-4 pt-3 border-t border-line/40 flex flex-col gap-2">
            <Button
              onClick={() => setActiveTabForm(activeForm === "code_github" ? "none" : "code_github")}
              variant="secondary"
              className="w-full justify-center text-xs py-1.5"
            >
              {activeForm === "code_github" ? "Close Search" : "Search GitHub Repos"}
            </Button>
            <Button
              onClick={() => setActiveTabForm(activeForm === "code_folder" ? "none" : "code_folder")}
              variant="secondary"
              className="w-full justify-center text-xs py-1.5 text-text-muted"
            >
              {activeForm === "code_folder" ? "Close Folder" : "Add Local Folder"}
            </Button>
          </div>
        </div>

        {/* 2. Linear */}
        <div
          className={`rounded-xl border p-4 flex flex-col justify-between transition-all ${
            linearSet
              ? "bg-sand border-ok/40 shadow-2xs"
              : "bg-cream border-line hover:border-ink/20"
          }`}
        >
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div className="w-10 h-10 rounded-lg bg-paper border border-line flex items-center justify-center text-ink shadow-2xs">
                <BrandIcon name="linear" size={22} />
              </div>
              {linearSet ? (
                <StatusPill kind="ok">Connected</StatusPill>
              ) : (
                <span className="text-[10px] font-mono text-text-muted uppercase font-medium">Tickets</span>
              )}
            </div>

            <div>
              <h3 style={{ fontFamily: "var(--font-display)" }} className="text-sm font-medium text-ink">
                Linear
              </h3>
              <p className="text-text-muted text-[11px] mt-0.5 leading-relaxed">
                Sync issues, project specs, and ticket discussions into graph context.
              </p>
            </div>
          </div>

          <div className="mt-4 pt-3 border-t border-line/40">
            {linearSet ? (
              <div className="text-[11px] font-mono text-ok text-center font-medium py-1">
                ✓ Synced with Linear
              </div>
            ) : (
              <Button
                onClick={() => setActiveTabForm(activeForm === "linear" ? "none" : "linear")}
                variant="secondary"
                className="w-full justify-center text-xs py-1.5"
              >
                {activeForm === "linear" ? "Close" : "Connect Linear"}
              </Button>
            )}
          </div>
        </div>

        {/* 3. Fireflies & Meeting Notes */}
        <div
          className={`rounded-xl border p-4 flex flex-col justify-between transition-all ${
            firefliesSet
              ? "bg-sand border-ok/40 shadow-2xs"
              : "bg-cream border-line hover:border-ink/20"
          }`}
        >
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div className="w-10 h-10 rounded-lg bg-paper border border-line flex items-center justify-center text-ink shadow-2xs">
                <BrandIcon name="fireflies" size={22} />
              </div>
              {firefliesSet ? (
                <StatusPill kind="ok">Connected</StatusPill>
              ) : (
                <span className="text-[10px] font-mono text-text-muted uppercase font-medium">Decisions</span>
              )}
            </div>

            <div>
              <h3 style={{ fontFamily: "var(--font-display)" }} className="text-sm font-medium text-ink">
                Meeting Notes
              </h3>
              <p className="text-text-muted text-[11px] mt-0.5 leading-relaxed">
                Fireflies integration or manual transcript paste to extract decisions.
              </p>
            </div>
          </div>

          <div className="mt-4 pt-3 border-t border-line/40 flex gap-2">
            <Button
              onClick={() => setActiveTabForm(activeForm === "notes" ? "none" : "notes")}
              variant="secondary"
              className="flex-1 justify-center text-[11px] py-1.5"
            >
              {activeForm === "notes" ? "Close" : "Paste Notes"}
            </Button>
            {!firefliesSet && (
              <Button
                onClick={() => setActiveTabForm(activeForm === "fireflies" ? "none" : "fireflies")}
                variant="secondary"
                className="flex-1 justify-center text-[11px] py-1.5"
              >
                Fireflies
              </Button>
            )}
          </div>
        </div>

        {/* 4. Slack (Locked) */}
        <div className="rounded-xl border border-line bg-paper/60 p-4 flex flex-col justify-between opacity-70 relative">
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div className="w-10 h-10 rounded-lg bg-sand border border-line flex items-center justify-center text-ink">
                <BrandIcon name="slack" size={22} />
              </div>
              <span
                style={{ fontFamily: "var(--font-mono)" }}
                className="text-[9px] uppercase tracking-wider px-2 py-0.5 rounded bg-sand border border-line text-text-muted font-bold"
              >
                Locked
              </span>
            </div>

            <div>
              <h3 style={{ fontFamily: "var(--font-display)" }} className="text-sm font-medium text-ink">
                Slack Bot
              </h3>
              <p className="text-text-muted text-[11px] mt-0.5 leading-relaxed">
                Always-on ambient listening & channel Q&A in cloud mode.
              </p>
            </div>
          </div>

          <div className="mt-4 pt-3 border-t border-line/40">
            <button
              onClick={() => setSlackPopover((v) => !v)}
              className="w-full text-center text-[10px] font-mono text-text-muted uppercase tracking-wider hover:text-ink transition-colors"
            >
              Requires flow up --mode prod ↗
            </button>
          </div>

          {slackPopover && (
            <div className="absolute bottom-full mb-2 right-0 left-0 p-3 rounded-lg border border-line bg-paper shadow-xl text-[11px] text-ink z-50 rise-in">
              <div className="font-medium mb-1">Slack Integration Locked</div>
              <p className="text-text-muted text-[10px] leading-relaxed mb-2">
                Slack requires persistent socket connections in production mode (<code className="font-mono text-ink">flow up --mode prod</code>).
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Inline Active Forms */}
      {activeForm === "code_github" && (
        <div className="p-5 rounded-xl border border-line bg-sand flex flex-col gap-4 rise-in mt-2">
          <Kicker>GitHub Account Repositories</Kicker>
          <RepoPicker
            indexedUrls={indexedUrls}
            onMsg={(m) => setMsg(m)}
            onConnected={() => { setActiveTabForm("none"); onChanged(); }}
          />
        </div>
      )}

      {activeForm === "code_folder" && (
        <div className="p-5 rounded-xl border border-line bg-sand flex flex-col gap-4 rise-in mt-2">
          <AddFolder mode={mode} onAdded={() => { setActiveTabForm("none"); onChanged(); }} />
          <div className="border-t border-line/50 pt-3">
            <label className="block text-xs font-semibold text-ink mb-1">Or paste GitHub URL:</label>
            <AddRepoUrl onAdded={() => { setActiveTabForm("none"); onChanged(); }} />
          </div>
        </div>
      )}

      {activeForm === "linear" && (
        <div className="p-4 rounded-xl border border-line bg-sand flex flex-col gap-3 rise-in mt-2">
          <label className="text-xs font-semibold text-ink">Connect Linear API Key</label>
          <div className="flex gap-2">
            <input
              type="password"
              value={linearKey}
              onChange={(e) => setLinearKey(e.target.value)}
              placeholder="lin_api_..."
              className="flex-1 rounded-md border border-line bg-paper px-3 py-2 text-xs text-ink outline-none"
            />
            <Button
              onClick={() => handleSaveKey("LINEAR_API_KEY", linearKey)}
              disabled={!linearKey.trim() || savingKey}
              variant="primary"
            >
              Save Key
            </Button>
          </div>
        </div>
      )}

      {activeForm === "fireflies" && (
        <div className="p-4 rounded-xl border border-line bg-sand flex flex-col gap-3 rise-in mt-2">
          <label className="text-xs font-semibold text-ink">Connect Fireflies API Key</label>
          <div className="flex gap-2">
            <input
              type="password"
              value={firefliesKey}
              onChange={(e) => setFirefliesKey(e.target.value)}
              placeholder="ff_..."
              className="flex-1 rounded-md border border-line bg-paper px-3 py-2 text-xs text-ink outline-none"
            />
            <Button
              onClick={() => handleSaveKey("FIREFLIES_API_KEY", firefliesKey)}
              disabled={!firefliesKey.trim() || savingKey}
              variant="primary"
            >
              Save Key
            </Button>
          </div>
        </div>
      )}

      {activeForm === "notes" && (
        <form onSubmit={handleIngestNotes} className="p-4 rounded-xl border border-line bg-sand flex flex-col gap-3 rise-in mt-2">
          <label className="text-xs font-semibold text-ink">Paste Meeting Transcript or Decision Notes</label>
          <input
            type="text"
            value={notesTitle}
            onChange={(e) => setNotesTitle(e.target.value)}
            placeholder="Title (e.g. Architecture Decisions)"
            className="w-full rounded-md border border-line bg-paper px-3 py-2 text-xs text-ink outline-none"
          />
          <textarea
            value={notesText}
            onChange={(e) => setNotesText(e.target.value)}
            placeholder="Paste transcript or decisions..."
            rows={5}
            className="w-full rounded-md border border-line bg-paper px-3 py-2 text-xs text-ink outline-none resize-y"
          />
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
  );
}
