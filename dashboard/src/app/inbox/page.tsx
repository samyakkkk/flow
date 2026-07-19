"use client";
import { Shell } from "@/components/Shell";
import { timeAgo } from "@/lib/time";
import { useCallback, useEffect, useState } from "react";
import { useProject } from "@/lib/useProject";

// Review inbox — correction flags filed by agents when graph content
// contradicts the code. Verified by the indexer against the repo's base
// branch; shown here so unclear/failed ones get human eyes. (Durable rules no
// longer pass through here: they flow through the distiller into memory and
// earn their way into the orient docs — nothing to approve.)

interface CorrectionRow {
  id: string;
  target_ids: string;
  reason: string;
  evidence?: string | null;
  repo?: string | null;
  actor?: string | null;
  status: string;
  resolution?: string | null;
  created_at: number;
}

const CORRECTION_COLORS: Record<string, string> = {
  pending: "var(--text-muted)",
  verifying: "var(--accent-hover)",
  applied: "var(--ok)",
  rejected: "var(--text-secondary)",
  unclear: "var(--warn, #b45309)",
  failed: "var(--danger, #b91c1c)",
};

function StatusChip({ status }: { status: string }) {
  return (
    <span
      style={{
        fontFamily: "monospace",
        fontSize: 10,
        textTransform: "uppercase",
        letterSpacing: "0.08em",
        color: CORRECTION_COLORS[status] ?? "var(--text-muted)",
        border: "1px solid var(--border)",
        borderRadius: 999,
        padding: "2px 8px",
        whiteSpace: "nowrap",
      }}
    >
      {status}
    </span>
  );
}

export default function InboxPage() {
  const [corrections, setCorrections] = useState<CorrectionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const { prefix } = useProject();

  const load = useCallback(() => {
    fetch(prefix("/api/corrections"))
      .then((r) => r.json())
      .catch(() => ({ rows: [] }))
      .then((c) => {
        setCorrections(((c as { rows?: CorrectionRow[] }).rows ?? []));
        setLoading(false);
      });
  }, [prefix]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <Shell>
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: "var(--text-primary)" }}>Inbox</h1>
        <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--text-secondary)" }}>
          Correction flags from agent sessions, verified automatically against each repo&apos;s base branch.
        </p>
      </div>

      {loading ? (
        <div style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading…</div>
      ) : (
        <section>
          <h2 style={{ margin: "0 0 12px", fontSize: 15, fontWeight: 700, color: "var(--text-primary)" }}>
            Corrections {corrections.length > 0 && <span style={{ color: "var(--text-muted)" }}>({corrections.length})</span>}
          </h2>
          {corrections.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--text-muted)" }}>No correction flags yet. Agents file these when graph content contradicts the code.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {corrections.map((c) => {
                let targets: string[] = [];
                try {
                  targets = JSON.parse(c.target_ids) as string[];
                } catch {
                  /* leave empty */
                }
                return (
                  <div
                    key={c.id}
                    style={{
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      padding: "12px 16px",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 6 }}>
                      <div style={{ fontFamily: "monospace", fontSize: 11, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {targets.join(", ")}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{timeAgo(c.created_at)}</span>
                        <StatusChip status={c.status} />
                      </div>
                    </div>
                    <div style={{ fontSize: 13, color: "var(--text-primary)" }}>{c.reason}</div>
                    {c.evidence && (
                      <div style={{ fontFamily: "monospace", fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>{c.evidence}</div>
                    )}
                    {c.resolution && (
                      <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 6, borderTop: "1px solid var(--border)", paddingTop: 6 }}>
                        {c.resolution}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}
    </Shell>
  );
}
