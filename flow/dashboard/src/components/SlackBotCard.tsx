"use client";
// SlackBotCard — Add/Disconnect the deployment's Slack bot (the Q&A agent).
//
// Each self-hosted deployment creates its OWN Slack app: the "Create Slack
// app" button deep-links api.slack.com with the instance's manifest
// prefilled; the user generates an app-level token, installs the app, and
// pastes the two tokens here. Tokens go through PUT /api/settings →
// orchestrator settings (encrypted, hot-applied) — the agent connects via
// Socket Mode without a restart. Disconnect clears both tokens the same way.

import { useCallback, useEffect, useRef, useState } from "react";
import { useProject } from "@/lib/useProject";

interface SlackStatus {
  configured: boolean;
  connected: boolean;
  bot_user_id: string | null;
  bot_name: string | null;
  team: string | null;
  last_error: string | null;
}

interface ManifestInfo {
  project: string;
  manifest: Record<string, unknown>;
  create_url: string;
}

export function SlackBotCard() {
  const { prefix } = useProject();
  const [status, setStatus] = useState<SlackStatus | null>(null);
  const [manifestInfo, setManifestInfo] = useState<ManifestInfo | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [botToken, setBotToken] = useState("");
  const [appToken, setAppToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [copied, setCopied] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(() => {
    fetch(prefix("/api/slack/status"))
      .then((r) => r.json())
      .then((d) => setStatus(d as SlackStatus))
      .catch(() => {});
  }, [prefix]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Poll while the wizard is open or a connect is settling.
  useEffect(() => {
    if (!wizardOpen && !busy) return;
    pollRef.current = setInterval(refresh, 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [wizardOpen, busy, refresh]);

  const openWizard = async () => {
    setWizardOpen(true);
    setMsg("");
    if (!manifestInfo) {
      try {
        const r = await fetch(prefix("/api/slack/manifest"));
        if (r.ok) setManifestInfo((await r.json()) as ManifestInfo);
      } catch {
        /* card shows copy fallback error below */
      }
    }
  };

  const copyManifest = async () => {
    if (!manifestInfo) return;
    await navigator.clipboard.writeText(JSON.stringify(manifestInfo.manifest, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const connect = async () => {
    if (!botToken.trim().startsWith("xoxb-") || !appToken.trim().startsWith("xapp-")) {
      setMsg("Expected a bot token starting with xoxb- and an app token starting with xapp-.");
      return;
    }
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch(prefix("/api/settings"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          SLACK_BOT_TOKEN: botToken.trim(),
          SLACK_APP_TOKEN: appToken.trim(),
        }),
      });
      if (!res.ok) {
        const d = (await res.json()) as { error?: string };
        throw new Error(d.error ?? `HTTP ${res.status}`);
      }
      setBotToken("");
      setAppToken("");
      // Give the hot-apply a few seconds, then let polling confirm.
      setTimeout(() => {
        refresh();
        setBusy(false);
        setWizardOpen(false);
      }, 4000);
    } catch (err) {
      setMsg(`Could not save tokens: ${(err as Error).message}`);
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!window.confirm("Disconnect the Slack bot? It will stop answering until reconnected.")) return;
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch(prefix("/api/settings"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ SLACK_BOT_TOKEN: "", SLACK_APP_TOKEN: "" }),
      });
      if (!res.ok) {
        const d = (await res.json()) as { error?: string };
        throw new Error(d.error ?? `HTTP ${res.status}`);
      }
      setTimeout(() => {
        refresh();
        setBusy(false);
      }, 2000);
    } catch (err) {
      setMsg(`Could not disconnect: ${(err as Error).message}`);
      setBusy(false);
    }
  };

  const connected = Boolean(status?.connected);
  const configured = Boolean(status?.configured);

  return (
    <div
      style={{
        padding: "14px 16px",
        background: "var(--surface-2)",
        border: "1px solid var(--border)",
        borderRadius: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)" }}>Slack bot</span>
        <span
          style={{
            fontSize: 11,
            padding: "2px 8px",
            borderRadius: 4,
            background: connected ? "rgba(34,197,94,0.1)" : "var(--surface)",
            color: connected ? "var(--success)" : "var(--text-muted)",
            border: connected ? "1px solid rgba(34,197,94,0.2)" : "1px solid var(--border)",
            fontWeight: 600,
          }}
        >
          {connected ? "Connected" : configured ? "Configured (connecting…)" : "Off"}
        </span>
      </div>

      <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5, marginBottom: 10 }}>
        {connected ? (
          <>
            <strong style={{ color: "var(--text-secondary)" }}>{status?.bot_name ?? "bot"}</strong>
            {status?.team ? ` in ${status.team}` : ""} — DM it, @mention it in a channel, or add it to a
            group DM to ask Flow questions.
          </>
        ) : (
          <>Ask Flow questions from Slack — DMs, channels (via @mention), group DMs, and Slack Connect. Works in local and prod modes (Socket Mode, no public URL needed).</>
        )}
        {status?.last_error && !connected ? (
          <div style={{ color: "var(--danger, #e5484d)", marginTop: 4 }}>Last error: {status.last_error}</div>
        ) : null}
      </div>

      {connected || configured ? (
        <button
          onClick={disconnect}
          disabled={busy}
          style={{
            padding: "7px 14px",
            borderRadius: 6,
            border: "1px solid var(--border)",
            background: "var(--surface)",
            color: "var(--text-primary)",
            fontSize: 12,
            fontWeight: 600,
            cursor: busy ? "wait" : "pointer",
          }}
        >
          {busy ? "Working…" : "Disconnect"}
        </button>
      ) : !wizardOpen ? (
        <button
          onClick={openWizard}
          style={{
            padding: "7px 14px",
            borderRadius: 6,
            border: "1px solid var(--border)",
            background: "var(--accent, #4f46e5)",
            color: "#fff",
            fontSize: 12,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Add Slack bot
        </button>
      ) : (
        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.6, marginBottom: 8 }}>
            <strong>1.</strong> Create the app in your workspace (manifest is prefilled):{" "}
            <a
              href={manifestInfo?.create_url ?? "https://api.slack.com/apps?new_app=1"}
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--accent, #4f46e5)", fontWeight: 600 }}
            >
              Create Slack app ↗
            </a>{" "}
            <button
              onClick={copyManifest}
              disabled={!manifestInfo}
              style={{
                fontSize: 11,
                padding: "2px 8px",
                borderRadius: 4,
                border: "1px solid var(--border)",
                background: "var(--surface)",
                color: "var(--text-secondary)",
                cursor: "pointer",
              }}
            >
              {copied ? "Copied!" : "or copy manifest JSON"}
            </button>
            <br />
            <strong>2.</strong> On the app&apos;s page: <em>Basic Information → App-Level Tokens</em> →
            generate a token with <code>connections:write</code> (xapp-…).
            <br />
            <strong>3.</strong> <em>Install App → Install to Workspace</em> → copy the Bot User OAuth
            Token (xoxb-…).
          </div>
          <input
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            placeholder="Bot token (xoxb-…)"
            type="password"
            style={inputStyle}
          />
          <input
            value={appToken}
            onChange={(e) => setAppToken(e.target.value)}
            placeholder="App-level token (xapp-…)"
            type="password"
            style={inputStyle}
          />
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              onClick={connect}
              disabled={busy || !botToken || !appToken}
              style={{
                padding: "7px 14px",
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "var(--accent, #4f46e5)",
                color: "#fff",
                fontSize: 12,
                fontWeight: 600,
                cursor: busy ? "wait" : "pointer",
                opacity: busy || !botToken || !appToken ? 0.6 : 1,
              }}
            >
              {busy ? "Connecting…" : "Connect"}
            </button>
            <button
              onClick={() => setWizardOpen(false)}
              style={{
                padding: "7px 14px",
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "var(--surface)",
                color: "var(--text-secondary)",
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {msg && <div style={{ fontSize: 12, color: "var(--danger, #e5484d)", marginTop: 8 }}>{msg}</div>}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 11px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text-primary)",
  fontSize: 12,
  fontFamily: "ui-monospace, monospace",
  outline: "none",
  marginBottom: 8,
  boxSizing: "border-box",
};
