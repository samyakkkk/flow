"use client";
import { Shell } from "@/components/Shell";
import { Kicker, Heading, Button, StatusPill, Card } from "@/components/ui";
import { useEffect, useState, useCallback } from "react";
import { useProject } from "@/lib/useProject";

interface AuditRow {
  id: number;
  event_id: string;
  classification: string;
  confidence?: number;
  action?: string;
  target?: string;
  status?: string;
  detail?: string;
  source?: string;
  ts?: number;
}

interface OutboxRow {
  id: number;
  event_id?: string;
  action?: string;
  target?: string;
  payload?: string;
  status: string;
  created_at?: string;
}

// ─── Humanizing layer ─────────────────────────────────────────────────────────

function isNoise(row: AuditRow): boolean {
  return (
    row.classification === "noise" ||
    row.action === "suppress" ||
    row.status === "suppressed" ||
    row.classification === "suppressed"
  );
}

function humanize(row: AuditRow): string | null {
  if (isNoise(row)) return null;

  const cls = row.classification ?? "";
  const action = row.action ?? "";
  const status = row.status ?? "";
  const target = row.target ?? row.source ?? "";

  if (cls === "knowledge_claim" && (action === "graph_write" || action === "graphwrite")) {
    return target ? `Learned a fact from ${target}` : "Learned a new fact";
  }
  if (cls === "knowledge_claim") {
    return target ? `Captured knowledge from ${target}` : "Captured new knowledge";
  }
  if ((cls === "index_job" || action === "index_repo") && status === "ok") {
    return target ? `Indexed ${target} — facts added` : "Indexing complete";
  }
  if (cls === "index_job" || action === "index_repo") {
    return target ? `Indexing ${target}` : "Indexing in progress";
  }
  if (cls === "task_discussion" && action === "propose") {
    return `Suggested a Linear ticket — review pending`;
  }
  if (cls === "repo_added" || action === "repo_added") {
    return target ? `Connected ${target} — indexing now` : "Connected a new repository";
  }
  if (cls === "decision" || action === "decision") {
    return target ? `Noted a decision from ${target}` : "Captured a decision";
  }
  if (cls === "correction") {
    return "Applied a correction to the knowledge base";
  }
  if (cls === "meeting_segment" && action === "decision") {
    return `Captured a meeting decision${target ? ` from ${target}` : ""}`;
  }
  if (action === "graph_write" || action === "graphwrite") {
    return target ? `Updated knowledge about ${target}` : "Updated the knowledge base";
  }
  if (status === "ok" && target) {
    return `Updated ${target}`;
  }

  return null;
}

function timeAgo(ts?: number): string {
  if (!ts) return "—";
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ─── Outbox proposal card ─────────────────────────────────────────────────────

function ProposalCard({
  row,
  onAct,
}: {
  row: OutboxRow;
  onAct: (id: number, action: "approve" | "dismiss") => Promise<void>;
}) {
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  async function act(action: "approve" | "dismiss") {
    setBusy(true);
    try {
      await onAct(row.id, action);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="rounded-xl border border-warn/30 bg-paper p-5"
      style={{ borderLeftWidth: 3, borderLeftColor: "var(--warn)" }}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1.5">
            <StatusPill kind="warn">Review</StatusPill>
          </div>
          <p className="text-[14px] text-ink mb-1">
            {row.action ?? "Proposed action"}
            {row.target ? ` — ${row.target}` : ""}
          </p>
          {row.event_id && (
            <p
              style={{ fontFamily: "var(--font-mono)" }}
              className="text-[10px] text-text-muted"
            >
              event: {row.event_id}
            </p>
          )}
          {msg && <p className="text-[11px] text-warn mt-2">{msg}</p>}
        </div>
        <div className="flex gap-2 flex-shrink-0">
          <button
            onClick={() => act("approve")}
            disabled={busy}
            className="px-4 py-2 rounded-full text-[11px] uppercase tracking-wider transition-all hover:scale-[1.02]"
            style={{
              fontFamily: "var(--font-mono)",
              background: "var(--ok)",
              color: "white",
              border: "none",
              cursor: busy ? "not-allowed" : "pointer",
              opacity: busy ? 0.5 : 1,
            }}
          >
            Approve
          </button>
          <button
            onClick={() => act("dismiss")}
            disabled={busy}
            className="px-4 py-2 rounded-full text-[11px] uppercase tracking-wider border border-line bg-paper text-text-muted hover:bg-sand transition-all"
            style={{
              fontFamily: "var(--font-mono)",
              cursor: busy ? "not-allowed" : "pointer",
              opacity: busy ? 0.5 : 1,
            }}
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Advanced raw table ───────────────────────────────────────────────────────

function RawTable({ rows }: { rows: AuditRow[] }) {
  return (
    <div
      className="rounded-lg border border-line overflow-hidden bg-paper"
      style={{ fontSize: 11 }}
    >
      {/* Header */}
      <div
        className="grid px-4 py-2.5 border-b border-line"
        style={{
          gridTemplateColumns: "48px 1fr 1fr 80px 1fr 2fr",
          fontFamily: "var(--font-mono)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "var(--text-muted)",
          fontSize: 10,
        }}
      >
        <div>ID</div>
        <div>Classification</div>
        <div>Action</div>
        <div>Status</div>
        <div>Target</div>
        <div>Detail</div>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-6 text-text-muted text-[12px]">No entries.</div>
      ) : (
        rows.map((row, i) => (
          <div
            key={row.id}
            className="grid px-4 py-2.5"
            style={{
              gridTemplateColumns: "48px 1fr 1fr 80px 1fr 2fr",
              borderBottom: i < rows.length - 1 ? "1px solid var(--line)" : "none",
              color: "var(--text-muted)",
            }}
          >
            <div style={{ fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>{row.id}</div>
            <div style={{ color: "var(--text)" }}>{row.classification ?? "—"}</div>
            <div>{row.action ?? "—"}</div>
            <div>
              <span
                className="px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider"
                style={{
                  fontFamily: "var(--font-mono)",
                  background:
                    row.status === "ok" || row.status === "done" || row.status === "approved"
                      ? "rgba(90,140,90,0.12)"
                      : row.status === "pending"
                      ? "rgba(255,247,129,0.35)"
                      : row.status === "failed" || row.status === "error"
                      ? "rgba(168,80,70,0.12)"
                      : "var(--sand)",
                  color:
                    row.status === "ok" || row.status === "done" || row.status === "approved"
                      ? "var(--ok)"
                      : row.status === "pending"
                      ? "var(--ink)"
                      : row.status === "failed" || row.status === "error"
                      ? "var(--danger)"
                      : "var(--text-muted)",
                }}
              >
                {row.status ?? "—"}
              </span>
            </div>
            <div
              className="overflow-hidden text-ellipsis whitespace-nowrap"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              {row.target ?? "—"}
            </div>
            <div className="overflow-hidden text-ellipsis whitespace-nowrap" title={row.detail ?? ""}>
              {row.detail ?? "—"}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ActivityPage() {
  const [auditRows, setAuditRows] = useState<AuditRow[]>([]);
  const [outboxRows, setOutboxRows] = useState<OutboxRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [approveMessages, setApproveMessages] = useState<Record<number, string>>({});
  const [showAdvanced, setShowAdvanced] = useState(false);
  const { prefix } = useProject();

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      fetch(prefix("/api/audit?limit=200")).then((r) => r.json()),
      fetch(prefix("/api/outbox?status=pending")).then((r) => r.json()),
    ]).then(([a, o]) => {
      const auditData = a as { rows?: AuditRow[] };
      const outboxData = o as { rows?: OutboxRow[] };
      setAuditRows(auditData.rows ?? []);
      setOutboxRows(outboxData.rows ?? []);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [prefix]);

  useEffect(() => {
    load();
    const iv = setInterval(load, 10_000);
    return () => clearInterval(iv);
  }, [load]);

  async function handleApprove(id: number, action: "approve" | "dismiss") {
    const res = await fetch(prefix("/api/outbox/approve"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action }),
    });
    const d = await res.json() as Record<string, unknown>;
    if (res.status === 501) {
      setApproveMessages((m) => ({
        ...m,
        [id]: "Not yet implemented — orchestrator needs PATCH /v1/outbox/:id.",
      }));
    } else if (res.ok) {
      load();
    } else {
      setApproveMessages((m) => ({ ...m, [id]: (d.error as string) ?? "Error" }));
    }
  }

  // Humanized timeline — filter noise
  const timeline = auditRows
    .map((r) => ({ row: r, human: humanize(r) }))
    .filter((e): e is { row: AuditRow; human: string } => e.human !== null);

  return (
    <Shell>
      <div className="max-w-2xl">
        {/* Header */}
        <div className="mb-8">
          <Kicker>Activity</Kicker>
          <Heading as="h1" className="text-[30px] mt-2">
            What Flow has done.
          </Heading>
          <p className="text-text-muted text-[15px] mt-1.5">
            A timeline of things Flow learned and actions it took for you.
          </p>
        </div>

        {/* Pending proposals */}
        {outboxRows.length > 0 && (
          <section className="mb-8">
            <Kicker>Needs your review</Kicker>
            <div className="mt-3 flex flex-col gap-3">
              {outboxRows.map((row) => (
                <ProposalCard
                  key={row.id}
                  row={{
                    ...row,
                    id: row.id,
                    // merge approve message into display
                    action: approveMessages[row.id]
                      ? `${row.action ?? "action"} — ${approveMessages[row.id]}`
                      : row.action,
                  }}
                  onAct={handleApprove}
                />
              ))}
            </div>
          </section>
        )}

        {/* Timeline */}
        <section className="mb-8">
          {loading ? (
            <div className="text-text-muted text-[14px]">Loading…</div>
          ) : timeline.length === 0 ? (
            <Card>
              <div className="text-center py-6">
                <p
                  style={{ fontFamily: "var(--font-display)" }}
                  className="text-ink text-[17px] font-medium mb-1"
                >
                  Nothing yet.
                </p>
                <p className="text-text-muted text-[13px]">
                  Flow will show you what it learns and does here.
                </p>
              </div>
            </Card>
          ) : (
            <div className="relative">
              {/* Timeline line */}
              <div
                className="absolute left-[7px] top-2 bottom-2 w-px"
                style={{ background: "var(--line)" }}
              />
              <div className="flex flex-col gap-4">
                {timeline.map(({ row, human }) => (
                  <div key={row.id} className="flex gap-4 items-baseline">
                    {/* Dot */}
                    <div
                      className="w-3.5 h-3.5 rounded-full flex-shrink-0 mt-0.5"
                      style={{
                        background:
                          row.status === "ok" || row.status === "done"
                            ? "var(--ok)"
                            : row.status === "pending"
                            ? "var(--accent)"
                            : "var(--line)",
                        border: "2px solid var(--cream)",
                        zIndex: 1,
                        position: "relative",
                      }}
                    />
                    <div className="flex-1 min-w-0">
                      <span className="text-[14px] text-text">{human}</span>
                      {row.ts && (
                        <span
                          style={{ fontFamily: "var(--font-mono)" }}
                          className="ml-3 text-[10px] text-text-muted"
                        >
                          {timeAgo(row.ts)}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* Advanced toggle */}
        <div className="flex items-center gap-4 mb-4">
          <Button
            variant="secondary"
            onClick={() => setShowAdvanced((v) => !v)}
          >
            {showAdvanced ? "Hide advanced" : "Advanced — raw log"}
          </Button>
          {showAdvanced && (
            <span className="text-text-muted text-[12px]">
              {auditRows.length} entries total (including suppressed)
            </span>
          )}
        </div>

        {showAdvanced && <RawTable rows={auditRows} />}
      </div>
    </Shell>
  );
}
