"use client";

// D4 — connect ChatGPT / claude.ai to this project's brain WITHOUT a
// marketplace. Every self-hosted deployment already exposes its brain as a
// remote MCP server at /<project>/mcp (bearer-authed). So "installing" a
// consumer connector is just: this deployment's URL + a personal token +
// paste steps for the target app. Instance-parameterized by construction —
// the URL is THIS deployment's origin, the token inherits the viewer's grants.
// Member-allowed: it's a personal connector, like linking your own coding tool.

import { useState } from "react";
import { useProject } from "@/lib/useProject";

type App = "chatgpt" | "claude";

const APP_META: Record<App, { label: string; steps: string[] }> = {
  chatgpt: {
    label: "ChatGPT",
    steps: [
      "Open ChatGPT → Settings → Connectors → Create.",
      "Choose “Add a custom MCP server”.",
      "Name it “Flow”, paste the Server URL below.",
      "Set Authentication to “Access token / API key” and paste the token below.",
      "Save. Then in any chat, enable the Flow connector and ask about your codebase.",
    ],
  },
  claude: {
    label: "claude.ai",
    steps: [
      "Open claude.ai → Settings → Connectors → Add custom connector.",
      "Paste the Server URL below.",
      "When asked for authentication, choose token/header and paste the token below.",
      "Save. Flow’s tools (orient, search, remember) appear in the connector.",
    ],
  },
};

function Row({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[10px] uppercase tracking-wider text-text-muted">{label}</div>
      <div className="flex items-center gap-2">
        <code className="flex-1 font-mono text-[11px] bg-cream border border-line rounded px-2 py-1.5 overflow-x-auto whitespace-nowrap text-ink">
          {value}
        </code>
        <button
          className="text-[11px] px-2 py-1 rounded border border-ink/20 text-ink/60 hover:border-ink/40 hover:text-ink shrink-0"
          onClick={() => {
            void navigator.clipboard?.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

export function ConsumerConnectorModal({ app, onClose }: { app: App; onClose: () => void }) {
  const { project, prefix } = useProject();
  const meta = APP_META[app];
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const mcpUrl = project ? `${origin}/${project}/mcp` : `${origin}/<project>/mcp`;

  const [token, setToken] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);
  const [err, setErr] = useState("");

  async function mint() {
    setMinting(true);
    setErr("");
    try {
      const res = await fetch(prefix("/api/tokens"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: `${meta.label} connector` }),
      });
      const d = (await res.json()) as { token?: string; error?: string };
      if (res.ok && d.token) setToken(d.token);
      else setErr(d.error ?? "Could not generate a token.");
    } catch {
      setErr("Network error generating token.");
    } finally {
      setMinting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/45 p-4" onClick={onClose}>
      <div
        className="bg-paper border border-line rounded-2xl w-full max-w-lg max-h-[88vh] overflow-y-auto p-5 shadow-2xl rise-in flex flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line pb-3">
          <span className="font-semibold text-ink text-sm">Connect {meta.label} to this brain</span>
          <button onClick={onClose} className="text-text-muted hover:text-ink text-lg">✕</button>
        </div>

        <p className="text-xs text-text-muted">
          {meta.label} reaches this project&apos;s brain through Flow&apos;s remote MCP server — no marketplace,
          no install. Add it as a custom connector with the URL and token below.
        </p>

        <Row label="Server URL (MCP)" value={mcpUrl} />

        <div className="flex flex-col gap-1">
          <div className="text-[10px] uppercase tracking-wider text-text-muted">Access token</div>
          {token ? (
            <>
              <Row label="" value={token} />
              <div className="text-[10px] text-[color:var(--warning,#b45309)]">
                Shown once — copy it now. It inherits your access to this project.
              </div>
            </>
          ) : (
            <button
              onClick={mint}
              disabled={minting}
              className="self-start text-[12px] px-3 py-1.5 rounded-lg bg-ink text-paper disabled:opacity-50"
            >
              {minting ? "Generating…" : "Generate a token"}
            </button>
          )}
          {err && <div className="text-[11px] text-red-600">{err}</div>}
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="text-[10px] uppercase tracking-wider text-text-muted">Steps in {meta.label}</div>
          <ol className="list-decimal pl-5 text-xs text-ink/80 leading-relaxed flex flex-col gap-0.5">
            {meta.steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}
