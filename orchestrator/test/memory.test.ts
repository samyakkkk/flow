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
let anchors: typeof import("../src/memory/anchors.js");
let headline: typeof import("../src/memory/headline.js");
let cards: typeof import("../src/memory/cards.js");
let findHits: typeof import("../src/memory/find-hits.js");
let corpusObserve: typeof import("../src/memory/corpus-observe.js");
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
  db.exec("DELETE FROM observations; DELETE FROM memories; DELETE FROM anchors; DELETE FROM slack_messages; DELETE FROM linear_tickets;");
  store.invalidateVectorCache();
  headline?.invalidateHeadlineCache();
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
  anchors = await import("../src/memory/anchors.js");
  headline = await import("../src/memory/headline.js");
  cards = await import("../src/memory/cards.js");
  findHits = await import("../src/memory/find-hits.js");
  corpusObserve = await import("../src/memory/corpus-observe.js");
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

  test("repo affinity ranks — cross-repo memories stay eligible, same-family first", async () => {
    // Two repos in one project learn about the same area. The project is the
    // trust boundary: NOTHING is filtered by repo; family affinity only orders.
    await seed("payment webhooks are verified with an hmac signature", "acme-backend", ["hmac", "webhook"]);
    await seed("payment webhooks retry with exponential backoff", "other-repo", ["hmac", "webhook", "retry"]);
    store.setEmbedder(stubEmbedder);
    const res = await search.searchMemory({ query: "payment webhooks hmac signature verified", repo: "acme-frontend", limit: 10 });
    const ids = res.memories.map((m) => m.id);
    const acme = db.prepare("SELECT id FROM memories WHERE repo_family = 'acme' AND claim LIKE '%hmac%'").get() as { id: string };
    const other = db.prepare("SELECT id FROM memories WHERE repo_family = 'other-repo'").get() as { id: string };
    assert.ok(ids.includes(acme.id), "same-family memory surfaces");
    assert.ok(ids.includes(other.id), "cross-repo memory must NOT be gated out — all repos in a project share memories");
    assert.ok(ids.indexOf(acme.id) < ids.indexOf(other.id), "same-family ranks above rest-of-project");
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

// ---------------------------------------------------------------------------
// remember — active capture. Same pipeline as a session tail, plus the two
// remember-specific guarantees: source_weight floors to user_stated, and the
// text survives an LLM failure verbatim (an explicit "remember" is never lost).
describe("remember (active capture)", () => {
  before(() => store.setEmbedder(stubEmbedder));

  test("LLM path: extracts, floors source_weight to user_stated, consolidates", async () => {
    llm.setLlmTransport(async () =>
      JSON.stringify([
        { claim: "Deploys go through the staging soak for 24h first", kind: "constraint", context: {}, source: "agent_inferred", retrieval_keys: ["staging", "soak", "deploy"] },
      ]),
    );
    const out = await distiller.rememberText({ text: "remember: deploys always soak in staging for 24h", repo: "acme", branch: "main", sessionId: "sess-r1", judge: async () => ({ verdict: "new" as const }) });
    assert.equal(out.ran, true);
    assert.equal(out.observations, 1);
    assert.equal(out.reason, undefined, "LLM path should not report a fallback");
    const obs = db.prepare("SELECT * FROM observations WHERE claim LIKE '%soak%'").get() as any;
    assert.ok(obs, "observation should exist");
    assert.equal(obs.source_weight, "user_stated", "the human dictated this — weight floors to user_stated");
    assert.equal(obs.repo, "acme");
  });

  test("LLM failure: the text is stored verbatim, never lost", async () => {
    llm.setLlmTransport(async () => {
      throw new Error("model unavailable");
    });
    const text = "remember: the landing .env holds the working OPENROUTER key";
    const out = await distiller.rememberText({ text, repo: "acme", branch: null, sessionId: null, judge: async () => ({ verdict: "new" as const }) });
    assert.equal(out.ran, true);
    assert.equal(out.observations, 1);
    assert.equal(out.reason, "verbatim-fallback");
    const obs = db.prepare("SELECT * FROM observations WHERE claim = ?").get(text) as any;
    assert.ok(obs, "verbatim observation should exist");
    assert.equal(obs.source_weight, "user_stated");
  });

  test("LLM returns empty array: verbatim fallback also fires", async () => {
    llm.setLlmTransport(async () => "[]");
    const text = "remember this exact sentence";
    const out = await distiller.rememberText({ text, repo: null, branch: null, sessionId: null, judge: async () => ({ verdict: "new" as const }) });
    assert.equal(out.reason, "verbatim-fallback");
    const obs = db.prepare("SELECT * FROM observations WHERE claim = ?").get(text) as any;
    assert.ok(obs);
  });
});

// ---------------------------------------------------------------------------
// Distiller triggers — the idle sweep. Regression: agent_sessions.updated_at
// is written in MILLISECONDS (runtime.ts uses Date.now()); the sweep's cutoff
// once divided by 1000, so the ms-vs-seconds comparison was always false and
// the sweep matched ZERO sessions — the distiller never fired on live
// deployments. These tests insert rows exactly as the runtime does (ms).
describe("distiller trigger: idle sweep", () => {
  let trigger: typeof import("../src/memory/trigger.js");

  before(async () => {
    trigger = await import("../src/memory/trigger.js");
    store.setEmbedder(stubEmbedder);
    // memory.test.ts never imports runtime.ts (which owns this table), so
    // create the columns the trigger touches, shaped like the real thing.
    db.exec(`CREATE TABLE IF NOT EXISTS agent_sessions (
      id TEXT PRIMARY KEY, backend TEXT, repo TEXT, cwd TEXT, title TEXT,
      status TEXT, updated_at INTEGER, created_at INTEGER, last_distilled_seq INTEGER
    )`);
    trigger.setTranscriptReader(() => [
      { seq: 1, kind: "user_prompt", data: { text: "Switch the auth flow to JWT stored in httpOnly cookies, not localStorage." } },
      { seq: 2, kind: "update", data: { sessionUpdate: "agent_message_chunk", content: { text: "Done — JWT now lives in an httpOnly cookie." } } },
    ]);
  });

  beforeEach(() => db.exec("DELETE FROM agent_sessions"));

  test("sweeps an idle session whose updated_at (ms) is older than IDLE_MS", async () => {
    llm.setLlmTransport(async () =>
      JSON.stringify([
        { claim: "Auth uses JWT in httpOnly cookies", kind: "decision", context: {}, source: "user_stated", retrieval_keys: ["jwt", "cookie"] },
      ]),
    );
    const staleMs = Date.now() - trigger.IDLE_MS - 60_000; // ms, as runtime writes
    db.prepare("INSERT INTO agent_sessions (id, backend, repo, cwd, title, status, created_at, updated_at) VALUES (?, 'claude', ?, '/tmp', 'test', ?, ?, ?)")
      .run("sweep-1", "acme", "idle", staleMs, staleMs);
    const ran = await trigger.idleSweep();
    assert.equal(ran, 1, "the stale idle session must be swept (ms cutoff regression)");
    const obs = db.prepare("SELECT * FROM observations WHERE session_id = 'sweep-1'").get() as any;
    assert.ok(obs, "distilled observation should exist");
    const meta = db.prepare("SELECT last_distilled_seq FROM agent_sessions WHERE id = 'sweep-1'").get() as any;
    assert.equal(meta.last_distilled_seq, 2, "high-water mark advances to the max transcript seq");
  });

  test("leaves recently-active sessions alone", async () => {
    db.prepare("INSERT INTO agent_sessions (id, backend, repo, cwd, title, status, created_at, updated_at) VALUES (?, 'claude', ?, '/tmp', 'test', ?, ?, ?)")
      .run("sweep-2", "acme", "idle", Date.now(), Date.now());
    const ran = await trigger.idleSweep();
    assert.equal(ran, 0);
  });
});

// ---------------------------------------------------------------------------
// Section A — anchor resolution. Deterministic file matching against a STUBBED
// NodeAnchorProvider (no graph, no gateway). Covers: file match, most-specific
// preference (endpoint over service), cap 3, idempotent re-resolve after a node
// disappears → fallback to repo-level, never lost.
describe("anchor resolution (Section A)", () => {
  before(() => store.setEmbedder(stubEmbedder));

  // A provider whose node set we control per-test. Returns nodes anchored to the
  // given files; the specificity is derived by the ranker from id/path shape
  // unless we set it explicitly.
  function stubProvider(nodes: Array<{ node_id: string; paths: string[]; specificity?: number }>) {
    anchors.setNodeAnchorProvider({
      nodesForFiles: async (_repo, _files) => nodes,
    });
  }

  async function seedMemory(claim: string, repo: string, contextFiles: string[], keys: string[] = []) {
    const o = await store.insertObservation({
      source: "session", repo, claim, kind: "decision", source_weight: "user_stated",
      context_files: contextFiles, retrieval_keys: keys, session_id: "s1",
    });
    return consolidate.consolidateObservation(o, async () => ({ verdict: "new" as const }));
  }

  test("rankAnchors: pure file match, most-specific first, cap 3", () => {
    // basename match: memory touches store.ts; nodes anchored at that path.
    const files = ["orchestrator/src/store.ts", "utils.ts"];
    const nodes = [
      { node_id: "svc:orchestrator", paths: ["orchestrator/src/store.ts"], specificity: 10 },
      { node_id: "api:orchestrator:POST /store", paths: ["orchestrator/src/store.ts"], specificity: 30 },
      { node_id: "svc:utils", paths: ["utils.ts"], specificity: 10 },
      { node_id: "svc:unrelated", paths: ["other/thing.ts"], specificity: 10 },
    ];
    const ranked = anchors.rankAnchors(files, nodes);
    assert.ok(ranked.length <= anchors.MAX_ANCHORS_PER_ITEM, "cap 3");
    assert.equal(ranked[0], "api:orchestrator:POST /store", "most specific (endpoint) ranks first");
    assert.ok(ranked.includes("svc:utils"));
    assert.ok(!ranked.includes("svc:unrelated"), "a node with no matching file is excluded");
  });

  test("cap of 3 enforced even when more than 3 nodes match", () => {
    const files = ["a.ts"];
    const nodes = Array.from({ length: 6 }, (_, i) => ({ node_id: `svc:n${i}`, paths: ["a.ts"], specificity: 6 - i }));
    const ranked = anchors.rankAnchors(files, nodes);
    assert.equal(ranked.length, 3, "never more than 3 anchors");
  });

  test("consolidation resolves a memory's anchors deterministically from context_files", async () => {
    clearMemory();
    stubProvider([
      { node_id: "svc:store", paths: ["orchestrator/src/store.ts"], specificity: 10 },
      { node_id: "api:store:GET /x", paths: ["orchestrator/src/store.ts"], specificity: 30 },
    ]);
    const res = await seedMemory("route writes through the db singleton", "acme", ["orchestrator/src/store.ts"], ["insertObservation"]);
    const nodeIds = anchors.nodeIdsForItem("memory", res.memoryId);
    assert.ok(nodeIds.includes("api:store:GET /x"), "most-specific node anchored");
    assert.ok(nodeIds.length <= 3);
  });

  test("re-resolve after a node disappears drops the edge; item falls back to repo-level, never lost", async () => {
    clearMemory();
    stubProvider([{ node_id: "svc:gone", paths: ["orchestrator/src/store.ts"] }]);
    const res = await seedMemory("some durable claim about the store", "acme", ["orchestrator/src/store.ts"]);
    assert.deepEqual(anchors.nodeIdsForItem("memory", res.memoryId), ["svc:gone"], "anchored initially");

    // Node disappears from the graph → provider no longer returns it.
    stubProvider([]);
    const after = await anchors.resolveMemoryAnchors(res.memoryId);
    assert.deepEqual(after, [], "re-resolve drops the stale edge");
    assert.deepEqual(anchors.nodeIdsForItem("memory", res.memoryId), [], "edge gone");

    // The memory itself still exists (repo-level fallback = the memory is intact).
    const mem = store.getMemory(res.memoryId);
    assert.ok(mem, "memory is never lost when its anchor disappears");
    assert.equal(mem.repo_family, "acme");
  });

  test("no file-ish context → no anchors (stays repo-level), not an error", async () => {
    clearMemory();
    stubProvider([{ node_id: "svc:x", paths: ["a.ts"] }]);
    const res = await seedMemory("a preference with no files", "acme", [], ["justwords"]);
    assert.deepEqual(anchors.nodeIdsForItem("memory", res.memoryId), []);
  });

  test("reresolveAllMemoryAnchors is idempotent (reindex-safe)", async () => {
    clearMemory();
    stubProvider([{ node_id: "svc:store", paths: ["store.ts"] }]);
    const res = await seedMemory("claim about store", "acme", ["store.ts"]);
    await anchors.reresolveAllMemoryAnchors();
    await anchors.reresolveAllMemoryAnchors();
    // idempotent: exactly one edge, not duplicated.
    assert.deepEqual(anchors.nodeIdsForItem("memory", res.memoryId), ["svc:store"]);
  });

  // Reset to a no-op provider so later suites aren't affected.
  test("teardown: restore no-op provider", () => {
    anchors.setNodeAnchorProvider({ nodesForFiles: async () => [] });
  });
});

// ---------------------------------------------------------------------------
// Section B — node headline index. Typed sections, hard char cap, +N more line,
// graceful fallback (empty when no attachments). Anchors are written directly so
// the test doesn't depend on the provider.
describe("node headline index (Section B)", () => {
  before(() => store.setEmbedder(stubEmbedder));

  async function seedAnchoredMemory(claim: string, repo: string, nodeId: string, keys: string[] = []) {
    const o = await store.insertObservation({
      source: "session", repo, claim, kind: "gotcha", source_weight: "user_stated",
      retrieval_keys: keys, session_id: "s1",
    });
    const res = await consolidate.consolidateObservation(o, async () => ({ verdict: "new" as const }));
    anchors.setAnchors("memory", res.memoryId, [nodeId], "files");
    headline.invalidateHeadlineCache(nodeId);
    return res.memoryId;
  }

  test("renders typed MEMORIES section with tier glyph, kind, and [mem:id]; never blends sections", async () => {
    clearMemory();
    await seedAnchoredMemory("payments verified with an hmac signature", "acme", "svc:payments", ["hmac"]);
    const h = headline.getNodeHeadline("svc:payments");
    assert.ok(h.hasAttachments);
    assert.match(h.rendered, /MEMORIES:/);
    assert.match(h.rendered, /\[mem:/);
    assert.match(h.rendered, /\[gotcha\]/);
    // no TICKETS/THREADS headers when there are none.
    assert.ok(!/TICKETS:/.test(h.rendered));
    assert.ok(!/THREADS:/.test(h.rendered));
  });

  test("hard char cap (~1200) enforced; overflow becomes a working +N more query", async () => {
    clearMemory();
    // Seed many memories on one node; the render must cap and emit +N more.
    for (let i = 0; i < 40; i++) {
      await seedAnchoredMemory(`durable claim number ${i} about the payments service and its many behaviors and edge cases`, "acme", "svc:payments", [`k${i}`]);
    }
    const h = headline.getNodeHeadline("svc:payments");
    assert.ok(h.rendered.length <= headline.HEADLINE_CHAR_CAP, `render ${h.rendered.length} within cap ${headline.HEADLINE_CHAR_CAP}`);
    assert.match(h.rendered, /\+\d+ more: search_knowledge node:svc:payments type:memory/, "overflow is a working node-scoped query");
  });

  test("memories are strength-ranked (strong first)", async () => {
    clearMemory();
    // A weak memory (single agent_inferred observation) and a strong one (many
    // people). Reinforce the strong one so its strength dominates.
    const weak = await store.insertObservation({ source: "session", repo: "acme", claim: "weak claim about caching layer", kind: "gotcha", source_weight: "agent_inferred", session_id: "sw" });
    const wr = await consolidate.consolidateObservation(weak, async () => ({ verdict: "new" as const }));
    anchors.setAnchors("memory", wr.memoryId, ["svc:cache"], "files");

    // Strong: three distinct people reinforce it.
    const s1 = await store.insertObservation({ source: "session", repo: "acme", claim: "strong claim about caching invalidation", kind: "gotcha", source_weight: "error_proven", session_id: "sa" });
    const sr = await consolidate.consolidateObservation(s1, async () => ({ verdict: "new" as const }));
    for (const sess of ["sb", "sc"]) {
      const o = await store.insertObservation({ source: "session", repo: "acme", claim: "strong claim about caching invalidation", kind: "gotcha", source_weight: "error_proven", session_id: sess });
      await consolidate.consolidateObservation(o, async () => ({ verdict: "same" as const }));
    }
    anchors.setAnchors("memory", sr.memoryId, ["svc:cache"], "files");
    headline.invalidateHeadlineCache("svc:cache");

    const h = headline.getNodeHeadline("svc:cache");
    const strongIdx = h.rendered.indexOf("invalidation");
    const weakIdx = h.rendered.indexOf("caching layer");
    assert.ok(strongIdx >= 0 && weakIdx >= 0);
    assert.ok(strongIdx < weakIdx, "the stronger memory ranks above the weaker one");
  });

  test("unanchored node → empty headline, hasAttachments false (graceful)", () => {
    clearMemory();
    const h = headline.getNodeHeadline("svc:nothing-here");
    assert.equal(h.hasAttachments, false);
    assert.equal(h.rendered, "");
    assert.deepEqual(h.counts, { memories: 0, tickets: 0, threads: 0 });
  });

  test("cache invalidates on consolidation so a new memory shows up", async () => {
    clearMemory();
    await seedAnchoredMemory("first claim on svc:api", "acme", "svc:api");
    const before = headline.getNodeHeadline("svc:api");
    assert.equal(before.counts.memories, 1);
    // add another, invalidate, re-read.
    await seedAnchoredMemory("second claim on svc:api", "acme", "svc:api");
    const after = headline.getNodeHeadline("svc:api");
    assert.equal(after.counts.memories, 2, "cache reflects the new anchored memory");
  });
});

// ---------------------------------------------------------------------------
// Section C — drill-down cards for each id namespace + not_found.
describe("drill-down cards (Section C)", () => {
  before(() => store.setEmbedder(stubEmbedder));

  test("mem:<id> card carries claim, strength+tier, breakdown, born, anchors, evidence [obs:id]", async () => {
    clearMemory();
    const o = await store.insertObservation({ source: "session", repo: "acme", branch: "main", claim: "auth uses jwt in httpOnly cookies", kind: "decision", source_weight: "user_stated", context_files: ["auth.ts"], retrieval_keys: ["jwt"], session_id: "s1" });
    const res = await consolidate.consolidateObservation(o, async () => ({ verdict: "new" as const }));
    anchors.setAnchors("memory", res.memoryId, ["svc:auth"], "files");

    const card = cards.getCard("mem", res.memoryId);
    assert.equal(card.status, "found");
    const c = card.card as any;
    assert.equal(c.kind, "memory");
    assert.match(c.claim, /jwt/);
    assert.ok(typeof c.strength.value === "number" && c.strength.tier);
    assert.ok("people_count" in c.breakdown && "evidence_count" in c.breakdown && "contradiction_count" in c.breakdown);
    assert.equal(c.born.repo, "acme");
    assert.equal(c.born.branch, "main");
    assert.deepEqual(c.anchors, ["svc:auth"], "anchors are node ids");
    assert.ok(Array.isArray(c.evidence) && c.evidence[0].id.startsWith("obs:"));
    assert.ok(c.context_files.includes("auth.ts"));
  });

  test("obs:<id> card carries full text, source, session, parent memory id", async () => {
    clearMemory();
    const o = await store.insertObservation({ source: "session", repo: "acme", claim: "the flaky test is a race in WorktreePruner", kind: "gotcha", source_weight: "error_proven", session_id: "sess-42" });
    const res = await consolidate.consolidateObservation(o, async () => ({ verdict: "new" as const }));
    const card = cards.getCard("obs", o.id);
    assert.equal(card.status, "found");
    const c = card.card as any;
    assert.equal(c.kind, "observation");
    assert.match(c.text, /WorktreePruner/);
    assert.equal(c.source, "session");
    assert.equal(c.session, "sess-42");
    assert.equal(c.parent_memory, `mem:${res.memoryId}`);
  });

  test("lin:<identifier> card: title/status/description(truncated)/permalink + anchored nodes", async () => {
    clearMemory();
    db.prepare("INSERT INTO linear_tickets (id, identifier, title, description, state, url, updated_at) VALUES (?,?,?,?,?,?,?)")
      .run("t1", "ACME-123", "Fix the webhook retry", "x".repeat(600), "In Progress", "https://linear.app/acme/ACME-123", 1700000000);
    // A corpus observation derived from the ticket, anchored to a node.
    const o = await store.insertObservation({ source: "linear", repo: "acme", claim: "ACME-123 webhook retry work", kind: "gotcha", source_weight: "user_stated", retrieval_keys: ["ACME-123"] });
    anchors.setAnchors("observation", o.id, ["svc:webhooks"], "files");

    const card = cards.getCard("lin", "ACME-123");
    assert.equal(card.status, "found");
    const c = card.card as any;
    assert.equal(c.identifier, "ACME-123");
    assert.equal(c.status, "In Progress");
    assert.ok(c.description.length <= 401 && c.description.endsWith("…"), "description truncated");
    assert.match(c.permalink, /ACME-123/);
    assert.ok(c.anchored_nodes.includes("svc:webhooks"));
  });

  test("slackthread:<ts> card: root text, participants, messages, permalink", async () => {
    clearMemory();
    db.prepare("INSERT INTO slack_messages (id, channel, user_id, text, ts, thread_ts, permalink) VALUES (?,?,?,?,?,?,?)")
      .run("m1", "C1", "U1", "should we switch to JWT?", "1700000000.001", null, "https://slack/1");
    db.prepare("INSERT INTO slack_messages (id, channel, user_id, text, ts, thread_ts, permalink) VALUES (?,?,?,?,?,?,?)")
      .run("m2", "C1", "U2", "yes, httpOnly cookies", "1700000001.002", "1700000000.001", "https://slack/2");
    const card = cards.getCard("slackthread", "1700000000.001");
    assert.equal(card.status, "found");
    const c = card.card as any;
    assert.equal(c.kind, "thread");
    assert.match(c.root_text, /JWT/);
    assert.ok(c.participants.includes("U1") && c.participants.includes("U2"));
    assert.equal(c.messages.length, 2);
    assert.match(c.permalink, /slack/);
  });

  test("unknown id / missing row → not_found (never throws)", () => {
    assert.equal(cards.getCard("mem", "nope").status, "not_found");
    assert.equal(cards.getCard("lin", "NOPE-999").status, "not_found");
    assert.equal(cards.getCard("bogus", "x").status, "not_found");
  });

  test("parseCardId splits namespaces (node ids with colons stay intact for lin/slackthread)", () => {
    assert.deepEqual(cards.parseCardId("mem:abc-123"), { type: "mem", id: "abc-123" });
    assert.deepEqual(cards.parseCardId("slackthread:1700000000.001"), { type: "slackthread", id: "1700000000.001" });
    assert.equal(cards.parseCardId("svc:users"), null, "graph node ids are not card namespaces");
    assert.equal(cards.parseCardId("noColon"), null);
  });
});

// ---------------------------------------------------------------------------
// Citation source refs (migration 10): observations carry source_id/source_url
// back to the original artifact; (source, source_id) dedupes re-mirrored rows.
describe("citation source refs", () => {
  before(() => store.setEmbedder(stubEmbedder));

  test("observeCorpus stores source_id + source_url; obs card cites the url", async () => {
    clearMemory();
    await corpusObserve.observeCorpus({
      source: "slack",
      text: "the deploy failed because of the missing env var",
      source_id: "ev-1",
      source_url: "https://slack/permalink/1",
    });
    const o = store.getObservationBySource("slack", "ev-1");
    assert.ok(o, "observation found by (source, source_id)");
    assert.equal(o!.source_url, "https://slack/permalink/1");
    const card = cards.getCard("obs", o!.id);
    assert.equal((card.card as any).source_url, "https://slack/permalink/1");
  });

  test("re-mirrored source refreshes its one observation instead of duplicating (linear poller shape)", async () => {
    clearMemory();
    const base = { source: "linear" as const, source_id: "lin-uuid-1", source_url: "https://linear.app/acme/ACME-9" };
    await corpusObserve.observeCorpus({ ...base, text: "ACME-9 — fix retries" });
    await corpusObserve.observeCorpus({ ...base, text: "ACME-9 — fix retries (now with repro steps)" });
    const rows = db.prepare("SELECT id, claim FROM observations WHERE source = 'linear' AND source_id = 'lin-uuid-1'").all();
    assert.equal(rows.length, 1, "one observation per source artifact");
    assert.match(rows[0].claim, /repro steps/, "claim refreshed to the latest mirror");
    // FTS mirror followed the update (observations_au trigger).
    const fts = db.prepare("SELECT id FROM observations_fts WHERE observations_fts MATCH 'repro'").all();
    assert.equal(fts.length, 1);
  });

  test("unchanged re-mirror is a no-op (no re-embed, claim identical)", async () => {
    clearMemory();
    const base = { source: "linear" as const, source_id: "lin-uuid-2", source_url: "https://linear.app/acme/ACME-10", text: "ACME-10 — same text" };
    await corpusObserve.observeCorpus(base);
    const before = db.prepare("SELECT id, embedding FROM observations WHERE source_id = 'lin-uuid-2'").get();
    await corpusObserve.observeCorpus(base);
    const after = db.prepare("SELECT id, embedding FROM observations WHERE source_id = 'lin-uuid-2'").get();
    assert.equal(after.id, before.id);
    assert.deepEqual(after.embedding, before.embedding);
  });

  test("mem card evidence lines carry the citation url when the observation has one", async () => {
    clearMemory();
    const o = await store.insertObservation({
      source: "slack",
      repo: "acme",
      claim: "we always gate deploys on the smoke suite",
      kind: "decision",
      source_weight: "user_stated",
      source_id: "ev-2",
      source_url: "https://slack/permalink/2",
    });
    const res = await consolidate.consolidateObservation(o, async () => ({ verdict: "new" as const }));
    const card = cards.getCard("mem", res.memoryId);
    const ev = (card.card as any).evidence;
    assert.equal(ev[0].url, "https://slack/permalink/2", "evidence cites the original message");
  });

  test("lin card anchored_nodes uses the exact source_id FK (no retrieval_keys needed)", async () => {
    clearMemory();
    db.prepare("INSERT INTO linear_tickets (id, identifier, title, description, state, url, updated_at) VALUES (?,?,?,?,?,?,?)")
      .run("t9", "ACME-77", "Harden pollers", null, "Todo", "https://linear.app/acme/ACME-77", 1700000000);
    // Observation carries the FK but neither the identifier in its claim nor retrieval keys.
    const o = await store.insertObservation({ source: "linear", claim: "harden the pollers against cursor loss", kind: "gotcha", source_weight: "user_stated", source_id: "t9", source_url: "https://linear.app/acme/ACME-77" });
    anchors.setAnchors("observation", o.id, ["svc:pollers"], "semantic");
    const card = cards.getCard("lin", "ACME-77");
    assert.ok((card.card as any).anchored_nodes.includes("svc:pollers"));
  });

  test("pre-migration rows (source_id NULL) still fuzzy-match via retrieval_keys", async () => {
    clearMemory();
    db.prepare("INSERT INTO linear_tickets (id, identifier, title, description, state, url, updated_at) VALUES (?,?,?,?,?,?,?)")
      .run("t10", "ACME-88", "Legacy row", null, "Todo", "https://linear.app/acme/ACME-88", 1700000000);
    const o = await store.insertObservation({ source: "linear", claim: "ACME-88 legacy observation", kind: "gotcha", source_weight: "user_stated", retrieval_keys: ["ACME-88"] });
    anchors.setAnchors("observation", o.id, ["svc:legacy"], "files");
    const card = cards.getCard("lin", "ACME-88");
    assert.ok((card.card as any).anchored_nodes.includes("svc:legacy"));
  });
});

// ---------------------------------------------------------------------------
// Section E — node-scoped search composes with type filter + keywords.
describe("node-scoped search (Section E)", () => {
  before(() => store.setEmbedder(stubEmbedder));

  async function seedAnchored(claim: string, repo: string, nodeId: string | null, keys: string[] = []) {
    const o = await store.insertObservation({ source: "session", repo, claim, kind: "decision", source_weight: "user_stated", retrieval_keys: keys, session_id: "s1" });
    const res = await consolidate.consolidateObservation(o, async () => ({ verdict: "new" as const }));
    if (nodeId) anchors.setAnchors("memory", res.memoryId, [nodeId], "files");
    return res.memoryId;
  }

  test("parseSearchTokens pulls node:/type: out; node ids with colons survive", () => {
    const p = search.parseSearchTokens("node:api:dashboard:GET /agents type:memory hmac verify");
    assert.equal(p.node, "api:dashboard:GET /agents");
    assert.equal(p.type, "memory");
    assert.equal(p.query, "hmac verify");
  });

  test("node: token filters to items anchored to that node", async () => {
    clearMemory();
    const onNode = await seedAnchored("payments verified with hmac on svc:payments", "acme", "svc:payments", ["hmac"]);
    await seedAnchored("unrelated caching claim elsewhere", "acme", "svc:cache", ["cache"]);
    const res = await search.searchMemory({ query: "node:svc:payments hmac", repo: "acme", limit: 10 });
    const ids = res.memories.map((m) => m.id);
    assert.ok(ids.includes(onNode));
    assert.equal(ids.length, 1, "only the node-anchored memory surfaces");
  });

  test("empty query under a node scope returns the node's memories (the +N more query)", async () => {
    clearMemory();
    await seedAnchored("first anchored claim", "acme", "svc:payments", ["k1"]);
    await seedAnchored("second anchored claim", "acme", "svc:payments", ["k2"]);
    const res = await search.searchMemory({ query: "node:svc:payments", repo: "acme", limit: 10 });
    assert.equal(res.memories.length, 2, "the anchored set IS the answer for a bare node scope");
  });

  test("type:memory composes with node scope; keeps only memory hits", async () => {
    clearMemory();
    await seedAnchored("anchored memory claim", "acme", "svc:payments", ["hmac"]);
    const res = await search.searchMemory({ query: "node:svc:payments type:memory hmac", repo: "acme", limit: 10 });
    assert.ok(res.memories.length >= 1);
    assert.equal(res.corpus.length, 0, "type:memory excludes corpus");
  });

  test("node scope drops memories anchored to OTHER nodes even on a keyword hit", async () => {
    clearMemory();
    await seedAnchored("hmac claim on the wrong node", "acme", "svc:other", ["hmac"]);
    const res = await search.searchMemory({ query: "node:svc:payments hmac", repo: "acme", limit: 10 });
    assert.equal(res.memories.length, 0, "keyword hit on a non-scoped node is filtered out");
  });
});

// ---------------------------------------------------------------------------
// Section D (orchestrator half) — find_entity memory hits + type quota. The
// gateway merge is tested on the gateway side; here we verify the quota and the
// typed terse line shape produced by find-hits.ts (reusing search ranking/gates).
describe("find_entity memory hits + quota (Section D)", () => {
  before(() => store.setEmbedder(stubEmbedder));

  async function seed(claim: string, repo: string, keys: string[]) {
    const o = await store.insertObservation({ source: "session", repo, claim, kind: "gotcha", source_weight: "user_stated", retrieval_keys: keys, session_id: "s1" });
    return consolidate.consolidateObservation(o, async () => ({ verdict: "new" as const }));
  }

  test("terse typed line shape: [Memory:<kind>] headline (tier) [mem:id]", async () => {
    clearMemory();
    await seed("payments verified with hmac signature", "acme", ["hmac"]);
    const hits = await findHits.memoryHitsForQuery("hmac", "acme");
    assert.ok(hits.length >= 1);
    assert.match(hits[0].line, /^\[Memory:gotcha\] .+ \((strong|medium|weak)\) \[mem:[0-9a-f-]+\]$/);
  });

  test("quota caps memory hits at 3 for an untyped query", async () => {
    clearMemory();
    for (let i = 0; i < 6; i++) await seed(`hmac related claim ${i}`, "acme", ["hmac", `k${i}`]);
    const hits = await findHits.memoryHitsForQuery("hmac", "acme");
    assert.equal(hits.length, findHits.MEMORY_HIT_QUOTA, "untyped query is capped at the quota");
  });

  test("quota LIFTS when the query carries a type filter", async () => {
    clearMemory();
    for (let i = 0; i < 6; i++) await seed(`hmac related claim ${i}`, "acme", ["hmac", `k${i}`]);
    const hits = await findHits.memoryHitsForQuery("type:memory hmac", "acme", { limit: 10 });
    assert.ok(hits.length > findHits.MEMORY_HIT_QUOTA, "a typed query lifts the quota");
  });

  test("the 0.55 silence gate still applies to hits (no keyword → no noise)", async () => {
    clearMemory();
    await seed("we chose tailwind css for styling", "acme", ["tailwind"]);
    const hits = await findHits.memoryHitsForQuery("database migration rollback", "acme");
    assert.equal(hits.length, 0, "a weak vector-only match is silenced, so no memory hit blends in");
  });
});
