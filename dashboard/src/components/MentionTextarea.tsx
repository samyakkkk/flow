"use client";
// Textarea with "@" file/folder mention autocomplete — type @ to search the
// repo's tracked (+ untracked, non-ignored) paths and insert one. The same
// interaction most editor-integrated coding-agent harnesses offer.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

// Grow the textarea to fit its content, up to a cap; scroll past that. Runs in
// a layout effect so the height is set before paint — no flicker as you type.
const MAX_TEXTAREA_HEIGHT = 200;

export interface FileEntry {
  path: string;
  type: "file" | "dir";
}

interface MentionTextareaProps {
  value: string;
  onChange: (value: string) => void;
  fetchFiles: (query: string) => Promise<FileEntry[]>;
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onPaste?: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  disabled?: boolean;
  rows?: number;
  className?: string;
  // Grow to fit content (capped), snapping back when cleared. Opt-in so boxes
  // that want a fixed/user-resizable size (rows + resize-y) keep it.
  autoGrow?: boolean;
}

// The "@token" ending at the cursor, if the caret is mid-mention.
function mentionAt(text: string, cursor: number): { start: number; query: string } | null {
  const upto = text.slice(0, cursor);
  const at = upto.lastIndexOf("@");
  if (at === -1) return null;
  const token = upto.slice(at + 1);
  if (/\s/.test(token)) return null;
  return { start: at, query: token };
}

export function MentionTextarea({
  value,
  onChange,
  fetchFiles,
  onKeyDown,
  onPaste,
  placeholder,
  disabled,
  rows = 1,
  className,
  autoGrow = false,
}: MentionTextareaProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [start, setStart] = useState(0);
  const [options, setOptions] = useState<FileEntry[]>([]);
  const [active, setActive] = useState(0);
  const reqId = useRef(0);

  // Auto-resize to fit content (capped) whenever the value changes — including
  // when it's cleared after send, which snaps it back to a single row.
  useLayoutEffect(() => {
    if (!autoGrow) return;
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > MAX_TEXTAREA_HEIGHT ? "auto" : "hidden";
  }, [value, autoGrow]);

  function syncMention() {
    const el = ref.current;
    if (!el) return;
    const m = mentionAt(value, el.selectionStart ?? value.length);
    if (!m) {
      setOpen(false);
      return;
    }
    setStart(m.start);
    setQuery(m.query);
    setOpen(true);
    setActive(0);
  }

  useEffect(() => {
    if (!open) return;
    const id = ++reqId.current;
    const t = setTimeout(() => {
      fetchFiles(query)
        .then((entries) => {
          if (reqId.current === id) setOptions(entries);
        })
        .catch(() => {
          if (reqId.current === id) setOptions([]);
        });
    }, 120);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query]);

  function select(entry: FileEntry) {
    const el = ref.current;
    const cursor = el?.selectionStart ?? start + 1 + query.length;
    const before = value.slice(0, start);
    const after = value.slice(cursor);
    const mention = `@${entry.path}${entry.type === "dir" ? "/" : ""} `;
    onChange(`${before}${mention}${after}`);
    setOpen(false);
    requestAnimationFrame(() => {
      if (!el) return;
      const pos = before.length + mention.length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (open && options.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => (a + 1) % options.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => (a - 1 + options.length) % options.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        select(options[active]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        return;
      }
    }
    onKeyDown?.(e);
  }

  return (
    <div className="relative flex-1 min-w-0">
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          requestAnimationFrame(syncMention);
        }}
        onKeyDown={handleKeyDown}
        onKeyUp={syncMention}
        onPaste={onPaste}
        onClick={syncMention}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        placeholder={placeholder}
        disabled={disabled}
        rows={rows}
        className={className}
      />
      {open && options.length > 0 && (
        <div className="absolute bottom-full left-0 mb-1 w-full max-w-sm max-h-56 overflow-y-auto rounded-lg border border-line bg-paper shadow-lg z-20">
          {options.map((o, i) => (
            <button
              key={o.path}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                select(o);
              }}
              onMouseEnter={() => setActive(i)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12px]"
              style={{
                background: i === active ? "var(--cream)" : "transparent",
                fontFamily: "var(--font-mono)",
              }}
            >
              <span className="text-text-muted flex-shrink-0">{o.type === "dir" ? "📁" : "📄"}</span>
              <span className="text-ink truncate">{o.path}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
