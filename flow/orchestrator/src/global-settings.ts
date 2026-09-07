// Machine-level defaults shared across all projects on this box.
//
// Local Flow is single-user on your own machine, so re-entering the same
// OpenRouter key for every project is pure friction. When a key is saved it's
// also recorded here as the machine default; a new project offers to reuse it.
//
// Stored at <data>/global.json, mode 0600 — the same trust level as each
// project's .env (which already holds the admin token in plaintext), and
// under the gitignored data/ dir.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

function globalStorePath(): string {
  // DB_PATH = <data>/projects/<name>/flow.db → up three levels = <data>.
  const dbPath = process.env.DB_PATH ?? "";
  const dataRoot = dbPath && dbPath !== ":memory:"
    ? path.dirname(path.dirname(path.dirname(dbPath)))
    : path.resolve("data");
  return path.join(dataRoot, "global.json");
}

function readStore(): Record<string, string> {
  try {
    const p = globalStorePath();
    if (!existsSync(p)) return {};
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function readGlobalDefault(key: string): string | undefined {
  const v = readStore()[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function writeGlobalDefault(key: string, value: string): void {
  if (!value) return;
  try {
    const p = globalStorePath();
    mkdirSync(path.dirname(p), { recursive: true });
    const store = readStore();
    store[key] = value;
    writeFileSync(p, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  } catch {
    // Best-effort — reuse is a convenience, never block a save on it.
  }
}
