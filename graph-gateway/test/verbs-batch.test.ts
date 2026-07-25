// verbs-batch.test.ts — batched read verbs (get_entity ids[], find_entity qs[])
// exercised WITHOUT a live FalkorDB. `./graph.js` (the only DB touch), the
// journal, and the embed model are module-mocked, so the test isolates the
// batch orchestration itself: order preservation, explicit not-found for
// missing ids, per-item error isolation, cross-group dedup notes, cap
// enforcement, and single-value backward compat.
//
// Run with: node --experimental-test-module-mocks --import tsx/esm --test test/verbs-batch.test.ts
// (wired into `npm test` in package.json).

import { test, describe, before, mock } from "node:test";
import assert from "node:assert/strict";

/* eslint-disable @typescript-eslint/no-explicit-any */
let callVerb: (name: string, input: unknown) => Promise<any>;

// Canned graph state the mocked `run()` answers from. The mock parses just
// enough of each Cypher string to serve the batch verbs' fixed query shapes.
const NODES = new Map<string, { type: string; name: string }>([
  ["svc:a", { type: "Service", name: "Alpha service" }],
  ["svc:b", { type: "Service", name: "Beta service" }],
  ["svc:c", { type: "Service", name: "Gamma service" }],
]);
// ids that should throw when fetched, to prove per-item error isolation.
const THROW_IDS = new Set<string>(["svc:boom"]);

function mockRun(_graph: string, cypher: string, params: Record<string, any> = {}): any[] {
  const id = params.id ?? params.q;
  if (typeof id === "string" && THROW_IDS.has(id)) throw new Error(`boom for ${id}`);

  // get_entity: node lookup by id
  if (/MATCH \(n \{id: \$id\}\) RETURN labels\(n\)\[0\] AS type, properties\(n\)/.test(cypher)) {
    const n = NODES.get(String(id));
    return n ? [{ type: n.type, props: { id, name: n.name } }] : [];
  }
  // get_entity: outgoing / incoming rels (none in this fixture)
  if (/-\[r\]->\(m\)/.test(cypher) || /<-\[r\]-\(m\)/.test(cypher)) return [];

  // find_entity: exact id match
  if (/MATCH \(n \{id: \$q\}\)/.test(cypher)) {
    const n = NODES.get(String(id));
    return n ? [{ type: n.type, id, name: n.name, description: null, anchor: null }] : [];
  }
  // find_entity: lexical findSimilar — match any node whose name/id contains a token
  if (/n\.embedding IS NOT NULL/.test(cypher)) return []; // vector pass: no embeddings
  if (/CONTAINS/.test(cypher)) {
    const tokens = Object.entries(params)
      .filter(([k]) => /^t\d+$/.test(k) || k === "ql")
      .map(([, v]) => String(v));
    const out: any[] = [];
    for (const [nid, n] of NODES) {
      const hay = `${nid} ${n.name}`.toLowerCase();
      if (tokens.length && tokens.every((t) => hay.includes(t))) {
        out.push({ type: n.type, id: nid, name: n.name, description: null, anchor: null });
      }
    }
    return out;
  }
  return [];
}

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
  mock.module("../src/journal.js", {
    namedExports: { record: async () => {}, tail: async () => [] },
  });
  mock.module("../src/embed.js", {
    namedExports: {
      EMBED_DIM: 768,
      embeddingsEnabled: () => false, // vector pass self-noops → lexical only
      entityText: () => "",
      embedText: async () => null,
      embedQuery: async () => ({ vec: null, error: "disabled in test" }),
      embedBatch: async () => [],
    },
  });
  ({ callVerb } = await import("../src/verbs.js"));
});

// ---------------------------------------------------------------------------
describe("get_entity — batch", () => {
  test("single id form stays backward compatible (flat {status,node,...})", async () => {
    const res = await callVerb("get_entity", { id: "svc:a" });
    assert.equal(res.status, "found");
    assert.ok(res.node, "single form returns node directly");
    assert.ok(!("results" in res), "single form has no batch envelope");
  });

  test("ids[] returns sections in REQUEST ORDER, one per id", async () => {
    const res = await callVerb("get_entity", { ids: ["svc:c", "svc:a", "svc:b"] });
    assert.equal(res.status, "batch");
    assert.deepEqual(res.results.map((r: any) => r.id), ["svc:c", "svc:a", "svc:b"]);
    assert.ok(res.results.every((r: any) => r.status === "found"));
  });

  test("a missing id is an explicit not_found entry, never dropped", async () => {
    const res = await callVerb("get_entity", { ids: ["svc:a", "svc:missing", "svc:b"] });
    assert.equal(res.results.length, 3, "missing id keeps its slot");
    assert.equal(res.results[1].status, "not_found");
    assert.equal(res.results[1].id, "svc:missing");
    assert.deepEqual(res.not_found, ["svc:missing"]);
    assert.equal(res.found, 2);
  });

  test("a per-item error is isolated — the rest of the batch still returns", async () => {
    const res = await callVerb("get_entity", { ids: ["svc:a", "svc:boom", "svc:b"] });
    assert.equal(res.results.length, 3);
    assert.equal(res.results[0].status, "found");
    assert.equal(res.results[1].status, "error");
    assert.match(res.results[1].error, /boom/);
    assert.equal(res.results[2].status, "found", "error in one item must not sink the others");
  });

  test("over the cap (16 ids) is a clear error, not silent truncation", async () => {
    const ids = Array.from({ length: 16 }, (_, i) => `svc:${i}`);
    const res = await callVerb("get_entity", { ids });
    assert.equal(res.status, "error");
    assert.match(res.error, /Invalid input/);
  });

  test("neither id nor ids → explicit error", async () => {
    const res = await callVerb("get_entity", {});
    assert.equal(res.status, "error");
    assert.match(res.error, /id.*ids|ids.*id/);
  });
});

// ---------------------------------------------------------------------------
describe("find_entity — batch", () => {
  test("single q form stays backward compatible (flat {status,matches})", async () => {
    const res = await callVerb("find_entity", { q: "svc:a" });
    assert.equal(res.status, "exact");
    assert.ok(Array.isArray(res.matches));
    assert.ok(!("groups" in res), "single form has no batch envelope");
  });

  test("qs[] groups results per query, in REQUEST ORDER", async () => {
    const res = await callVerb("find_entity", { qs: ["svc:b", "svc:a"] });
    assert.equal(res.status, "batch");
    assert.deepEqual(res.groups.map((g: any) => g.query), ["svc:b", "svc:a"]);
    assert.equal(res.groups[0].matches[0].id, "svc:b");
    assert.equal(res.groups[1].matches[0].id, "svc:a");
  });

  test("cross-group duplicate ids get a terse note, not a repeated full entry", async () => {
    // Both queries match every service by the shared token "service". The first
    // group owns the full entries; the second group's overlaps are noted.
    const res = await callVerb("find_entity", { qs: ["service", "service"] });
    const g1 = res.groups[0].matches;
    const g2 = res.groups[1].matches;
    assert.ok(g1.length >= 1 && g1[0].name, "first group carries full entries");
    // every g2 match that also appeared in g1 is a terse note back to q1
    for (const m of g2) {
      assert.match(m.note, /also matched q1/);
      assert.ok(!("name" in m), "deduped entry omits the full fields");
    }
  });

  test("a per-query error is isolated to its group", async () => {
    const res = await callVerb("find_entity", { qs: ["svc:a", "svc:boom"] });
    assert.equal(res.groups.length, 2);
    assert.equal(res.groups[0].status, "exact");
    assert.equal(res.groups[1].status, "error");
    assert.match(res.groups[1].error, /boom/);
  });

  test("over the cap (11 qs) is a clear error", async () => {
    const qs = Array.from({ length: 11 }, (_, i) => `q${i}`);
    const res = await callVerb("find_entity", { qs });
    assert.equal(res.status, "error");
    assert.match(res.error, /Invalid input/);
  });

  test("neither q nor qs → explicit error", async () => {
    const res = await callVerb("find_entity", {});
    assert.equal(res.status, "error");
    assert.match(res.error, /q.*qs|qs.*q/);
  });
});
