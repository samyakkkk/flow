"use client";
import { Shell } from "@/components/Shell";
import { BrainGraph } from "@/components/BrainGraph";
import { Kicker, Heading, Chip, StatusPill } from "@/components/ui";
import { MarkdownContent } from "@/components/Markdown";
import { useState, FormEvent, useRef, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useProject } from "@/lib/useProject";

type CitationKind = "node" | "file" | "slack" | "linear";

interface Citation {
  kind: CitationKind;
  ref: string;
}

interface AskResult {
  id?: string;
  status?: string;
  answer_md?: string;
  citations?: Citation[];
  confidence?: number;
  gaps?: string[];
  error?: string;
  message?: string;
}

interface GraphData {
  nodes: Array<{ id: string; data: { name: string; type: string; description?: string } }>;
  edges: Array<{ source: string; target: string; label: string }>;
  error?: string;
}

// ─── Confidence phrase ────────────────────────────────────────────────────────

function confidencePhrase(score: number): string {
  if (score >= 0.75) return "high confidence";
  if (score >= 0.5) return "moderate confidence";
  return "low confidence";
}

function ConfidenceBadge({ value }: { value: number }) {
  const phrase = confidencePhrase(value);
  const kind: "ok" | "warn" | "idle" =
    value >= 0.75 ? "ok" : value >= 0.5 ? "warn" : "idle";
  return <StatusPill kind={kind}>{phrase}</StatusPill>;
}

// ─── Citation chip ────────────────────────────────────────────────────────────

function CitationBadge({ c }: { c: Citation }) {
  const prefix: Record<CitationKind, string> = {
    node: "",
    file: "",
    slack: "#",
    linear: "",
  };
  return <Chip>{prefix[c.kind]}{c.ref}</Chip>;
}

// ─── Graph neighborhood panel ─────────────────────────────────────────────────

function AnswerGraph({ citations }: { citations: Citation[] }) {
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(false);
  const { prefix } = useProject();

  const nodeIds = citations.filter((c) => c.kind === "node").map((c) => c.ref);

  useEffect(() => {
    if (nodeIds.length === 0) return;
    setLoading(true);
    setGraphData(null);
    Promise.all(
      nodeIds.map((id) =>
        fetch(prefix(`/api/graph/neighborhood?nodeId=${encodeURIComponent(id)}`))
          .then((r) => r.json())
          .catch(() => ({ nodes: [], edges: [] }))
      )
    ).then((results) => {
      const all = results as GraphData[];
      const nodesMap = new Map<string, GraphData["nodes"][0]>();
      const edges: GraphData["edges"] = [];
      for (const g of all) {
        for (const n of g.nodes ?? []) nodesMap.set(n.id, n);
        for (const e of g.edges ?? []) edges.push(e);
      }
      setGraphData({ nodes: Array.from(nodesMap.values()), edges });
      setLoading(false);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeIds.join(",")]);

  if (nodeIds.length === 0) return null;

  return (
    <div className="mt-6">
      <Kicker>Knowledge graph</Kicker>
      <p className="text-text-muted text-[12px] mt-1 mb-3">
        The facts Flow used to answer — highlighted in the graph.
      </p>
      <BrainGraph
        mode="neighborhood"
        externalData={loading ? null : graphData}
        citedNodeIds={nodeIds}
        height={340}
      />
    </div>
  );
}

// ─── Inner page (accesses searchParams) ──────────────────────────────────────

function AskPageInner() {
  const { prefix } = useProject();
  const searchParams = useSearchParams();
  const initialQ = searchParams.get("q") ?? "";

  const [question, setQuestion] = useState(initialQ);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AskResult | null>(null);
  const [pollId, setPollId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-submit if query param provided
  useEffect(() => {
    if (initialQ && !result) {
      submitQuestion(initialQ);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Polling
  useEffect(() => {
    if (!pollId) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(prefix(`/api/jobs/${pollId}`));
        const data = await res.json() as AskResult & { result?: AskResult };
        if (data.status === "done" || data.status === "failed") {
          clearInterval(interval);
          setPollId(null);
          setLoading(false);
          const r = (data.result as AskResult) ?? data;
          setResult({ ...r, status: data.status });
        }
      } catch {/* ignore */}
    }, 800);
    return () => clearInterval(interval);
  }, [pollId]);

  async function submitQuestion(q: string) {
    if (!q.trim()) return;
    setLoading(true);
    setResult(null);
    setPollId(null);
    try {
      const res = await fetch(prefix("/api/ask"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
      });
      const data = await res.json() as AskResult;
      if (res.ok) {
        if (data.status === "running" && data.id) {
          setPollId(data.id);
        } else {
          setLoading(false);
          setResult(data);
        }
      } else {
        setLoading(false);
        setResult({ error: data.error ?? "Something went wrong." });
      }
    } catch {
      setLoading(false);
      setResult({ error: "Network error — is the orchestrator running?" });
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    submitQuestion(question);
  }

  return (
    <Shell>
      <div className="max-w-2xl">
        {/* Header */}
        <div className="mb-8">
          <Kicker>Ask Flow</Kicker>
          <Heading as="h1" className="text-[30px] mt-2">
            What do you want to know?
          </Heading>
        </div>

        {/* Input */}
        <form onSubmit={handleSubmit} className="mb-8">
          <div
            className="flex items-center gap-3 rounded-xl border border-line bg-paper px-4 py-3"
            style={{ boxShadow: "var(--shadow-sm)" }}
          >
            <input
              id="ask-input"
              ref={inputRef}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="What does the auth service do?"
              disabled={loading}
              autoFocus
              className="flex-1 bg-transparent text-[15px] text-text placeholder:text-text-muted/60 outline-none"
              style={{ fontFamily: "var(--font-sans)" }}
            />
            <button
              type="submit"
              disabled={loading || !question.trim()}
              className="flex-shrink-0 rounded-full px-4 py-2 text-[11px] uppercase tracking-wider transition-all hover:scale-[1.02] disabled:opacity-40 disabled:pointer-events-none"
              style={{
                fontFamily: "var(--font-mono)",
                background: "var(--accent)",
                color: "var(--ink)",
                border: "none",
                cursor: "pointer",
              }}
            >
              {loading ? "Thinking…" : "Ask ↗"}
            </button>
          </div>
        </form>

        {/* Loading state */}
        {loading && (
          <div
            className="rounded-xl border border-line bg-paper p-6 text-center rise-in"
          >
            <div className="flex items-center justify-center gap-2 mb-2">
              <div
                className="w-2 h-2 rounded-full bg-accent animate-pulse"
                style={{ animationDelay: "0ms" }}
              />
              <div
                className="w-2 h-2 rounded-full bg-accent animate-pulse"
                style={{ animationDelay: "150ms" }}
              />
              <div
                className="w-2 h-2 rounded-full bg-accent animate-pulse"
                style={{ animationDelay: "300ms" }}
              />
            </div>
            <p className="text-text-muted text-[13px]">
              {pollId ? "Waiting for answer…" : "Searching the knowledge graph…"}
            </p>
          </div>
        )}

        {/* Result */}
        {result && !loading && (
          <div className="rise-in">
            {result.error ? (
              <div
                className="rounded-xl border p-5"
                style={{
                  background: "rgba(168,80,70,0.06)",
                  borderColor: "rgba(168,80,70,0.2)",
                }}
              >
                <p className="text-[14px]" style={{ color: "var(--danger)" }}>
                  {result.error}
                </p>
                {result.message && (
                  <p className="text-text-muted text-[12px] mt-2">{result.message}</p>
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-6">
                {/* Answer header */}
                <div className="flex items-center gap-3 flex-wrap">
                  <span
                    style={{ fontFamily: "var(--font-mono)" }}
                    className="text-[11px] uppercase tracking-wider text-text-muted"
                  >
                    Answer
                  </span>
                  {typeof result.confidence === "number" && (
                    <ConfidenceBadge value={result.confidence} />
                  )}
                </div>

                {/* Answer body */}
                <div
                  className="rounded-xl border border-line bg-paper p-6"
                >
                  {result.answer_md ? (
                    <MarkdownContent md={result.answer_md} />
                  ) : (
                    <p className="text-text-muted text-[14px]">
                      {result.message ?? "No answer content yet."}
                    </p>
                  )}
                </div>

                {/* Citations */}
                {result.citations && result.citations.length > 0 && (
                  <div>
                    <Kicker>Sources used</Kicker>
                    <div className="flex flex-wrap gap-2 mt-2">
                      {result.citations.map((c, i) => (
                        <CitationBadge key={i} c={c} />
                      ))}
                    </div>
                  </div>
                )}

                {/* Gaps */}
                {result.gaps && result.gaps.length > 0 && (
                  <div
                    className="rounded-lg border p-4"
                    style={{
                      background: "rgba(184,134,60,0.06)",
                      borderColor: "rgba(184,134,60,0.2)",
                    }}
                  >
                    <p
                      style={{ fontFamily: "var(--font-mono)", color: "var(--warn)" }}
                      className="text-[10px] uppercase tracking-wider mb-2"
                    >
                      Knowledge gaps
                    </p>
                    <ul className="list-disc pl-4 space-y-1">
                      {result.gaps.map((g, i) => (
                        <li key={i} className="text-[13px] text-text-muted">{g}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Graph highlight */}
                {result.citations && result.citations.length > 0 && (
                  <AnswerGraph citations={result.citations} />
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </Shell>
  );
}

// Wrap with Suspense for useSearchParams
export default function AskPage() {
  return (
    <Suspense>
      <AskPageInner />
    </Suspense>
  );
}
