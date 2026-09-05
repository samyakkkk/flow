// Flow design-system primitives. See docs/DESIGN.md. Every screen builds from
// these so the look stays consistent and beautiful.
import React from "react";

export function Kicker({ children }: { children: React.ReactNode }) {
  return <span className="kicker">{children}</span>;
}

export function Heading({
  children,
  className = "",
  as: Tag = "h2",
  variant = "display",
}: {
  children: React.ReactNode;
  className?: string;
  as?: "h1" | "h2" | "h3";
  variant?: "display" | "section" | "card";
}) {
  const typography = {
    display: "tracking-tight leading-[1.15]",
    section: "text-[20px] font-normal leading-normal tracking-normal",
    card: "text-[16px] font-normal leading-normal tracking-normal",
  };

  return (
    <Tag
      style={{ fontFamily: "var(--font-display)" }}
      className={`text-ink ${typography[variant]} ${className}`}
    >
      {children}
    </Tag>
  );
}

export function BodyText({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p className={`font-sans text-[12px] font-normal leading-relaxed tracking-normal text-text-muted ${className}`}>
      {children}
    </p>
  );
}

export function Button({
  children,
  variant = "primary",
  arrow = false,
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary";
  arrow?: boolean;
}) {
  const base =
    "inline-flex items-center gap-2.5 rounded-full px-5 py-2.5 text-[12.5px] uppercase tracking-[0.12em] transition-all disabled:opacity-40 disabled:pointer-events-none";
  const styles =
    variant === "primary"
      ? "bg-accent text-ink hover:scale-[1.02] shadow-[var(--shadow-sm)] hover:shadow-[var(--shadow-md)]"
      : "bg-paper text-ink border border-line hover:bg-cream";
  return (
    <button
      {...props}
      style={{ fontFamily: "var(--font-mono)" }}
      className={`${base} ${styles} ${className}`}
    >
      {children}
      {arrow && (
        <svg width="9" height="9" viewBox="0 0 9 9" fill="none" aria-hidden>
          <path d="M1 8L8 1M8 1H1M8 1V8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}

export function Card({
  children,
  emphasis = false,
  className = "",
}: {
  children: React.ReactNode;
  emphasis?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`rounded-lg border p-6 ${
        emphasis ? "bg-ink text-paper border-transparent" : "bg-paper border-line"
      } ${className}`}
    >
      {children}
    </div>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full rounded-md border border-line bg-cream px-4 py-3 text-[15px] text-text placeholder:text-text-muted/70 outline-none focus:border-ink/25 focus:ring-2 focus:ring-[color:var(--accent)]/50 transition ${props.className ?? ""}`}
    />
  );
}

type StatusKind = "live" | "ok" | "warn" | "idle";
export function StatusPill({ kind, children }: { kind: StatusKind; children: React.ReactNode }) {
  const map: Record<StatusKind, string> = {
    live: "bg-accent text-ink",
    ok: "bg-[color:var(--ok)]/12 text-[color:var(--ok)]",
    warn: "bg-[color:var(--warn)]/12 text-[color:var(--warn)]",
    idle: "bg-paper text-text-muted border border-line",
  };
  return (
    <span
      style={{ fontFamily: "var(--font-mono)" }}
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10.5px] uppercase tracking-wider ${map[kind]}`}
    >
      {kind === "live" && <span className="live-dot inline-block w-1.5 h-1.5 rounded-full bg-ink" />}
      {children}
    </span>
  );
}

export function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{ fontFamily: "var(--font-mono)" }}
      className="inline-flex items-center rounded-md border border-line bg-paper px-2 py-1 text-[11px] text-text"
    >
      {children}
    </span>
  );
}
