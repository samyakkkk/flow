"use client";
import { useEffect, useRef, useState } from "react";
import { useProject } from "@/lib/useProject";
import { useUpdateStatus } from "@/lib/useUpdateStatus";

// Update banner — shown across the top of every page when the flow checkout
// is behind upstream (useUpdateStatus). One tap POSTs /api/update-status,
// which runs `flow up` detached: pull, rebuild, restart everything including
// the dashboard serving this page. We then poll GET and reload once the
// server's bootId changes — a new dashboard process means the new build is
// live. bootId (not `behind`) is the restart signal on purpose: `behind` can
// read 0 mid-install (git lock contention makes the check bail), which would
// reload the tab onto the OLD build and hide the banner for the cache TTL.
//
// The watch state lives in sessionStorage because Shell (and this banner)
// remounts on every client-side navigation — losing the "installing" phase
// mid-install would strand the tab on dead chunks with no reload.

const WATCH_KEY = "flow-self-update"; // JSON {startedAt, bootId}
const TIMEOUT_MS = 12 * 60 * 1000; // worst case: npm install (5m cap) + build + restarts
const POLL_MS = 4000;

interface Watch {
  startedAt: number;
  bootId: string;
}

export function UpdateBanner() {
  const { prefix } = useProject();
  const update = useUpdateStatus();
  const [phase, setPhase] = useState<"idle" | "installing" | "error">("idle");
  const [message, setMessage] = useState("");
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    try {
      const saved: Watch | null = JSON.parse(sessionStorage.getItem(WATCH_KEY) || "null");
      if (saved && Date.now() - saved.startedAt < TIMEOUT_MS) watch(saved);
      else sessionStorage.removeItem(WATCH_KEY);
    } catch {
      sessionStorage.removeItem(WATCH_KEY);
    }
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function watch(saved: Watch) {
    setPhase("installing");
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(async () => {
      if (Date.now() - saved.startedAt > TIMEOUT_MS) {
        if (timer.current) clearInterval(timer.current);
        sessionStorage.removeItem(WATCH_KEY);
        setMessage(
          "The update didn't finish — check data/logs/self-update.log, or run `flow up` in a terminal.",
        );
        setPhase("error");
        return;
      }
      try {
        const r = await fetch(prefix("/api/update-status"), { cache: "no-store" });
        if (!r.ok) return;
        const d = await r.json();
        if (d.bootId && d.bootId !== saved.bootId) {
          if (timer.current) clearInterval(timer.current);
          sessionStorage.removeItem(WATCH_KEY);
          window.location.reload(); // new process, new build — pick up the new chunks
        }
      } catch {
        // dashboard down mid-restart — keep polling
      }
    }, POLL_MS);
  }

  async function install() {
    setPhase("installing");
    try {
      const r = await fetch(prefix("/api/update-status"), { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setMessage(d.error || "Couldn't start the update.");
        setPhase("error");
        return;
      }
      const saved: Watch = { startedAt: Date.now(), bootId: String(d.bootId || "") };
      sessionStorage.setItem(WATCH_KEY, JSON.stringify(saved));
      watch(saved);
    } catch {
      setMessage("Couldn't reach the dashboard to start the update.");
      setPhase("error");
    }
  }

  if (phase === "idle" && update.behind === 0) return null;

  return (
    <div
      className="flex items-center gap-3 px-4 py-2.5 mb-5 rounded-lg flex-shrink-0"
      style={{ background: "var(--paper)", border: "1px solid var(--line)" }}
    >
      <span
        className={`w-2 h-2 rounded-full flex-shrink-0 ${phase === "installing" ? "animate-pulse" : ""}`}
        style={{
          background:
            phase === "error" ? "var(--danger)" : phase === "installing" ? "var(--warn)" : "var(--accent)",
          border: "1px solid var(--line)",
        }}
      />
      {phase === "idle" && (
        <>
          <span className="text-[13px] flex-1" style={{ color: "var(--text)" }}>
            A new version of Flow is available
            {update.current && update.latest && (
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-muted)" }}>
                {" "}
                · {update.current} → {update.latest} ({update.behind} commit{update.behind === 1 ? "" : "s"})
              </span>
            )}
          </span>
          <button
            onClick={install}
            className="px-3 py-1.5 rounded-md transition-colors flex-shrink-0"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              background: "var(--ink)",
              color: "var(--cream)",
              border: "none",
              cursor: "pointer",
            }}
          >
            Install &amp; restart
          </button>
        </>
      )}
      {phase === "installing" && (
        <span className="text-[13px]" style={{ color: "var(--text)" }}>
          Installing update — Flow is rebuilding and will restart. This page reloads itself when it&apos;s
          back (a minute or two).
        </span>
      )}
      {phase === "error" && (
        <span className="text-[13px]" style={{ color: "var(--danger)" }}>
          {message}
        </span>
      )}
    </div>
  );
}
