"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { timeAgo } from "@/lib/time";

// Floating review dialog, mounted in the Shell so it appears on every page:
// whenever an agent files a procedure proposal or nominates one for
// retirement, this surfaces it with one-click accept/reject. The Inbox page
// stays the full editing surface — this is the quick path.
//
// Poll-based (20s) as the baseline, plus an instant path: the agent session
// view dispatches "flow:proposals-changed" the moment a proposal verb fires,
// so the dialog appears immediately while the user is right there on the
// session page. Dismissing (×) hides an item for this browser session only
// (sessionStorage, survives navigation) — it remains in the Inbox.

interface PendingItem {
  id: string;
  name: string;
  trigger: string;
  steps: string;
  status: "proposed" | "retire_proposed";
  source_quote?: string | null;
  retire_reason?: string | null;
  retire_quote?: string | null;
  created_by?: string | null;
  created_at?: string | null;
  retire_proposed_by?: string | null;
  retire_proposed_at?: string | null;
}

const POLL_MS = 20_000;
const DISMISS_KEY = "flow-proposal-dismissed";

function readDismissed(): Set<string> {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(DISMISS_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

export function ProposalDialog() {
  const [items, setItems] = useState<PendingItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const dismissed = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/procedures");
      if (!res.ok) return;
      const d = (await res.json()) as { proposed?: PendingItem[]; retireProposed?: PendingItem[] };
      setItems(
        [...(d.proposed ?? []), ...(d.retireProposed ?? [])].filter(
          (p) => !dismissed.current.has(`${p.id}:${p.status}`)
        )
      );
    } catch {
      /* dialog is best-effort; the Inbox is the durable surface */
    }
  }, []);

  useEffect(() => {
    dismissed.current = readDismissed();
    load();
    const t = setInterval(load, POLL_MS);
    // Instant path: the session view pokes this when a proposal verb fires.
    window.addEventListener("flow:proposals-changed", load);
    return () => {
      clearInterval(t);
      window.removeEventListener("flow:proposals-changed", load);
    };
  }, [load]);

  const item = items[0];
  if (!item) return null;
  const isRetire = item.status === "retire_proposed";

  async function act(action: "approve" | "reject" | "confirm_retire" | "dismiss_retire") {
    if (!item) return;
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch("/api/procedures", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, action }),
      });
      if (res.ok) {
        setItems((list) => list.slice(1));
      } else {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        setMsg(d.error ?? `Failed (${res.status})`);
      }
    } catch {
      setMsg("Network error");
    } finally {
      setBusy(false);
    }
  }

  function dismiss() {
    if (!item) return;
    dismissed.current.add(`${item.id}:${item.status}`);
    try {
      sessionStorage.setItem(DISMISS_KEY, JSON.stringify([...dismissed.current]));
    } catch {
      /* private mode etc. — dismissal just won't survive navigation */
    }
    setItems((list) => list.slice(1));
  }

  const btn = (primary: boolean): React.CSSProperties => ({
    padding: "7px 14px",
    borderRadius: 6,
    border: "1px solid var(--border)",
    background: primary ? "var(--accent)" : "var(--surface-2)",
    color: primary ? "var(--ink)" : "var(--text-secondary)",
    fontSize: 12,
    fontWeight: 600,
    cursor: busy ? "not-allowed" : "pointer",
  });

  return (
    <div
      style={{
        position: "fixed",
        bottom: 20,
        right: 20,
        width: 420,
        maxWidth: "calc(100vw - 260px)",
        zIndex: 60,
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
        padding: "16px 18px",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
        <div style={{ fontFamily: "monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-muted)" }}>
          {isRetire ? "Retirement requested" : "Procedure proposed"}
          {items.length > 1 && <span> · {items.length} pending</span>}
        </div>
        <button
          onClick={dismiss}
          aria-label="Dismiss"
          style={{ background: "transparent", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 14, lineHeight: 1 }}
        >
          ×
        </button>
      </div>

      <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)", margin: "8px 0 2px" }}>{item.name}</div>
      <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 8 }}>{item.trigger}</div>

      {isRetire ? (
        <>
          <div style={{ fontSize: 12, color: "var(--text-primary)", marginBottom: 6 }}>{item.retire_reason}</div>
          {item.retire_quote && (
            <blockquote style={{ margin: "0 0 8px", padding: "6px 10px", borderLeft: "3px solid var(--border)", fontSize: 11, fontStyle: "italic", color: "var(--text-secondary)" }}>
              “{item.retire_quote}”
            </blockquote>
          )}
          <div style={{ fontFamily: "monospace", fontSize: 10, color: "var(--text-muted)", marginBottom: 12 }}>
            by {item.retire_proposed_by ?? "unknown"} · {timeAgo(item.retire_proposed_at)} · stays active until you decide
          </div>
        </>
      ) : (
        <>
          <div style={{ fontFamily: "monospace", fontSize: 11, color: "var(--text-secondary)", whiteSpace: "pre-wrap", marginBottom: 8, maxHeight: 96, overflowY: "auto" }}>
            {item.steps}
          </div>
          {item.source_quote && (
            <blockquote style={{ margin: "0 0 8px", padding: "6px 10px", borderLeft: "3px solid var(--border)", fontSize: 11, fontStyle: "italic", color: "var(--text-secondary)" }}>
              “{item.source_quote}”
            </blockquote>
          )}
          <div style={{ fontFamily: "monospace", fontSize: 10, color: "var(--text-muted)", marginBottom: 12 }}>
            by {item.created_by ?? "unknown"} · {timeAgo(item.created_at)}
          </div>
        </>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {isRetire ? (
          <>
            <button style={btn(true)} disabled={busy} onClick={() => act("confirm_retire")}>
              Retire it
            </button>
            <button style={btn(false)} disabled={busy} onClick={() => act("dismiss_retire")}>
              Keep it
            </button>
          </>
        ) : (
          <>
            <button style={btn(true)} disabled={busy} onClick={() => act("approve")}>
              Approve
            </button>
            <button style={btn(false)} disabled={busy} onClick={() => act("reject")}>
              Reject
            </button>
            <a href="/inbox" style={{ fontSize: 11, color: "var(--accent-hover)", textDecoration: "none", marginLeft: "auto" }}>
              Edit in Inbox →
            </a>
          </>
        )}
        {msg && <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{msg}</span>}
      </div>
    </div>
  );
}
