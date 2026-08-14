#!/usr/bin/env node
// Dry-run the CURRENT distiller (v2 prompt) over REAL captured transcripts and
// write the would-be memories to a reviewable doc — NOTHING is written to the
// memory store (scratch DB only for llm_log). This is the "show me what the
// new model would remember from my actual sessions" tool.
//
//   node --import tsx/esm benchmarks/knowledge/dryrun-real.mjs \
//     [--limit N] [--session <id>] [--concurrency 3] [--out <prefix>] [--skip-native]
//
// Sources:
//   1. Flow-captured sessions:  <flowRoot>/data/projects/<proj>/agent-sessions/*.jsonl
//      (runtime event shape — used as-is)
//   2. Claude Code native transcripts: ~/.claude/projects/<flow-workspace dirs>/*.jsonl
//      (converted: user text → user_prompt, assistant text → agent_message_chunk;
//       skipped when the same session id was already flow-captured)
//
// Long sessions are processed in event windows with the SAME budget semantics
// as the live trigger: prior-observation count feeds the prompt's pressure
// note at 25 and extraction stops at the hard cap of 60.

import { readFileSync, readdirSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const LIMIT = Number(flag("--limit") ?? Infinity);
const ONLY_SESSION = flag("--session");
const CONCURRENCY = Number(flag("--concurrency") ?? 3);
const OUT_PREFIX = flag("--out") ?? join(REPO_ROOT, "memory-preview-v2");
const SKIP_NATIVE = argv.includes("--skip-native");

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "flow-dryrun-")), "log.db"); // llm_log only
process.env.FLOW_FAKE_OPENCODE = "1";
process.env.FLOW_DISTILLER = "1";

const { slimTranscript } = await import("../../orchestrator/src/memory/slim.js");
const { buildDistillerPrompt, BUDGET_PRESSURE_AT } = await import("../../orchestrator/src/memory/prompt.js");
const { parseObservations } = await import("../../orchestrator/src/memory/parse.js");
const { callLlm, distillerModel } = await import("../../orchestrator/src/memory/llm.js");
const { SESSION_OBS_HARD_CAP } = await import("../../orchestrator/src/memory/trigger.js");

// ---------------------------------------------------------------------------
// Source discovery

function findFlowRoot() {
  let cur = REPO_ROOT;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(cur, "data", "projects", "flow", "agent-sessions"))) return cur;
    const parent = join(cur, "..");
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

const flowRoot = findFlowRoot();
if (!flowRoot) {
  console.error("no flow data dir found");
  process.exit(1);
}
const SESS_DIR = join(flowRoot, "data", "projects", "flow", "agent-sessions");

function loadFlowTranscript(file) {
  const events = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      events.push({ kind: e.kind, data: e.data, ts: e.ts });
    } catch {
      /* skip */
    }
  }
  return events;
}

// Claude Code native format → runtime event shape (text only; tools/thinking
// dropped — slim keeps prompts + agent conclusions anyway).
function loadNativeTranscript(file) {
  const events = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.isSidechain) continue;
    const content = e?.message?.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (!text) continue;
    if (e.type === "user") {
      events.push({ kind: "user_prompt", data: { text }, ts: Date.parse(e.timestamp ?? "") || 0 });
    } else if (e.type === "assistant") {
      events.push({ kind: "update", data: { sessionUpdate: "agent_message_chunk", content: { text } }, ts: Date.parse(e.timestamp ?? "") || 0 });
    }
  }
  return events;
}

const sources = [];
for (const f of readdirSync(SESS_DIR)) {
  if (!f.endsWith(".jsonl")) continue;
  sources.push({ id: f.replace(/\.jsonl$/, ""), file: join(SESS_DIR, f), origin: "flow" });
}
const flowIds = new Set(sources.map((s) => s.id.replace(/^ext-[a-z]+-/, "")));
if (!SKIP_NATIVE) {
  for (const dir of ["-Users-samyakjain-Documents-flow-workspace", "-Users-samyakjain-Documents-flow-workspace-flow"]) {
    const full = join(homedir(), ".claude", "projects", dir);
    if (!existsSync(full)) continue;
    for (const f of readdirSync(full)) {
      if (!f.endsWith(".jsonl")) continue;
      const id = f.replace(/\.jsonl$/, "");
      if (flowIds.has(id)) continue; // already flow-captured
      sources.push({ id: `cc-${id.slice(0, 8)}`, file: join(full, f), origin: "claude-code" });
    }
  }
}

let picked = ONLY_SESSION ? sources.filter((s) => s.id === ONLY_SESSION || s.id.startsWith(ONLY_SESSION)) : sources;
picked = picked.slice(0, LIMIT);
console.log(`[dryrun] ${picked.length} transcripts (of ${sources.length} discovered) · model ${distillerModel() ?? "default"} · concurrency ${CONCURRENCY}`);

// ---------------------------------------------------------------------------
// Windowed extraction with live budget semantics

const WINDOW_EVENTS = 400;

async function distillOne(src) {
  const events = src.origin === "flow" ? loadFlowTranscript(src.file) : loadNativeTranscript(src.file);
  const meta = events.find((e) => e.kind === "created")?.data ?? {};
  const firstPrompt = events.find((e) => e.kind === "user_prompt")?.data?.text ?? "";
  const title = (meta.title || firstPrompt || "(untitled)").slice(0, 90).replace(/\s+/g, " ");
  const out = { id: src.id, origin: src.origin, title, events: events.length, observations: [], windows: 0, skipped: null };
  if (events.length < 2) {
    out.skipped = "empty";
    return out;
  }
  for (let start = 0; start < events.length; start += WINDOW_EVENTS) {
    if (out.observations.length >= SESSION_OBS_HARD_CAP) {
      out.skipped = "hit-hard-cap";
      break;
    }
    const window = events.slice(start, start + WINDOW_EVENTS);
    const slimmed = slimTranscript(window.map((e) => ({ kind: e.kind, data: e.data })));
    if (slimmed.trim().length < 40) continue;
    out.windows++;
    const prompt = buildDistillerPrompt(slimmed, { priorObservations: out.observations.length });
    try {
      const reply = await callLlm(prompt, { tier: "smart", feature: "dryrun-distill", model: distillerModel() });
      for (const raw of parseObservations(reply)) {
        out.observations.push({
          claim: raw.claim,
          kind: raw.kind,
          source: raw.source,
          ambient: raw.ambient,
          keys: raw.retrieval_keys.slice(0, 6),
        });
      }
    } catch (err) {
      out.skipped = `llm-error: ${err instanceof Error ? err.message.slice(0, 80) : err}`;
      break;
    }
  }
  return out;
}

const results = [];
let idx = 0;
async function worker() {
  for (;;) {
    const i = idx++;
    if (i >= picked.length) return;
    const src = picked[i];
    const t0 = Date.now();
    const r = await distillOne(src);
    results[i] = r;
    console.log(
      `  [${i + 1}/${picked.length}] ${src.id.slice(0, 44)} → ${r.observations.length} obs (${r.windows}w, ${Math.round((Date.now() - t0) / 1000)}s)${r.skipped ? ` [${r.skipped}]` : ""}`,
    );
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

// ---------------------------------------------------------------------------
// Report

const done = results.filter(Boolean);
const withObs = done.filter((r) => r.observations.length > 0);
const totalObs = done.reduce((n, r) => n + r.observations.length, 0);
const byKind = {};
const bySource = {};
let quoted = 0;
let userStated = 0;
for (const r of done)
  for (const o of r.observations) {
    byKind[o.kind] = (byKind[o.kind] ?? 0) + 1;
    bySource[o.source] = (bySource[o.source] ?? 0) + 1;
    if (o.source === "user_stated") {
      userStated++;
      if (/"[^"]{8,}"/.test(o.claim)) quoted++;
    }
  }

const fmt = (o) =>
  `- **(${o.kind}, ${o.source}${o.ambient ? ", ambient" : ""})** ${o.claim}`;

const md = `# Memory preview — distiller v2 over real transcripts (dry run)

Generated ${new Date().toISOString()} · NOTHING was written to the live memory store.
${done.length} transcripts processed (${done.filter((d) => d.origin === "flow").length} flow-captured, ${done.filter((d) => d.origin === "claude-code").length} Claude Code native) · ${totalObs} would-be observations · ${withObs.length} sessions produced ≥1.

**Register check**: ${bySource.user_stated ?? 0} user_stated / ${bySource.agent_inferred ?? 0} agent_inferred / ${bySource.error_proven ?? 0} error_proven. Of the user_stated, ${quoted}/${userStated} carry a verbatim quote of your words.
**Kinds**: ${Object.entries(byKind).map(([k, n]) => `${k} ${n}`).join(" · ")}

> Review guide: each block below is one real session. Ask of each claim — is this durable? is it what YOU said (not what the agent did)? would a teammate want it? Delete-worthy claims are the feedback that tunes the next iteration.

${done
  .filter((r) => r.observations.length > 0)
  .map(
    (r) => `## ${r.title}
\`${r.id}\` · ${r.origin} · ${r.events} events${r.skipped ? ` · ${r.skipped}` : ""}

${r.observations.map(fmt).join("\n")}`,
  )
  .join("\n\n")}

## Sessions that (correctly?) produced nothing
${done
  .filter((r) => r.observations.length === 0)
  .map((r) => `- \`${r.id}\` — ${r.title} (${r.events} events${r.skipped ? `, ${r.skipped}` : ""})`)
  .join("\n")}
`;

writeFileSync(`${OUT_PREFIX}.md`, md);
writeFileSync(`${OUT_PREFIX}.json`, JSON.stringify({ generated: new Date().toISOString(), sessions: done }, null, 2));
console.log(`\n[dryrun] ${totalObs} observations from ${done.length} sessions`);
console.log(`[dryrun] review doc: ${OUT_PREFIX}.md`);
