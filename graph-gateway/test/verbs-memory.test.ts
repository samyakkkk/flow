// verbs-memory.test.ts — the gateway's memory-aware read verbs, exercised
// WITHOUT a live FalkorDB or a live orchestrator. `./graph.js`, `./journal.js`,
// `./embed.js`, and `./memory-client.js` are module-mocked, so the test isolates
// the gateway-side orchestration:
//   - get_entity appends the node HEADLINE INDEX (Section B); graceful when the
//     memory source is unreachable ("attachments unavailable").
//   - get_entity resolves mem:/obs:/lin:/slackthread: id NAMESPACES to drill-down
//     cards (Section C), single AND in a mixed batch incl. not_found.
//   - find_entity blends `memory_hits` (Section D) with the type quota already
//     applied by the (mocked) orchestrator; single + batch.
//
// Run with: node --experimental-test-module-mocks --import tsx/esm --test test/verbs-memory.test.ts
// (wired into `npm test` in package.json).

import { test, describe, before, mock } from "node:test";
import assert from "node:assert/strict";

/* eslint-disable @typescript-eslint/no-explicit-any */
let callVerb: (name: string, input: unknown) => Promise<any>;

const NODES = new Map<string, { type: string; name: string }>([
  ["svc:payments", { type: "Service", name: "Payments service" }],
  ["svc:cache", { type: "Service", name: "Cache service" }],
]);

function mockRun(_graph: string, cypher: string, params: Record<string, any> = {}): any[] {
  const id = params.id ?? params.q;
  if (/MATCH \(n \{id: \$id\}\) RETURN labels\(n\)\[0\] AS type, properties\(n\)/.test(cypher)) {
    const n = NODES.get(String(id));
    return n ? [{ type: n.type, props: { id, name: n.name } }] : [];
  }
  if (/-\[r\]->\(m\)/.test(cypher) || /<-\[r\]-\(m\)/.test(cypher)) return [];
  if (/MATCH \(n \{id: \$q\}\)/.test(cypher)) {
    const n = NODES.get(String(id));
    return n ? [{ type: n.type, id, name: n.name, description: null, anchor: null }] : [];
  }
  if (/n\.embedding IS NOT NULL/.test(cypher)) return [];
  if (/CONTAINS/.test(cypher)) return []; // keep graph matches empty; memory is the focus
  return [];
}

// ---- memory-client mock: controllable per-test via these mutable knobs ----
const MEM = {
  headline: null as any, // fetchHeadline return
  cards: new Map<string, any>(), // "type:id" -> CardResult
  hits: new Map<string, string[]>(), // query -> hit lines
};

before(async () => {
  mock.module("../src/graph.js", {
    namedExports: {
      DEFAULT_GRAPH: "memory",
      run: async (g: string, c: string, p: Record<string, any> = {}) => mockRun(g, c, p),
      raw: async () => ({}),
      deletedGraphError: async () => null,
      close: async () => {},
    },
  });
  mock.module("../src/journal.js", { namedExports: { record: async () => {}, tail: async () => [] } });
  mock.module("../src/embed.js", {
    namedExports: {
      EMBED_DIM: 768,
      embeddingsEnabled: () => false,
      entityText: () => "",
      embedText: async () => null,
      embedQuery: async () => ({ vec: null, error: "disabled in test" }),
      embedBatch: async () => [],
    },
  });
  mock.module("../src/memory-client.js", {
    namedExports: {
      fetchHeadline: async (_nodeId: string) => MEM.headline,
      fetchCard: async (type: string, id: string) =>
        MEM.cards.get(`${type}:${id}`) ?? { status: "not_found", type, id },
      fetchMemoryHits: async (queries: string[]) =>
        queries.map((q) => ({
          query: q,
          hits: (MEM.hits.get(q) ?? []).map((line) => ({
            type: "memory", kind: "gotcha", headline: line, tier: "strong", id: "mem:x", line,
          })),
        })),
      // real impl re-used (pure string parse) — keep it identical here.
      parseCardId: (raw: string) => {
        const CARD = new Set(["mem", "obs", "lin", "slackthread"]);
        const i = raw.indexOf(":");
        if (i <= 0) return null;
        const t = raw.slice(0, i);
        if (!CARD.has(t)) return null;
        const rest = raw.slice(i + 1);
        return rest ? { type: t, id: rest } : null;
      },
    },
  });
  ({ callVerb } = await import("../src/verbs.js"));
});

function resetMem() {
  MEM.headline = null;
  MEM.cards.clear();
  MEM.hits.clear();
}

// ---------------------------------------------------------------------------
describe("get_entity — headline index (Section B)", () => {
  test("appends the headline index when the node has attachments", async () => {
    resetMem();
    MEM.headline = {
      node_id: "svc:payments",
      rendered: "MEMORIES:\n  ● hmac verify [gotcha] [mem:abc]",
      hasAttachments: true,
      counts: { memories: 1, tickets: 0, threads: 0 },
    };
    const res = await callVerb("get_entity", { id: "svc:payments" });
    assert.equal(res.status, "found");
    assert.match(res.attachments, /MEMORIES:/);
    assert.match(res.attachments, /\[mem:abc\]/);
    assert.deepEqual(res.attachment_counts, { memories: 1, tickets: 0, threads: 0 });
  });

  test("a node with no attachments returns cleanly (no attachments field)", async () => {
    resetMem();
    MEM.headline = { node_id: "svc:payments", rendered: "", hasAttachments: false, counts: { memories: 0, tickets: 0, threads: 0 } };
    const res = await callVerb("get_entity", { id: "svc:payments" });
    assert.equal(res.status, "found");
    assert.ok(!("attachments" in res), "no attachments field when nothing anchors");
  });

  test("GRACEFUL: unreachable memory source → node WITHOUT attachments, noted", async () => {
    resetMem();
    MEM.headline = null; // fetchHeadline returns null on failure
    const res = await callVerb("get_entity", { id: "svc:payments" });
    assert.equal(res.status, "found");
    assert.ok(res.node, "the node itself is still returned");
    assert.equal(res.attachments, "unavailable");
  });
});

// ---------------------------------------------------------------------------
describe("get_entity — drill-down card namespaces (Section C)", () => {
  test("mem:<id> resolves to a memory card, not a graph lookup", async () => {
    resetMem();
    MEM.cards.set("mem:abc-1", { status: "found", type: "mem", id: "abc-1", card: { kind: "memory", claim: "auth uses jwt" } });
    const res = await callVerb("get_entity", { id: "mem:abc-1" });
    assert.equal(res.status, "found");
    assert.equal(res.card_type, "mem");
    assert.equal((res.card as any).claim, "auth uses jwt");
    assert.ok(!("node" in res), "a card is not a graph node");
  });

  test("lin:<identifier> and slackthread:<ts> resolve to cards", async () => {
    resetMem();
    MEM.cards.set("lin:ACME-9", { status: "found", type: "lin", id: "ACME-9", card: { kind: "ticket", identifier: "ACME-9" } });
    MEM.cards.set("slackthread:1700000000.001", { status: "found", type: "slackthread", id: "1700000000.001", card: { kind: "thread" } });
    const lin = await callVerb("get_entity", { id: "lin:ACME-9" });
    assert.equal((lin.card as any).identifier, "ACME-9");
    const th = await callVerb("get_entity", { id: "slackthread:1700000000.001" });
    assert.equal((th.card as any).kind, "thread");
  });

  test("a missing card id → not_found (never a graph lookup fallthrough)", async () => {
    resetMem();
    const res = await callVerb("get_entity", { id: "mem:does-not-exist" });
    assert.equal(res.status, "not_found");
  });

  test("BATCH ids[] mixing node ids, card ids, and a not_found — request order kept", async () => {
    resetMem();
    MEM.headline = { node_id: "svc:cache", rendered: "MEMORIES:\n  ● x [gotcha] [mem:z]", hasAttachments: true, counts: { memories: 1, tickets: 0, threads: 0 } };
    MEM.cards.set("mem:m1", { status: "found", type: "mem", id: "m1", card: { kind: "memory", claim: "c1" } });
    const res = await callVerb("get_entity", { ids: ["svc:cache", "mem:m1", "mem:missing", "obs:o404"] });
    assert.equal(res.status, "batch");
    assert.equal(res.results.length, 4);
    // order preserved
    assert.equal(res.results[0].node && res.results[0].status, "found"); // graph node + headline
    assert.match(res.results[0].attachments, /MEMORIES:/);
    assert.equal(res.results[1].card_type, "mem"); // card
    assert.equal(res.results[2].status, "not_found"); // missing card
    assert.equal(res.results[3].status, "not_found");
    assert.deepEqual(res.not_found.sort(), ["mem:missing", "obs:o404"]);
    assert.equal(res.found, 2);
  });
});

// ---------------------------------------------------------------------------
describe("find_entity — unified memory hits (Section D)", () => {
  test("single: blends memory_hits alongside graph matches", async () => {
    resetMem();
    MEM.hits.set("hmac verify", ["[Memory:gotcha] payments verified with hmac (strong) [mem:a]"]);
    const res = await callVerb("find_entity", { q: "hmac verify" });
    assert.ok(Array.isArray(res.memory_hits));
    assert.equal(res.memory_hits.length, 1);
    assert.match(res.memory_hits[0], /\[Memory:gotcha\].*\[mem:a\]/);
  });

  test("single: no memory hits → no memory_hits field (byte-compatible)", async () => {
    resetMem();
    const res = await callVerb("find_entity", { q: "svc:payments" });
    assert.ok(!("memory_hits" in res), "no field when there are no hits");
  });

  test("batch qs[]: each group carries its own memory_hits, in request order", async () => {
    resetMem();
    MEM.hits.set("hmac", ["[Memory:gotcha] hmac thing (strong) [mem:1]"]);
    MEM.hits.set("cache", ["[Memory:gotcha] cache thing (medium) [mem:2]", "[Memory:decision] cache policy (strong) [mem:3]"]);
    const res = await callVerb("find_entity", { qs: ["hmac", "cache"] });
    assert.equal(res.status, "batch");
    assert.equal(res.groups[0].query, "hmac");
    assert.equal(res.groups[0].memory_hits.length, 1);
    assert.equal(res.groups[1].query, "cache");
    assert.equal(res.groups[1].memory_hits.length, 2);
  });

  test("the quota is the orchestrator's job — the gateway ships whatever it returns", async () => {
    // The orchestrator caps at 3 (untyped) / lifts on type:. Here we prove the
    // gateway is a faithful pass-through: 3 lines in → 3 lines out.
    resetMem();
    MEM.hits.set("q", ["[Memory:gotcha] a (strong) [mem:1]", "[Memory:gotcha] b (strong) [mem:2]", "[Memory:gotcha] c (strong) [mem:3]"]);
    const res = await callVerb("find_entity", { q: "q" });
    assert.equal(res.memory_hits.length, 3);
  });
});


test("orient distinguishes server project identity from caller repository labels", async () => {
  const previous = process.env.FLOW_PROJECT_NAME;
  try {
    process.env.FLOW_PROJECT_NAME = "team-cloud";
    const result = await callVerb("orient", { repo: "different-repository", project: "spoofed" });
    assert.match(result, /^CONNECTED PROJECT: "team-cloud"/);
    assert.match(result, /repo "different-repository"/);
    assert.ok(!result.includes("spoofed"));
    delete process.env.FLOW_PROJECT_NAME;
    assert.match(await callVerb("orient", { repo: "different-repository" }), /^CONNECTED PROJECT: \(identity unavailable\)/);
  } finally {
    if (previous === undefined) delete process.env.FLOW_PROJECT_NAME;
    else process.env.FLOW_PROJECT_NAME = previous;
  }
});


test("orient distinguishes unreadable memory from a confirmed empty store", async () => {
  const previous = process.env.FLOW_MEMORY_URL;
  let authorized = false;
  const fetchMock = mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    if (!authorized) return new Response("Unauthorized", { status: 401 });
    return Response.json(String(url).includes("/stats")
      ? { memories: 0, observations: 0, bySource: {} }
      : { global: null, repo: null });
  });
  try {
    process.env.FLOW_MEMORY_URL = "https://fixture.invalid/v1/memory/search";
    const unreadable = await callVerb("orient", { repo: "fixture" });
    assert.match(unreadable, /MEMORY: unavailable/);
    assert.ok(!unreadable.includes("MEMORY: none yet"));
    authorized = true;
    assert.match(await callVerb("orient", { repo: "fixture" }), /MEMORY: none yet/);
  } finally {
    fetchMock.mock.restore();
    if (previous === undefined) delete process.env.FLOW_MEMORY_URL;
    else process.env.FLOW_MEMORY_URL = previous;
  }
});
