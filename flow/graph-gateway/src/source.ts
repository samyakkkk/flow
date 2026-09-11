import { readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const MAX_BYTES = 256 * 1024;
type Repo = { name: string; url?: string; localPath?: string; kind?: string; lastIndexedCommit?: string; sourceRead?: boolean };

async function git(cwd: string, args: string[], maxBuffer = MAX_BYTES) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const result = await exec("git", ["--no-pager", "-c", "core.fsmonitor=false", ...args], {
    cwd, env: { ...env, GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0" },
    encoding: "utf8", timeout: 5000, maxBuffer,
  });
  return result.stdout;
}

// The registry is deployment configuration, never a client-supplied path.
// Project authorization is enforced by the gateway before these tools run.
// Only registered code repositories are visible, with an optional admin opt-out.
async function repository(name: string, revision?: string, registryPath = process.env.FLOW_SOURCE_REGISTRY) {
  if (!registryPath) throw new Error("Source access is not configured on this Flow deployment. Update Flow and rerun setup.");
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  const entry: Repo | undefined = registry.repos?.find((r: Repo) => r.name === name);
  if (!entry || entry.kind === "docs" || entry.sourceRead === false ||
      !name.split("/").every(part => /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(part))) {
    throw new Error("Repository is unavailable for source access in this project.");
  }
  const configured = entry.url ? resolve(dirname(registryPath), "repos", name) : entry.localPath;
  if (!configured) throw new Error("Repository has no registered source checkout.");
  const root = await realpath(configured);
  if (await realpath((await git(root, ["rev-parse", "--show-toplevel"])).trim()) !== root) {
    throw new Error("Registered source is not a repository root.");
  }
  const indexed = entry.lastIndexedCommit || null;
  if (revision !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(revision)) throw new Error("Revision must be a complete Git commit SHA.");
  const requested = revision ?? indexed ?? "HEAD";
  if (requested !== "HEAD" && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(requested)) {
    throw new Error("Revision must be a complete Git commit SHA.");
  }
  const commit = (await git(root, ["rev-parse", "--verify", `${requested}^{commit}`])).trim();
  return { root, commit, indexed, repo: name };
}

function pathInput(path: string) {
  if (!path || path.startsWith("/") || /[\0\r\n\\]/.test(path) || path.split("/").some(p => !p || p === "." || p === "..")) {
    throw new Error("Path must be a normalized repository-relative file path.");
  }
}

export async function sourceRead(input: { repo: string; path: string; revision?: string; start_line?: number; end_line?: number }, registryPath?: string) {
  try {
    pathInput(input.path);
    const source = await repository(input.repo, input.revision, registryPath);
    const tree = await git(source.root, ["ls-tree", "-z", source.commit, "--", `:(literal)${input.path}`]);
    const match = /^(100644|100755) blob ([a-f0-9]+)\t([^\0]+)\0$/.exec(tree);
    if (!match || match[3] !== input.path) throw new Error("Path is not a regular committed file (symlinks and submodules are not followed).");
    const size = Number((await git(source.root, ["cat-file", "-s", match[2]])).trim());
    if (size > MAX_BYTES) throw new Error("File exceeds the 256 KiB source limit; narrow with source_search.");
    const content = await git(source.root, ["cat-file", "blob", match[2]], MAX_BYTES + 1);
    if (content.includes("\0")) throw new Error("Binary source files are not supported.");
    const lines = content.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const start = input.start_line ?? 1;
    const end = input.end_line ?? start + 199;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end - start >= 200) throw new Error("Request at most 200 lines with valid one-based bounds.");
    return { repo: source.repo, revision: source.commit, indexed_revision: source.indexed, path: input.path,
      start_line: start, end_line: Math.min(end, lines.length), total_lines: lines.length,
      content: lines.slice(start - 1, end).join("\n"), truncated: end < lines.length,
      verification: source.indexed === source.commit ? "indexed_revision" : "different_or_unindexed_revision" };
  } catch (error) {
    // Git errors may contain private server paths. Keep transport errors generic.
    return { status: "error", error: error instanceof Error && !("code" in error) ? error.message : "Source unavailable, query exceeded limits, or revision not present in this project's checkout." };
  }
}

export async function sourceSearch(input: { repo: string; query: string; revision?: string; limit?: number }, registryPath?: string) {
  try {
    if (!input.query || input.query.length > 500 || /[\0\r\n]/.test(input.query)) throw new Error("Search requires a single literal query of 1–500 characters.");
    const source = await repository(input.repo, input.revision, registryPath);
    let output = "";
    try { output = await git(source.root, ["grep", "-I", "-n", "-z", "-F", "-e", input.query, source.commit, "--"]); }
    catch (e) { if ((e as { code?: number }).code !== 1) throw e; }
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Limit must be 1–50.");
    const matches: { path: string; line: number; text: string }[] = [];
    const pattern = /([^\0]+)\0(\d+)\0([^\n]*)\n/g;
    for (const match of output.matchAll(pattern)) {
      matches.push({ path: match[1].slice(source.commit.length + 1), line: Number(match[2]), text: match[3].slice(0, 2000) });
      if (matches.length > limit) break;
    }
    return { repo: source.repo, revision: source.commit, indexed_revision: source.indexed,
      matches: matches.slice(0, limit), truncated: matches.length > limit,
      verification: source.indexed === source.commit ? "indexed_revision" : "different_or_unindexed_revision" };
  } catch (error) {
    return { status: "error", error: error instanceof Error && !("code" in error) ? error.message : "Source unavailable, query exceeded limits, or revision not present in this project's checkout." };
  }
}
