import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import db from "../db.js";
import { encrypt, decrypt } from "../settings.js";

export const MAX_SETUP_BYTES = 1024 * 1024;
interface SetupFile { repo: string; environment: string; destination: string; encrypted: string; digest: string }
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const key = (...parts: string[]) => `setup-file:${JSON.stringify(parts)}`;
export function setupFiles(repo?: string): SetupFile[] {
  const rows = db.prepare("SELECT value FROM config WHERE key LIKE 'setup-file:%'").all() as { value: string }[];
  return rows.map(row => JSON.parse(row.value) as SetupFile).filter(file => !repo || file.repo === repo);
}
export function validateSetupPath(destination: string): void {
  if (!destination || destination.length > 500 || destination.includes("\\") || destination.split("/").some(p => !p || p === "." || p === ".." || p === ".git") || /[\x00-\x1f\x7f]/.test(destination) || path.isAbsolute(destination)) {
    throw new Error("Use a repository-relative file path without traversal or Git metadata");
  }
}
function safeTarget(root: string, destination: string): string {
  validateSetupPath(destination);
  const base = realpathSync(root);
  let current = base;
  for (const part of destination.split("/")) {
    current = path.join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) throw new Error("Setup paths cannot contain symlinks"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return current;
}
function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, "--literal-pathspecs", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function manifest(root: string): Record<string, string> {
  const metadata = git(root, ["rev-parse", "--absolute-git-dir"]);
  const file = path.join(metadata, "flow-setup-files.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}
export function isSetupFile(repo: string, destination: string): boolean {
  return setupFiles(repo).some(file => file.destination === destination);
}
export function unchangedSetupFile(repo: string, root: string, destination: string): boolean {
  if (!isSetupFile(repo, destination)) return false;
  const target = safeTarget(root, destination);
  return existsSync(target) && lstatSync(target).isFile() && manifest(root)[destination] === hash(readFileSync(target));
}
export function setupEnvironment(conversation: string, repo: string, select?: string): string | undefined {
  const selection = `setup-selection:${JSON.stringify([conversation, repo])}`;
  if (select !== undefined) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(select)) throw new Error("Use a short environment name such as staging or production");
    db.prepare("INSERT OR REPLACE INTO config (key,value) VALUES (?,?)").run(selection, select);
  }
  const pinned = db.prepare("SELECT value FROM config WHERE key = ?").get(selection) as { value: string } | undefined;
  if (pinned) return pinned.value;
  const environments = [...new Set(setupFiles(repo).map(file => file.environment))];
  // Production never becomes an implicit default just because it is the only profile.
  const candidates = environments.filter(e => !/^(prod|production|live)$/i.test(e));
  if (candidates.length === 1) return setupEnvironment(conversation, repo, candidates[0]);
  if (environments.length) throw new Error(`Choose a setup environment for ${repo}: ${environments.join(", ")}. Ask the requester if it is unclear.`);
}
function checkTarget(root: string, file: SetupFile, data: Buffer): void {
  const target = safeTarget(root, file.destination);
  if (git(root, ["ls-files", "--", file.destination])) throw new Error("Setup files must not overwrite files tracked by Git; choose a local config path");
  if (existsSync(target)) {
    if (!lstatSync(target).isFile()) throw new Error("Setup destination must be a regular file");
    const current = hash(readFileSync(target));
    const previous = manifest(root)[file.destination];
    if (current !== hash(data) && current !== previous && !setupFiles(file.repo).some(saved => saved.destination === file.destination && saved.digest === current)) throw new Error("Existing setup file changed locally; retained it instead of overwriting");
  } else if (manifest(root)[file.destination]) throw new Error("Setup file was deleted locally; retained that deletion instead of overwriting");
}
function place(root: string, file: SetupFile, data: Buffer): void {
  const target = safeTarget(root, file.destination);
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const metadata = git(root, ["rev-parse", "--absolute-git-dir"]);
  const exclude = git(root, ["rev-parse", "--git-path", "info/exclude"]);
  const excludePath = path.resolve(root, exclude);
  mkdirSync(path.dirname(excludePath), { recursive: true });
  // Escape Git ignore metacharacters and anchor the exact repository path.
  const pattern = "/" + file.destination.replace(/[\\*?!\[\] #]/g, "\\$&");
  const old = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
  if (!old.split("\n").includes(pattern)) writeFileSync(excludePath, old + "\n" + pattern + "\n", { mode: 0o600 });
  const tmp = path.join(path.dirname(target), `.flow-setup-${randomUUID()}`);
  writeFileSync(tmp, data, { mode: 0o600, flag: "wx" }); renameSync(tmp, target);
  writeFileSync(path.join(metadata, "flow-setup-files.json"), JSON.stringify({ ...manifest(root), [file.destination]: hash(data) }), { mode: 0o600 });
}
/** Called only while holding the machine coding slot. Validate both destinations before changing either. */
export function registerSetupFile(options: { repo: string; environment: string; destination: string; data: Buffer; source: string; worktree: string; conversation: string }): void {
  const { repo, environment, destination, data, source, worktree, conversation } = options;
  validateSetupPath(destination);
  if (data.length > MAX_SETUP_BYTES) throw new Error("Setup files must be at most 1 MiB");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(environment)) throw new Error("Invalid environment name");
  const file = { repo, environment, destination, encrypted: encrypt(data.toString("base64")), digest: hash(data) };
  checkTarget(source, file, data); checkTarget(worktree, file, data);
  // Store before applying: a crash can retry the same content without losing the supplied file.
  db.prepare("INSERT OR REPLACE INTO config (key,value) VALUES (?,?)").run(key(repo, environment, destination), JSON.stringify(file));
  setupEnvironment(conversation, repo, environment);
  place(source, file, data); place(worktree, file, data);
}
export function rememberExistingSetup(options: { repo: string; environment: string; destination: string; source: string; worktree: string; conversation: string; from: "source" | "worktree" }): void {
  const target = safeTarget(options[options.from], options.destination);
  if (!lstatSync(target).isFile() || lstatSync(target).size > MAX_SETUP_BYTES) throw new Error("Select a regular setup file at most 1 MiB");
  registerSetupFile({ ...options, data: readFileSync(target) });
}
export function applySetupFiles(conversation: string, repo: string, worktree: string): void {
  const files = setupFiles(repo);
  if (!files.length) return;
  const environment = setupEnvironment(conversation, repo);
  const selected = files.filter(file => file.environment === environment);
  const selectedPaths = new Set(selected.map(file => file.destination));
  const removals = [...new Set(files.map(file => file.destination))].filter(destination => !selectedPaths.has(destination)).flatMap(destination => {
    const target = safeTarget(worktree, destination);
    if (!existsSync(target)) return [];
    if (!lstatSync(target).isFile() || git(worktree, ["ls-files", "--", destination]) || !files.some(file => file.destination === destination && file.digest === hash(readFileSync(target)))) throw new Error("Another environment's setup file was changed locally; retained it instead of removing");
    return [{ destination, target }];
  });
  const planned = selected.map(file => {
    const plaintext = decrypt(file.encrypted);
    if (plaintext === null) throw new Error("Cannot decrypt saved setup file");
    const data = Buffer.from(plaintext, "base64");
    checkTarget(worktree, file, data);
    return { file, data };
  });
  for (const { destination, target } of removals) {
    unlinkSync(target);
    const previous = manifest(worktree); delete previous[destination];
    writeFileSync(path.join(git(worktree, ["rev-parse", "--absolute-git-dir"]), "flow-setup-files.json"), JSON.stringify(previous), { mode: 0o600 });
  }
  for (const { file, data } of planned) place(worktree, file, data);
}

/** Preserve unrelated entries when the requester supplies a single missing variable. */
export function mergeSetupValue(source: string, destination: string, variable: string, assignment: Buffer): Buffer {
  const target = safeTarget(source, destination);
  if (!existsSync(target)) return assignment;
  if (!lstatSync(target).isFile() || lstatSync(target).size > MAX_SETUP_BYTES) throw new Error("Existing env file cannot be safely updated");
  const content = readFileSync(target, "utf8");
  if (content.includes("\0")) throw new Error("Variable destination is not a text env file");
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${variable}\\s*=`);
  const lines = content.split(/\r?\n/);
  // Do not guess where a multiline assignment ends.
  if (lines.some(line => line.trim() === assignment.toString("utf8").trim())) return Buffer.from(content);
  if (lines.some(line => pattern.test(line))) throw new Error("Variable already exists; upload the complete replacement file instead");
  return Buffer.from(content.replace(/\n?$/, "\n") + assignment.toString("utf8"));
}
