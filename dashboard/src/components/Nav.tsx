"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMode } from "@/lib/useMode";
import { useProject } from "@/lib/useProject";
import { ProjectSwitcher } from "@/components/ProjectSwitcher";

// Primary nav items (front door — visually emphasized)
const PRIMARY_ITEMS = [
  { href: "/", label: "Dashboard (Home)" },
  { href: "/agents", label: "Agents / Sessions" },
  { href: "/connections", label: "Connections" },
  { href: "/inbox", label: "Inbox" },
  { href: "/settings", label: "Settings" },
];

// Secondary nav cluster
const SECONDARY_ITEMS = [
  { href: "/activity", label: "Activity" },
  { href: "/permissions", label: "Automations" },
];

export function Nav() {
  const path = usePathname();
  const { prefix } = useProject();
  const { mode, loading } = useMode();

  function isActive(href: string) {
    const full = prefix(href);
    // Home is /p/<name>/ (or /) — exact match, tolerant of the trailing slash.
    return href === "/" ? path === full || path === full.replace(/\/$/, "") : path.startsWith(full);
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
      </div>

      {/* Project switcher — the door between projects */}
      <div className="px-3 pt-3">
        <ProjectSwitcher />
      </div>

      {/* Primary links */}
      <div className="px-3 pt-3 pb-2">
        {PRIMARY_ITEMS.map((item) => {
          const active = isActive(item.href);
          return (
            <Link
              key={item.href}
              href={prefix(item.href)}
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
              href={prefix(item.href)}
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
