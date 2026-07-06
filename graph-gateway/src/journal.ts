import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

// Append-only mutation journal. The graph is a projection of this log; it is
// also how observers (the orchestrator) see what any client wrote and why.

const JOURNAL_PATH =
  process.env.JOURNAL_PATH ?? new URL("../data/journal.jsonl", import.meta.url).pathname;

export interface JournalEntry {
  ts: string;
  graph: string;
  actor: string;
  session?: string;
  verb: string;
  input: unknown;
  status: string;
}

let dirReady = false;

export async function record(entry: Omit<JournalEntry, "ts">): Promise<void> {
  if (!dirReady) {
    await mkdir(dirname(JOURNAL_PATH), { recursive: true });
    dirReady = true;
  }
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  await appendFile(JOURNAL_PATH, line + "\n", "utf8");
}

export async function tail(limit = 50): Promise<JournalEntry[]> {
  let raw: string;
  try {
    raw = await readFile(JOURNAL_PATH, "utf8");
  } catch {
    return [];
  }
  const lines = raw.trimEnd().split("\n").filter(Boolean);
  return lines.slice(-limit).map((l) => JSON.parse(l) as JournalEntry);
}
