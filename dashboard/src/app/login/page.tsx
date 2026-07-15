"use client";
// Deployment-level sign-in. Three states, decided by /api/auth/status:
//   local            → no login exists; bounce straight back
//   prod, first run  → create the owner account (setup code from `flow up`)
//   prod             → email + password
// One session covers every project the account is granted.
import { useState, useEffect, FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";

interface AuthStatus {
  mode: "local" | "prod";
  needsBootstrap: boolean;
}

function Field({
  label,
  type,
  value,
  onChange,
  placeholder,
  autoFocus,
  mono,
}: {
  label: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  mono?: boolean;
}) {
  return (
    <>
      <label
        style={{
          display: "block",
          fontSize: 12,
          fontWeight: 500,
          color: "var(--text-secondary)",
          marginBottom: 6,
        }}
      >
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        style={{
          width: "100%",
          padding: "10px 12px",
          borderRadius: 7,
          border: "1px solid var(--border)",
          background: "var(--surface-2)",
          color: "var(--text-primary)",
          fontSize: 14,
          fontFamily: mono ? "ui-monospace, monospace" : "inherit",
          outline: "none",
          marginBottom: 16,
        }}
      />
    </>
  );
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const from = params.get("from") ?? "/";
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Already authenticated → leave immediately. In local mode auth/check is
  // always 200, so a local user who lands here via bookmark or stale redirect
  // can never get stuck on a login screen.
  useEffect(() => {
    fetch("/api/auth/check", { cache: "no-store" })
      .then((r) => {
        if (r.ok) {
          router.replace(from);
          return null;
        }
        return fetch("/api/auth/status", { cache: "no-store" }).then((s) => s.json());
      })
      .then((s) => {
        if (s) setStatus(s as AuthStatus);
      })
      .catch(() => setStatus({ mode: "prod", needsBootstrap: false }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const bootstrap = status?.needsBootstrap ?? false;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch(bootstrap ? "/api/auth/bootstrap" : "/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bootstrap ? { email, password, setupToken } : { email, password }),
      });
      const data = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        setError((data.error as string) ?? "Sign-in failed");
      } else {
        router.push(from);
      }
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  const ready = email && password && (!bootstrap || setupToken);

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--background)",
      }}
    >
      <div
        style={{
          width: 360,
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          padding: "36px 32px",
        }}
      >
        {/* Logo */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 28 }}>
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 8,
              background: "var(--accent)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 18,
              fontWeight: 700,
              color: "#fff",
            }}
          >
            F
          </div>
          <span style={{ fontWeight: 700, fontSize: 20, color: "var(--text-primary)" }}>Flow</span>
        </div>

        <h1
          style={{
            margin: "0 0 6px",
            fontSize: 18,
            fontWeight: 600,
            color: "var(--text-primary)",
          }}
        >
          {bootstrap ? "Set up Flow" : "Sign in"}
        </h1>
        <p style={{ margin: "0 0 24px", fontSize: 13, color: "var(--text-secondary)" }}>
          {bootstrap
            ? "Create the owner account for this deployment. The setup code was printed by `flow up` on the server."
            : "Sign in with your Flow account."}
        </p>

        <form onSubmit={handleSubmit}>
          <Field label="Email" type="email" value={email} onChange={setEmail} placeholder="you@company.com" autoFocus />
          <Field label="Password" type="password" value={password} onChange={setPassword} />
          {bootstrap && (
            <Field
              label="Setup code"
              type="password"
              value={setupToken}
              onChange={setSetupToken}
              placeholder="printed by flow up"
              mono
            />
          )}
          {error && (
            <div
              style={{
                fontSize: 12,
                color: "var(--error)",
                marginBottom: 12,
                padding: "8px 10px",
                background: "rgba(239,68,68,0.08)",
                borderRadius: 6,
                border: "1px solid rgba(239,68,68,0.2)",
              }}
            >
              {error}
            </div>
          )}
          <button
            type="submit"
            disabled={loading || !ready}
            style={{
              width: "100%",
              padding: "10px",
              borderRadius: 7,
              border: "none",
              background: loading || !ready ? "var(--surface-2)" : "var(--accent)",
              color: loading || !ready ? "var(--text-muted)" : "#fff",
              fontSize: 14,
              fontWeight: 600,
              cursor: loading || !ready ? "not-allowed" : "pointer",
              transition: "background 0.15s",
            }}
          >
            {loading ? (bootstrap ? "Creating…" : "Signing in…") : bootstrap ? "Create owner account" : "Sign in"}
          </button>
        </form>

        <p style={{ marginTop: 20, fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
          {bootstrap
            ? "Passwords are stored as scrypt hashes on the server. The setup code works exactly once."
            : "Your session is a signed httpOnly cookie. Project access follows your grants."}
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
