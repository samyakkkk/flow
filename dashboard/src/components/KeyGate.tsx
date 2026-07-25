"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useProject } from "@/lib/useProject";
import { Button, Heading, Input, Kicker, StatusPill } from "@/components/ui";
import { BrandIcon, type BrandName } from "@/components/BrandIcon";

type DetectedAgent = {
  id: string;
  name: string;
  installed: boolean;
  source?: "explicit" | "local" | "bundled";
};

// Maps orchestrator backend ids to BrandIcon names + a one-line "how it gets
// models" description. Same id space as INDEXER_RUNTIME / IndexerBackend.
const CLI_META: Record<string, { brand: BrandName; desc: string }> = {
  claude: { brand: "anthropic", desc: "Uses your Claude Code login" },
  codex: { brand: "openai", desc: "Uses your Codex CLI auth" },
  opencode: { brand: "opencode", desc: "Uses your OpenCode provider auth" },
};

// State 0 — the first thing a new user sees. Nothing else exists until Flow has
// a brain. One primary slot holds EITHER a coding-CLI picker OR an OpenRouter
// key field; a link swaps them in place. Which one is primary by default is
// decided by detection: a machine with a logged-in CLI (local dev) leads with
// the picker; a bare box (an EC2 deployment) leads with the key.
// See docs/UX.md + docs/DESIGN.md.
export function KeyGate({ onReady }: { onReady: () => void }) {
  const { prefix } = useProject();
  const [key, setKey] = useState("");
  const [status, setStatus] = useState<"idle" | "checking" | "ok" | "error">("idle");
  const [error, setError] = useState("");

  // Which control is primary. null until detection resolves the default.
  const [active, setActive] = useState<"cli" | "key" | null>(null);
  // Usable coding CLIs on this machine (a real executable, not Flow's adapter).
  const [clis, setClis] = useState<DetectedAgent[]>([]);
  const [selectedCli, setSelectedCli] = useState("");

  // If the machine already has an OpenRouter key (saved by another project),
  // offer to reuse it instead of asking for a fresh one.
  const [suggested, setSuggested] = useState<{ available: boolean; hint?: string } | null>(null);
  const [enteringNew, setEnteringNew] = useState(false);

  useEffect(() => {
    fetch(prefix("/api/onboarding/suggested-key"))
      .then((r) => (r.ok ? r.json() : { available: false }))
      .then((d) => setSuggested(d))
      .catch(() => setSuggested({ available: false }));
  }, []);

  // Detect CLIs, then choose the default primary control: picker if any CLI is
  // usable, otherwise the key field. Only "local"/"explicit" agents are real
  // executables that can run an index job — "bundled" is Flow's ACP adapter.
  useEffect(() => {
    fetch(prefix("/api/agents"))
      .then((r) => (r.ok ? r.json() : { agents: [] }))
      .then((d: { agents?: DetectedAgent[] }) => {
        const usable = (d.agents ?? []).filter(
          (a) => a.installed && (a.source === "local" || a.source === "explicit")
        );
        setClis(usable);
        setSelectedCli(usable[0]?.id ?? "");
        setActive(usable.length > 0 ? "cli" : "key");
      })
      .catch(() => {
        setClis([]);
        setActive("key");
      });
  }, []);

  const usingSuggested = active === "key" && !!suggested?.available && !enteringNew;
  const busy = status === "checking";

  // Pick a coding CLI: no key required. BRAIN_MODE (any value) opens the gate;
  // INDEXER_RUNTIME pins the exact backend so indexing runs through the CLI the
  // user chose rather than the auto-resolver's first match. Classifier +
  // semantic search wake up later if a key lands in Settings.
  async function chooseCli() {
    if (!selectedCli) return;
    setStatus("checking");
    setError("");
    try {
      const res = await fetch(prefix("/api/settings"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ BRAIN_MODE: selectedCli, INDEXER_RUNTIME: selectedCli }),
      });
      if (res.ok) {
        setStatus("ok");
        setTimeout(onReady, 900);
      } else {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setStatus("error");
        setError(data.error ?? "Couldn't save that choice.");
      }
    } catch {
      setStatus("error");
      setError("Couldn't reach the server.");
    }
  }

  async function reuse() {
    setStatus("checking");
    setError("");
    try {
      const res = await fetch(prefix("/api/onboarding/adopt-key"), { method: "POST" });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (data.ok) {
        setStatus("ok");
        setTimeout(onReady, 900);
      } else {
        setStatus("error");
        setError(data.error ?? "Couldn't reuse that key.");
      }
    } catch {
      setStatus("error");
      setError("Couldn't reach the server.");
    }
  }

  async function submitKey() {
    if (!key.trim()) return;
    setStatus("checking");
    setError("");
    try {
      const res = await fetch(prefix("/api/onboarding/openrouter"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: key.trim() }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (data.ok) {
        setStatus("ok");
        setTimeout(onReady, 900); // let the "Brain online" beat land
      } else {
        setStatus("error");
        setError(data.error ?? "That didn't work.");
      }
    } catch {
      setStatus("error");
      setError("Couldn't reach the server.");
    }
  }

  // One footer action that adapts to the active control.
  function primaryLabel() {
    if (active === "cli") return busy ? "Setting up…" : "Continue";
    if (usingSuggested) return busy ? "Setting up…" : "Use this key";
    return busy ? "Verifying…" : "Connect";
  }
  function primaryDisabled() {
    if (busy) return true;
    if (active === "cli") return clis.length === 0 || !selectedCli;
    if (usingSuggested) return false;
    return key.trim().length < 3;
  }
  function onPrimary() {
    if (active === "cli") return chooseCli();
    if (usingSuggested) return reuse();
    return submitKey();
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-6 bg-cream">
      <div className="w-full max-w-lg rise-in">
        <div className="mb-8 flex justify-center">
          <BrainMark active={status === "ok"} />
        </div>

        <div className="text-center space-y-4 mb-9">
          <div className="flex justify-center">
            <Kicker>Step 1 of 2 · Give Flow a brain</Kicker>
          </div>
          <Heading as="h1" className="text-[38px]">
            {status === "ok" ? "Brain online." : "Let's create your brain."}
          </Heading>
          <p className="text-[16px] text-text-muted leading-relaxed max-w-sm mx-auto">
            {status === "ok"
              ? "Let's connect your first source."
              : "Use your installed CLIs or provide an OpenRouter key as your LLM provider."}
          </p>
        </div>

        {status !== "ok" && active && (
          <div className="flex flex-col">
            {/* Primary slot: CLI picker or key field */}
            {active === "cli" ? (
              <div>
                <FieldLabel>{clis.length > 0 ? "Indexing runs through" : "Coding CLI"}</FieldLabel>
                <CliDropdown
                  clis={clis}
                  selected={selectedCli}
                  onSelect={(id) => {
                    setSelectedCli(id);
                    if (status === "error") setStatus("idle");
                  }}
                />
              </div>
            ) : usingSuggested ? (
              <div>
                <FieldLabel>OpenRouter key</FieldLabel>
                <div className="rounded-lg border border-line bg-paper px-4 py-3 flex items-center justify-between">
                  <div>
                    <p style={{ fontFamily: "var(--font-mono)" }} className="text-[10px] uppercase tracking-wider text-text-muted">
                      Existing OpenRouter key
                    </p>
                    <p style={{ fontFamily: "var(--font-mono)" }} className="text-[14px] text-ink">
                      sk-or-•••• {suggested?.hint?.replace(/^…/, "") ?? ""}
                    </p>
                  </div>
                  <span className="text-ok text-lg">✓</span>
                </div>
                <button
                  onClick={() => setEnteringNew(true)}
                  style={{ fontFamily: "var(--font-mono)" }}
                  className="mt-3 text-[12px] uppercase tracking-wider text-text-muted hover:text-ink transition"
                >
                  Use a different key
                </button>
              </div>
            ) : (
              <div>
                <FieldLabel>OpenRouter key</FieldLabel>
                <Input
                  autoFocus
                  type="password"
                  placeholder="sk-or-…"
                  value={key}
                  onChange={(e) => {
                    setKey(e.target.value);
                    if (status === "error") setStatus("idle");
                  }}
                  onKeyDown={(e) => e.key === "Enter" && !primaryDisabled() && onPrimary()}
                />
                <a
                  href="https://openrouter.ai/keys"
                  target="_blank"
                  rel="noreferrer"
                  style={{ fontFamily: "var(--font-mono)" }}
                  className="mt-2.5 inline-block text-[11px] uppercase tracking-wider text-text-muted hover:text-ink transition"
                >
                  Where do I get one? ↗
                </a>
              </div>
            )}

            {error && <p className="text-[13px] text-[color:var(--danger)] px-1 mt-3">{error}</p>}

            {/* Swap link — replaces the primary control with the other option */}
            <button
              onClick={() => {
                setActive(active === "cli" ? "key" : "cli");
                if (status === "error") setStatus("idle");
              }}
              style={{ fontFamily: "var(--font-mono)" }}
              className="mt-4 self-start inline-flex items-center gap-2 text-[11.5px] uppercase tracking-wider text-text-muted hover:text-ink transition"
            >
              {active === "cli" ? (
                <>
                  <BrandIcon name="openrouter" size={15} />
                  Use an OpenRouter key instead
                </>
              ) : (
                <>
                  <TerminalGlyph />
                  Use a coding CLI instead
                </>
              )}
            </button>

            <div className="flex justify-end mt-6">
              <Button onClick={onPrimary} disabled={primaryDisabled()} arrow>
                {primaryLabel()}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <p
      style={{ fontFamily: "var(--font-mono)" }}
      className="mb-2.5 ml-0.5 text-[10px] uppercase tracking-[0.14em] text-text-muted"
    >
      {children}
    </p>
  );
}

// Custom dropdown: a native <select> can't render brand icons in its options,
// so this is a button + listbox that shows each detected CLI with its mark.
function CliDropdown({
  clis,
  selected,
  onSelect,
}: {
  clis: DetectedAgent[];
  selected: string;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const none = clis.length === 0;
  const current = clis.find((c) => c.id === selected);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={none}
        onClick={() => setOpen((o) => !o)}
        className={`w-full flex items-center gap-3 rounded-xl border bg-paper px-4 py-3.5 text-left transition ${
          none
            ? "border-line opacity-60 cursor-not-allowed"
            : open
            ? "border-ink/25 ring-2 ring-[color:var(--accent)]/50"
            : "border-line hover:border-ink/25"
        }`}
      >
        <span className="w-[22px] h-[22px] flex items-center justify-center text-ink shrink-0">
          {none ? (
            <span className="text-text-muted">○</span>
          ) : (
            <BrandIcon name={CLI_META[selected]?.brand ?? "opencode"} size={20} />
          )}
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-[15px] font-semibold text-ink truncate">
            {none ? "No coding CLI detected" : current?.name ?? selected}
          </span>
          <span className="block text-[12.5px] text-text-muted truncate">
            {none
              ? "Install opencode, Codex, or Claude Code to use one"
              : CLI_META[selected]?.desc ?? "Uses this CLI's provider auth"}
          </span>
        </span>
        {!none && (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className={`text-text-muted shrink-0 transition ${open ? "rotate-180" : ""}`}>
            <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>

      {open && !none && (
        <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-20 rounded-xl border border-line bg-cream p-1.5 shadow-[0_12px_40px_rgba(54,55,38,0.14)]">
          {clis.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => {
                onSelect(c.id);
                setOpen(false);
              }}
              className="w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-paper transition"
            >
              <span className="w-[22px] h-[22px] flex items-center justify-center text-ink shrink-0">
                <BrandIcon name={CLI_META[c.id]?.brand ?? "opencode"} size={20} />
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-[14.5px] font-semibold text-ink truncate">{c.name}</span>
                <span className="block text-[12px] text-text-muted truncate">
                  {CLI_META[c.id]?.desc ?? "Uses this CLI's provider auth"}
                </span>
              </span>
              <StatusPill kind="ok">Detected</StatusPill>
              {selected === c.id && (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-ink shrink-0">
                  <path d="M5 12l5 5L20 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// A small ">_" terminal prompt, for the "use a coding CLI instead" swap link.
function TerminalGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M5 7l4 5-4 5M11 17h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// A small serif-era emblem — the "brain". Glows to accent when online.
function BrainMark({ active }: { active: boolean }) {
  return (
    <div
      className="relative w-16 h-16 rounded-full flex items-center justify-center transition-all duration-700"
      style={{
        background: active ? "var(--accent)" : "var(--paper)",
        border: "1px solid var(--line)",
        boxShadow: active ? "0 0 40px 0 rgba(255,247,129,0.6)" : "none",
      }}
    >
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="3" fill="var(--ink)" />
        <circle cx="5" cy="7" r="1.6" fill="var(--ink)" opacity={active ? 1 : 0.5} />
        <circle cx="19" cy="7" r="1.6" fill="var(--ink)" opacity={active ? 1 : 0.5} />
        <circle cx="5" cy="17" r="1.6" fill="var(--ink)" opacity={active ? 1 : 0.5} />
        <circle cx="19" cy="17" r="1.6" fill="var(--ink)" opacity={active ? 1 : 0.5} />
        <path d="M12 12L5 7M12 12L19 7M12 12L5 17M12 12L19 17" stroke="var(--ink)" strokeWidth="0.8" opacity="0.4" />
      </svg>
    </div>
  );
}
