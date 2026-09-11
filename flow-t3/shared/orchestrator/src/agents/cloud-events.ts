import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DB_DIR } from "../db.js";
import { redactCloudText } from "./repo-env.js";

export interface CloudEvent { time: number; kind: string; title: string; output?: string; status?: string }
const live = new Map<string, CloudEvent[]>();
function eventFromLine(line: string): CloudEvent | undefined {
  try {
    const event = JSON.parse(line);
    if (event.type === "text" && event.part?.text) return { time: event.timestamp ?? Date.now(), kind: "message", title: redactCloudText(String(event.part.text)).slice(0, 16_000) };
    if (event.type === "tool_use" && event.part?.tool) {
      const { tool, state } = event.part;
      return { time: event.timestamp ?? Date.now(), kind: "tool", status: state?.status,
        title: redactCloudText(`${tool} ${state?.input?.command ?? state?.input?.filePath ?? state?.input?.repo ?? ""}`).slice(0, 2000),
        output: redactCloudText(String(state?.error ?? state?.output ?? "")).slice(0, 16_000) };
    }
  } catch { /* not a supported event */ }
}
export function recordCloudEvent(id: string, line: string): void {
  const event = eventFromLine(line);
  if (!event) return;
  if (!live.has(id) && live.size >= 100) live.delete(live.keys().next().value!);
  const rows = live.get(id) ?? [];
  rows.push(event);
  if (rows.length > 200) rows.shift();
  live.set(id, rows);
}
export function cloudEvents(id: string): CloudEvent[] {
  if (live.has(id)) return live.get(id)!;
  if (!DB_DIR || !/^[a-zA-Z0-9-]+$/.test(id)) return [];
  const file = path.join(DB_DIR, "job-logs", `${id}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").slice(-1000).flatMap((line) => { const event = eventFromLine(line); return event ? [event] : []; }).slice(-200);
}
