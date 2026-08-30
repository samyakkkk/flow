"use client";

import React, { useState } from "react";
import { BrainGraph } from "@/components/BrainGraph";

// Mock Data representing a rich agent session
const MOCK_TABS = [
  { id: "tab-1", title: "Landing page copy", branch: "feat/landing-hero", status: "ready_to_merge", pr: "#8376", active: false },
  { id: "tab-2", title: "Adjust Feature & Navigation", branch: "flow/adjust-feature-ui", status: "working", pr: null, active: true },
  { id: "tab-3", title: "Investigate crash", branch: "fix/session-leak", status: "done", pr: "#8370", active: false },
];

const MOCK_WORKSPACES = [
  { id: "w1", title: "Scope dynamic API keys", repo: "flow-core", time: "22h", avatars: ["👨‍💻", "🤖"] },
  { id: "w2", title: "Revamp Cloud Conductor dashboard", repo: "flow-ui", time: "7d", avatars: ["👩‍🎨"] },
  { id: "w3", title: "Landing page copy", repo: "marketing", time: "10h", avatars: ["📝"], active: true },
  { id: "w4", title: "Investigate workspace crash", repo: "flow-core", time: "22m", avatars: ["⚡"] },
  { id: "w5", title: "Hide single repo icon", repo: "flow-ui", time: "10h", avatars: ["🎨"] },
  { id: "w6", title: "Adjusting sidebar color contrast", repo: "flow-ui", time: "10h", avatars: ["🎨"] },
];

const MOCK_DIFF_FILES = [
  { path: "apps/marketing/src/app/page.tsx", adds: 53, dels: 46, status: "modified" },
  { path: "apps/marketing/src/components/AgentOrchestrationDemo.tsx", adds: 248, dels: 0, status: "added" },
  { path: "apps/marketing/src/components/AnywhereDemo.tsx", adds: 16, dels: 0, status: "added" },
  { path: "apps/marketing/src/components/BecomeAConductor.tsx", adds: 35, dels: 0, status: "added" },
  { path: "apps/marketing/src/components/CloudBetaSignupForm.tsx", adds: 0, dels: 157, status: "deleted" },
  { path: "apps/marketing/src/components/CloudBrailleVideo.tsx", adds: 0, dels: 72, status: "deleted" },
  { path: "apps/marketing/src/components/CloudInlineLoader.tsx", adds: 0, dels: 40, status: "deleted" },
  { path: "apps/marketing/src/components/CloudAsciiBackdrop.tsx", adds: 481, dels: 0, status: "added" },
];

export function AgentSessionConductor() {
  const [activeTab, setActiveTab] = useState("tab-2");
  const [activeInspectorTab, setActiveInspectorTab] = useState<"changes" | "brain" | "terminal" | "checks">("changes");
  const [toolCallsOpen, setToolCallsOpen] = useState(false);
  const [toolCallsOpen2, setToolCallsOpen2] = useState(false);
  const [inputVal, setInputVal] = useState("");
  const [model, setModel] = useState("Google Gemini 2.5 Flash");
  const [effort, setEffort] = useState("High");

  return (
    <div className="flex flex-col h-[calc(100vh-84px)] -m-9 bg-cream text-ink select-none overflow-hidden">
      {/* 1. TOP HEADER / TABS BAR */}
      <header className="h-12 border-b border-line bg-paper/60 backdrop-blur flex items-center justify-between px-3 flex-shrink-0">
        {/* Left window control / tab trail */}
        <div className="flex items-center gap-2 overflow-x-auto no-scrollbar max-w-[65%]">
          <div className="flex items-center gap-1 pr-2 border-r border-line text-text-muted">
            <button className="p-1 hover:bg-cream rounded text-xs">←</button>
            <button className="p-1 hover:bg-cream rounded text-xs">→</button>
          </div>

          {/* Session / Workspace Tabs */}
          <div className="flex items-center gap-1.5">
            {MOCK_TABS.map((tab) => {
              const isActive = activeTab === tab.id;
              return (
                <div
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`group flex items-center gap-2 px-3 py-1.5 rounded-md text-[12.5px] cursor-pointer transition border ${
                    isActive
                      ? "bg-cream border-line text-ink font-medium shadow-xs"
                      : "bg-transparent border-transparent text-text-muted hover:text-ink hover:bg-sand/40"
                  }`}
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-ok/80"></span>
                  <span className="truncate max-w-[160px]">{tab.title}</span>
                  <span className="text-[10px] text-text-muted opacity-0 group-hover:opacity-100 hover:text-ink">×</span>
                </div>
              );
            })}
            <button className="w-7 h-7 flex items-center justify-center rounded-md text-text-muted hover:text-ink hover:bg-sand/40 text-sm">
              +
            </button>
          </div>
        </div>

        {/* Right Status Actions & PR button */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <button className="p-1.5 text-text-muted hover:text-ink rounded-md hover:bg-sand/40" title="History / Undo">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
          </button>
          <button className="p-1.5 text-text-muted hover:text-ink rounded-md hover:bg-sand/40" title="Share">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
          </button>
          
          <div className="h-4 w-px bg-line mx-1" />

          {/* PR / Branch Status Badge */}
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-sand/60 border border-line text-[11px] font-mono text-text">
            <span className="text-ok font-semibold">#8376 ↗</span>
            <span className="text-ink">Ready to merge</span>
          </div>

          {/* Merge / Actions CTA */}
          <button className="flex items-center gap-1.5 px-3 py-1 bg-ink text-paper rounded-md text-[11.5px] font-medium hover:bg-ink/90 transition shadow-xs">
            <span>⎇ Merge</span>
          </button>
        </div>
      </header>

      {/* 2. THREE-PANE MAIN WORKSPACE */}
      <div className="flex flex-1 min-h-0">
        
        {/* PANE 1: WORKSPACE & RECENT SESSIONS SIDEBAR */}
        <aside className="w-64 border-r border-line bg-paper/30 flex flex-col justify-between p-3 flex-shrink-0 text-[12px]">
          <div className="flex flex-col gap-4 overflow-y-auto">
            {/* Top actions */}
            <div className="flex flex-col gap-1">
              <button className="flex items-center gap-2 px-2.5 py-1.5 rounded-md text-text hover:bg-sand/50 text-left font-medium">
                <span className="text-sm">⚡</span>
                <span className="flex-1">Home</span>
                <span className="text-[10px] text-text-muted">⌘H</span>
              </button>
              <button className="flex items-center gap-2 px-2.5 py-1.5 rounded-md text-text hover:bg-sand/50 text-left">
                <span className="text-sm">+</span>
                <span>Create Workspace</span>
              </button>
              <button className="flex items-center gap-2 px-2.5 py-1.5 rounded-md text-text hover:bg-sand/50 text-left">
                <span className="text-sm">🔍</span>
                <span>Search sessions</span>
              </button>
            </div>

            {/* Pinned section */}
            <div>
              <div className="text-[10px] uppercase font-mono tracking-wider text-text-muted px-2.5 mb-1.5 font-semibold">
                Pinned
              </div>
              <div className="flex items-center justify-between px-2.5 py-1.5 rounded-md hover:bg-sand/40 cursor-pointer text-ink">
                <span className="truncate">Scope dynamic API ke...</span>
                <span className="text-[10px] text-text-muted font-mono">22h</span>
              </div>
            </div>

            {/* Workspaces list */}
            <div>
              <div className="text-[10px] uppercase font-mono tracking-wider text-text-muted px-2.5 mb-1.5 font-semibold flex items-center justify-between">
                <span>Workspaces</span>
                <span className="text-[9px] lowercase bg-sand px-1.5 py-0.5 rounded text-text">active</span>
              </div>
              <div className="flex flex-col gap-0.5">
                {MOCK_WORKSPACES.map((w) => (
                  <div
                    key={w.id}
                    className={`flex items-center justify-between px-2.5 py-1.5 rounded-md cursor-pointer transition ${
                      w.active ? "bg-sand/80 text-ink font-medium" : "text-text hover:bg-sand/40"
                    }`}
                  >
                    <span className="truncate max-w-[150px]">{w.title}</span>
                    <span className="text-[10px] text-text-muted font-mono">{w.time}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* User / Workspace footer */}
          <div className="border-t border-line pt-2.5 flex items-center justify-between px-1 text-text-muted">
            <div className="flex items-center gap-2">
              <div className="w-5 h-5 rounded-full bg-accent text-ink font-bold flex items-center justify-center text-[10px]">
                F
              </div>
              <span className="text-[11.5px] font-medium text-ink">Flow Local</span>
            </div>
            <span className="text-[10px] font-mono uppercase bg-sand px-1.5 py-0.5 rounded">Pro</span>
          </div>
        </aside>

        {/* PANE 2: CENTER CONVERSATION & AGENT STEERING */}
        <main className="flex-1 min-w-0 flex flex-col bg-cream/50 relative">
          
          {/* Scrollable Transcript */}
          <div className="flex-1 overflow-y-auto p-6 space-y-6 max-w-4xl mx-auto w-full">
            
            {/* User message block */}
            <div className="flex flex-col items-end gap-1.5">
              <div className="bg-sand/70 border border-line rounded-2xl rounded-tr-sm px-4 py-3 max-w-[80%] text-[13.5px] text-ink leading-relaxed shadow-xs">
                lets actually make this the new hero image.
                <div className="mt-2.5 flex items-center gap-2 bg-paper/80 border border-line rounded-lg px-2.5 py-1 text-[11px] font-mono text-text">
                  <span>🖼️</span>
                  <span>CleanShot 2026-07-30 at 00.52.12@2x.png</span>
                </div>
              </div>
              <span className="text-[10px] font-mono text-text-muted px-2">12:42 PM · Samyak</span>
            </div>

            {/* Agent response block */}
            <div className="flex flex-col items-start gap-3 w-full">
              <div className="flex items-center gap-2 text-xs font-mono text-text-muted">
                <span className="w-2 h-2 rounded-full bg-ok animate-pulse" />
                <span className="font-medium text-ink">OpenCode</span>
                <span>·</span>
                <span>Google Gemini 2.5 Flash</span>
              </div>

              <div className="text-[13.5px] text-ink leading-relaxed max-w-[95%]">
                I'll replace the current homepage hero media with this screenshot, preserving its native proportions and the existing edge treatment so it doesn't crop or stretch. I'm using the marketing-repo and interface-polish guidance to match the current hero structure.
              </div>

              {/* Tool calls collapsible capsule 1 */}
              <div className="w-full max-w-[95%] border border-line rounded-lg bg-paper/50 overflow-hidden text-[12px]">
                <button
                  onClick={() => setToolCallsOpen(!toolCallsOpen)}
                  className="w-full px-3 py-2 flex items-center justify-between hover:bg-sand/30 font-mono text-text transition"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-text-muted">{toolCallsOpen ? "▼" : "▶"}</span>
                    <span>5 tool calls executed</span>
                  </div>
                  <span className="text-[10px] text-ok bg-ok/10 px-2 py-0.5 rounded-full font-sans">completed</span>
                </button>
                {toolCallsOpen && (
                  <div className="border-t border-line bg-cream/40 p-3 flex flex-col gap-1.5 font-mono text-[11px] text-text-muted">
                    <div className="flex items-center gap-2"><span>✓</span><span>read apps/marketing/src/app/page.tsx</span></div>
                    <div className="flex items-center gap-2"><span>✓</span><span>glob apps/marketing/src/components/*Hero*</span></div>
                    <div className="flex items-center gap-2"><span>✓</span><span>read apps/marketing/src/components/HeroHeadline.tsx</span></div>
                    <div className="flex items-center gap-2"><span>🧠</span><span>flow-graph orient</span></div>
                    <div className="flex items-center gap-2"><span>✓</span><span>edit apps/marketing/src/app/page.tsx</span></div>
                  </div>
                )}
              </div>

              <div className="w-full flex justify-end">
                <div className="bg-sand/50 text-[11px] font-mono px-3 py-1.5 rounded-md border border-line text-text">
                  Commit and push all changes
                </div>
              </div>

              {/* Tool calls collapsible capsule 2 */}
              <div className="w-full max-w-[95%] border border-line rounded-lg bg-paper/50 overflow-hidden text-[12px]">
                <button
                  onClick={() => setToolCallsOpen2(!toolCallsOpen2)}
                  className="w-full px-3 py-2 flex items-center justify-between hover:bg-sand/30 font-mono text-text transition"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-text-muted">{toolCallsOpen2 ? "▼" : "▶"}</span>
                    <span>17 tool calls, 3 git actions</span>
                  </div>
                  <span className="text-[10px] text-ok bg-ok/10 px-2 py-0.5 rounded-full font-sans">done</span>
                </button>
                {toolCallsOpen2 && (
                  <div className="border-t border-line bg-cream/40 p-3 flex flex-col gap-1.5 font-mono text-[11px] text-text-muted">
                    <div className="flex items-center gap-2"><span>✓</span><span>git add apps/marketing/...</span></div>
                    <div className="flex items-center gap-2"><span>✓</span><span>git commit -m "Refresh hero banner asset"</span></div>
                    <div className="flex items-center gap-2"><span>✓</span><span>git push origin feat/landing-hero</span></div>
                  </div>
                )}
              </div>

              {/* Formatted markdown summary */}
              <div className="prose prose-sm text-ink max-w-[95%] text-[13px] leading-relaxed">
                <p className="font-medium">Done and pushed.</p>
                <ul className="list-disc pl-5 space-y-1 my-2">
                  <li>New Conductor screenshot is now the hero image.</li>
                  <li>Preserved its native 3462×2128 aspect ratio with a cache-safe asset path.</li>
                  <li>Compressed to a 316 KB WebP format.</li>
                  <li>Included the rotating hero headline changes.</li>
                  <li>Commit: <code className="bg-sand px-1.5 py-0.5 rounded font-mono text-[11px]">e8d628ed5</code> — Refresh homepage hero</li>
                  <li>PR <a href="#" className="text-ink underline font-semibold">#8376 ↗</a></li>
                </ul>
              </div>

              {/* File touch pills */}
              <div className="flex items-center gap-2 flex-wrap text-[11px] font-mono pt-1">
                <span className="text-text-muted">2m 4s</span>
                <span className="px-2 py-0.5 rounded bg-paper border border-line text-text flex items-center gap-1">
                  <span>📄</span> conductor-app-hero.webp <span className="text-ok">+0 -0</span>
                </span>
                <span className="px-2 py-0.5 rounded bg-paper border border-line text-text flex items-center gap-1">
                  <span>⚛️</span> HeroHeadline.tsx <span className="text-ok">+2</span> <span className="text-danger">-7</span>
                </span>
                <span className="px-2 py-0.5 rounded bg-paper border border-line text-text flex items-center gap-1">
                  <span>⚛️</span> Screenshot.tsx <span className="text-ok">+6</span> <span className="text-danger">-6</span>
                </span>
              </div>
            </div>
          </div>

          {/* Prompt Composer & Steering Dock */}
          <div className="p-4 bg-gradient-to-t from-cream via-cream to-transparent flex-shrink-0">
            <div className="max-w-4xl mx-auto rounded-xl border border-line bg-paper shadow-sm p-2.5 flex flex-col gap-2">
              
              {/* Text Input */}
              <textarea
                value={inputVal}
                onChange={(e) => setInputVal(e.target.value)}
                placeholder="Ask or steer the agent... (@ to mention file, / for commands)"
                rows={2}
                className="w-full bg-transparent text-[13.5px] text-ink placeholder:text-text-muted/60 focus:outline-none resize-none px-2 pt-1"
              />

              {/* Toolbar Controls */}
              <div className="flex items-center justify-between border-t border-line/60 pt-2 px-1 text-xs">
                <div className="flex items-center gap-2">
                  <button className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-sand/60 hover:bg-sand border border-line text-text text-[11.5px] font-mono">
                    <span>⚡ {model}</span>
                    <span className="text-[9px] text-text-muted">▼</span>
                  </button>

                  <button className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-sand/60 hover:bg-sand border border-line text-text text-[11.5px] font-mono">
                    <span>Effort: {effort}</span>
                    <span className="text-[9px] text-text-muted">▼</span>
                  </button>

                  <button className="p-1.5 text-text-muted hover:text-ink hover:bg-sand/60 rounded-md" title="Attach file">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M13 6.5l-5.5 5.5a2.5 2.5 0 0 1-3.5-3.5l6-6a1.6 1.6 0 0 1 2.3 2.3l-6 6a0.7 0.7 0 0 1-1-1L11 5" /></svg>
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-mono text-text-muted hidden sm:inline">⌘L to focus</span>
                  <button className="w-7 h-7 flex items-center justify-center rounded-lg bg-ink text-paper hover:opacity-90 transition font-bold text-xs">
                    ↑
                  </button>
                </div>
              </div>
            </div>
          </div>
        </main>

        {/* PANE 3: RIGHT INSPECTOR (DIFFS, BRAIN GRAPH, TERMINAL/RUN) */}
        <aside className="w-96 border-l border-line bg-paper/20 flex flex-col flex-shrink-0">
          
          {/* Top Inspector Tabs */}
          <div className="flex items-center justify-between px-3 border-b border-line bg-paper/50 h-10">
            <div className="flex items-center gap-1">
              <button
                onClick={() => setActiveInspectorTab("changes")}
                className={`px-2.5 py-1 text-[11.5px] font-mono rounded-md transition ${
                  activeInspectorTab === "changes"
                    ? "bg-sand text-ink font-semibold"
                    : "text-text-muted hover:text-ink"
                }`}
              >
                Changes <span className="text-[10px] text-text-muted">74</span>
              </button>
              <button
                onClick={() => setActiveInspectorTab("brain")}
                className={`px-2.5 py-1 text-[11.5px] font-mono rounded-md transition ${
                  activeInspectorTab === "brain"
                    ? "bg-sand text-ink font-semibold"
                    : "text-text-muted hover:text-ink"
                }`}
              >
                🧠 Brain
              </button>
              <button
                onClick={() => setActiveInspectorTab("checks")}
                className={`px-2.5 py-1 text-[11.5px] font-mono rounded-md transition ${
                  activeInspectorTab === "checks"
                    ? "bg-sand text-ink font-semibold"
                    : "text-text-muted hover:text-ink"
                }`}
              >
                Checks
              </button>
            </div>

            <div className="flex items-center gap-1">
              <button className="p-1 text-text-muted hover:text-ink text-xs">⎇ vs dev</button>
            </div>
          </div>

          {/* Inspector Content */}
          <div className="flex-1 overflow-y-auto p-3 flex flex-col min-h-0">
            {activeInspectorTab === "changes" && (
              <div className="flex flex-col gap-1 text-[11.5px] font-mono">
                {MOCK_DIFF_FILES.map((file, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between px-2.5 py-1.5 rounded hover:bg-sand/50 cursor-pointer group"
                  >
                    <span className="truncate max-w-[230px] text-text group-hover:text-ink">
                      {file.path.split("/").pop()}
                    </span>
                    <div className="flex items-center gap-1 text-[10.5px]">
                      {file.adds > 0 && <span className="text-ok">+{file.adds}</span>}
                      {file.dels > 0 && <span className="text-danger">-{file.dels}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {activeInspectorTab === "brain" && (
              <div className="h-full flex flex-col">
                <div className="flex-1 rounded-lg border border-line overflow-hidden bg-sand/30 min-h-[220px]">
                  <BrainGraph citedNodeIds={[]} fillHeight mode="overview" pollInterval={0} />
                </div>
                <div className="pt-2 text-[10px] font-mono uppercase text-text-muted">
                  435 nodes · 744 edges
                </div>
              </div>
            )}

            {activeInspectorTab === "checks" && (
              <div className="flex flex-col gap-2 p-2 text-xs">
                <div className="flex items-center justify-between p-2 rounded bg-ok/10 border border-ok/20">
                  <span className="font-mono text-ok">✓ Build (Next.js)</span>
                  <span className="text-[10px] text-text-muted">Passed</span>
                </div>
                <div className="flex items-center justify-between p-2 rounded bg-ok/10 border border-ok/20">
                  <span className="font-mono text-ok">✓ TypeScript check</span>
                  <span className="text-[10px] text-text-muted">Passed</span>
                </div>
              </div>
            )}
          </div>

          {/* Bottom Execution Preview / Dev Action Box */}
          <div className="border-t border-line p-3 bg-paper/40 flex flex-col gap-2 flex-shrink-0">
            <div className="flex items-center justify-between text-[11px] font-mono text-text-muted">
              <span className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-ok" />
                <span>Dev Server</span>
              </span>
              <span>⌘R</span>
            </div>

            <button className="w-full py-2 px-3 rounded-lg border border-line bg-sand/50 hover:bg-sand text-ink text-xs font-mono font-medium flex items-center justify-center gap-2 transition">
              <span>▶</span>
              <span>Start Dev</span>
            </button>
          </div>
        </aside>

      </div>
    </div>
  );
}
