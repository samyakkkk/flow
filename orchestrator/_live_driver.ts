// _live_driver.ts — LIVE end-to-end proof of the session-memory distiller.
// Placed inside orchestrator/ so imports resolve against the worktree.
//
// It (1) runs migrations (via db.ts import), (2) synthesizes a REAL agent_sessions
// row + a real JSONL transcript in SESSIONS_DIR, (3) fires the GENUINE trigger
// (onSessionClosed — the exact callback setStatus invokes when a session goes
// 'closed'), (4) waits for the non-blocking distill to complete, (5) dumps the
// write-path state, then (6) runs the three retrieval queries through the real
// searchMemory (query embedded via the real gateway /v1/embed hop).

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import db from "./src/db.js";
import { blobToVec } from "./src/embed.js";
// Importing runtime wires setTranscriptReader(readTranscript) + startIdleSweep()
// — the REAL trigger wiring. We drive onSessionClosed, the closed-trigger entry.
import { readTranscript } from "./src/agents/runtime.js";
import { onSessionClosed, maybeDistill, stopIdleSweep } from "./src/memory/trigger.js";
import { searchMemory } from "./src/memory/search.js";
import { memoryStats } from "./src/memory/routes.js";

const OUT = process.env.LIVE_OUT ?? "/tmp/memlive-out";
mkdirSync(OUT, { recursive: true });

// SESSIONS_DIR is derived by runtime.ts as dirname(DB_PATH)/agent-sessions.
const DB_PATH = process.env.DB_PATH!;
const SESSIONS_DIR = path.join(path.dirname(DB_PATH), "agent-sessions");
mkdirSync(SESSIONS_DIR, { recursive: true });

const SESSION_ID = randomUUID();
const REPO = "flow-orchestrator"; // family -> "flow"
const BRANCH = "flow/session-memory-distiller";

function log(...a: unknown[]) {
  console.log("[driver]", ...a);
}

// --- 1. Build a realistic multi-turn coding-session transcript ------------
// The durable lesson: a specific gotcha (opening a 2nd better-sqlite3 connection
// in the distiller path collides with the WAL checkpoint) + its fix (reuse the
// shared db singleton) + a verbatim error string.
const VERBATIM_ERROR = "SqliteError: database is locked";

let seq = 0;
function ev(kind: string, data: unknown) {
  return { seq: ++seq, ts: Date.now(), kind, data };
}

const events = [
  ev("created", { repo: REPO, backend: "claude", title: "distiller crashes on session close", branch: BRANCH }),
  ev("user_prompt", {
    text:
      "The memory distiller crashes intermittently when a session closes. I see 'SqliteError: database is locked' in the orchestrator logs whenever two sessions close near the same time. Figure out why and fix it.",
  }),
  ev("update", {
    sessionUpdate: "agent_message_chunk",
    content: {
      text:
        "Let me reproduce. I'll close two sessions in quick succession and watch the distiller path in orchestrator/src/memory/store.ts.",
    },
  }),
  ev("update", {
    sessionUpdate: "tool_call",
    toolCallId: "t1",
    title: "Bash: run distiller twice concurrently",
    _meta: { claudeCode: { toolName: "Bash" } },
  }),
  ev("update", {
    sessionUpdate: "tool_call_update",
    toolCallId: "t1",
    status: "failed",
    content: [
      {
        content: {
          text:
            "SqliteError: database is locked\n    at Database.prepare (better-sqlite3)\n    at insertObservation (orchestrator/src/memory/store.ts:88)",
        },
      },
    ],
  }),
  ev("update", {
    sessionUpdate: "agent_message_chunk",
    content: {
      text:
        "Found it. The distiller path was opening a SECOND better-sqlite3 connection (new Database(DB_PATH)) instead of reusing the shared singleton exported from orchestrator/src/db.ts. Under WAL mode, when the periodic checkpoint runs, a second writer connection contends and throws 'SqliteError: database is locked'. The fix is to NEVER open a second better-sqlite3 connection in the distiller/consolidate path — always import and reuse the single shared `db` from db.ts, which serializes writes on one connection. After switching to the shared singleton the concurrent-close reproduction passes cleanly.",
    },
  }),
  ev("update", {
    sessionUpdate: "agent_message_chunk",
    content: {
      text:
        "Conclusion: in this repo, all SQLite access in the memory subsystem must go through the shared db singleton in orchestrator/src/db.ts. Opening a fresh better-sqlite3 Database on the same file while WAL checkpointing is active deadlocks with 'SqliteError: database is locked'. This is a durable gotcha for anyone touching the distiller write path.",
    },
  }),
];

const jsonl = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
const transcriptPath = path.join(SESSIONS_DIR, `${SESSION_ID}.jsonl`);
writeFileSync(transcriptPath, jsonl);
log("wrote transcript", transcriptPath, `(${events.length} events, maxSeq=${seq})`);
writeFileSync(path.join(OUT, "transcript.jsonl"), jsonl);

// --- 2. Insert the matching agent_sessions row (real schema) ---------------
const now = Date.now();
db.prepare(
  `INSERT INTO agent_sessions (id, backend, repo, cwd, title, status, worktree_id, last_distilled_seq, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
).run(SESSION_ID, "claude", REPO, "/tmp/fake-cwd", "distiller crashes on session close", "closed", null, null, now, now);
log("inserted agent_sessions row", SESSION_ID, "status=closed last_distilled_seq=NULL");

// Sanity: the runtime's transcript reader (wired by importing runtime.ts) sees it.
const readBack = readTranscript(SESSION_ID);
log("readTranscript sees", readBack.length, "events; last seq =", readBack[readBack.length - 1]?.seq);

async function main() {
  // --- 3. Confirm migrations ran (tables exist) --------------------------
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name IN ('observations','memories','observations_fts')`)
    .all()
    .map((r: any) => r.name);
  log("memory tables present:", tables.join(", "));

  // --- 4. FIRE THE REAL TRIGGER ------------------------------------------
  // onSessionClosed is the exact callback setStatus() calls on status->'closed'.
  // It funnels through queueDistill -> setImmediate -> maybeDistill (the real
  // high-water-mark + transcript reader + non-blocking distillSession logic).
  // This is NOT a direct distillSession() call.
  const method = process.env.TRIGGER_METHOD ?? "onSessionClosed";
  log(`FIRING TRIGGER via ${method} (branch=${BRANCH})`);
  const fireT0 = Date.now();
  if (method === "maybeDistill") {
    // idle-sweep's unit of work, awaited so we know when it finished.
    const ran = await maybeDistill(SESSION_ID, BRANCH);
    log("maybeDistill returned ran =", ran, `(${Date.now() - fireT0}ms)`);
  } else {
    // The genuine closed-trigger. Fire-and-forget via setImmediate; we then
    // poll last_distilled_seq to know when the async distill completed.
    onSessionClosed(SESSION_ID, BRANCH);
    log("onSessionClosed dispatched (non-blocking); polling for completion…");
    const deadline = Date.now() + 180_000;
    let done = false;
    while (Date.now() < deadline) {
      const row = db.prepare(`SELECT last_distilled_seq FROM agent_sessions WHERE id = ?`).get(SESSION_ID) as {
        last_distilled_seq: number | null;
      };
      const obsCount = (db.prepare(`SELECT COUNT(*) c FROM observations WHERE session_id = ?`).get(SESSION_ID) as any).c;
      if (row.last_distilled_seq != null || obsCount > 0) {
        done = true;
        log(
          `distill completed automatically after ${Date.now() - fireT0}ms:`,
          `last_distilled_seq=${row.last_distilled_seq}, observations=${obsCount}`,
        );
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!done) {
      log("WARN: trigger did not complete within deadline");
    }
  }

  // --- 5. VERIFY WRITE PATH ----------------------------------------------
  const obsRows = db
    .prepare(`SELECT id, claim, kind, source_weight, repo, repo_family, retrieval_keys, memory_id, length(embedding) AS emblen FROM observations WHERE session_id = ?`)
    .all(SESSION_ID) as any[];
  log(`OBSERVATIONS for session: ${obsRows.length}`);
  for (const o of obsRows) {
    const dims = o.emblen != null ? o.emblen / 4 : null;
    log(`  obs ${o.id.slice(0, 8)} kind=${o.kind} src=${o.source_weight} embDims=${dims} claim="${o.claim.slice(0, 110)}"`);
  }
  const memRows = db
    .prepare(`SELECT id, claim, kind, repo_family, strength, evidence_count, status, length(embedding) AS emblen FROM memories`)
    .all() as any[];
  log(`MEMORIES: ${memRows.length}`);
  for (const m of memRows) {
    const dims = m.emblen != null ? m.emblen / 4 : null;
    log(`  mem ${m.id.slice(0, 8)} kind=${m.kind} strength=${m.strength.toFixed?.(3) ?? m.strength} ev=${m.evidence_count} embDims=${dims} claim="${m.claim.slice(0, 110)}"`);
  }
  writeFileSync(
    path.join(OUT, "write-path.json"),
    JSON.stringify({ stats: memoryStats(), observations: obsRows, memories: memRows }, null, 2),
  );

  // Confirm embedding blobs are real 768-float vectors (non-null, non-zero).
  const embCheck = db.prepare(`SELECT embedding FROM observations WHERE session_id = ? AND embedding IS NOT NULL LIMIT 1`).get(SESSION_ID) as any;
  if (embCheck?.embedding) {
    const v = blobToVec(embCheck.embedding);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    log(`embedding sanity: dims=${v.length}, L2norm=${norm.toFixed(4)}, first3=[${v[0].toFixed(4)},${v[1].toFixed(4)},${v[2].toFixed(4)}]`);
  } else {
    log("WARN: no non-null observation embedding found");
  }

  // --- 6. VERIFY EMBEDDING RETRIEVAL -------------------------------------
  // (a) semantic paraphrase sharing NO exact tokens with claim/keys/error.
  // (b) verbatim error string (FTS bypass of silence gate).
  // (c) unrelated query in the SAME repo family (silence-gate drop).
  const queries: Array<{ label: string; query: string }> = [
    {
      label: "a) SEMANTIC paraphrase (no shared tokens)",
      query: "why does the second concurrent writer deadlock when journaling checkpoints happen",
    },
    { label: "b) VERBATIM error (FTS)", query: "SqliteError: database is locked" },
    { label: "c) UNRELATED same-family (silence gate)", query: "how do I configure the Slack notification webhook signature" },
  ];

  const retrieval: any[] = [];
  for (const q of queries) {
    const t0 = Date.now();
    const res = await searchMemory({ query: q.query, repo: REPO, limit: 8 });
    const ms = Date.now() - t0;
    log(`\nQUERY ${q.label}`);
    log(`  "${q.query}"`);
    log(`  -> ${res.memories.length} memory hit(s) in ${ms}ms (search internal durationMs=${res.durationMs})`);
    for (const m of res.memories) {
      log(`     cosine=${m.cosine.toFixed(4)} score=${m.score.toFixed(4)} fts=${m.ftsHit} tier=${m.strengthTier} claim="${m.claim.slice(0, 90)}"`);
    }
    retrieval.push({
      label: q.label,
      query: q.query,
      latencyMs: ms,
      durationMs: res.durationMs,
      memories: res.memories.map((m) => ({ cosine: m.cosine, score: m.score, ftsHit: m.ftsHit, claim: m.claim, id: m.id })),
    });
  }
  writeFileSync(path.join(OUT, "retrieval.json"), JSON.stringify(retrieval, null, 2));

  // Warm latency measurement: 5 repeats of the semantic query (model already loaded).
  const lat: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    await searchMemory({ query: queries[0].query, repo: REPO, limit: 8 });
    lat.push(Date.now() - t0);
  }
  lat.sort((a, b) => a - b);
  log(`\nWARM search latency over 5 runs (ms): [${lat.join(", ")}] median=${lat[2]}`);
  writeFileSync(path.join(OUT, "latency.json"), JSON.stringify({ warmRunsMs: lat, median: lat[2] }, null, 2));

  // Dump the whole DB's observations+memories for the artifact.
  const allObs = db.prepare(`SELECT * FROM observations`).all();
  const allMem = db.prepare(`SELECT * FROM memories`).all();
  writeFileSync(
    path.join(OUT, "db-dump.json"),
    JSON.stringify(
      { observations: allObs, memories: allMem },
      (k, v) => (Buffer.isBuffer(v) ? `<blob ${v.length} bytes = ${v.length / 4} floats>` : v),
      2,
    ),
  );

  stopIdleSweep();
  log("\nDONE. Artifacts in", OUT);
  // Give any in-flight setImmediate distills nothing to do; exit clean.
  process.exit(0);
}

main().catch((e) => {
  console.error("[driver] FATAL", e);
  process.exit(1);
});
