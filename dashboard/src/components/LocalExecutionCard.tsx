"use client";
// The prod dashboard's window onto THIS machine's local Flow, and the gate for
// running agents here. Four states, decided by a localhost probe refined by the
// server-side machine record (which survives reboots, unlike the probe):
//   connected            → probe succeeds → link into native local agents
//   lna-denied           → probe blocked by Chrome's Local Network Access perm
//   installed-not-running→ has a machine record but probe fails → `flow up`
//   not-connected        → no machine record → the one-command install
// The machine record is trusted OVER the probe for "has this machine ever
// connected", so we never tell someone with Flow installed to reinstall.
// Renders nothing in local mode: the page already IS the local dashboard.
import { useState, useEffect, useCallback } from "react";
import { discoverLocal, type LocalLink } from "@/lib/executionClient";
import { RemoteBrainComposer } from "@/components/RemoteBrainComposer";

type State = "probing" | "connected" | "lna-denied" | "installed-not-running" | "not-connected";

const wrap: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 10,
  background: "var(--surface-1)",
  padding: "14px 18px",
  marginBottom: 18,
  fontSize: 13,
};

const retryBtn: React.CSSProperties = {
  background: "none",
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "2px 10px",
  color: "var(--text-secondary)",
  fontSize: 12,
  cursor: "pointer",
  marginLeft: 6,
};

async function lnaIsDenied(): Promise<boolean> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = await (navigator.permissions.query({ name: "local-network-access" as any }) as Promise<PermissionStatus>);
    return p.state === "denied";
  } catch {
    return false; // Safari/Firefox have no such permission name
  }
}

export function LocalExecutionCard() {
  const [mode, setMode] = useState<"local" | "prod" | null>(null);
  const [state, setState] = useState<State>("probing");
  const [link, setLink] = useState<LocalLink | null>(null);
  const [installCmd, setInstallCmd] = useState<string>("");
  const [copied, setCopied] = useState(false);

  const probe = useCallback(async () => {
    setState("probing");
    const l = await discoverLocal();
    if (l && l.base !== undefined) {
      // base "" means the page itself is the local dashboard (same origin).
      setLink(l);
      setState("connected");
      return;
    }
    // Probe failed — disambiguate with the server record + the LNA permission.
    if (await lnaIsDenied()) {
      setState("lna-denied");
      return;
    }
    const machines = await fetch("/api/machines", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { machines: [] }))
      .then((d) => d.machines ?? [])
      .catch(() => []);
    if (machines.length > 0) {
      setState("installed-not-running");
      return;
    }
    // Never connected → build the one-command install with a pre-blessed code.
    const origin = window.location.origin;
    const code = await fetch("/api/auth/device/prebless", { method: "POST" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.code as string | undefined)
      .catch(() => undefined);
    setInstallCmd(
      code
        ? `curl -fsSL ${origin}/install.sh | bash -s -- --connect ${origin} --code ${code}`
        : `flow connect ${origin}`
    );
    setState("not-connected");
  }, []);

  useEffect(() => {
    fetch("/api/auth/status", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        setMode(d.mode);
        if (d.mode === "prod") probe();
      })
      .catch(() => setMode(null));
  }, [probe]);

  if (mode !== "prod") return null;

  if (state === "probing") {
    return <div style={wrap}>Checking for a local Flow on this machine…</div>;
  }

  if (state === "connected" && link) {
    return (
      <div style={wrap}>
        <div>
          <span style={{ color: "var(--success, #34c759)", marginRight: 8 }}>●</span>
          <strong>This machine&apos;s Flow is connected.</strong>
        </div>
        {/* The composer: pick a local WORKSPACE, run on your machine, brain =
            this deployment's project. It discovers this machine's runner (set
            up by `flow connect`) through the door — no local project to pick. */}
        <RemoteBrainComposer link={link} />
      </div>
    );
  }

  if (state === "lna-denied") {
    return (
      <div style={wrap}>
        <span style={{ color: "var(--warning, #ff9f0a)", marginRight: 8 }}>▲</span>
        <strong>Chrome is blocking access to your local Flow.</strong>{" "}
        <span style={{ color: "var(--text-secondary)" }}>
          Allow <em>local network access</em> for this site (click the icon left of the address bar → Site settings →
          Local network access → Allow), then retry.
        </span>{" "}
        <button onClick={probe} style={retryBtn}>
          Retry
        </button>
      </div>
    );
  }

  if (state === "installed-not-running") {
    // The probe failed but this machine has a connection record. We can't tell
    // "Flow isn't running" from "the browser couldn't reach it" (LNA permission
    // still on 'prompt', an insecure http:// page, or a port mismatch), so we
    // name both rather than assert one — the old copy said "not running", which
    // was wrong when Flow was up but the browser was blocking the request.
    const insecure = typeof window !== "undefined" && window.location.protocol !== "https:";
    return (
      <div style={wrap}>
        <div>
          <span style={{ color: "var(--warning, #ff9f0a)", marginRight: 8 }}>◐</span>
          <strong>This machine is connected, but the page couldn&apos;t reach its Flow.</strong>
        </div>
        <ul style={{ color: "var(--text-secondary)", margin: "8px 0 0", paddingLeft: 28, lineHeight: 1.6 }}>
          <li>
            Make sure Flow is running here — <code>flow up</code> in a terminal.
          </li>
          <li>
            Allow <em>local network access</em> for this site (the icon left of the address bar → Site
            settings → Local network access → Allow).
          </li>
          {insecure && (
            <li>
              Open the <strong>https://</strong> dashboard — Chrome blocks reaching localhost from an
              insecure <code>http://</code> page.
            </li>
          )}
        </ul>
        <button onClick={probe} style={{ ...retryBtn, marginLeft: 28, marginTop: 8 }}>
          Retry
        </button>
      </div>
    );
  }

  // not-connected → the one-command install.
  return (
    <div style={wrap}>
      <div>
        <span style={{ color: "var(--text-secondary)", marginRight: 8 }}>○</span>
        <strong>Run agents on this machine.</strong>{" "}
        <span style={{ color: "var(--text-secondary)" }}>
          Install Flow and connect it to this deployment with one command:
        </span>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
        <code
          style={{
            flex: 1,
            fontFamily: "ui-monospace, monospace",
            fontSize: 12,
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "8px 10px",
            overflowX: "auto",
            whiteSpace: "nowrap",
          }}
        >
          {installCmd}
        </code>
        <button
          onClick={() => {
            navigator.clipboard?.writeText(installCmd).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          style={{ ...retryBtn, marginLeft: 0 }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <button onClick={probe} style={{ ...retryBtn, marginLeft: 0 }}>
          Recheck
        </button>
      </div>
      <div style={{ color: "var(--text-secondary)", fontSize: 12, marginTop: 8 }}>
        Then refresh this tab. The command is safe to re-run — it reconnects in place.
      </div>
    </div>
  );
}
