"use client";
// Deployment-level /connect page, two modes:
//   ?code=…  → approve a `flow connect` handshake: shows the machine label,
//              one click mints a PAT for the signed-in user and hands it to
//              the waiting CLI. (proxy.ts already forced login.)
//   no code  → the Connect page: the copy-paste command for a new machine,
//              plus this user's connected machines (PATs) with revocation.
import { useState, useEffect, useCallback, Suspense } from "react";
import { useSearchParams } from "next/navigation";

interface TokenRow {
  id: string;
  label: string;
  createdAt: string;
}

const card: React.CSSProperties = {
  maxWidth: 460,
  margin: "80px auto",
  padding: 28,
  borderRadius: 12,
  border: "1px solid var(--border)",
  background: "var(--surface-1)",
};

const button: React.CSSProperties = {
  padding: "10px 18px",
  borderRadius: 7,
  border: "none",
  background: "var(--accent, #4f7df7)",
  color: "#fff",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};

const mono: React.CSSProperties = {
  fontFamily: "ui-monospace, monospace",
  fontSize: 13,
  background: "var(--surface-2)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "8px 10px",
  display: "block",
  overflowX: "auto",
  whiteSpace: "nowrap",
};

function ApproveFlow({ code }: { code: string }) {
  const [label, setLabel] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "approved" | "error">("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(`/api/auth/device/${encodeURIComponent(code)}`, { cache: "no-store" })
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!ok) {
          setError(d.error ?? "Unknown or expired connect code");
          setState("error");
          return;
        }
        setLabel(d.label);
        setState(d.status === "approved" ? "approved" : "ready");
      })
      .catch(() => {
        setError("Couldn't reach the server");
        setState("error");
      });
  }, [code]);

  const approve = useCallback(() => {
    fetch(`/api/auth/device/${encodeURIComponent(code)}/approve`, { method: "POST" })
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!ok) {
          setError(d.error ?? "Approval failed");
          setState("error");
          return;
        }
        setState("approved");
      })
      .catch(() => {
        setError("Couldn't reach the server");
        setState("error");
      });
  }, [code]);

  if (state === "loading") return <div style={card}>Checking connect code…</div>;
  if (state === "error") {
    return (
      <div style={card}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>Connect failed</h2>
        <p style={{ color: "var(--text-secondary)", fontSize: 14 }}>{error}</p>
        <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>
          Rerun <code>flow connect</code> on your machine to get a fresh code.
        </p>
      </div>
    );
  }
  if (state === "approved") {
    return (
      <div style={card}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>✓ Machine connected</h2>
        <p style={{ color: "var(--text-secondary)", fontSize: 14 }}>
          <strong>{label}</strong> now holds a personal access token with your project grants. You can close this tab
          and return to the terminal.
        </p>
        <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>
          Revoke it any time from <a href="/connect">Connected machines</a>.
        </p>
      </div>
    );
  }
  return (
    <div style={card}>
      <h2 style={{ marginTop: 0, fontSize: 18 }}>Connect this machine?</h2>
      <p style={{ color: "var(--text-secondary)", fontSize: 14 }}>
        <strong>{label}</strong> is asking to connect to this Flow deployment. Approving mints a personal access token
        with <em>your</em> project grants — agents on that machine will read and write memory as you.
      </p>
      <button style={button} onClick={approve}>
        Approve
      </button>
    </div>
  );
}

function MachineList() {
  const [tokens, setTokens] = useState<TokenRow[] | null>(null);
  const [origin, setOrigin] = useState("");

  const load = useCallback(() => {
    fetch("/api/tokens", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { tokens: [] }))
      .then((d) => setTokens(d.tokens ?? []))
      .catch(() => setTokens([]));
  }, []);

  useEffect(() => {
    setOrigin(window.location.origin);
    load();
  }, [load]);

  const revoke = (id: string) => {
    fetch(`/api/tokens/${encodeURIComponent(id)}`, { method: "DELETE" }).then(load);
  };

  return (
    <div style={{ ...card, maxWidth: 560 }}>
      <h2 style={{ marginTop: 0, fontSize: 18 }}>Connect a machine</h2>
      <p style={{ color: "var(--text-secondary)", fontSize: 14 }}>
        On the machine you want to connect (with Flow installed), run:
      </p>
      <code style={mono}>flow connect {origin}</code>
      <p style={{ color: "var(--text-secondary)", fontSize: 13, marginTop: 10 }}>
        Your browser opens back here to approve it; the machine then holds a personal access token with your project
        grants. MCP clients can also use a token directly against <code>{origin}/&lt;project&gt;/mcp</code>.
      </p>

      <h3 style={{ fontSize: 15, marginTop: 28 }}>Connected machines</h3>
      {tokens === null ? (
        <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>Loading…</p>
      ) : tokens.length === 0 ? (
        <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>None yet.</p>
      ) : (
        <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: "8px 4px" }}>{t.label}</td>
                <td style={{ padding: "8px 4px", color: "var(--text-secondary)", fontFamily: "ui-monospace, monospace" }}>
                  flowpat_{t.id}_…
                </td>
                <td style={{ padding: "8px 4px", color: "var(--text-secondary)" }}>
                  {new Date(t.createdAt).toLocaleDateString()}
                </td>
                <td style={{ padding: "8px 4px", textAlign: "right" }}>
                  <button
                    onClick={() => revoke(t.id)}
                    style={{
                      background: "none",
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      padding: "4px 10px",
                      color: "var(--text-secondary)",
                      fontSize: 12,
                      cursor: "pointer",
                    }}
                  >
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ConnectInner() {
  const params = useSearchParams();
  const code = params.get("code");
  return code ? <ApproveFlow code={code} /> : <MachineList />;
}

export default function ConnectPage() {
  return (
    <Suspense fallback={<div style={card}>Loading…</div>}>
      <ConnectInner />
    </Suspense>
  );
}
