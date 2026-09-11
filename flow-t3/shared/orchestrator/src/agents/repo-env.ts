import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import db from "../db.js";
import { encrypt, decrypt, getSetting, SETTINGS } from "../settings.js";
import { setupFiles } from "./setup-files.js";
import { containsSecret } from "../events.js";

const prefix = (repo: string) => `repo-env:${repo}:`;
const validName = (name: string) => /^\.env(?:\.[A-Za-z0-9_-]+)*$/.test(name);
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
interface StoredEnv { filename: string; encrypted: string; updatedAt: number }
function storedFiles(repo: string): StoredEnv[] {
  return (db.prepare("SELECT value FROM config WHERE substr(key, 1, ?) = ?").all(prefix(repo).length, prefix(repo)) as { value: string }[])
    .map((row) => JSON.parse(row.value) as StoredEnv);
}
export function listRepoEnv(repo: string) {
  return storedFiles(repo).map(({ filename, updatedAt }) => ({ filename, updatedAt }));
}
export function saveRepoEnv(repo: string, filename: string, content: string): void {
  if (!validName(filename)) throw new Error("Use .env or a name such as .env.local; directories are not allowed");
  if (Buffer.byteLength(content) > 256 * 1024 || content.includes("\0")) throw new Error("Env files must be text, at most 256 KiB");
  db.prepare("INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(prefix(repo) + filename, JSON.stringify({ filename, encrypted: encrypt(content), updatedAt: Date.now() }));
}
export function removeRepoEnv(repo: string, filename: string): void {
  if (!validName(filename)) throw new Error("Invalid env filename");
  db.prepare("DELETE FROM config WHERE key = ?").run(prefix(repo) + filename);
}
function manifest(gitDir: string): Record<string, string> {
  const file = path.join(gitDir, "flow-env-overlays.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}
export function managedEnvUnchanged(gitDir: string, cwd: string, filename: string): boolean {
  if (!validName(filename)) return false;
  const target = path.join(cwd, filename);
  return existsSync(target) && lstatSync(target).isFile() && manifest(gitDir)[filename] === hash(readFileSync(target));
}
/** Apply on turn admission, never while an agent is already using its files. */
export function applyRepoEnv(repo: string, source: string, cwd: string, gitDir: string): void {
  const old = manifest(gitDir);
  const files = storedFiles(repo);
  const next: Record<string, string> = {};
  const planned: Array<{ target: string; content?: string }> = [];
  for (const name of new Set([...Object.keys(old), ...files.map((f) => f.filename)])) {
    if (!validName(name)) throw new Error("Invalid stored env filename");
    const target = path.join(cwd, name), fallback = path.join(source, name);
    if (existsSync(target) || (() => { try { lstatSync(target); return true; } catch { return false; } })()) {
      if (!lstatSync(target).isFile()) throw new Error("Env destination is not a regular file");
      const current = readFileSync(target);
      const matches = old[name] ? old[name] === hash(current) :
        existsSync(fallback) && lstatSync(fallback).isFile() && current.equals(readFileSync(fallback));
      if (!matches) throw new Error("An env file was changed in this worktree; it has been retained instead of overwritten");
    }
    if (old[name] && !existsSync(target)) throw new Error("An env file was deleted in this worktree; its deletion has been retained instead of overwritten");
    const file = files.find((f) => f.filename === name);
    if (file) {
      const content = decrypt(file.encrypted);
      if (content === null) throw new Error("Could not decrypt the repository env file");
      next[name] = hash(content);
      planned.push({ target, content });
    } else planned.push({ target, content: existsSync(fallback) && lstatSync(fallback).isFile() ? readFileSync(fallback, "utf8") : undefined });
  }
  for (const { target, content } of planned) {
    if (content === undefined) { if (existsSync(target)) unlinkSync(target); }
    else {
      const temporary = path.join(cwd, `.flow-env-${randomUUID()}`);
      writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
      renameSync(temporary, target);
    }
  }
  writeFileSync(path.join(gitDir, "flow-env-overlays.json"), JSON.stringify(next), { mode: 0o600 });
}

/** Best-effort display/log redaction; an authenticated shell still has host permissions. */
export function redactCloudText(text: string): string {
  if (containsSecret(text)) return "[Output withheld because it contains a credential pattern]";
  const values = Object.entries(process.env).filter(([key]) => /TOKEN|SECRET|PASSWORD|API_KEY/.test(key)).map(([, value]) => value ?? "");
  for (const setting of SETTINGS) if (setting.secret) values.push(getSetting(setting.key) ?? "");
  const rows = db.prepare("SELECT value FROM config WHERE substr(key, 1, 9) = 'repo-env:'").all() as { value: string }[];
  for (const row of rows) {
    const raw = decrypt((JSON.parse(row.value) as StoredEnv).encrypted);
    if (raw) for (const line of raw.split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/.exec(line);
      if (match) values.push(match[1].replace(/^['"]|['"]$/g, ""));
    }
  }
  for (const file of setupFiles()) {
    const decoded = decrypt(file.encrypted);
    if (!decoded) continue;
    const raw = Buffer.from(decoded, "base64").toString("utf8");
    values.push(raw.trim());
    for (const line of raw.split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/.exec(line);
      if (match) values.push(match[1].replace(/^['"]|['"]$/g, ""));
    }
    try {
      const collect = (value: unknown): void => { if (typeof value === "string") values.push(value); else if (value && typeof value === "object") Object.values(value).forEach(collect); };
      collect(JSON.parse(raw));
    } catch { /* non-JSON setup file */ }
  }
  for (const value of values.filter((v) => v.length >= 4).sort((a, b) => b.length - a.length)) text = text.replaceAll(value, "[redacted]");
  return text;
}
