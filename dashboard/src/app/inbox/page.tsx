"use client";
import { Shell } from "@/components/Shell";
import { timeAgo } from "@/lib/time";
import { useCallback, useEffect, useState } from "react";
import { useProject } from "@/lib/useProject";

// Review inbox — the human verification surface for the two agent proposal
// lanes: procedure proposals (bless exactly what you review; edits apply on
// approve) and correction flags (verified by the indexer against the repo's
// base branch; shown here so unclear/failed ones get human eyes).

interface ProcedureRow {
  id: string;
  name: string;
  description: string;
  trigger: string;
  steps: string;
  scope: string;
  mode: string;
  status: string;
  repo?: string | null;
  source_quote?: string | null;
  governs_pending?: string | null;
  created_by?: string | null;
  created_at?: string | null;
  blessed_by?: string | null;
  blessed_at?: string | null;
  retire_reason?: string | null;
  retire_quote?: string | null;
  retire_proposed_by?: string | null;
  retire_proposed_at?: string | null;
}

interface NoteRow {
  id: string;
  repo: string;
  branch: string;
  kind: string;
  text: string;
  actor?: string | null;
  updated_at: number;
}

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

interface ProcEdits {
  name: string;
  description: string;
  trigger: string;
  steps: string; // one step per line in the textarea
  scope: string;
  mode: string;
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

const fieldStyle: React.CSSProperties = {
  width: "100%",
  background: "var(--surface-2)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "7px 10px",
  fontSize: 13,
  color: "var(--text-primary)",
  fontFamily: "inherit",
};

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  color: "var(--text-muted)",
  marginBottom: 3,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};

function stepsToLines(steps: string): string {
  // Steps are stored as plain lines; strip any leading numbering defensively
  // (rows written before the format settled).
  return steps
    .split("\n")
    .map((s) => s.replace(/^\d+\.\s*/, ""))
    .join("\n");
}

function governsList(raw?: string | null): string {
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as string[];
    return Array.isArray(parsed) ? parsed.join(", ") : String(raw);
  } catch {
    return String(raw);
  }
}

function ProposalCard({
  proc,
  onDone,
}: {
  proc: ProcedureRow;
  onDone: () => void;
}) {
  const [edits, setEdits] = useState<ProcEdits>({
    name: proc.name,
    description: proc.description,
    trigger: proc.trigger,
    steps: stepsToLines(proc.steps ?? ""),
    scope: proc.scope,
    mode: proc.mode,
  });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const { prefix } = useProject();

  async function review(action: "approve" | "reject") {
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch(prefix("/api/procedures"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: proc.id,
          action,
          ...(action === "approve"
            ? {
                edits: {
                  name: edits.name,
                  description: edits.description,
                  trigger: edits.trigger,
                  steps: edits.steps.split("\n").map((s) => s.trim()).filter(Boolean),
                  scope: edits.scope,
                  mode: edits.mode,
                },
              }
            : {}),
        }),
      });
      const d = (await res.json()) as Record<string, unknown>;
      if (res.ok) onDone();
      else setMsg((d.error as string) ?? "Error");
    } catch {
      setMsg("Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        padding: "20px 24px",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
        <div style={{ fontFamily: "monospace", fontSize: 11, color: "var(--text-muted)" }}>
          {proc.id} · proposed by {proc.created_by ?? "unknown"} · {timeAgo(proc.created_at)}
        </div>
        <StatusChip status="proposed" />
      </div>

      {proc.source_quote && (
        <blockquote
          style={{
            margin: "0 0 14px",
            padding: "8px 12px",
            borderLeft: "3px solid var(--border)",
            fontSize: 12,
            fontStyle: "italic",
            color: "var(--text-secondary)",
          }}
        >
          “{proc.source_quote}”
        </blockquote>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <div style={labelStyle}>Name</div>
          <input style={fieldStyle} value={edits.name} onChange={(e) => setEdits({ ...edits, name: e.target.value })} />
        </div>
        <div>
          <div style={labelStyle}>Trigger (when does this apply?)</div>
          <input style={fieldStyle} value={edits.trigger} onChange={(e) => setEdits({ ...edits, trigger: e.target.value })} />
        </div>
        <div>
          <div style={labelStyle}>Why</div>
          <textarea
            style={{ ...fieldStyle, minHeight: 52, resize: "vertical" }}
            value={edits.description}
            onChange={(e) => setEdits({ ...edits, description: e.target.value })}
          />
        </div>
        <div>
          <div style={labelStyle}>Steps (one per line)</div>
          <textarea
            style={{ ...fieldStyle, minHeight: 80, resize: "vertical", fontFamily: "monospace", fontSize: 12 }}
            value={edits.steps}
            onChange={(e) => setEdits({ ...edits, steps: e.target.value })}
          />
        </div>
        <div style={{ display: "flex", gap: 16 }}>
          <div>
            <div style={labelStyle}>Scope</div>
            <select style={fieldStyle} value={edits.scope} onChange={(e) => setEdits({ ...edits, scope: e.target.value })}>
              <option value="repo">repo{proc.repo ? ` (${proc.repo})` : ""}</option>
              <option value="project">project</option>
            </select>
          </div>
          <div>
            <div style={labelStyle}>Delivery</div>
            <select style={fieldStyle} value={edits.mode} onChange={(e) => setEdits({ ...edits, mode: e.target.value })}>
              <option value="retrieve">retrieve — found on demand</option>
              <option value="insert">insert — pushed into matching sessions</option>
            </select>
          </div>
        </div>
        {governsList(proc.governs_pending) && (
          <div>
            <div style={labelStyle}>Will govern</div>
            <div style={{ fontFamily: "monospace", fontSize: 12, color: "var(--text-secondary)" }}>{governsList(proc.governs_pending)}</div>
          </div>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 16 }}>
        <button
          onClick={() => review("approve")}
          disabled={busy}
          style={{
            padding: "8px 18px",
            borderRadius: 6,
            border: "1px solid var(--border)",
            background: "var(--accent)",
            color: "var(--ink)",
            fontSize: 12,
            fontWeight: 600,
            cursor: busy ? "not-allowed" : "pointer",
          }}
        >
          {busy ? "Working…" : "Approve"}
        </button>
        <button
          onClick={() => review("reject")}
          disabled={busy}
          style={{
            padding: "8px 18px",
            borderRadius: 6,
            border: "1px solid var(--border)",
            background: "var(--surface-2)",
            color: "var(--text-secondary)",
            fontSize: 12,
            fontWeight: 600,
            cursor: busy ? "not-allowed" : "pointer",
          }}
        >
          Reject
        </button>
        {msg && <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{msg}</span>}
      </div>
    </div>
  );
}

export default function InboxPage() {
  const [proposed, setProposed] = useState<ProcedureRow[]>([]);
  const [blessed, setBlessed] = useState<ProcedureRow[]>([]);
  const [retireProposed, setRetireProposed] = useState<ProcedureRow[]>([]);
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [corrections, setCorrections] = useState<CorrectionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [retiring, setRetiring] = useState<Record<string, boolean>>({});
  const [retireMsgs, setRetireMsgs] = useState<Record<string, string>>({});
  const { prefix } = useProject();

  const load = useCallback(() => {
    Promise.all([
      fetch(prefix("/api/procedures")).then((r) => r.json()).catch(() => ({ proposed: [], blessed: [] })),
      fetch(prefix("/api/corrections")).then((r) => r.json()).catch(() => ({ rows: [] })),
      fetch(prefix("/api/notes?limit=30")).then((r) => r.json()).catch(() => ({ rows: [] })),
    ]).then(([p, c, n]) => {
      setNotes(((n as { rows?: NoteRow[] }).rows ?? []));
      const pd = p as { proposed?: ProcedureRow[]; blessed?: ProcedureRow[]; retireProposed?: ProcedureRow[] };
      setProposed(pd.proposed ?? []);
      setBlessed(pd.blessed ?? []);
      setRetireProposed(pd.retireProposed ?? []);
      setCorrections(((c as { rows?: CorrectionRow[] }).rows ?? []));
      setLoading(false);
    });
  }, [prefix]);

  useEffect(() => {
    load();
  }, [load]);

  async function review(id: string, action: "reject" | "confirm_retire" | "dismiss_retire") {
    setRetiring((r) => ({ ...r, [id]: true }));
    setRetireMsgs((m) => ({ ...m, [id]: "" }));
    try {
      const res = await fetch(prefix("/api/procedures"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      if (res.ok) {
        load();
      } else {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        setRetireMsgs((m) => ({ ...m, [id]: d.error ?? `Retire failed (${res.status})` }));
      }
    } catch {
      setRetireMsgs((m) => ({ ...m, [id]: "Network error" }));
    } finally {
      setRetiring((r) => ({ ...r, [id]: false }));
    }
  }

  return (
    <Shell>
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: "var(--text-primary)" }}>Inbox</h1>
        <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--text-secondary)" }}>
          Agent proposals awaiting your review. Approving a procedure blesses exactly the text you see;
          corrections are verified automatically against each repo&apos;s base branch.
        </p>
      </div>

      {loading ? (
        <div style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading…</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
          {/* Procedure proposals */}
          <section>
            <h2 style={{ margin: "0 0 12px", fontSize: 15, fontWeight: 700, color: "var(--text-primary)" }}>
              Procedure proposals {proposed.length > 0 && <span style={{ color: "var(--text-muted)" }}>({proposed.length})</span>}
            </h2>
            {proposed.length === 0 ? (
              <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Nothing waiting. Agents propose procedures when you state a durable rule mid-session.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {proposed.map((p) => (
                  <ProposalCard key={p.id} proc={p} onDone={load} />
                ))}
              </div>
            )}
          </section>

          {/* Retirement requests */}
          {retireProposed.length > 0 && (
            <section>
              <h2 style={{ margin: "0 0 12px", fontSize: 15, fontWeight: 700, color: "var(--text-primary)" }}>
                Retirement requests <span style={{ color: "var(--text-muted)" }}>({retireProposed.length})</span>
              </h2>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {retireProposed.map((p) => (
                  <div
                    key={p.id}
                    style={{
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      padding: "12px 16px",
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>{p.name}</div>
                    <div style={{ fontSize: 12, color: "var(--text-primary)", margin: "4px 0" }}>{p.retire_reason}</div>
                    {p.retire_quote && (
                      <blockquote style={{ margin: "0 0 6px", padding: "4px 10px", borderLeft: "3px solid var(--border)", fontSize: 11, fontStyle: "italic", color: "var(--text-secondary)" }}>
                        “{p.retire_quote}”
                      </blockquote>
                    )}
                    <div style={{ fontFamily: "monospace", fontSize: 10, color: "var(--text-muted)", marginBottom: 8 }}>
                      nominated by {p.retire_proposed_by ?? "unknown"} {timeAgo(p.retire_proposed_at)} · stays active until you decide
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        onClick={() => review(p.id, "confirm_retire")}
                        disabled={retiring[p.id]}
                        style={{ padding: "6px 14px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--accent)", color: "var(--ink)", fontSize: 12, fontWeight: 600, cursor: retiring[p.id] ? "not-allowed" : "pointer" }}
                      >
                        Retire it
                      </button>
                      <button
                        onClick={() => review(p.id, "dismiss_retire")}
                        disabled={retiring[p.id]}
                        style={{ padding: "6px 14px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--surface-2)", color: "var(--text-secondary)", fontSize: 12, fontWeight: 600, cursor: retiring[p.id] ? "not-allowed" : "pointer" }}
                      >
                        Keep it
                      </button>
                      {retireMsgs[p.id] && <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{retireMsgs[p.id]}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Blessed procedures */}
          <section>
            <h2 style={{ margin: "0 0 12px", fontSize: 15, fontWeight: 700, color: "var(--text-primary)" }}>
              Blessed procedures {blessed.length > 0 && <span style={{ color: "var(--text-muted)" }}>({blessed.length})</span>}
            </h2>
            {blessed.length === 0 ? (
              <div style={{ fontSize: 13, color: "var(--text-muted)" }}>None yet.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {blessed.map((p) => (
                  <div
                    key={p.id}
                    style={{
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      padding: "12px 16px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>{p.name}</div>
                      <div style={{ fontSize: 12, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {p.trigger}
                      </div>
                      <div style={{ fontFamily: "monospace", fontSize: 10, color: "var(--text-muted)", marginTop: 2 }}>
                        {p.mode} · {p.scope} · blessed by {p.blessed_by ?? "?"} {timeAgo(p.blessed_at)}
                      </div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                      <button
                        onClick={() => review(p.id, "reject")}
                        disabled={retiring[p.id]}
                        style={{
                          padding: "6px 12px",
                          borderRadius: 6,
                          border: "1px solid var(--border)",
                          background: "var(--surface-2)",
                          color: "var(--text-muted)",
                          fontSize: 11,
                          cursor: retiring[p.id] ? "not-allowed" : "pointer",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {retiring[p.id] ? "…" : "Retire"}
                      </button>
                      {retireMsgs[p.id] && (
                        <span style={{ fontSize: 11, color: "var(--text-secondary)", maxWidth: 200, textAlign: "right" }}>
                          {retireMsgs[p.id]}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Branch notes — working memory, ungated; shown for visibility, not approval */}
          {notes.length > 0 && (
            <section>
              <h2 style={{ margin: "0 0 12px", fontSize: 15, fontWeight: 700, color: "var(--text-primary)" }}>
                Branch notes <span style={{ color: "var(--text-muted)" }}>({notes.length})</span>
              </h2>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {notes.map((n) => (
                  <div
                    key={n.id}
                    style={{
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      padding: "10px 14px",
                      display: "flex",
                      alignItems: "flex-start",
                      justifyContent: "space-between",
                      gap: 10,
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontFamily: "monospace", fontSize: 10, color: "var(--text-muted)", marginBottom: 2 }}>
                        {n.kind} · {n.repo}:{n.branch} · {n.actor ?? "?"} · {timeAgo(n.updated_at)}
                      </div>
                      <div style={{ fontSize: 12.5, color: "var(--text-primary)", whiteSpace: "pre-wrap" }}>
                        {n.text.length > 400 ? n.text.slice(0, 400) + "…" : n.text}
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        fetch(prefix(`/api/notes?id=${encodeURIComponent(n.id)}`), { method: "DELETE" }).then(load);
                      }}
                      style={{ background: "transparent", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 13, lineHeight: 1 }}
                      aria-label="Delete note"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Corrections */}
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
        </div>
      )}
    </Shell>
  );
}
