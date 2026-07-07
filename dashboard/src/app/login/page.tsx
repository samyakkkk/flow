"use client";
import { useState, useEffect, FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const from = params.get("from") ?? "/";
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Already authenticated → leave immediately. In local mode auth/check is
  // always 200 (env token is authoritative), so a local user who lands here
  // via bookmark or stale redirect can never get stuck on a login screen.
  useEffect(() => {
    fetch("/api/auth/check", { cache: "no-store" })
      .then((r) => {
        if (r.ok) router.replace(from);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await res.json() as Record<string, unknown>;
      if (!res.ok) {
        setError((data.error as string) ?? "Login failed");
      } else {
        router.push(from);
      }
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

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
          Sign in
        </h1>
        <p style={{ margin: "0 0 24px", fontSize: 13, color: "var(--text-secondary)" }}>
          Enter your admin token to continue.
        </p>

        <form onSubmit={handleSubmit}>
          <label
            style={{
              display: "block",
              fontSize: 12,
              fontWeight: 500,
              color: "var(--text-secondary)",
              marginBottom: 6,
            }}
          >
            Admin Token
          </label>
          <input
            id="token-input"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="flow_..."
            autoFocus
            style={{
              width: "100%",
              padding: "10px 12px",
              borderRadius: 7,
              border: `1px solid ${error ? "var(--error)" : "var(--border)"}`,
              background: "var(--surface-2)",
              color: "var(--text-primary)",
              fontSize: 14,
              fontFamily: "ui-monospace, monospace",
              outline: "none",
              marginBottom: 16,
            }}
          />
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
            disabled={loading || !token}
            style={{
              width: "100%",
              padding: "10px",
              borderRadius: 7,
              border: "none",
              background: loading || !token ? "var(--surface-2)" : "var(--accent)",
              color: loading || !token ? "var(--text-muted)" : "#fff",
              fontSize: 14,
              fontWeight: 600,
              cursor: loading || !token ? "not-allowed" : "pointer",
              transition: "background 0.15s",
            }}
          >
            {loading ? "Signing in..." : "Sign in"}
          </button>
        </form>

        <p style={{ marginTop: 20, fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
          Token is validated against the orchestrator and stored in an httpOnly session cookie. Never shared with the browser.
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
