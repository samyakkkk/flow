"use client";
// The prod dashboard's window onto THIS machine's local Flow — the first
// consumer of the dual-origin execution client. Rendered only on prod
// deployments: probes localhost:7600 through the execution door and shows
// either the machine's local projects (linking into the native local agents
// experience — same ACP loop, zero added latency) or how to get connected.
// Renders nothing in local mode: the page already IS the local dashboard.
import { useState, useEffect, useCallback } from "react";
import { discoverLocal, localFetch, LOCAL_DASHBOARD, type LocalLink } from "@/lib/executionClient";

interface LocalProject {
  name: string;
  mode: string;
}

const wrap: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 10,
  background: "var(--surface-1)",
  padding: "14px 18px",
  marginBottom: 18,
  fontSize: 13,
};

export function LocalExecutionCard() {
  const [mode, setMode] = useState<"local" | "prod" | null>(null);
  const [link, setLink] = useState<LocalLink | null>(null);
  const [projects, setProjects] = useState<LocalProject[] | null>(null);
  const [probing, setProbing] = useState(true);

  const probe = useCallback(() => {
    setProbing(true);
    discoverLocal()
      .then((l) => {
        setLink(l);
        if (l && l.base) {
          return localFetch(l, "/api/projects")
            .then((r) => (r.ok ? r.json() : { projects: [] }))
            .then((d) => setProjects(d.projects ?? []));
        }
      })
      .finally(() => setProbing(false));
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

  if (probing) {
    return <div style={wrap}>Checking for a local Flow on this machine…</div>;
  }

  if (link && link.base) {
    return (
      <div style={wrap}>
        <span style={{ color: "var(--success, #34c759)", marginRight: 8 }}>●</span>
        <strong>This machine&apos;s Flow is connected.</strong>{" "}
        <span style={{ color: "var(--text-secondary)" }}>
          Sessions run natively on your machine
          {projects && projects.length > 0 ? (
            <>
              {" — open a local project: "}
              {projects.map((p, i) => (
                <span key={p.name}>
                  {i > 0 && ", "}
                  <a href={`${LOCAL_DASHBOARD}/${p.name}/agents`} target="_blank" rel="noreferrer">
                    {p.name}
                  </a>
                </span>
              ))}
              .
            </>
          ) : (
            "."
          )}
        </span>
      </div>
    );
  }

  return (
    <div style={wrap}>
      <span style={{ color: "var(--text-secondary)", marginRight: 8 }}>○</span>
      <strong>Run agents on this machine</strong>{" "}
      <span style={{ color: "var(--text-secondary)" }}>
        — start Flow locally (<code>flow up</code>), and connect it to this deployment once with{" "}
        <code>flow connect {typeof window !== "undefined" ? window.location.origin : ""}</code>.
      </span>{" "}
      <button
        onClick={probe}
        style={{
          background: "none",
          border: "1px solid var(--border)",
          borderRadius: 6,
          padding: "2px 10px",
          color: "var(--text-secondary)",
          fontSize: 12,
          cursor: "pointer",
          marginLeft: 6,
        }}
      >
        Retry
      </button>
    </div>
  );
}
