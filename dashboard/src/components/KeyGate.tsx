"use client";
import { useEffect, useState } from "react";
import { useProject } from "@/lib/useProject";
import { Button, Heading, Input, Kicker } from "@/components/ui";

// State 0 — the first thing a new user sees. Nothing else exists until Flow has
// a brain. Focused, warm, self-explanatory. See docs/UX.md + docs/DESIGN.md.
export function KeyGate({ onReady }: { onReady: () => void }) {
  const { prefix } = useProject();
  const [key, setKey] = useState("");
  const [status, setStatus] = useState<"idle" | "checking" | "ok" | "error">("idle");
  const [error, setError] = useState("");

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

  async function submit() {
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

  return (
    <div className="min-h-screen flex items-center justify-center px-6 bg-cream">
      <div className="w-full max-w-lg rise-in">
        <div className="mb-8 flex justify-center">
          <BrainMark active={status === "ok"} />
        </div>

        <div className="text-center space-y-4 mb-10">
          <div className="flex justify-center">
            <Kicker>Step 1 of 2 · Give Flow a brain</Kicker>
          </div>
          <Heading as="h1" className="text-[38px]">
            {status === "ok" ? "Brain online." : "Flow needs a brain."}
          </Heading>
          <p className="text-[16px] text-text-muted leading-relaxed max-w-sm mx-auto">
            {status === "ok"
              ? "Let's connect your first source."
              : suggested?.available && !enteringNew
              ? "You already gave Flow an OpenRouter key on another project. Reuse it, or use a different one for this project."
              : "Flow uses an LLM to understand your code and conversations. Paste your OpenRouter key to begin."}
          </p>
        </div>

        {/* Reuse the machine's existing key */}
        {status !== "ok" && suggested?.available && !enteringNew && (
          <div className="space-y-4">
            <div className="rounded-lg border border-line bg-paper px-4 py-3 flex items-center justify-between">
              <div>
                <p style={{ fontFamily: "var(--font-mono)" }} className="text-[10px] uppercase tracking-wider text-text-muted">
                  Existing OpenRouter key
                </p>
                <p style={{ fontFamily: "var(--font-mono)" }} className="text-[14px] text-ink">
                  sk-or-•••• {suggested.hint?.replace(/^…/, "") ?? ""}
                </p>
              </div>
              <span className="text-ok text-lg">✓</span>
            </div>
            {error && <p className="text-[13px] text-[color:var(--danger)] px-1">{error}</p>}
            <div className="flex items-center justify-between pt-1">
              <button
                onClick={() => setEnteringNew(true)}
                style={{ fontFamily: "var(--font-mono)" }}
                className="text-[12px] uppercase tracking-wider text-text-muted hover:text-ink transition"
              >
                Use a different key
              </button>
              <Button onClick={reuse} disabled={status === "checking"} arrow>
                {status === "checking" ? "Setting up…" : "Use this key"}
              </Button>
            </div>
          </div>
        )}

        {/* Enter a fresh key (default when the machine has none, or after "use a different key") */}
        {status !== "ok" && (!suggested?.available || enteringNew) && (
          <div className="space-y-4">
            <Input
              type="password"
              placeholder="sk-or-…"
              value={key}
              autoFocus
              onChange={(e) => {
                setKey(e.target.value);
                if (status === "error") setStatus("idle");
              }}
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
            {error && <p className="text-[13px] text-[color:var(--danger)] px-1">{error}</p>}
            <div className="flex items-center justify-between pt-1">
              <a
                href="https://openrouter.ai/keys"
                target="_blank"
                rel="noreferrer"
                style={{ fontFamily: "var(--font-mono)" }}
                className="text-[12px] uppercase tracking-wider text-text-muted hover:text-ink transition"
              >
                Where do I get one? ↗
              </a>
              <Button onClick={submit} disabled={status === "checking" || !key.trim()} arrow>
                {status === "checking" ? "Verifying…" : "Connect"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
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
