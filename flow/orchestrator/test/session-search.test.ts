// session-search.test.ts — semantic search over agent sessions. Fully offline:
// in-memory DB, injected transcript reader, deterministic stub embedder (same
// token-hash scheme as memory.test.ts) — no gateway, no model.

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Env BEFORE importing anything that touches the DB.
process.env.DB_PATH = ":memory:";
process.env.FLOW_ADMIN_TOKEN = "test-admin-token-session-search";
process.env.FLOW_SESSION_SEARCH = "0"; // no timers in tests

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let ss: typeof import("../src/agents/session-search.js");
/* eslint-enable @typescript-eslint/no-explicit-any */

const DIM = 64;
function stubVec(text: string): Float32Array {
  const v = new Float32Array(DIM);
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const tok of tokens) {
    let h = 0;
    for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) >>> 0;
    v[h % DIM] += 1;
  }
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < DIM; i++) v[i] /= n;
  return v;
}
const stubEmbedder = async (t: string) => stubVec(t);

// Synthetic transcripts, keyed by session id — the injected reader.
const transcripts = new Map<string, Array<{ kind: string; data: unknown }>>();

function insertSession(id: string, title: string, opts: { repo?: string; status?: string; updatedAt?: number } = {}): void {
  db.prepare(
    `INSERT INTO agent_sessions (id, backend, repo, cwd, title, status, created_at, updated_at)
     VALUES (?, 'claude', ?, '/tmp', ?, ?, ?, ?)`
  ).run(id, opts.repo ?? "flow", title, opts.status ?? "closed", Date.now() - 1000, opts.updatedAt ?? Date.now() - 1000);
}

function chunk(text: string): { kind: string; data: unknown } {
  return { kind: "update", data: { sessionUpdate: "agent_message_chunk", content: { text } } };
}

before(async () => {
  db = (await import("../src/db.js")).default;
  // agent_sessions is created at runtime.ts module load; these tests bypass
  // runtime entirely, so create the current baseline shape directly.
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_sessions (
      id TEXT PRIMARY KEY,
      backend TEXT NOT NULL,
      repo TEXT NOT NULL,
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      acp_session_id TEXT,
      stop_reason TEXT,
      error TEXT,
      start_sha TEXT,
      start_untracked TEXT,
      worktree_id TEXT,
      last_distilled_seq INTEGER,
      search_text TEXT,
      embedding BLOB,
      embedded_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  ss = await import("../src/agents/session-search.js");
  ss.setEmbedder(stubEmbedder);
  ss.setSessionTranscriptReader((id) => transcripts.get(id) ?? []);
});

beforeEach(() => {
  db.exec("DELETE FROM agent_sessions");
  transcripts.clear();
});

describe("buildSearchText", () => {
  test("keeps title, repo/branch, prompts, and only the LAST agent conclusion", () => {
    const doc = ss.buildSearchText({ title: "Fix nginx", repo: "bs365" }, [
      { kind: "created", data: { branch: "dev" } },
      { kind: "user_prompt", data: { text: "the proxy caches stale DNS" } },
      chunk("first turn conclusion about resolvers"),
      { kind: "user_prompt", data: { text: "now add a variable proxy_pass" } },
      chunk("final: switched to metadata resolver"),
    ]);
    assert.match(doc, /Fix nginx/);
    assert.match(doc, /bs365 dev/);
    assert.match(doc, /stale DNS/);
    assert.match(doc, /variable proxy_pass/);
    assert.match(doc, /metadata resolver/);
    assert.doesNotMatch(doc, /first turn conclusion/);
  });

  test("caps long docs keeping head and tail", () => {
    const doc = ss.buildSearchText({ title: "t", repo: "r" }, [
      { kind: "user_prompt", data: { text: "start-marker " + "x".repeat(6000) } },
      chunk("y".repeat(3000) + " end-marker"),
    ]);
    assert.ok(doc.length <= 4100);
    assert.match(doc, /start-marker/);
    assert.match(doc, /end-marker/);
  });

  test("strips the MCP orientation preamble from prompts", () => {
    const preamble =
      "You have access to the flow-graph tools. Consult it FIRST to orient yourself before diving into files.\n\n" +
      "fix the login bug on the settings page and add a regression test for it";
    const doc = ss.buildSearchText({ title: "t", repo: "r" }, [{ kind: "user_prompt", data: { text: preamble } }]);
    assert.match(doc, /fix the login bug/);
    assert.doesNotMatch(doc, /Consult it FIRST/);
  });
});

describe("query helpers", () => {
  test("queryTerms drops stopwords and short tokens", () => {
    assert.deepEqual(ss.queryTerms("the session where we fixed nginx DNS"), ["fixed", "nginx", "dns"]);
  });

  test("lexicalOverlap is the matched fraction", () => {
    assert.equal(ss.lexicalOverlap(["nginx", "dns"], "nginx resolver work"), 0.5);
    assert.equal(ss.lexicalOverlap([], "anything"), 0);
  });

  test("snippetFor windows around the first matching term", () => {
    const snip = ss.snippetFor(["resolver"], "a".repeat(200) + " the metadata resolver fix " + "b".repeat(200));
    assert.ok(snip);
    assert.match(snip!, /metadata resolver fix/);
    assert.ok(snip!.startsWith("…") && snip!.endsWith("…"));
  });
});

describe("embed sweep", () => {
  test("embeds pending sessions, then skips unchanged ones on re-sweep", async () => {
    insertSession("s1", "Fix nginx DNS caching");
    transcripts.set("s1", [{ kind: "user_prompt", data: { text: "nginx pins upstream IPs, add a resolver" } }]);

    assert.equal(await ss.sweepSessionEmbeddings(), 1);
    const row = db.prepare("SELECT search_text, embedding, embedded_at FROM agent_sessions WHERE id='s1'").get();
    assert.match(row.search_text, /resolver/);
    assert.ok(row.embedding && row.embedded_at);

    // Row moves (status flip) but content is unchanged → restamp, no re-embed.
    db.prepare("UPDATE agent_sessions SET updated_at = ? WHERE id='s1'").run(Date.now() + 60_000);
    assert.equal(await ss.embedSessionNow("s1"), "skipped");
  });

  test("embedder unavailable stores the doc, leaves the vector pending", async () => {
    insertSession("s1", "Some task");
    transcripts.set("s1", [{ kind: "user_prompt", data: { text: "investigate the flaky login test" } }]);
    ss.setEmbedder(async () => null);
    try {
      assert.equal(await ss.embedSessionNow("s1"), "failed");
    } finally {
      ss.setEmbedder(stubEmbedder);
    }
    const row = db.prepare("SELECT search_text, embedding, embedded_at FROM agent_sessions WHERE id='s1'").get();
    assert.match(row.search_text, /flaky login/);
    assert.equal(row.embedding, null);
    assert.equal(row.embedded_at, null);
  });
});

describe("searchSessions", () => {
  test("ranks the semantically-matching session first", async () => {
    insertSession("nginx", "Fix proxy outage");
    transcripts.set("nginx", [
      { kind: "user_prompt", data: { text: "nginx caches DNS forever, the upstream IP rotated and broke the proxy" } },
    ]);
    insertSession("billing", "Billing work");
    transcripts.set("billing", [
      { kind: "user_prompt", data: { text: "charge the project owner pool for editor builds" } },
    ]);
    await ss.sweepSessionEmbeddings();

    const { results, semantic } = await ss.searchSessions("nginx DNS caching proxy");
    assert.equal(semantic, true);
    assert.ok(results.length >= 1);
    assert.equal(results[0].id, "nginx");
    assert.ok(results[0].snippet && /DNS/.test(results[0].snippet));
  });

  test("degrades to lexical-only when the query cannot be embedded", async () => {
    insertSession("s1", "Fix nginx DNS caching");
    transcripts.set("s1", [{ kind: "user_prompt", data: { text: "nginx resolver work" } }]);
    await ss.sweepSessionEmbeddings();

    ss.setEmbedder(async () => null);
    try {
      const { results, semantic } = await ss.searchSessions("nginx resolver");
      assert.equal(semantic, false);
      assert.equal(results[0]?.id, "s1");
    } finally {
      ss.setEmbedder(stubEmbedder);
    }
  });

  test("unrelated queries return nothing", async () => {
    insertSession("s1", "Fix nginx DNS caching");
    transcripts.set("s1", [{ kind: "user_prompt", data: { text: "nginx resolver work" } }]);
    await ss.sweepSessionEmbeddings();
    const { results } = await ss.searchSessions("kubernetes helm chart upgrade");
    assert.equal(results.length, 0);
  });
});
