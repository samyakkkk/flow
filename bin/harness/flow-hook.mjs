#!/usr/bin/env node
// flow-hook — the one capture shim behind every harness's hook line.
//
// Contract with the harnesses: this file's PATH AND ARGUMENTS are frozen the
// day they're written into a tool's config (Codex re-requires /hooks trust on
// any definition change). All evolving logic lives here, in the versioned
// script — updating Flow updates capture for every repo on the machine with
// zero per-repo edits.
//
// Contract with the user's session: NEVER break it. Any failure — no config,
// no network, bad JSON — exits 0 silently (best-effort breadcrumb in
// ~/.flow/logs/hook.log). Hard wall-clock cap so a slow server can't stall a
// SessionEnd (Claude Code allows 1.5s there).
//
// Zero dependencies; stock Node 22.

import { readFileSync, appendFileSync, mkdirSync, statSync, writeFileSync, openSync, readSync, fstatSync, closeSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const VERSION = "1";
const FLOW_DIR = join(homedir(), ".flow");
const DEADLINE_MS = 2500;

// ---------------------------------------------------------------------------
// args: --harness <dialect> --project <name> --repo <name> --remote <name>
const args = {};
for (let i = 2; i < process.argv.length - 1; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args[a.slice(2)] = process.argv[++i];
}

function logLine(msg) {
  try {
    const dir = join(FLOW_DIR, "logs");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "hook.log");
    try {
      if (statSync(p).size > 512 * 1024) writeFileSync(p, ""); // crude rotation
    } catch {}
    appendFileSync(p, `${new Date().toISOString()} [${args.harness ?? "?"}] ${msg}\n`);
  } catch {}
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

// ---------------------------------------------------------------------------
// Client-side redaction — transcripts carry raw tool output; secrets must die
// on the laptop, before any upload. Values are masked, shapes preserved.
const SECRET_PATTERNS = [
  /\b(sk|rk)-[A-Za-z0-9_-]{16,}\b/g, // OpenAI/Anthropic/OpenRouter-style keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)(["']?\s*[:=]\s*["']?)[^\s"'&]{6,}/gi,
];

function redactText(text) {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m, ...groups) =>
      // Pattern 8 keeps the key name + separator, masks only the value.
      groups.length > 2 && typeof groups[0] === "string" && typeof groups[1] === "string"
        ? `${groups[0]}${groups[1]}[redacted]`
        : "[redacted]"
    );
  }
  return out;
}

function redactDeep(v) {
  if (typeof v === "string") return redactText(v);
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = redactDeep(val);
    return out;
  }
  return v;
}

// Copilot CLI and VS Code Stop hooks carry a path, not the final answer.
// Read only a bounded tail of that supplied JSONL file; never scan session
// directories or upload tool output/reasoning. Unknown formats degrade quietly.
function copilotTranscriptLines(payload, tail = true) {
  const path = payload.transcript_path ?? payload.transcriptPath;
  if (typeof path !== "string" || !path) return [];
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return [];
    const length = Math.min(stat.size, tail ? 256 * 1024 : 8192);
    const offset = tail ? stat.size - length : 0;
    const buf = Buffer.alloc(length);
    const count = readSync(fd, buf, 0, length, offset);
    const lines = buf.subarray(0, count).toString("utf8").split("\n");
    if (offset) lines.shift(); // first line may start mid-record
    return lines.flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function copilotAnswer(payload) {
  let answer = null;
  for (const entry of copilotTranscriptLines(payload)) {
    if (!entry || entry.agentId || entry.data?.parentToolCallId) continue;
    if (entry.type === "user.message") answer = null;
    if (entry.type === "assistant.message" && typeof entry.data?.content === "string") {
      answer = entry.data.content.trim() ? entry.data.content.slice(-16000) : null;
    }
  }
  return answer;
}

// ---------------------------------------------------------------------------
async function main() {
  // Sessions Flow itself runs are already captured by the ACP runtime —
  // uploading them again would double-distill every Flow-driven session.
  if (process.env.FLOW_SESSION_ID) return;

  const raw = await readStdin();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    logLine("unparseable stdin, dropped");
    return;
  }

  // Copilot also executes .claude/settings.json hooks. Its session.start
  // transcript header distinguishes these from actual Claude sessions.
  if (args.harness === "claude" && copilotTranscriptLines(payload, false).some(
    (entry) => entry?.type === "session.start" && typeof entry.data?.sessionId === "string"
  )) return;

  // The binding (--project) resolves to a machine-level config entry written
  // by `flow setup` — never resolved from the payload at capture time.
  const remoteName = args.remote ?? "local";
  let remote;
  try {
    const cfg = JSON.parse(readFileSync(join(FLOW_DIR, "config.json"), "utf8"));
    const proj = args.project ? cfg.projects?.[args.project] : undefined;
    remote = proj ? { url: proj.orchestratorUrl, token: proj.token } : cfg.remotes?.[remoteName];
  } catch {}
  if (!remote?.url) {
    logLine(`no binding for project "${args.project}" / remote "${remoteName}" in ~/.flow/config.json, dropped`);
    return;
  }

  if (args.harness === "copilot" && ["Stop", "agentStop"].includes(payload?.hook_event_name ?? payload?.hookEventName)) {
    if (!payload.last_assistant_message) {
      const answer = copilotAnswer(payload);
      if (answer) payload.last_assistant_message = answer;
    }
  }

  const body = JSON.stringify({
    harness: args.harness ?? "generic",
    project: args.project ?? null,
    repo: args.repo ?? null,
    event: redactDeep(payload),
    shim_version: VERSION,
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DEADLINE_MS);
  try {
    const res = await fetch(`${remote.url.replace(/\/+$/, "")}/v1/ingest/hook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(remote.token ? { authorization: `Bearer ${remote.token}` } : {}),
      },
      body,
      signal: ctrl.signal,
    });
    if (!res.ok) logLine(`ingest ${res.status}`);
  } catch (e) {
    logLine(`post failed: ${e?.name ?? e}`);
  } finally {
    clearTimeout(timer);
  }
}

main()
  .catch((e) => logLine(`fatal: ${e?.message ?? e}`))
  .finally(() => process.exit(0));
