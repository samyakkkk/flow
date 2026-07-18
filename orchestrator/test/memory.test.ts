// memory.test.ts — Flow memory v1. Fully offline: an in-memory DB, a stub
// embedder (deterministic vectors, no model), a fake judge, and an injected LLM
// transport — NO test calls a real LLM or loads the embedding model.

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Env BEFORE importing anything that touches the DB.
process.env.DB_PATH = ":memory:";
process.env.FLOW_ADMIN_TOKEN = "test-admin-token-memory";
process.env.FLOW_FAKE_OPENCODE = "1";
process.env.FLOW_DRAIN_DISABLE = "1";
process.env.FLOW_POLL_DISABLE = "1";
process.env.FLOW_DISTILLER = "1";

// ---- module handles, loaded in before() so DB_PATH is set first ----
/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let slim: typeof import("../src/memory/slim.js");
let parse: typeof import("../src/memory/parse.js");
let repoFamily: typeof import("../src/memory/repo-family.js");
let strength: typeof import("../src/memory/strength.js");
let store: typeof import("../src/memory/store.js");
let consolidate: typeof import("../src/memory/consolidate.js");
let maintenance: typeof import("../src/memory/maintenance.js");
let search: typeof import("../src/memory/search.js");
let distiller: typeof import("../src/memory/distiller.js");
let llm: typeof import("../src/memory/llm.js");
let migrations: typeof import("../src/migrations.js");
let cosine: (a: Float32Array, b: Float32Array) => number;
/* eslint-enable @typescript-eslint/no-explicit-any */

// A deterministic stub embedder: hashes tokens into a fixed-dim vector so that
// texts sharing tokens are close in cosine space, and negations still land
// close to their positive (they share almost all tokens) — exactly the eval
// hazard the banding must handle via the judge, not the cosine.
const DIM = 64;
function stubVec(text: string): Float32Array {
  const v = new Float32Array(DIM);
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const tok of tokens) {
    let h = 0;
    for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) >>> 0;
    v[h % DIM] += 1;
  }
  // normalize
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < DIM; i++) v[i] /= n;
  return v;
}
const stubEmbedder = async (t: string) => stubVec(t);

function clearMemory(): void {
  db.exec("DELETE FROM observations; DELETE FROM memories;");
  store.invalidateVectorCache();
}

before(async () => {
  db = (await import("../src/db.js")).default;
  slim = await import("../src/memory/slim.js");
  parse = await import("../src/memory/parse.js");
  repoFamily = await import("../src/memory/repo-family.js");
  strength = await import("../src/memory/strength.js");
  store = await import("../src/memory/store.js");
  consolidate = await import("../src/memory/consolidate.js");
  maintenance = await import("../src/memory/maintenance.js");
  search = await import("../src/memory/search.js");
  distiller = await import("../src/memory/distiller.js");
  llm = await import("../src/memory/llm.js");
  migrations = await import("../src/migrations.js");
  cosine = (await import("../src/embed.js")).cosine;
  store.setEmbedder(stubEmbedder);
});

beforeEach(() => clearMemory());

// ---------------------------------------------------------------------------
describe("slimming", () => {
  test("keeps user prompts, agent conclusions, and failed tools; drops chatter", () => {
    const events = [
      { kind: "created", data: { repo: "acme", backend: "claude", title: "fix bug", branch: "main" } },
      { kind: "user_prompt", data: { text: "Make the login flow use JWT not sessions" } },
      { kind: "update", data: { sessionUpdate: "agent_message_chunk", content: { text: "Looking into it. " } } },
      { kind: "update", data: { sessionUpdate: "tool_call", toolCallId: "t1", title: "run tests" } },
      { kind: "update", data: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "failed", content: [{ content: { text: "Error: ECONNREFUSED 127.0.0.1:5432" } }] } },
      { kind: "update", data: { sessionUpdate: "agent_message_chunk", content: { text: "Done — switched to JWT." } } },
    ];
    const out = slim.slimTranscript(events);
    assert.match(out, /login flow use JWT/);
    assert.match(out, /switched to JWT/);
    assert.match(out, /ECONNREFUSED/);
    assert.match(out, /TOOL FAILED: run tests/);
  });

  test("caps at ~20k keeping the END", () => {
    // Many prompt/agent turns so the assembled output (each agent run tail-capped
    // to 1400) still overflows CAP and forces beginning-truncation.
    const events: Array<{ kind: string; data: unknown }> = [];
    for (let i = 0; i < 40; i++) {
      events.push({ kind: "user_prompt", data: { text: `prompt ${i} ` + "p".repeat(600) } });
      events.push({ kind: "update", data: { sessionUpdate: "agent_message_chunk", content: { text: `turn ${i} conclusion ` + "c".repeat(600) } } });
    }
    events.push({ kind: "user_prompt", data: { text: "THE_END prompt" } });
    const out = slim.slimTranscript(events);
    assert.ok(out.length <= 20050, `length ${out.length}`);
    assert.match(out, /THE_END/);
    assert.match(out, /BEGINNING TRUNCATED/);
  });

  test("strips the MCP orientation preamble", () => {
    const preamble =
      "You have a flow-graph tool. Consult it FIRST to orient yourself before diving into files.\n\nActually fix the JSON parser in the config loader, it drops trailing commas.";
    const out = slim.stripPreamble(preamble);
    assert.match(out, /preamble stripped/);
    assert.match(out, /fix the JSON parser/);
  });
});

// ---------------------------------------------------------------------------
describe("distiller JSON parse", () => {
  test("plain array parses", () => {
    const reply = JSON.stringify([
      { claim: "We use JWT for auth", kind: "decision", context: { repo: "acme" }, source: "user_stated", retrieval_keys: ["jwt", "auth"] },
    ]);
    const obs = parse.parseObservations(reply);
    assert.equal(obs.length, 1);
    assert.equal(obs[0].kind, "decision");
  });

  test("the []-then-array wrapper bug: takes the LAST valid array", () => {
    // Model emits an empty array, reconsiders, then the real one.
    const reply =
      "[]\nWait, on reflection there is something durable:\n" +
      JSON.stringify([{ claim: "Postgres must be on 5432", kind: "constraint", context: {}, source: "error_proven", retrieval_keys: ["5432", "ECONNREFUSED"] }]);
    const obs = parse.parseObservations(reply);
    assert.equal(obs.length, 1);
    assert.match(obs[0].claim, /5432/);
  });

  test("markdown fences + leading prose tolerated", () => {
    const reply = "Here are the memories:\n```json\n" + JSON.stringify([{ claim: "c", kind: "gotcha", context: {}, source: "agent_inferred", retrieval_keys: [] }]) + "\n```";
    const obs = parse.parseObservations(reply);
    assert.equal(obs.length, 1);
  });

  test("empty array is valid (common answer)", () => {
    assert.deepEqual(parse.parseObservations("[]"), []);
  });

  test("malformed elements are dropped, valid ones kept", () => {
    const reply = JSON.stringify([
      { claim: "", kind: "decision", context: {}, source: "user_stated", retrieval_keys: [] }, // no claim
      { claim: "good one", kind: "bogus_kind", context: {}, source: "user_stated", retrieval_keys: [] }, // bad kind
      { claim: "keeper", kind: "how_to", context: {}, source: "user_stated", retrieval_keys: [] },
    ]);
    const obs = parse.parseObservations(reply);
    assert.equal(obs.length, 1);
    assert.equal(obs[0].claim, "keeper");
  });
});

// ---------------------------------------------------------------------------
describe("repo family", () => {
  test("strips component suffixes and owner prefix", () => {
    assert.equal(repoFamily.repoFamily("acme-backend"), "acme");
    assert.equal(repoFamily.repoFamily("acme-frontend"), "acme");
    assert.equal(repoFamily.repoFamily("org/acme-api.git"), "acme");
    assert.equal(repoFamily.repoFamily("acme"), "acme");
    assert.equal(repoFamily.repoFamily(null), null);
  });

  test("family gate: null matches all; mismatch drops", () => {
    assert.equal(repoFamily.familyMatches("acme", "acme"), true);
    assert.equal(repoFamily.familyMatches("acme", "other"), false);
    assert.equal(repoFamily.familyMatches(null, "acme"), true);
    assert.equal(repoFamily.familyMatches("acme", null), true);
  });
});

// ---------------------------------------------------------------------------
describe("strength formula properties", () => {
  const base = { people_count: 1, evidence_count: 1, max_source_weight: "agent_inferred", contradiction_count: 0, last_reinforced_at: 1_000_000, now: 1_000_000 };

  test("reinforcement (more evidence) raises strength", () => {
    const a = strength.computeStrength(base);
    const b = strength.computeStrength({ ...base, evidence_count: 4 });
    assert.ok(b > a, `${b} > ${a}`);
  });

  test("contradiction lowers strength", () => {
    const a = strength.computeStrength({ ...base, evidence_count: 3 });
    const b = strength.computeStrength({ ...base, evidence_count: 3, contradiction_count: 2 });
    assert.ok(b < a, `${b} < ${a}`);
  });

  test("recency decay sinks an old memory below floor", () => {
    const fresh = strength.computeStrength({ ...base, people_count: 2, evidence_count: 2 });
    const old = strength.computeStrength({ ...base, people_count: 2, evidence_count: 2, now: 1_000_000 + 400 * 24 * 3600 });
    assert.ok(old < fresh);
    assert.ok(old < strength.STRENGTH_FLOOR, `decayed ${old} should be under floor ${strength.STRENGTH_FLOOR}`);
  });

  test("people_count dominates evidence_count", () => {
    // 3 distinct people, once each vs 1 person, 3 observations.
    const threePeople = strength.computeStrength({ ...base, people_count: 3, evidence_count: 3 });
    const onePersonThrice = strength.computeStrength({ ...base, people_count: 1, evidence_count: 3 });
    assert.ok(threePeople > onePersonThrice, `${threePeople} > ${onePersonThrice}`);
  });

  test("error_proven outranks agent_inferred provenance", () => {
    const inferred = strength.computeStrength(base);
    const proven = strength.computeStrength({ ...base, max_source_weight: "error_proven" });
    assert.ok(proven > inferred);
  });
});

// ---------------------------------------------------------------------------
describe("consolidation banding", () => {
  before(() => store.setEmbedder(stubEmbedder));

  async function obs(claim: string, repo = "acme", keys: string[] = []) {
    return store.insertObservation({ source: "session", repo, claim, kind: "decision", source_weight: "user_stated", retrieval_keys: keys, session_id: "s1" });
  }

  test("below T_LO → new memory, judge never consulted", async () => {
    let judgeCalls = 0;
    const judge = async () => { judgeCalls++; return { verdict: "same" as const }; };
    const o1 = await obs("we deploy with kubernetes helm charts");
    const o2 = await obs("the color theme uses a warm orange palette"); // unrelated tokens → low cosine
    await consolidate.consolidateObservation(o1, judge);
    const r2 = await consolidate.consolidateObservation(o2, judge);
    assert.equal(r2.action, "new");
    assert.equal(judgeCalls, 0, "judge must not run below T_LO");
    const count = (db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n;
    assert.equal(count, 2);
  });

  test("negation is CONTRADICTS, never auto-merged (embeds similarly)", async () => {
    // "we use redis for caching" vs "we do not use redis for caching" share
    // almost all tokens → high cosine. A naive band would merge them; the judge
    // must be reached and its 'contradicts' honored.
    const judge = async (_a: any, b: any) => ({ verdict: /\bnot\b/.test(b.claim) ? ("contradicts" as const) : ("same" as const) });
    const o1 = await obs("we use redis for caching sessions");
    const r1 = await consolidate.consolidateObservation(o1, judge);
    const o2 = await obs("we do not use redis for caching sessions");
    // sanity: they must actually be in the same band (>= T_LO) for this to test anything
    const sim = cosine(stubVec(o1.claim), stubVec(o2.claim));
    assert.ok(sim >= consolidate.T_LO, `negation cosine ${sim} must be >= T_LO ${consolidate.T_LO} to exercise the judge`);
    const r2 = await consolidate.consolidateObservation(o2, judge);
    assert.equal(r2.action, "contradicts");
    assert.equal(r2.memoryId, r1.memoryId, "attached as counter-evidence to the same memory, not a new one");
    const mem = store.getMemory(r1.memoryId);
    assert.equal(mem.contradiction_count, 1);
  });

  test("same → reinforces (evidence++, people recompute)", async () => {
    const judge = async () => ({ verdict: "same" as const });
    const o1 = await store.insertObservation({ source: "session", repo: "acme", claim: "ci runs on github actions", kind: "decision", source_weight: "user_stated", session_id: "s1" });
    const r1 = await consolidate.consolidateObservation(o1, judge);
    const o2 = await store.insertObservation({ source: "session", repo: "acme", claim: "ci runs on github actions workflows", kind: "decision", source_weight: "user_stated", session_id: "s2" });
    const r2 = await consolidate.consolidateObservation(o2, judge);
    assert.equal(r2.action, "same");
    assert.equal(r2.memoryId, r1.memoryId);
    const mem = store.getMemory(r1.memoryId);
    assert.equal(mem.evidence_count, 2);
    assert.equal(mem.people_count, 2, "two distinct sessions → 2 people");
  });

  test("refines → replaces canonical claim", async () => {
    const judge = async () => ({ verdict: "refines" as const, refinedClaim: "CI runs on GitHub Actions, self-hosted runners" });
    const o1 = await obs("ci runs on github actions");
    const r1 = await consolidate.consolidateObservation(o1, judge);
    const o2 = await obs("ci runs on github actions self hosted");
    await consolidate.consolidateObservation(o2, judge);
    const mem = store.getMemory(r1.memoryId);
    assert.match(mem.claim, /self-hosted runners/);
  });
});

// ---------------------------------------------------------------------------
describe("maintenance sweep", () => {
  test("recomputes decay and sinks memories under the floor", async () => {
    store.setEmbedder(stubEmbedder);
    const o = await store.insertObservation({ source: "session", repo: "acme", claim: "ephemeral fact about something", kind: "gotcha", source_weight: "agent_inferred", session_id: "s1" });
    const judge = async () => ({ verdict: "new" as const });
    const r = await consolidate.consolidateObservation(o, judge);
    // Backdate last_reinforced_at far into the past so decay sinks it.
    db.prepare("UPDATE memories SET last_reinforced_at = ? WHERE id = ?").run(1000, r.memoryId);
    const res = maintenance.sweepMemories();
    assert.ok(res.sunk >= 1);
    const mem = store.getMemory(r.memoryId);
    assert.equal(mem.status, "sunk");
  });
});

// ---------------------------------------------------------------------------
describe("search ranking", () => {
  before(() => store.setEmbedder(stubEmbedder));

  async function seed(claim: string, repo: string | null, keys: string[] = []) {
    const o = await store.insertObservation({ source: "session", repo, claim, kind: "decision", source_weight: "user_stated", retrieval_keys: keys, session_id: "s1" });
    const judge = async () => ({ verdict: "new" as const });
    return consolidate.consolidateObservation(o, judge);
  }

  test("family hard gate drops cross-family memories", async () => {
    await seed("payment webhooks are verified with an hmac signature", "acme-backend", ["hmac", "webhook"]);
    await seed("payment webhooks are verified with an hmac signature", "other-repo", ["hmac", "webhook"]);
    store.setEmbedder(stubEmbedder);
    const res = await search.searchMemory({ query: "payment webhooks hmac signature verified", repo: "acme-frontend", limit: 10 });
    // acme-frontend shares family "acme" with acme-backend, NOT with other-repo.
    assert.ok(res.memories.length >= 1);
    assert.ok(res.memories.every((m) => m.claim.includes("hmac")));
    // Ensure the other-repo memory is absent: only acme-family survives the gate.
    const ids = new Set(res.memories.map((m) => m.id));
    const otherFamily = db.prepare("SELECT id FROM memories WHERE repo_family = 'other'").all() as Array<{ id: string }>;
    for (const m of otherFamily) assert.ok(!ids.has(m.id), "other-family memory must be gated out");
  });

  test("silence gate drops weak vector-only hits", async () => {
    await seed("we chose tailwind css for styling the dashboard", "acme", ["tailwind", "css"]);
    // Query with no token overlap → cosine ~0 → below floor, no FTS hit → dropped.
    const res = await search.searchMemory({ query: "database migration rollback strategy", repo: "acme", limit: 10 });
    assert.equal(res.memories.length, 0, "weak vector-only hit must be silenced");
  });

  test("FTS exact-match bypasses the silence gate", async () => {
    // Seed a memory whose retrieval keys carry a rare identifier. A query for
    // that identifier is an FTS exact hit even if the dense cosine is weak.
    await seed("the flaky test is caused by a race in the WorktreePruner", "acme", ["WorktreePruner", "race"]);
    const res = await search.searchMemory({ query: "WorktreePruner", repo: "acme", limit: 10 });
    assert.ok(res.memories.length >= 1, "FTS exact hit must survive even under the cosine floor");
    assert.ok(res.memories[0].ftsHit);
  });
});

// ---------------------------------------------------------------------------
// Grep-style keyword matching: filler words are stripped so a natural-language
// query can't false-match a memory on a shared stopword. This is the fix for
// the live-proof failure where "…images ON a landing page" surfaced an
// unrelated sqlite memory because both contained "on" and FTS hits bypass the
// silence gate. Multi-memory store so ranking/discrimination is exercised too.
describe("keyword matching + multi-memory retrieval", () => {
  before(() => store.setEmbedder(stubEmbedder));

  async function seed(claim: string, repo: string, keys: string[] = []) {
    const o = await store.insertObservation({ source: "session", repo, claim, kind: "gotcha", source_weight: "user_stated", retrieval_keys: keys, session_id: "s1" });
    return consolidate.consolidateObservation(o, async () => ({ verdict: "new" as const }));
  }

  test("meaningfulTokens strips filler, keeps identifiers/paths/errors", () => {
    const t = search.meaningfulTokens("rotating avatar images for user profile cards on a marketing landing page");
    for (const filler of ["for", "on", "a"]) assert.ok(!t.includes(filler), `"${filler}" must be stripped`);
    assert.ok(t.includes("avatar") && t.includes("landing"));
    // identifiers/paths/error snippets survive at any length
    const c = search.meaningfulTokens("SqliteError: database is locked in store.ts insertObservation");
    assert.ok(!c.includes("is"), '"is" must be stripped');
    assert.ok(c.includes("database") && c.includes("locked"));
    assert.ok(c.some((x) => x.includes("store.ts")) && c.includes("insertobservation"));
    // an all-filler query yields nothing → no keyword bypass of silence
    assert.deepEqual(search.meaningfulTokens("how is it that we do this with the"), []);
  });

  test("stopword-only overlap does NOT surface a memory (the live bug)", async () => {
    clearMemory();
    // The memory shares ONLY filler words with the query below ("on", "with").
    await seed("the ci pipeline runs on github-actions with layer caching", "acme", ["ci", "github-actions", "caching"]);
    const res = await search.searchMemory({ query: "avatar images on profile cards with rounded corners", repo: "acme", limit: 10 });
    assert.equal(res.memories.length, 0, "shared stopwords must not surface an unrelated memory");
    // positive control: a real content token from that memory DOES surface it
    const hit = await search.searchMemory({ query: "github-actions caching", repo: "acme", limit: 10 });
    assert.ok(hit.memories.length >= 1 && hit.memories[0].ftsHit, "real keyword must still hit");
  });

  test("grep-style identifier query pinpoints the right memory among many", async () => {
    clearMemory();
    await seed("route all sqlite writes through the shared db singleton in db.ts", "acme", ["insertObservation", "db.ts", "sqlite"]);
    await seed("dashboard uses tailwind for styling", "acme", ["tailwind", "css"]);
    await seed("payments verified with an hmac signature", "acme", ["hmac", "webhook"]);
    await seed("retries use exponential backoff with jitter", "acme", ["retry", "backoff"]);
    const res = await search.searchMemory({ query: "insertObservation", repo: "acme", limit: 10 });
    assert.ok(res.memories.length >= 1);
    assert.ok(res.memories[0].claim.includes("db singleton"), "the identifier must rank the sqlite memory first");
  });

  test("both polarities of a topic surface — retrieval doesn't need to resolve negation", async () => {
    clearMemory();
    // Two memories, opposite advice, same topic. Retrieval should surface BOTH
    // (the agent reads the claim text to see always vs never); the consolidator,
    // not search, is where contradiction is adjudicated.
    await seed("always run bare `flow up` to refresh every project at once", "acme", ["flow-up", "restart"]);
    await seed("never run bare `flow up` — restart one project and verify health", "acme", ["flow-up", "restart"]);
    const res = await search.searchMemory({ query: "flow-up restart", repo: "acme", limit: 10 });
    assert.equal(res.memories.length, 2, "both the always- and never- memories must surface");
    assert.ok(res.memories.some((m) => m.claim.includes("always")) && res.memories.some((m) => m.claim.includes("never")));
  });
});

// ---------------------------------------------------------------------------
// Batched memory search: one call, several queries. Reuses the single-query
// core per query (no forked ranking), groups results, preserves request order.
describe("batched memory search", () => {
  before(() => store.setEmbedder(stubEmbedder));

  async function seed(claim: string, repo: string, keys: string[] = []) {
    const o = await store.insertObservation({ source: "session", repo, claim, kind: "gotcha", source_weight: "user_stated", retrieval_keys: keys, session_id: "s1" });
    return consolidate.consolidateObservation(o, async () => ({ verdict: "new" as const }));
  }

  test("groups per query and preserves request order", async () => {
    clearMemory();
    await seed("route all sqlite writes through the shared db singleton", "acme", ["insertObservation", "db.ts", "sqlite"]);
    await seed("payments verified with an hmac signature", "acme", ["hmac", "webhook"]);
    const res = await search.searchMemoryBatch({ queries: ["insertObservation", "hmac"], repo: "acme", limit: 10 });
    assert.equal(res.groups.length, 2);
    // order preserved: q0 is the sqlite query, q1 the hmac query
    assert.equal(res.groups[0].query, "insertObservation");
    assert.equal(res.groups[1].query, "hmac");
    assert.ok(res.groups[0].result.memories.some((m) => m.claim.includes("db singleton")));
    assert.ok(res.groups[1].result.memories.some((m) => m.claim.includes("hmac")));
  });

  test("single-query result equals that query's group in a batch (no forked logic)", async () => {
    clearMemory();
    await seed("retries use exponential backoff with jitter", "acme", ["retry", "backoff"]);
    const single = await search.searchMemory({ query: "backoff", repo: "acme", limit: 10 });
    const batch = await search.searchMemoryBatch({ queries: ["backoff"], repo: "acme", limit: 10 });
    assert.deepEqual(
      batch.groups[0].result.memories.map((m) => m.id),
      single.memories.map((m) => m.id),
    );
  });

  test("a query with no hits still gets an (empty) group in order", async () => {
    clearMemory();
    await seed("dashboard uses tailwind for styling", "acme", ["tailwind", "css"]);
    const res = await search.searchMemoryBatch({ queries: ["tailwind", "zzznonexistentzzz"], repo: "acme", limit: 10 });
    assert.equal(res.groups.length, 2);
    assert.ok(res.groups[0].result.memories.length >= 1);
    assert.equal(res.groups[1].result.memories.length, 0, "empty group is kept, not dropped");
  });

  test("batch render labels each query section in order", async () => {
    clearMemory();
    await seed("ci runs on github-actions with caching", "acme", ["github-actions", "ci"]);
    const res = await search.searchMemoryBatch({ queries: ["github-actions", "nomatchtoken"], repo: "acme", limit: 10 });
    const text = search.renderBatchSearchResult(res);
    assert.match(text, /=== q1: github-actions ===/);
    assert.match(text, /=== q2: nomatchtoken ===/);
    assert.ok(text.indexOf("q1:") < text.indexOf("q2:"), "sections in request order");
  });
});

// ---------------------------------------------------------------------------
// HTTP surface for batched search: cap enforcement, single-value backward
// compat, and blank/empty handling live at the route, so exercise them there.
describe("memory search route: batch shape", () => {
  let app: any;
  let routes: typeof import("../src/memory/routes.js");
  let fastify: any;

  before(async () => {
    store.setEmbedder(stubEmbedder);
    fastify = (await import("fastify")).default;
    routes = await import("../src/memory/routes.js");
    app = fastify();
    routes.registerMemoryRoutes(app);
    await app.ready();
  });

  async function seed(claim: string, repo: string, keys: string[] = []) {
    const o = await store.insertObservation({ source: "session", repo, claim, kind: "gotcha", source_weight: "user_stated", retrieval_keys: keys, session_id: "s1" });
    return consolidate.consolidateObservation(o, async () => ({ verdict: "new" as const }));
  }

  test("single {query} form still works (backward compatible)", async () => {
    clearMemory();
    store.setEmbedder(stubEmbedder);
    await seed("payments verified with an hmac signature", "acme", ["hmac"]);
    const res = await app.inject({ method: "POST", url: "/v1/memory/search", payload: { query: "hmac", repo: "acme" } });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok("memories" in body, "single form returns flat memories");
    assert.ok(!("groups" in body), "single form has no groups");
    assert.ok(typeof body.lines === "string");
  });

  test("{queries:[…]} form returns grouped results in order", async () => {
    clearMemory();
    store.setEmbedder(stubEmbedder);
    await seed("route sqlite writes through the db singleton", "acme", ["insertObservation", "sqlite"]);
    await seed("payments verified with an hmac signature", "acme", ["hmac"]);
    const res = await app.inject({ method: "POST", url: "/v1/memory/search", payload: { queries: ["insertObservation", "hmac"], repo: "acme" } });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.groups.length, 2);
    assert.equal(body.groups[0].query, "insertObservation");
    assert.equal(body.groups[1].query, "hmac");
    assert.match(body.lines, /=== q1: insertObservation ===/);
  });

  test("over the cap (11 queries) is a clear 400, not truncation", async () => {
    const queries = Array.from({ length: search.SEARCH_MEMORY_MAX_BATCH + 1 }, (_, i) => `q${i}`);
    const res = await app.inject({ method: "POST", url: "/v1/memory/search", payload: { queries, repo: "acme" } });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /too many queries/);
  });

  test("blank query strings are dropped; all-blank is 400", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/memory/search", payload: { queries: ["", "   "], repo: "acme" } });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /empty/);
  });
});

// ---------------------------------------------------------------------------
describe("migration idempotency", () => {
  test("running migrate twice on an existing pre-v8 DB is a no-op", async () => {
    const Database = (await import("better-sqlite3")).default;
    const mem = new Database(":memory:");
    mem.exec("CREATE TABLE poll_cursors(source TEXT); CREATE TABLE events(id TEXT); CREATE TABLE jobs(id TEXT);");
    mem.exec("CREATE TABLE agent_sessions(id TEXT PRIMARY KEY, backend TEXT, repo TEXT, cwd TEXT, title TEXT, status TEXT, created_at INTEGER, updated_at INTEGER);");
    mem.pragma("user_version = 7");
    migrations.migrate(mem, { fresh: false });
    assert.equal(mem.pragma("user_version", { simple: true }), migrations.LATEST_VERSION);
    const cols = (mem.prepare("PRAGMA table_info(agent_sessions)").all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(cols.includes("last_distilled_seq"));
    // second run must not throw and must not bump the version
    migrations.migrate(mem, { fresh: false });
    assert.equal(mem.pragma("user_version", { simple: true }), migrations.LATEST_VERSION);
    // observations + memories + anchors (migration 9) present
    const tables = (mem.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((t) => t.name);
    assert.ok(tables.includes("observations"));
    assert.ok(tables.includes("memories"));
    assert.ok(tables.includes("anchors"), "migration 9 creates the anchors table");
    mem.close();
  });
});

// ---------------------------------------------------------------------------
describe("distiller end-to-end (injected LLM + judge)", () => {
  before(() => store.setEmbedder(stubEmbedder));

  test("slim → parse → insert → consolidate, with a fake transport", async () => {
    llm.setLlmTransport(async () =>
      JSON.stringify([
        { claim: "Auth uses JWT stored in httpOnly cookies", kind: "decision", context: { repo: "acme" }, source: "user_stated", retrieval_keys: ["jwt", "cookie", "auth"] },
      ]),
    );
    const events = [
      { kind: "created", data: { repo: "acme", backend: "claude", title: "auth", branch: "main" } },
      { kind: "user_prompt", data: { text: "Switch auth to JWT in httpOnly cookies, not localStorage." } },
      { kind: "update", data: { sessionUpdate: "agent_message_chunk", content: { text: "Done. JWT now lives in an httpOnly cookie." } } },
    ];
    const out = await distiller.distillSession({ sessionId: "sess-1", repo: "acme", branch: "main", events, judge: async () => ({ verdict: "new" as const }) });
    assert.equal(out.ran, true);
    assert.equal(out.observations, 1);
    const mem = db.prepare("SELECT * FROM memories WHERE claim LIKE '%JWT%'").get() as any;
    assert.ok(mem, "a memory should have been created");
    assert.equal(mem.repo_family, "acme");
  });

  test("FLOW_DISTILLER=0 disables the write path", async () => {
    const prev = process.env.FLOW_DISTILLER;
    process.env.FLOW_DISTILLER = "0";
    try {
      const out = await distiller.distillSession({ sessionId: "sess-2", repo: "acme", branch: "main", events: [{ kind: "user_prompt", data: { text: "hi" } }], judge: async () => ({ verdict: "new" as const }) });
      assert.equal(out.ran, false);
      assert.equal(out.reason, "disabled");
    } finally {
      process.env.FLOW_DISTILLER = prev;
    }
  });
});
