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

// A slash command advertised by the agent (Claude Code / Codex / OpenCode) over
// ACP. `name` is the command word (no leading slash); `hint` labels the input.
export interface SlashCommand {
  name: string;
  description: string;
  hint?: string;
}

interface MentionTextareaProps {
  value: string;
  onChange: (value: string) => void;
  fetchFiles: (query: string) => Promise<FileEntry[]>;
  // Slash commands to offer when the message starts with "/". Omit for none.
  commands?: SlashCommand[];
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

// The "/command" being typed at the start of the message. Slash commands are
// only valid as the first token (mirrors Claude Code / opencode), so the menu
// opens only while the caret sits inside a leading "/word" with no space yet.
function commandAt(text: string, cursor: number): { start: number; query: string } | null {
  const upto = text.slice(0, cursor);
  const m = /^\s*\/(\S*)$/.exec(upto);
  if (!m) return null;
  return { start: upto.lastIndexOf("/"), query: m[1] };
}

export function MentionTextarea({
  value,
  onChange,
  fetchFiles,
  commands,
  onKeyDown,
  onPaste,
  placeholder,
  disabled,
  rows = 1,
  className,
  autoGrow = false,
}: MentionTextareaProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // The open menu, if any: "file" for @-mentions, "command" for /-commands.
  const [mode, setMode] = useState<null | "file" | "command">(null);
  const [query, setQuery] = useState("");
  const [start, setStart] = useState(0);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [active, setActive] = useState(0);
  const reqId = useRef(0);

  // Command options are derived synchronously from the agent-supplied list;
  // file options are fetched (below). One of these feeds the dropdown.
  const cmdOptions =
    mode === "command" && commands
      ? commands.filter((c) => c.name.toLowerCase().includes(query.toLowerCase())).slice(0, 50)
      : [];
  const optionCount = mode === "command" ? cmdOptions.length : files.length;

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

  function syncMenu() {
    const el = ref.current;
    if (!el) return;
    const cursor = el.selectionStart ?? value.length;
    // A leading "/command" wins over an "@mention" — they can't overlap, since a
    // command menu only opens at the very start of the message.
    const cmd = commands && commands.length > 0 ? commandAt(value, cursor) : null;
    const m = cmd ?? mentionAt(value, cursor);
    if (!m) {
      setMode(null);
      return;
    }
    setMode(cmd ? "command" : "file");
    setStart(m.start);
    setQuery(m.query);
    setActive(0);
  }

  useEffect(() => {
    if (mode !== "file") return;
    const id = ++reqId.current;
    const t = setTimeout(() => {
      fetchFiles(query)
        .then((entries) => {
          if (reqId.current === id) setFiles(entries);
        })
        .catch(() => {
          if (reqId.current === id) setFiles([]);
        });
    }, 120);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, query]);

  // Replace the trigger token (@file or /command) with the chosen value and put
  // the caret right after it — one shared path for both menus.
  function insert(replacement: string) {
    const el = ref.current;
    const cursor = el?.selectionStart ?? start + 1 + query.length;
    const before = value.slice(0, start);
    const after = value.slice(cursor);
    onChange(`${before}${replacement}${after}`);
    setMode(null);
    requestAnimationFrame(() => {
      if (!el) return;
      const pos = before.length + replacement.length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  }

  function choose(i: number) {
    if (mode === "command") {
      const c = cmdOptions[i];
      if (c) insert(`/${c.name} `);
    } else {
      const f = files[i];
      if (f) insert(`@${f.path}${f.type === "dir" ? "/" : ""} `);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (mode && optionCount > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => (a + 1) % optionCount);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => (a - 1 + optionCount) % optionCount);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        choose(active);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMode(null);
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
          requestAnimationFrame(syncMenu);
        }}
        onKeyDown={handleKeyDown}
        onKeyUp={syncMenu}
        onPaste={onPaste}
        onClick={syncMenu}
        onBlur={() => setTimeout(() => setMode(null), 120)}
        placeholder={placeholder}
        disabled={disabled}
        rows={rows}
        className={className}
      />
      {mode === "command" && cmdOptions.length > 0 && (
        <div className="absolute bottom-full left-0 mb-1 w-full max-w-md max-h-56 overflow-y-auto rounded-lg border border-line bg-paper shadow-lg z-20">
          {cmdOptions.map((c, i) => (
            <button
              key={c.name}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                choose(i);
              }}
              onMouseEnter={() => setActive(i)}
              className="w-full flex items-baseline gap-2 px-3 py-1.5 text-left text-[12px]"
              style={{ background: i === active ? "var(--cream)" : "transparent" }}
            >
              <span className="text-ink flex-shrink-0" style={{ fontFamily: "var(--font-mono)" }}>
                /{c.name}
              </span>
              <span className="text-text-muted truncate">{c.description || c.hint || ""}</span>
            </button>
          ))}
        </div>
      )}
      {mode === "file" && files.length > 0 && (
        <div className="absolute bottom-full left-0 mb-1 w-full max-w-sm max-h-56 overflow-y-auto rounded-lg border border-line bg-paper shadow-lg z-20">
          {files.map((o, i) => (
            <button
              key={o.path}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                choose(i);
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
