"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMode } from "@/lib/useMode";
import { useUpdateStatus } from "@/lib/useUpdateStatus";

// Primary nav items (front door — visually emphasized)
const PRIMARY_ITEMS = [
  { href: "/", label: "Home" },
  { href: "/ask", label: "Ask Flow" },
  { href: "/agents", label: "Agents" },
];

// Secondary nav cluster (quieter — power-user surfaces)
const SECONDARY_ITEMS = [
  { href: "/connections", label: "Sources" },
  { href: "/permissions", label: "Automations" },
  { href: "/activity", label: "Activity" },
  { href: "/settings", label: "Settings" },
];

export function Nav() {
  const path = usePathname();
  const { mode, loading } = useMode();
  const update = useUpdateStatus();

  function isActive(href: string) {
    return href === "/" ? path === "/" : path.startsWith(href);
  }

  return (
    <nav
      className="flex flex-col flex-shrink-0"
      style={{
        width: 220,
        minHeight: "100vh",
        background: "var(--paper)",
        borderRight: "1px solid var(--line)",
      }}
    >
      {/* Wordmark + mode badge */}
      <div
        className="flex flex-col gap-3 px-5 py-5"
        style={{ borderBottom: "1px solid var(--line)" }}
      >
        <div className="flex items-center gap-2">
          {/* Brain mark — same as KeyGate */}
          <div
            className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0"
            style={{ background: "var(--accent)", border: "1px solid var(--line)" }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
              <circle cx="12" cy="12" r="3" fill="var(--ink)" />
              <circle cx="5" cy="7" r="1.6" fill="var(--ink)" opacity="0.6" />
              <circle cx="19" cy="7" r="1.6" fill="var(--ink)" opacity="0.6" />
              <circle cx="5" cy="17" r="1.6" fill="var(--ink)" opacity="0.6" />
              <circle cx="19" cy="17" r="1.6" fill="var(--ink)" opacity="0.6" />
              <path d="M12 12L5 7M12 12L19 7M12 12L5 17M12 12L19 17" stroke="var(--ink)" strokeWidth="0.8" opacity="0.35" />
            </svg>
          </div>
          <span
            style={{ fontFamily: "var(--font-display)", fontWeight: 500, fontSize: 17 }}
            className="text-ink tracking-tight"
          >
            Flow
          </span>
        </div>

        {!loading && (
          <span
            style={{ fontFamily: "var(--font-mono)" }}
            className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-text-muted"
          >
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{ background: mode === "prod" ? "var(--ok)" : "var(--text-muted)" }}
            />
            {mode === "prod" ? "Production" : "Local"}
          </span>
        )}

        {/* Update badge — a long-running install that's fallen behind main.
            flow up applies it (self-update runs at start), hence the hint. */}
        {update.behind > 0 && (
          <span
            style={{ fontFamily: "var(--font-mono)" }}
            className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-widest"
            title={`${update.behind} commit${update.behind === 1 ? "" : "s"} behind (${update.current} → ${update.latest}). Restart with \`flow up\` to apply.`}
          >
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--accent)" }} />
            <span style={{ color: "var(--ink)" }}>
              Update · <span className="normal-case">flow up</span>
            </span>
          </span>
        )}
      </div>

      {/* Primary links */}
      <div className="px-3 pt-4 pb-2">
        {PRIMARY_ITEMS.map((item) => {
          const active = isActive(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className="flex items-center gap-2.5 px-3 py-2 rounded-lg mb-0.5 transition-colors"
              style={{
                background: active ? "var(--sand)" : "transparent",
                color: active ? "var(--ink)" : "var(--text)",
                textDecoration: "none",
                fontFamily: active ? "var(--font-display)" : "var(--font-sans)",
                fontSize: 14,
                fontWeight: active ? 500 : 400,
              }}
            >
              {item.label}
            </Link>
          );
        })}
      </div>

      {/* Divider */}
      <div className="mx-3 my-1" style={{ height: 1, background: "var(--line)" }} />

      {/* Secondary cluster */}
      <div className="px-3 pt-2 pb-2 flex-1">
        {/* Cluster label */}
        <div
          style={{ fontFamily: "var(--font-mono)" }}
          className="text-[10px] uppercase tracking-widest text-text-muted px-3 mb-1.5"
        >
          More
        </div>
        {SECONDARY_ITEMS.map((item) => {
          const active = isActive(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className="flex items-center px-3 py-1.5 rounded-md mb-0.5 transition-colors"
              style={{
                background: active ? "var(--sand)" : "transparent",
                color: active ? "var(--ink)" : "var(--text-muted)",
                textDecoration: "none",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                fontWeight: 400,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
              }}
            >
              {item.label}
            </Link>
          );
        })}
      </div>

      {/* Sign out */}
      <div className="px-3 py-4" style={{ borderTop: "1px solid var(--line)" }}>
        <form action="/api/auth/logout" method="POST">
          <button
            type="submit"
            className="w-full px-3 py-2 rounded-md text-left transition-colors hover:bg-sand"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              color: "var(--text-muted)",
              background: "transparent",
              border: "none",
              cursor: "pointer",
            }}
          >
            Sign out
          </button>
        </form>
      </div>
    </nav>
  );
}
