import type { CaptureRow, TranscriptEvent } from "./types.js";

export const TRANSCRIPT_TARGET_CHARS = 120_000;
export const TRANSCRIPT_HARD_CHARS = 150_000;
export const MAX_EVIDENCE_CHARS = 8_000;
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
const string = (value: unknown): string => (typeof value === "string" ? value : "");
export function redactSecrets(text: string): string {
  return text
    .replace(
      /\b(?:sk-or-v1-|sk-ant-|sk-proj-|ghp_|github_pat_|glpat-|xox[baprs]-|xapp-|xai-|hf_|lin_api_)[A-Za-z0-9_-]+/g,
      "[redacted credential]",
    )
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[redacted credential]")
    .replace(/([?#&](?:token|secret|api_key)=)[^&\s)"'<>`{}[\]\\]+/gi, "$1[redacted]")
    .replace(/(\bBearer\s+)[A-Za-z0-9_.~-]{16,}/gi, "$1[redacted]")
    .replace(
      /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g,
      "[redacted private key]",
    )
    .replace(
      /((?:api[_ -]?key|(?:access|auth|bot|app|refresh)[_ -]?token|password|secret|client[_ -]?secret)["']?\s*[=:]\s*["']?)[A-Za-z0-9_./+~-]{16,}/gi,
      "$1[redacted credential]",
    )
    .replace(/\b[A-Za-z0-9_+/-]{40,}\b/g, (value, offset: number, source: string) =>
      /^.{0,40}\b(?:api[_ -]?(?:key|token|tokne)|access token|password|secret)\b/i.test(
        source.slice(offset + value.length, offset + value.length + 80),
      )
        ? "[redacted credential]"
        : value,
    );
}

/** Keep existing binary captures retrievable at their source, out of text-only evidence. */
function evidenceJson(value: unknown): string {
  return (
    JSON.stringify(value, (_key, item: unknown) => {
      const block = record(item);
      if (
        typeof block.data === "string" &&
        (block.type === "base64" || block.type === "image" || block.type === "audio")
      )
        return {
          ...block,
          data: `[Binary content omitted from text evidence; ${block.data.length} encoded characters captured]`,
        };
      if (typeof item === "string" && /^data:(?:image|audio|video)\/[\w.+-]+;base64,/i.test(item))
        return `[Binary data URL omitted from text evidence; ${item.length} characters captured]`;
      return item;
    }) ?? ""
  );
}
export function excerpt(text: string, cap: number): string {
  const safe = redactSecrets(text);
  if (safe.length <= cap) return safe;
  if (cap <= 0) return "";
  const fullMarker = "\n[… excerpt; content omitted …]\n";
  const marker = cap >= fullMarker.length ? fullMarker : "[… omitted …]".slice(0, cap);
  const available = Math.max(0, cap - marker.length);
  const head = Math.floor(available / 3);
  const tail = available - head;
  return safe.slice(0, head) + marker + (tail ? safe.slice(-tail) : "");
}
export function evidenceParts(row: CaptureRow): Record<string, string> {
  const data = record(row.data);
  const raw = record(data.rawInput);
  const item = Object.keys(record(raw.item)).length ? record(raw.item) : raw;
  const result = record(item.result ?? raw.result ?? data.rawOutput);
  const toolInput = record(item.input);
  const command = string(item.command) || string(toolInput.command);
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const output =
    (data.sessionUpdate === "agent_message_chunk" ? string(record(data.content).text) : "") ||
    string(item.aggregatedOutput) ||
    string(item.output) ||
    string(raw.output) ||
    string(result.content) ||
    (Array.isArray(result.content)
      ? result.content
          .map(
            (part) =>
              string(record(part).text) ||
              (["image", "audio"].includes(string(record(part).type)) ? evidenceJson(part) : ""),
          )
          .filter(Boolean)
          .join("\n")
      : "") ||
    (Object.keys(result).length ? evidenceJson(result) : "");
  const input = command
    ? `cwd: ${string(item.cwd) || string(toolInput.cwd) || "not recorded"}\ncommand: ${command}`
    : evidenceJson(item.arguments ?? item.input ?? raw.input ?? data.rawInput ?? data);
  let diff = changes
    .map((change) => {
      const file = record(change);
      return `FILE: ${string(file.path)}\n${string(file.diff)}`;
    })
    .join("\n");
  if (
    !diff &&
    item.toolName === "Edit" &&
    typeof toolInput.old_string === "string" &&
    typeof toolInput.new_string === "string"
  ) {
    diff = `FILE: ${string(toolInput.file_path)}\nCaptured replacement (not a full-file snapshot):\nOLD:\n${toolInput.old_string}\nNEW:\n${toolInput.new_string}\nreplace_all: ${toolInput.replace_all === true}`;
  } else if (!diff && item.toolName === "Write" && typeof toolInput.content === "string") {
    diff = `FILE: ${string(toolInput.file_path)}\nCaptured new content (previous file content was not recorded here):\n${toolInput.content}`;
  }
  return {
    all: redactSecrets(evidenceJson(row.data)),
    input: redactSecrets(input),
    output: redactSecrets(output),
    diff: redactSecrets(diff),
  };
}
export function normalizeTranscript(rows: CaptureRow[]): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  let previousSource: CaptureRow | undefined;
  for (const row of rows) {
    const adjacentSource = previousSource;
    previousSource = row;
    const data = record(row.data);
    let kind: TranscriptEvent["kind"];
    let text = "";
    if (row.kind === "created") {
      const context = ["repo", "branch", "backend"].flatMap((key) =>
        typeof data[key] === "string" ? [`${key}: ${data[key]}`] : [],
      );
      if (!context.length) continue;
      kind = "boundary";
      text = `Recorded conversation context: ${context.join("; ")}. This describes the source conversation at this event.`;
    } else if (row.kind === "user_prompt") {
      kind = "user";
      text = string(data.text);
    } else if (row.kind === "error") {
      kind = "boundary";
      text = `Error: ${string(data.message) || JSON.stringify(row.data)}`;
    } else if (row.kind !== "update") continue;
    else if (data.sessionUpdate === "agent_message_chunk") {
      kind = "assistant";
      text = string(record(data.content).text);
    } else if (data.sessionUpdate === "remember") {
      kind = "nomination";
      text = `The main agent nominated this for memory. Check it against the original conversation:\n${string(data.text)}`;
    } else if (data.sessionUpdate === "turn_completed") {
      kind = "boundary";
      const error = data.errorMessage ?? data.error;
      const reason = string(data.stopReason) || string(data.reason) || string(data.exitKind);
      text = `Turn outcome: ${string(data.state) || string(data.status) || "ended"}${error ? "; error: " + JSON.stringify(error) : ""}${reason ? "; reason: " + reason : ""}`;
    } else if (data.sessionUpdate === "tool_call" || data.sessionUpdate === "tool_call_update") {
      kind = "tool";
      const raw = record(data.rawInput);
      const item = Object.keys(record(raw.item)).length ? record(raw.item) : raw;
      const toolInput = record(item.input);
      const parts = evidenceParts(row);
      const phase = data.sessionUpdate === "tool_call" ? "started" : "completed";
      const title =
        string(data.title) ||
        string(item.toolName) ||
        string(item.tool) ||
        string(item.type) ||
        "Tool";
      if (item.type === "fileChange" || parts.diff) {
        const files = (Array.isArray(item.changes) ? item.changes : []).map((change) =>
          string(record(change).path),
        );
        text = `File edit ${phase}: ${files.join(", ") || string(toolInput.file_path) || title}\n${parts.diff.length} edit-evidence characters retained; read_evidence can inspect them. Outcome: ${string(data.status) || string(item.status) || "not recorded"}.`;
      } else if (item.type === "commandExecution" || item.command || toolInput.command) {
        text = `Command ${phase}: ${excerpt(parts.input, phase === "started" ? 1800 : 600)}`;
        if (phase === "completed")
          text += `\nExit status: ${item.exitCode ?? "not recorded"}\nOutput excerpt:\n${excerpt(parts.output, item.exitCode === 0 ? 700 : 1600) || "[No captured output]"}`;
      } else {
        text = `${title} ${phase}: ${string(data.status) || string(item.status)}`;
        text +=
          phase === "started"
            ? `\nInput: ${excerpt(parts.input, 1800)}`
            : `\nOutput excerpt:\n${excerpt(parts.output || parts.all, 900)}`;
      }
    } else continue;
    if (!text) continue;
    const previous = events.at(-1);
    // Assistant deltas are one stream, not a new historical event per token.
    // Retain the source range so the combined passage can be fetched again.
    if (
      kind === "assistant" &&
      previous?.kind === "assistant" &&
      adjacentSource?.kind === "update" &&
      record(adjacentSource.data).sessionUpdate === "agent_message_chunk" &&
      previous.text.length + text.length <= 8000
    ) {
      previous.fromSeq ??= previous.seq;
      previous.text += text;
      previous.seq = row.seq;
      previous.at = row.ts;
    } else events.push({ seq: row.seq, at: row.ts, kind, text });
  }
  return events.map((event) => ({ ...event, text: redactSecrets(event.text) }));
}
export const formatEvent = (event: TranscriptEvent): string =>
  `[E${event.seq} ${new Date(event.at).toISOString()} ${event.kind}${event.fromSeq !== undefined ? `; fromSeq=${event.fromSeq}` : ""}]\n${event.text}`;

export function transcriptWindow(
  events: TranscriptEvent[],
  budget = TRANSCRIPT_TARGET_CHARS,
): {
  text: string;
  characters: number;
  firstSeq: number | null;
  through: number;
  omitted: boolean;
} {
  const cap = Math.max(1000, Math.min(budget, TRANSCRIPT_HARD_CHARS));
  const selected: string[] = [];
  let size = 0;
  let firstSeq: number | null = null;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    const line = formatEvent(event);
    if (size + line.length + 2 > cap) {
      if (!selected.length) {
        selected.push(excerpt(line, cap - 2));
        size = selected[0]!.length;
        firstSeq = event.seq;
      }
      break;
    }
    selected.push(line);
    size += line.length + 2;
    firstSeq = event.seq;
  }
  // This local buffer can be reversed in place; the shared runtime targets ES2022.
  // oxlint-disable-next-line unicorn/no-array-reverse
  const text = selected.reverse().join("\n\n");
  return {
    text,
    characters: text.length,
    firstSeq,
    through: events.at(-1)?.seq ?? 0,
    omitted:
      selected.length < events.length ||
      (events.length === 1 && formatEvent(events[0]!).length > text.length),
  };
}

/** Counts original transcript and expanded evidence held by the active native segment. */
export class TranscriptBudget {
  private used = 0;
  get characters(): number {
    return this.used;
  }
  get remaining(): number {
    return TRANSCRIPT_HARD_CHARS - this.used;
  }
  reset(characters: number): void {
    if (characters < 0 || characters > TRANSCRIPT_TARGET_CHARS)
      throw new Error("Invalid transcript window.");
    this.used = characters;
  }
  canAppend(characters: number): boolean {
    return characters >= 0 && this.used + characters <= TRANSCRIPT_HARD_CHARS;
  }
  append(characters: number): void {
    if (!this.canAppend(characters))
      throw new Error("The passive transcript needs a new bounded context window.");
    this.used += characters;
  }
}
