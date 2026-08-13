#!/usr/bin/env node
// Knowledge-pipeline benchmark: scripted sessions + slack/linear corpus with
// planted ground truth, run through the REAL pipeline (distiller LLM →
// consolidation judge → dedupe → docs composer → retrieval), then scored.
//
// What it measures (the user-facing questions, in order):
//   extraction   — precision / recall vs planted facts, per session
//   intent       — recall on the user-context channel specifically (rationale,
//                  preferences, north stars, plans) — the thing v1 dropped
//   forbidden    — trivia / ruled-out hypotheses / fabricated user rules /
//                  secrets that must NOT become memories
//   dedupe       — the same fact from two sessions must end as ONE active memory
//   contradiction— a stale preseeded claim vs a new user statement must not
//                  coexist as uncontested truth
//   retrieval    — realistic queries (symptom / paraphrase / task-shaped) hit
//                  the right memory or corpus row in the top results
//   docs         — chapters exist, citations valid (enforced in code), every
//                  matched fact's memory is cited somewhere, LLM-composed (not
//                  fallback), and a sampled fabrication check
//
// Run (from the repo root; ~25 min, real LLM calls via the claude CLI):
//   node --import tsx/esm benchmarks/knowledge/run.mjs [--stub-embed] [--keep-db]
//
// --stub-embed uses a deterministic hash embedder instead of the live
// gateway's /v1/embed (Gemma). Real embeddings need a running flow gateway;
// the script auto-discovers the local flow project's port + token and NEVER
// touches running services beyond that read-only embed endpoint.
// NOT wired into CI by design: long-running, costs LLM calls — a one-time
// proof harness, re-run when the pipeline changes materially.

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const args = new Set(process.argv.slice(2));
const STUB_EMBED = args.has("--stub-embed");
const KEEP_DB = args.has("--keep-db");

// ---------------------------------------------------------------------------
// Environment BEFORE importing any orchestrator module (db.ts reads DB_PATH at
// import time).
const workDir = mkdtempSync(join(tmpdir(), "flow-knowledge-bench-"));
process.env.DB_PATH = join(workDir, "bench.db");
process.env.FLOW_ADMIN_TOKEN = process.env.FLOW_ADMIN_TOKEN || "bench-token";
process.env.FLOW_DISTILLER = "1";
process.env.FLOW_DRAIN_DISABLE = "1";
process.env.FLOW_POLL_DISABLE = "1";
process.env.FLOW_DOCS_AUTOCOMPOSE = "0"; // compose once, explicitly, at the end
process.env.FLOW_FAKE_OPENCODE = "1"; // no telemetry from bench runs

// Live-gateway embeddings: discover the local flow project's gateway (read-only
// use of /v1/embed). Falls back to instructing --stub-embed.
function discoverGateway() {
  try {
    // Walk upward from the repo root until a flowRoot (a dir holding
    // data/projects/flow/project.json) appears — covers both a direct
    // checkout and a nested Flow worktree.
    const roots = [];
    if (process.env.FLOW_BENCH_FLOWROOT) roots.push(process.env.FLOW_BENCH_FLOWROOT);
    let cur = REPO_ROOT;
    for (let i = 0; i < 10; i++) {
      roots.push(cur);
      const parent = join(cur, "..");
      if (parent === cur) break;
      cur = parent;
    }
    for (const root of roots) {
      const pj = join(root, "data", "projects", "flow", "project.json");
      if (existsSync(pj)) {
        const ports = JSON.parse(readFileSync(pj, "utf8")).ports ?? {};
        const envFile = join(root, "data", "projects", "flow", ".env");
        const token = existsSync(envFile)
          ? /^FLOW_ADMIN_TOKEN=(.+)$/m.exec(readFileSync(envFile, "utf8"))?.[1]?.trim()
          : undefined;
        if (ports.gateway) return { url: `http://127.0.0.1:${ports.gateway}`, token };
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

if (!STUB_EMBED) {
  const gw = discoverGateway();
  if (!gw) {
    console.error("No local flow gateway found for real embeddings — re-run with --stub-embed, or set FLOW_BENCH_FLOWROOT.");
    process.exit(1);
  }
  process.env.GATEWAY_URL = gw.url;
  if (gw.token) process.env.GATEWAY_TOKEN = gw.token;
  console.log(`[bench] embeddings: live gateway ${gw.url}`);
} else {
  console.log("[bench] embeddings: deterministic stub");
}

// ---------------------------------------------------------------------------
// Imports (tsx resolves the orchestrator's TS behind the .js specifiers).
const store = await import("../../orchestrator/src/memory/store.js");
const { distillSession } = await import("../../orchestrator/src/memory/distiller.js");
const { consolidateObservation } = await import("../../orchestrator/src/memory/consolidate.js");
const { haikuJudge } = await import("../../orchestrator/src/memory/judge.js");
const { dedupeSweep } = await import("../../orchestrator/src/memory/maintenance.js");
const { composeAllDocs, listDocs, getDoc, validateCitations, CHAPTERS, docMembers } = await import("../../orchestrator/src/memory/docs.js");
const { searchMemory } = await import("../../orchestrator/src/memory/search.js");
const { observeCorpus } = await import("../../orchestrator/src/memory/corpus-observe.js");
const { callLlm } = await import("../../orchestrator/src/memory/llm.js");
const db = (await import("../../orchestrator/src/db.js")).default;

if (STUB_EMBED) {
  const DIM = 256;
  store.setEmbedder(async (text) => {
    const v = new Float32Array(DIM);
    for (const tok of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      let h = 0;
      for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) >>> 0;
      v[h % DIM] += 1;
    }
    let n = 0;
    for (const x of v) n += x * x;
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < DIM; i++) v[i] /= n;
    return v;
  });
}

const fixtures = JSON.parse(readFileSync(join(HERE, "fixtures", "sessions.json"), "utf8"));
const corpus = JSON.parse(readFileSync(join(HERE, "fixtures", "corpus.json"), "utf8"));
const queryFile = JSON.parse(readFileSync(join(HERE, "fixtures", "queries.json"), "utf8"));
const REPO = fixtures.repo;

// ---------------------------------------------------------------------------
// LLM judge for scoring: does a produced claim state the planted fact?
async function sameFact(a, b) {
  const prompt = `Statement A: ${a}\n\nStatement B: ${b}\n\nDoes statement A assert the same core fact as statement B (possibly with more or less detail)? A must actually contain B's central claim — topical overlap is NOT enough. Answer with exactly one word: yes or no.`;
  const reply = await callLlm(prompt, { tier: "fast", feature: "bench-match" });
  return /\byes\b/i.test(reply);
}

const report = {
  startedAt: new Date().toISOString(),
  embed: STUB_EMBED ? "stub" : "gateway",
  sessions: [],
  extraction: { producedTotal: 0, matchedProduced: 0, expectedTotal: 0, matchedExpected: 0 },
  intent: { expected: 0, matched: 0, misses: [] },
  forbidden: { violations: [] },
  dedupe: {},
  contradiction: {},
  retrieval: { cases: [], hits: 0, total: 0 },
  docs: {},
};

// ---------------------------------------------------------------------------
console.log("[bench] phase A: corpus ingestion (slack + linear)");
// Mirror rows + observations — the same two writes the real inbound path
// does. The search corpus lane reads the MIRROR tables (slack_messages /
// linear_tickets via FTS); observations carry the embedded/anchorable copy.
for (const s of corpus.slack) {
  db.prepare(
    `INSERT OR IGNORE INTO slack_messages (id, workspace, channel, user_id, text, ts, permalink) VALUES (?, 'bench', ?, ?, ?, ?, ?)`,
  ).run(s.source_id, s.channel, s.by, s.text, s.source_id, s.source_url);
  await observeCorpus({ source: "slack", text: `${s.by}: ${s.text}`, repo: null, source_id: s.source_id, source_url: s.source_url });
}
for (const t of corpus.linear) {
  db.prepare(
    `INSERT OR IGNORE INTO linear_tickets (id, identifier, title, description, url, updated_at) VALUES (?, ?, ?, ?, ?, unixepoch())`,
  ).run(t.source_id, t.identifier, t.text.split(" — ")[0], t.text, t.source_url);
  await observeCorpus({ source: "linear", text: t.text, repo: null, source_id: t.source_id, source_url: t.source_url });
}

// ---------------------------------------------------------------------------
console.log("[bench] phase B: distilling", fixtures.sessions.length, "sessions (real LLM — minutes, not seconds)");
for (const sess of fixtures.sessions) {
  if (sess.preseed_memory) {
    const o = await store.insertObservation({
      source: "session",
      repo: REPO,
      claim: sess.preseed_memory.claim,
      kind: sess.preseed_memory.kind,
      source_weight: sess.preseed_memory.source_weight,
      retrieval_keys: [],
      ambient: false,
      session_id: `${sess.id}-preseed`,
    });
    const res = await consolidateObservation(o, haikuJudge);
    report.contradiction.preseedMemoryId = res.memoryId;
  }
  const t0 = Date.now();
  const out = await distillSession({ sessionId: sess.id, repo: REPO, branch: null, events: sess.events });
  const produced = db
    .prepare(`SELECT id, claim, kind, source_weight, memory_id FROM observations WHERE session_id = ?`)
    .all(sess.id);
  console.log(`  ${sess.id}: ${produced.length} observation(s) in ${Math.round((Date.now() - t0) / 1000)}s${out.reason ? ` (${out.reason})` : ""}`);
  report.sessions.push({ id: sess.id, produced: produced.map((p) => ({ claim: p.claim, kind: p.kind, source: p.source_weight })) });
}

// A final global dedupe pass (the in-distill budget is 5 pairs; drain the rest).
const dd = await dedupeSweep(haikuJudge, { maxPairs: 60 });
console.log(`[bench] dedupe sweep: ${dd.judged} judged, ${dd.merged} merged, ${dd.contradicted} contradicted`);

// ---------------------------------------------------------------------------
console.log("[bench] phase C: scoring extraction");
for (const sess of fixtures.sessions) {
  const produced = db.prepare(`SELECT id, claim, kind, source_weight FROM observations WHERE session_id = ?`).all(sess.id);
  report.extraction.producedTotal += produced.length;
  const matchedProducedIdx = new Set();

  for (const exp of sess.expected ?? []) {
    report.extraction.expectedTotal++;
    if (exp.intent) report.intent.expected++;
    let matched = false;
    for (let i = 0; i < produced.length; i++) {
      if (await sameFact(produced[i].claim, exp.gist)) {
        matched = true;
        matchedProducedIdx.add(i);
        exp._matchedObsId = produced[i].id;
        // provenance check: expected user_stated must not be degraded, and
        // (the audit's failure mode) nothing agent-side may be PROMOTED to
        // user_stated.
        if (exp.source === "user_stated" && produced[i].source_weight !== "user_stated") {
          report.forbidden.violations.push({ session: sess.id, kind: "provenance-degraded", detail: `${exp.key}: expected user_stated, got ${produced[i].source_weight}` });
        }
        break;
      }
    }
    if (matched) {
      report.extraction.matchedExpected++;
      if (exp.intent) report.intent.matched++;
    } else if (exp.intent) {
      report.intent.misses.push({ session: sess.id, key: exp.key });
    }
  }

  for (const forb of sess.forbidden ?? []) {
    for (const p of produced) {
      if (forb.literal && p.claim.includes(forb.literal)) {
        report.forbidden.violations.push({ session: sess.id, kind: "literal", detail: `${forb.key}: secret/literal leaked into claim` });
        continue;
      }
      if (!forb.literal && (await sameFact(p.claim, forb.gist))) {
        report.forbidden.violations.push({ session: sess.id, kind: "forbidden-extraction", detail: `${forb.key}: "${p.claim.slice(0, 140)}"` });
      }
    }
  }
  // matched produced = true positives; the rest count against precision only
  // if they'd also fail a human sniff — we count strictly: unmatched produced
  // that also matches no OTHER session's expectation is "unplanted".
  report.extraction.matchedProduced += matchedProducedIdx.size;
}

// Fabricated user_stated anywhere (audit failure mode): any user_stated
// observation in sessions with no user_stated expectation.
for (const sess of fixtures.sessions) {
  const wantsUser = (sess.expected ?? []).some((e) => e.source === "user_stated");
  if (wantsUser) continue;
  const rows = db.prepare(`SELECT claim FROM observations WHERE session_id = ? AND source_weight = 'user_stated'`).all(sess.id);
  for (const r of rows) {
    report.forbidden.violations.push({ session: sess.id, kind: "provenance-fabricated", detail: `user_stated without user words: "${r.claim.slice(0, 140)}"` });
  }
}

// ---------------------------------------------------------------------------
console.log("[bench] phase D: dedupe + contradiction checks");
{
  const groups = {};
  for (const sess of fixtures.sessions) {
    for (const exp of sess.expected ?? []) {
      if (exp.dedupe_group && exp._matchedObsId) {
        const row = db.prepare(`SELECT memory_id FROM observations WHERE id = ?`).get(exp._matchedObsId);
        (groups[exp.dedupe_group] ??= new Set()).add(row?.memory_id ?? `unconsolidated-${exp._matchedObsId}`);
      }
    }
  }
  for (const [g, memoryIds] of Object.entries(groups)) {
    const ids = [...memoryIds];
    const active = ids.filter((id) => {
      const m = db.prepare(`SELECT status FROM memories WHERE id = ?`).get(id);
      return m?.status === "active";
    });
    report.dedupe[g] = { distinctMemories: ids.length, activeMemories: active.length, pass: active.length <= 1 };
  }

  // Contradiction: the preseeded stale claim vs the new user statement — they
  // must not both sit active with contradiction_count 0.
  const pre = report.contradiction.preseedMemoryId
    ? db.prepare(`SELECT status, contradiction_count, claim FROM memories WHERE id = ?`).get(report.contradiction.preseedMemoryId)
    : null;
  if (pre) {
    report.contradiction.preseed = { status: pre.status, contradictions: pre.contradiction_count };
    report.contradiction.pass = !(pre.status === "active" && pre.contradiction_count === 0);
  }
}

// ---------------------------------------------------------------------------
console.log("[bench] phase E: retrieval —", queryFile.cases.reduce((n, c) => n + c.queries.length, 0), "queries");
for (const c of queryFile.cases) {
  const targetGist = c.gist ?? fixtures.sessions.flatMap((s) => s.expected ?? []).find((e) => e.key === c.target)?.gist;
  if (!targetGist) continue;
  for (const q of c.queries) {
    report.retrieval.total++;
    const res = await searchMemory({ query: q, repo: REPO, limit: 8 });
    const texts = [
      ...res.memories.map((m) => m.claim),
      ...res.corpus.map((r) => r.claim ?? r.text ?? ""),
    ].slice(0, 8);
    let hit = false;
    for (const t of texts) {
      if (await sameFact(t, targetGist)) {
        hit = true;
        break;
      }
    }
    if (hit) report.retrieval.hits++;
    report.retrieval.cases.push({ target: c.target, query: q, hit, returned: texts.length });
    if (!hit) console.log(`  MISS [${c.target}] "${q}"`);
  }
}

// ---------------------------------------------------------------------------
console.log("[bench] phase F: docs compose + checks (real LLM)");
{
  const results = await composeAllDocs({ force: true });
  const composed = results.filter((r) => r.composed);
  const viaLlm = composed.filter((r) => r.via === "llm").length;
  const chapters = listDocs();
  let citationsValid = true;
  const memberUnion = new Set();
  for (const ch of chapters) {
    const doc = getDoc(ch.scope, ch.chapter);
    const spec = CHAPTERS.find((c) => c.chapter === ch.chapter);
    const members = docMembers(ch.scope, spec);
    const v = validateCitations(doc.body_md, members);
    if (!v.ok) citationsValid = false;
    for (const id of JSON.parse(doc.member_ids)) memberUnion.add(id);
  }
  // Coverage: every matched expected fact whose memory is active+uncontested
  // must be cited in some chapter.
  let covered = 0;
  let coverable = 0;
  for (const sess of fixtures.sessions) {
    for (const exp of sess.expected ?? []) {
      if (!exp._matchedObsId) continue;
      const row = db.prepare(`SELECT memory_id FROM observations WHERE id = ?`).get(exp._matchedObsId);
      if (!row?.memory_id) continue;
      const m = db.prepare(`SELECT status, contradiction_count, kind FROM memories WHERE id = ?`).get(row.memory_id);
      if (m?.status !== "active" || m.contradiction_count > 0) continue;
      coverable++;
      if (memberUnion.has(row.memory_id)) covered++;
    }
  }
  // Fabrication sample: 5 doc sentences with citations — judge each against
  // its cited memory's claim.
  const sampled = [];
  outer: for (const ch of chapters) {
    const doc = getDoc(ch.scope, ch.chapter);
    for (const m of doc.body_md.matchAll(/\[mem:([A-Za-z0-9-]+)\]/g)) {
      // The sentence is whatever precedes the citation on its line (the
      // composer places citations at the end of the carrying sentence).
      const upto = doc.body_md.slice(0, m.index);
      const lineStart = upto.lastIndexOf("\n") + 1;
      const sentence = upto
        .slice(lineStart)
        .replace(/\[mem:[A-Za-z0-9-]+\]/g, "")
        .replace(/^[-#*\s>]+/, "")
        .trim();
      if (sentence.length < 25) continue;
      sampled.push({ sentence, memId: m[1] });
      if (sampled.length >= 5) break outer;
    }
  }
  let honest = 0;
  for (const s of sampled) {
    const mem = db.prepare(`SELECT claim FROM memories WHERE id = ?`).get(s.memId);
    if (mem && (await sameFact(s.sentence, mem.claim))) honest++;
  }
  report.docs = {
    chapters: chapters.length,
    composedViaLlm: viaLlm,
    composedFallback: composed.length - viaLlm,
    citationsValid,
    coverage: { covered, coverable },
    fabricationSample: { honest, sampled: sampled.length },
  };
}

// ---------------------------------------------------------------------------
// Report
const ex = report.extraction;
const precision = ex.producedTotal ? ex.matchedProduced / ex.producedTotal : 1;
const recall = ex.expectedTotal ? ex.matchedExpected / ex.expectedTotal : 1;
const intentRecall = report.intent.expected ? report.intent.matched / report.intent.expected : 1;
const retrievalRate = report.retrieval.total ? report.retrieval.hits / report.retrieval.total : 1;
const dedupePass = Object.values(report.dedupe).every((d) => d.pass);

const md = `# Knowledge pipeline benchmark — ${report.startedAt}

Embeddings: ${report.embed} · sessions: ${fixtures.sessions.length} · repo: ${REPO}

| metric | score | detail |
|---|---|---|
| extraction precision | ${(precision * 100).toFixed(0)}% | ${ex.matchedProduced}/${ex.producedTotal} produced observations match a planted fact |
| extraction recall | ${(recall * 100).toFixed(0)}% | ${ex.matchedExpected}/${ex.expectedTotal} planted facts extracted |
| **intent-channel recall** | **${(intentRecall * 100).toFixed(0)}%** | ${report.intent.matched}/${report.intent.expected} user-context facts (rationale, preferences, north stars, plans) — v1's systematic miss |
| forbidden extractions | ${report.forbidden.violations.length} | trivia / ruled-out hypotheses / fabricated user rules / leaked secrets |
| dedupe | ${dedupePass ? "PASS" : "FAIL"} | ${JSON.stringify(report.dedupe)} |
| contradiction handling | ${report.contradiction.pass ? "PASS" : "FAIL"} | preseed: ${JSON.stringify(report.contradiction.preseed ?? null)} |
| retrieval hit rate | ${(retrievalRate * 100).toFixed(0)}% | ${report.retrieval.hits}/${report.retrieval.total} queries hit their target in top 8 |
| docs | ${report.docs.citationsValid ? "citations valid" : "CITATIONS INVALID"} | ${report.docs.chapters} chapters, ${report.docs.composedViaLlm} LLM-composed, coverage ${report.docs.coverage.covered}/${report.docs.coverage.coverable}, fabrication sample ${report.docs.fabricationSample.honest}/${report.docs.fabricationSample.sampled} honest |

## Intent misses
${report.intent.misses.length ? report.intent.misses.map((m) => `- ${m.session}: ${m.key}`).join("\n") : "(none)"}

## Forbidden violations
${report.forbidden.violations.length ? report.forbidden.violations.map((v) => `- [${v.kind}] ${v.session}: ${v.detail}`).join("\n") : "(none)"}

## Retrieval misses
${report.retrieval.cases.filter((c) => !c.hit).map((c) => `- [${c.target}] "${c.query}"`).join("\n") || "(none)"}

## Per-session extractions
${report.sessions.map((s) => `### ${s.id}\n${s.produced.map((p) => `- (${p.kind}, ${p.source}) ${p.claim}`).join("\n") || "(none)"}`).join("\n\n")}
`;

const resultsDir = join(HERE, "results");
mkdirSync(resultsDir, { recursive: true });
const stamp = report.startedAt.replace(/[:.]/g, "-");
writeFileSync(join(resultsDir, `report-${stamp}.md`), md);
writeFileSync(join(resultsDir, `report-${stamp}.json`), JSON.stringify(report, null, 2));
console.log(md.split("\n").slice(0, 16).join("\n"));
console.log(`[bench] full report: benchmarks/knowledge/results/report-${stamp}.md`);
if (KEEP_DB) console.log(`[bench] db kept at ${process.env.DB_PATH}`);
else rmSync(workDir, { recursive: true, force: true });
