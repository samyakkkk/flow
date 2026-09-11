"use client";
// AccessSettings — deployment-level people & machine credentials, rendered at
// the bottom of Settings in prod mode only. Two panels:
//   Access (owners): create/remove users, edit per-project grants.
//   API tokens (everyone): mint/revoke personal access tokens — the
//   credential agents use against the gateway, inheriting your grants.
// All endpoints here are deployment-level (unprefixed): /api/access/*,
// /api/tokens, /api/auth/status, /api/projects.
import { useCallback, useEffect, useState } from "react";

interface UserRow {
  id: string;
  email: string;
  role: "owner" | "member";
  grants: string[];
}

interface TokenRow {
  id: string;
  label: string;
  createdAt: string;
}

const panel: React.CSSProperties = {
  background: "var(--surface, var(--paper))",
  border: "1px solid var(--border, var(--line))",
  borderRadius: 10,
  padding: "20px 22px",
  marginBottom: 20,
};

const h2: React.CSSProperties = { margin: "0 0 4px", fontSize: 15, fontWeight: 500, color: "var(--text-primary)" };
const sub: React.CSSProperties = { margin: "0 0 16px", fontSize: 12.5, color: "var(--text-secondary)" };
const inputStyle: React.CSSProperties = {
  padding: "8px 10px",
  borderRadius: 6,
  border: "1px solid var(--border, var(--line))",
  background: "var(--surface-2, var(--cream))",
  color: "var(--text-primary)",
  fontSize: 13,
  outline: "none",
};
const btn: React.CSSProperties = {
  padding: "8px 14px",
  borderRadius: 6,
  border: "1px solid var(--border, var(--line))",
  background: "var(--accent)",
  color: "#fff",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};
const btnQuiet: React.CSSProperties = { ...btn, background: "transparent", color: "var(--text-secondary)", fontWeight: 400 };

export function AccessSettings() {
  const [me, setMe] = useState<{ id: string; email: string; role: string } | null>(null);
  const [prod, setProd] = useState(false);

  useEffect(() => {
    fetch("/api/auth/status", { cache: "no-store" })
      .then((r) => r.json())
      .then((s) => {
        const st = s as { mode?: string; user?: { id: string; email: string; role: string } | null };
        setProd(st.mode === "prod");
        setMe(st.user ?? null);
      })
      .catch(() => {});
  }, []);

  if (!prod || !me) return null;
  return (
    <>
      {me.role === "owner" && <AccessPanel meId={me.id} />}
      <TokensPanel />
    </>
  );
}

function AccessPanel({ meId }: { meId: string }) {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newGrants, setNewGrants] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetch("/api/access/users", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setUsers((d as { users?: UserRow[] }).users ?? []))
      .catch(() => {});
    fetch("/api/projects", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setProjects(((d as { projects?: { name: string }[] }).projects ?? []).map((p) => p.name)))
      .catch(() => {});
  }, []);
  useEffect(load, [load]);

  async function createUser() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/access/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, grants: newGrants }),
      });
      const d = (await res.json()) as { error?: string };
      if (!res.ok) setError(d.error ?? "Failed");
      else {
        setEmail("");
        setPassword("");
        setNewGrants([]);
        load();
      }
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  }

  async function updateGrants(u: UserRow, project: string, granted: boolean) {
    const grants = granted ? [...u.grants.filter((g) => g !== project), project] : u.grants.filter((g) => g !== project);
    await fetch(`/api/access/users/${u.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grants }),
    });
    load();
  }

  async function removeUser(u: UserRow) {
    if (!window.confirm(`Remove ${u.email}? Their sessions and API tokens stop working immediately.`)) return;
    await fetch(`/api/access/users/${u.id}`, { method: "DELETE" });
    load();
  }

  return (
    <div style={panel}>
      <h2 style={h2}>Access</h2>
      <p style={sub}>
        Who can open which project. Members see only their granted projects — in the switcher, in URLs, and
        through their API tokens. Owners see everything.
      </p>

      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 18 }}>
        <thead>
          <tr>
            {["User", "Role", ...projects, ""].map((hd, i) => (
              <th
                key={i}
                style={{
                  textAlign: "left",
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  color: "var(--text-muted)",
                  padding: "6px 8px",
                  borderBottom: "1px solid var(--border, var(--line))",
                }}
              >
                {hd}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td style={{ padding: "8px", fontSize: 13, color: "var(--text-primary)" }}>{u.email}</td>
              <td style={{ padding: "8px", fontSize: 12, color: "var(--text-secondary)" }}>{u.role}</td>
              {projects.map((p) => (
                <td key={p} style={{ padding: "8px" }}>
                  <input
                    type="checkbox"
                    checked={u.role === "owner" || u.grants.includes("*") || u.grants.includes(p)}
                    disabled={u.role === "owner"}
                    onChange={(e) => updateGrants(u, p, e.target.checked)}
                  />
                </td>
              ))}
              <td style={{ padding: "8px", textAlign: "right" }}>
                {u.id !== meId && (
                  <button style={{ ...btnQuiet, padding: "4px 10px", fontSize: 12 }} onClick={() => removeUser(u)}>
                    Remove
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input style={inputStyle} type="email" placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input
          style={inputStyle}
          type="password"
          placeholder="initial password (share it once)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {projects.map((p) => (
          <label key={p} style={{ fontSize: 12, color: "var(--text-secondary)", display: "inline-flex", gap: 4, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={newGrants.includes(p)}
              onChange={(e) => setNewGrants((g) => (e.target.checked ? [...g, p] : g.filter((x) => x !== p)))}
            />
            {p}
          </label>
        ))}
        <button style={btn} disabled={busy || !email || password.length < 8} onClick={createUser}>
          Add user
        </button>
      </div>
      {error && <p style={{ color: "var(--error, #ef4444)", fontSize: 12, marginTop: 8 }}>{error}</p>}
    </div>
  );
}

function TokensPanel() {
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [label, setLabel] = useState("");
  const [minted, setMinted] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetch("/api/tokens", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setTokens((d as { tokens?: TokenRow[] }).tokens ?? []))
      .catch(() => {});
  }, []);
  useEffect(load, [load]);

  async function mint() {
    setBusy(true);
    setMinted(null);
    try {
      const res = await fetch("/api/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      });
      const d = (await res.json()) as { token?: string };
      if (res.ok && d.token) {
        setMinted(d.token);
        setLabel("");
        load();
      }
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    await fetch(`/api/tokens/${id}`, { method: "DELETE" });
    load();
  }

  return (
    <div style={panel}>
      <h2 style={h2}>API tokens</h2>
      <p style={sub}>
        The machine credential for coding agents talking to this deployment&apos;s graph (MCP). A token carries
        your project grants; revoking it — or your account — cuts that access within seconds.
      </p>

      {tokens.map((t) => (
        <div
          key={t.id}
          style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid var(--border, var(--line))" }}
        >
          <span style={{ fontSize: 13, color: "var(--text-primary)" }}>
            {t.label}{" "}
            <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "ui-monospace, monospace" }}>
              flowpat_{t.id}_…
            </span>
          </span>
          <button style={{ ...btnQuiet, padding: "4px 10px", fontSize: 12 }} onClick={() => revoke(t.id)}>
            Revoke
          </button>
        </div>
      ))}

      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        <input style={{ ...inputStyle, flex: 1 }} placeholder="label (e.g. laptop-claude)" value={label} onChange={(e) => setLabel(e.target.value)} />
        <button style={btn} disabled={busy} onClick={mint}>
          Mint token
        </button>
      </div>
      {minted && (
        <p
          style={{
            marginTop: 10,
            fontSize: 12,
            fontFamily: "ui-monospace, monospace",
            color: "var(--text-primary)",
            background: "var(--surface-2, var(--sand))",
            padding: "8px 10px",
            borderRadius: 6,
            wordBreak: "break-all",
          }}
        >
          {minted}
          <br />
          <span style={{ color: "var(--text-muted)", fontFamily: "inherit" }}>
            Copy it now — it is shown only once.
          </span>
        </p>
      )}
    </div>
  );
}
