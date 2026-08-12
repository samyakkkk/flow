"use client";
import { Shell } from "@/components/Shell";
import { timeAgo } from "@/lib/time";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useProject } from "@/lib/useProject";

// Knowledge Base — everything Flow has learned, in one place: distilled
// memories (from agent sessions and explicit "remember" calls) plus the raw
// corpus knowledge mirrored from Slack, Linear and meetings. Each item shows
// where it came from and who contributed it, and can be deleted — the one
// human curation act. Correction flags (formerly the Inbox) live at the
// bottom of this page.

interface EvidenceRow {
  id: string;
  source: string;
  claim: string;
  source_url: string | null;
  source_weight: string;
  created_at: number;
  by: string | null;
}

interface MemoryItem {
  id: string;
  claim: string;
  kind: string;
  repo: string | null;
  strength: number;
  tier: string;
  evidence_count: number;
  people_count: number;
  contradiction_count: number;
  max_source_weight: string;
  created_at: number;
  updated_at: number;
  contributors: string[];
  sources: Record<string, number>;
  evidence: EvidenceRow[];
}

interface CorpusItem {
  id: string;
  source: string;
  claim: string;
  source_url: string | null;
  repo: string | null;
  created_at: number;
  by: string | null;
}

interface KnowledgeResponse {
  stats?: { memories: number; observations: number; bySource: Record<string, number> };
  memories?: MemoryItem[];
  corpus?: { rows: CorpusItem[]; total: number; limit: number; offset: number };
}

interface CorrectionRow {
  id: string;
  target_ids: string;
  reason: string;
  evidence?: string | null;
  repo?: string | null;
  status: string;
  resolution?: string | null;
  created_at: number;
}

const SOURCE_FILTERS = [
  { key: "", label: "All" },
  { key: "session", label: "Sessions" },
  { key: "slack", label: "Slack" },
  { key: "linear", label: "Linear" },
  { key: "meeting", label: "Meetings" },
];

const TIER_COLORS: Record<string, string> = {
  strong: "var(--ok)",
  medium: "var(--accent-hover, #b45309)",
  weak: "var(--text-muted)",
};

const CORRECTION_COLORS: Record<string, string> = {
  pending: "var(--text-muted)",
  verifying: "var(--accent-hover)",
  applied: "var(--ok)",
  rejected: "var(--text-secondary)",
  unclear: "var(--warn, #b45309)",
  failed: "var(--danger, #b91c1c)",
};

function Chip({ children, color }: { children: React.ReactNode; color?: string }) {
  return (
    <span
      style={{
        fontFamily: "monospace",
        fontSize: 10,
        textTransform: "uppercase",
        letterSpacing: "0.08em",
        color: color ?? "var(--text-muted)",
        border: "1px solid var(--border)",
        borderRadius: 999,
        padding: "2px 8px",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

function DeleteButton({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        background: "transparent",
        border: "1px solid var(--border)",
        borderRadius: 6,
        color: "var(--text-muted)",
        cursor: "pointer",
        padding: "3px 8px",
        fontSize: 11,
        lineHeight: 1,
        flexShrink: 0,
      }}
    >
      Delete
    </button>
  );
}

function sourcesLine(sources: Record<string, number>): string {
  return Object.entries(sources)
    .map(([s, n]) => (n > 1 ? `${s} ×${n}` : s))
    .join(" · ");
}

export default function KnowledgePage() {
  const [data, setData] = useState<KnowledgeResponse>({});
  const [corpusRows, setCorpusRows] = useState<CorpusItem[]>([]);
  const [corpusTotal, setCorpusTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [source, setSource] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [corrections, setCorrections] = useState<CorrectionRow[]>([]);
  const [showCorrections, setShowCorrections] = useState(false);
  const { prefix } = useProject();

  const load = useCallback(
    (opts: { q: string; source: string; offset: number; append: boolean }) => {
      const params = new URLSearchParams();
      if (opts.q.trim()) params.set("q", opts.q.trim());
      if (opts.source) params.set("source", opts.source);
      params.set("limit", "50");
      params.set("offset", String(opts.offset));
      fetch(prefix(`/api/memory/list?${params}`))
        .then((r) => r.json())
        .catch(() => ({}))
        .then((d: KnowledgeResponse) => {
          setData((prev) => (opts.append ? prev : d));
          setCorpusRows((prev) => (opts.append ? [...prev, ...(d.corpus?.rows ?? [])] : (d.corpus?.rows ?? [])));
          setCorpusTotal(d.corpus?.total ?? 0);
          setLoading(false);
        });
    },
    [prefix],
  );

  // Search + source filter drive a debounced server refetch (the corpus is
  // paged server-side; memories re-arrive too, cheap either way).
  useEffect(() => {
    const t = setTimeout(() => load({ q, source, offset: 0, append: false }), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [q, source, load]);

  useEffect(() => {
    fetch(prefix("/api/corrections"))
      .then((r) => r.json())
      .catch(() => ({ rows: [] }))
      .then((c) => setCorrections((c as { rows?: CorrectionRow[] }).rows ?? []));
  }, [prefix]);

  const memories = useMemo(() => {
    let rows = data.memories ?? [];
    if (source) rows = rows.filter((m) => (m.sources[source] ?? 0) > 0);
    const needle = q.trim().toLowerCase();
    if (needle) {
      rows = rows.filter(
        (m) =>
          m.claim.toLowerCase().includes(needle) ||
          (m.repo ?? "").toLowerCase().includes(needle) ||
          m.contributors.some((c) => c.toLowerCase().includes(needle)),
      );
    }
    return rows;
  }, [data.memories, q, source]);

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function deleteItem(id: string, type: "memory" | "observation") {
    const what = type === "memory" ? "this memory and all its evidence" : "this item";
    if (!window.confirm(`Delete ${what}? Agents will no longer recall it. This cannot be undone.`)) return;
    const res = await fetch(prefix(`/api/memory?id=${encodeURIComponent(id)}&type=${type}`), { method: "DELETE" });
    if (!res.ok) return;
    if (type === "memory") {
      setData((d) => ({ ...d, memories: (d.memories ?? []).filter((m) => m.id !== id) }));
    } else {
      setCorpusRows((rows) => rows.filter((r) => r.id !== id));
      setCorpusTotal((n) => Math.max(0, n - 1));
    }
  }

  const stats = data.stats;

  return (
    <Shell>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: "var(--text-primary)" }}>Knowledge Base</h1>
        <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--text-secondary)" }}>
          Everything Flow has learned — distilled memories with who contributed them, plus raw knowledge from Slack,
          Linear and meetings. Delete anything that&apos;s wrong; agents stop recalling it immediately.
        </p>
        {stats && (
          <div style={{ marginTop: 10, fontFamily: "monospace", fontSize: 11, color: "var(--text-muted)" }}>
            {stats.memories} memories · {stats.observations} observations
            {Object.entries(stats.bySource).map(([s, n]) => (
              <span key={s}> · {s} {n}</span>
            ))}
          </div>
        )}
      </div>

      {/* Search + source filters */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search knowledge…"
          style={{
            flex: "1 1 240px",
            maxWidth: 360,
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: "8px 12px",
            fontSize: 13,
            color: "var(--text-primary)",
            outline: "none",
          }}
        />
        <div style={{ display: "flex", gap: 6 }}>
          {SOURCE_FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setSource(f.key)}
              style={{
                fontFamily: "monospace",
                fontSize: 10,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                color: source === f.key ? "var(--text-primary)" : "var(--text-muted)",
                background: source === f.key ? "var(--surface)" : "transparent",
                border: "1px solid var(--border)",
                borderRadius: 999,
                padding: "4px 10px",
                cursor: "pointer",
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading…</div>
      ) : (
        <>
          {/* Distilled memories */}
          <section style={{ marginBottom: 32 }}>
            <h2 style={{ margin: "0 0 12px", fontSize: 15, fontWeight: 700, color: "var(--text-primary)" }}>
              Memories {memories.length > 0 && <span style={{ color: "var(--text-muted)" }}>({memories.length})</span>}
            </h2>
            {memories.length === 0 ? (
              <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
                {q || source ? "Nothing matches this filter." : "No memories yet. They distill automatically from agent sessions, Slack and Linear."}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {memories.map((m) => {
                  const open = expanded.has(m.id);
                  return (
                    <div
                      key={m.id}
                      style={{
                        background: "var(--surface)",
                        border: "1px solid var(--border)",
                        borderRadius: 8,
                        padding: "12px 16px",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
                        <Chip>{m.kind}</Chip>
                        <Chip color={TIER_COLORS[m.tier]}>{m.tier}</Chip>
                        {m.repo && <Chip>{m.repo}</Chip>}
                        <span style={{ flex: 1 }} />
                        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{timeAgo(m.updated_at * 1000)}</span>
                        <DeleteButton onClick={() => deleteItem(m.id, "memory")} title="Delete this memory and its evidence" />
                      </div>
                      <div style={{ fontSize: 13, color: "var(--text-primary)", lineHeight: 1.5 }}>{m.claim}</div>
                      <div
                        style={{
                          marginTop: 8,
                          display: "flex",
                          alignItems: "center",
                          gap: 12,
                          flexWrap: "wrap",
                          fontSize: 11,
                          color: "var(--text-muted)",
                        }}
                      >
                        {m.contributors.length > 0 && (
                          <span style={{ color: "var(--text-secondary)" }}>{m.contributors.join(" · ")}</span>
                        )}
                        <span>{sourcesLine(m.sources) || "no attached evidence"}</span>
                        <button
                          onClick={() => toggleExpand(m.id)}
                          style={{
                            background: "transparent",
                            border: "none",
                            color: "var(--text-muted)",
                            cursor: "pointer",
                            fontSize: 11,
                            padding: 0,
                            textDecoration: "underline",
                          }}
                        >
                          {open ? "hide evidence" : `evidence (${m.evidence_count})`}
                        </button>
                      </div>
                      {open && (
                        <div style={{ marginTop: 8, borderTop: "1px solid var(--border)", paddingTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
                          {m.evidence.map((e) => (
                            <div key={e.id} style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                              <span style={{ fontFamily: "monospace", fontSize: 10, color: "var(--text-muted)" }}>
                                [{e.source}]{e.by ? ` ${e.by}` : ""} · {timeAgo(e.created_at * 1000)}
                                {e.source_weight === "user_stated" && " · stated by a person"}
                                {e.source_weight === "error_proven" && " · proven by an error"}
                              </span>{" "}
                              {e.claim}
                              {e.source_url && (
                                <>
                                  {" "}
                                  <a href={e.source_url} target="_blank" rel="noreferrer" style={{ color: "var(--text-muted)" }}>
                                    source ↗
                                  </a>
                                </>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Raw corpus knowledge — slack / linear / meetings */}
          <section style={{ marginBottom: 32 }}>
            <h2 style={{ margin: "0 0 4px", fontSize: 15, fontWeight: 700, color: "var(--text-primary)" }}>
              From Slack, Linear &amp; meetings{" "}
              {corpusTotal > 0 && <span style={{ color: "var(--text-muted)" }}>({corpusTotal})</span>}
            </h2>
            <p style={{ margin: "0 0 12px", fontSize: 12, color: "var(--text-secondary)" }}>
              Mirrored knowledge agents can search — not yet consolidated into memories.
            </p>
            {corpusRows.length === 0 ? (
              <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
                {q || source ? "Nothing matches this filter." : "Nothing captured yet. Connect Slack or Linear and this fills up on its own."}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {corpusRows.map((r) => (
                  <div
                    key={r.id}
                    style={{
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      padding: "10px 16px",
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 10,
                    }}
                  >
                    <Chip>{r.source}</Chip>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, color: "var(--text-primary)", lineHeight: 1.5 }}>{r.claim}</div>
                      <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-muted)" }}>
                        {r.by && <span style={{ color: "var(--text-secondary)" }}>{r.by} · </span>}
                        {timeAgo(r.created_at * 1000)}
                        {r.source_url && (
                          <>
                            {" · "}
                            <a href={r.source_url} target="_blank" rel="noreferrer" style={{ color: "var(--text-muted)" }}>
                              source ↗
                            </a>
                          </>
                        )}
                      </div>
                    </div>
                    <DeleteButton onClick={() => deleteItem(r.id, "observation")} title="Delete this item" />
                  </div>
                ))}
                {corpusRows.length < corpusTotal && (
                  <button
                    onClick={() => load({ q, source, offset: corpusRows.length, append: true })}
                    style={{
                      alignSelf: "flex-start",
                      background: "transparent",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      color: "var(--text-secondary)",
                      cursor: "pointer",
                      padding: "6px 14px",
                      fontSize: 12,
                    }}
                  >
                    Load more ({corpusTotal - corpusRows.length} left)
                  </button>
                )}
              </div>
            )}
          </section>

          {/* Corrections — the old Inbox, folded in */}
          <section>
            <button
              onClick={() => setShowCorrections((v) => !v)}
              style={{
                background: "transparent",
                border: "none",
                padding: 0,
                cursor: "pointer",
                fontSize: 15,
                fontWeight: 700,
                color: "var(--text-primary)",
                marginBottom: 12,
              }}
            >
              Corrections{" "}
              {corrections.length > 0 && <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>({corrections.length})</span>}{" "}
              <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>{showCorrections ? "▾" : "▸"}</span>
            </button>
            {showCorrections &&
              (corrections.length === 0 ? (
                <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
                  No correction flags yet. Agents file these when graph content contradicts the code.
                </div>
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
                        style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "12px 16px" }}
                      >
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 6 }}>
                          <div style={{ fontFamily: "monospace", fontSize: 11, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {targets.join(", ")}
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{timeAgo(c.created_at)}</span>
                            <Chip color={CORRECTION_COLORS[c.status]}>{c.status}</Chip>
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
              ))}
          </section>
        </>
      )}
    </Shell>
  );
}
