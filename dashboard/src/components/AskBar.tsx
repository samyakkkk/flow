"use client";
import { useState, useRef } from "react";
import { useRouter } from "next/navigation";

export function AskBar() {
  const [question, setQuestion] = useState("");
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const q = question.trim();
    if (!q) return;
    router.push(`/ask?q=${encodeURIComponent(q)}`);
    setQuestion("");
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      handleSubmit(e);
    }
    // Dismiss on Escape
    if (e.key === "Escape") {
      inputRef.current?.blur();
    }
  }

  return (
    <div
      className="fixed bottom-6 left-1/2 z-50"
      style={{ transform: "translateX(-50%)", width: "min(600px, calc(100vw - 80px))" }}
    >
      <form
        onSubmit={handleSubmit}
        className="flex items-center gap-3 rounded-full px-4 py-2.5 border border-line bg-paper"
        style={{
          boxShadow: "0 4px 24px rgba(54,55,38,0.10), 0 1px 4px rgba(54,55,38,0.08)",
        }}
      >
        {/* Brain icon */}
        <div className="flex-shrink-0 flex items-center">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
            <circle cx="12" cy="12" r="3" fill="var(--text-muted)" />
            <circle cx="5" cy="7" r="1.4" fill="var(--text-muted)" opacity="0.5" />
            <circle cx="19" cy="7" r="1.4" fill="var(--text-muted)" opacity="0.5" />
            <circle cx="5" cy="17" r="1.4" fill="var(--text-muted)" opacity="0.5" />
            <circle cx="19" cy="17" r="1.4" fill="var(--text-muted)" opacity="0.5" />
            <path d="M12 12L5 7M12 12L19 7M12 12L5 17M12 12L19 17" stroke="var(--text-muted)" strokeWidth="0.7" opacity="0.4" />
          </svg>
        </div>

        <input
          ref={inputRef}
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask Flow anything…"
          className="flex-1 bg-transparent text-[14px] text-text placeholder:text-text-muted/60 outline-none"
          style={{ fontFamily: "var(--font-sans)", minWidth: 0 }}
        />

        {question.trim() && (
          <button
            type="submit"
            className="flex-shrink-0 rounded-full px-3 py-1 text-[10.5px] uppercase tracking-wider bg-accent text-ink transition-all hover:scale-[1.03]"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            Ask
          </button>
        )}

        {!question.trim() && (
          <span
            className="flex-shrink-0 text-[10px] uppercase tracking-wider text-text-muted/50 hidden sm:block"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            ↵ enter
          </span>
        )}
      </form>
    </div>
  );
}
