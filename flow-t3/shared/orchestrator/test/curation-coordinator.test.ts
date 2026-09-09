import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import Database from "better-sqlite3";
import { CurationStore } from "../src/curation/store.js";
import { CurationCoordinator } from "../src/curation/coordinator.js";
import type {
  BrainCuratorRun,
  BrainCuratorResult,
  BrainCuratorReply,
} from "../../runtime/src/contracts.js";

const result: BrainCuratorResult = { nativeThreadId: "ephemeral-1", assistantCharacters: 20 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture(run: (request: BrainCuratorRun) => Promise<BrainCuratorReply>) {
  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE t3_capture(seq INTEGER PRIMARY KEY, session TEXT, kind TEXT, data TEXT, ts INTEGER)",
  );
  const store = new CurationStore(db);
  const coordinator = new CurationCoordinator(store, {
    run,
    endpoint: "http://localhost:1",
    token: "private",
    cwd: "/tmp",
    intervalMs: 60000,
  });
  let seq = 0;
  return {
    db,
    store,
    coordinator,
    add(text: string, closed = false) {
      db.prepare("INSERT INTO t3_capture VALUES (?, 'chat-a', 'user_prompt', ?, ?)").run(
        ++seq,
        JSON.stringify({ text }),
        seq * 1000,
      );
      coordinator.capture("chat-a", "flow", seq, closed);
      return seq;
    },
    close() {
      coordinator.close();
      db.close();
    },
  };
}

NodeTest.test(
  "notes exist synchronously; busy checkpoints coalesce without advancing unfinished work",
  async () => {
    const begun = deferred<void>();
    const complete = deferred<BrainCuratorResult>();
    const calls: BrainCuratorRun[] = [];
    const f = fixture(async (request) => {
      calls.push(request);
      if (calls.length === 1) {
        begun.resolve();
        return complete.promise;
      }
      return result;
    });
    f.add("Create useful memory notes.");
    NodeAssert.match(f.store.get("notes:chat-a")!.text, /Create useful memory notes/);
    await begun.promise;
    f.add("Use original context.");
    f.add("Keep native history empty.", true);
    NodeAssert.equal(calls.length, 1);
    NodeAssert.equal(f.store.session("chat-a").lastSeq, 0);
    const flushed = f.coordinator.flush();
    complete.resolve(result);
    await flushed;
    NodeAssert.equal(calls.length, 2);
    NodeAssert.equal(calls[0]!.renew, true);
    NodeAssert.equal(calls[1]!.renew, false);
    NodeAssert.match(calls[1]!.input, /Use original context/);
    NodeAssert.match(calls[1]!.input, /Keep native history empty/);
    NodeAssert.doesNotMatch(calls[1]!.input, /Create useful memory notes/);
    NodeAssert.equal(f.store.session("chat-a").lastSeq, 3);
    f.close();
  },
);

NodeTest.test(
  "failed extraction retains its cursor and renews safely when explicitly retried",
  async () => {
    let fail = true;
    const calls: BrainCuratorRun[] = [];
    const f = fixture(async (request) => {
      calls.push(request);
      if (fail) throw new Error("Codex usage limit reached");
      return result;
    });
    f.add("Keep this request.");
    await f.coordinator.flush();
    NodeAssert.equal(f.store.session("chat-a").status, "error");
    NodeAssert.equal(f.store.session("chat-a").lastSeq, 0);
    NodeAssert.match(f.store.session("chat-a").error!, /usage limit/);
    fail = false;
    await f.coordinator.flush();
    NodeAssert.equal(calls.length, 2);
    NodeAssert.equal(calls[1]!.renew, true);
    NodeAssert.equal(f.store.session("chat-a").lastSeq, 1);
    f.close();
  },
);

NodeTest.test(
  "preparation failures report an error and leave the shared queue usable for retry",
  async (context) => {
    const calls: BrainCuratorRun[] = [];
    const f = fixture(async (request) => {
      calls.push(request);
      return result;
    });
    const originalList = f.store.list.bind(f.store);
    let fail = true;
    context.mock.method(f.store, "list", (...args: Parameters<CurationStore["list"]>) => {
      if (fail) throw new Error("Could not read the document catalog");
      return originalList(...args);
    });
    f.add("Preserve this request through preparation failure.");
    await NodeAssert.doesNotReject(f.coordinator.flush());
    NodeAssert.equal(calls.length, 0);
    NodeAssert.equal(f.store.session("chat-a").lastSeq, 0);
    NodeAssert.equal(f.store.session("chat-a").status, "error");
    NodeAssert.match(f.store.session("chat-a").error!, /document catalog/);
    fail = false;
    f.db
      .prepare("INSERT INTO t3_capture VALUES (2, 'chat-b', 'user_prompt', ?, 2000)")
      .run(JSON.stringify({ text: "Another chat must still work." }));
    f.coordinator.capture("chat-b", "flow", 2, true);
    await f.coordinator.flush();
    NodeAssert.equal(calls.length, 2);
    NodeAssert.ok(calls.every((call) => call.renew));
    NodeAssert.equal(f.store.session("chat-a").lastSeq, 1);
    NodeAssert.equal(f.store.session("chat-b").lastSeq, 2);
    NodeAssert.equal(f.store.session("chat-a").status, "idle");
    NodeAssert.equal(f.store.session("chat-b").status, "idle");
    f.close();
  },
);

NodeTest.test(
  "context renewal keeps a recent bounded original window and saved notes",
  async () => {
    const calls: BrainCuratorRun[] = [];
    const f = fixture(async (request) => {
      calls.push(request);
      return result;
    });
    f.add("Original task: improve memory.");
    await f.coordinator.flush();
    f.add("x".repeat(149000), true);
    await f.coordinator.flush();
    f.add("A later correction with important new evidence.", true);
    await f.coordinator.flush();
    NodeAssert.equal(calls.length, 3);
    NodeAssert.equal(calls[1]!.renew, true);
    NodeAssert.equal(calls[2]!.renew, false);
    NodeAssert.match(calls[1]!.input, /Current notes/);
    NodeAssert.match(calls[2]!.input, /later correction/);
    NodeAssert.ok(calls[1]!.input.length + calls[1]!.instructions.length <= 120000);
    NodeAssert.doesNotMatch(calls[2]!.input, /x{100}/);
    f.close();
  },
);

NodeTest.test(
  "recovery resumes enrolled work but opening an old chat enrolls only that chat",
  async () => {
    const calls: BrainCuratorRun[] = [];
    const f = fixture(async (request) => {
      calls.push(request);
      return result;
    });
    f.db
      .prepare("INSERT INTO t3_capture VALUES (1, 'archived', 'user_prompt', ?, 1000)")
      .run(JSON.stringify({ text: "An older task with useful history." }));
    f.db
      .prepare("INSERT INTO t3_capture VALUES (2, 'unopened', 'user_prompt', ?, 2000)")
      .run(JSON.stringify({ text: "An unrelated archive." }));
    f.coordinator.recover();
    await f.coordinator.flush();
    NodeAssert.equal(calls.length, 0);
    f.coordinator.open("archived", false);
    NodeAssert.match(f.store.get("notes:archived")!.text, /older task/);
    NodeAssert.equal(calls.length, 0);
    f.coordinator.open("archived");
    await f.coordinator.flush();
    NodeAssert.equal(calls.length, 1);
    NodeAssert.equal(calls[0]!.sessionId, "archived");
    f.coordinator.open("archived");
    await f.coordinator.flush();
    NodeAssert.equal(calls.length, 1);
    NodeAssert.equal(f.store.get("notes:unopened"), undefined);
    f.close();
  },
);

NodeTest.test(
  "an expired native segment gets full bounded context immediately without losing the source cursor",
  async () => {
    const calls: BrainCuratorRun[] = [];
    const f = fixture(async (request) => {
      calls.push(request);
      return calls.length === 2 ? { requiresContext: true } : result;
    });
    f.add("Original task and durable context.");
    await f.coordinator.flush();
    f.add("A correction after the native segment expired.", true);
    await f.coordinator.flush();
    NodeAssert.equal(calls.length, 3);
    NodeAssert.deepEqual(
      calls.map((call) => call.renew),
      [true, false, true],
    );
    NodeAssert.match(calls[2]!.input, /Original task and durable context/);
    NodeAssert.match(calls[2]!.input, /A correction after/);
    NodeAssert.equal(f.store.session("chat-a").lastSeq, 2);
    NodeAssert.equal(f.store.session("chat-a").status, "idle");
    NodeAssert.equal(f.store.session("chat-a").error, null);
    f.close();
  },
);

NodeTest.test(
  "the periodic checkpoint stays anchored to its prior start instead of restarting a full minute on late activity",
  async (context) => {
    context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
    const calls: BrainCuratorRun[] = [];
    const second = deferred<void>();
    const f = fixture(async (request) => {
      calls.push(request);
      if (calls.length === 2) second.resolve();
      return result;
    });
    f.add("Original task.");
    await f.coordinator.flush();
    context.mock.timers.tick(55_000);
    f.add("Meaningful progress near the checkpoint deadline.");
    context.mock.timers.tick(4999);
    NodeAssert.equal(calls.length, 1);
    context.mock.timers.tick(1);
    await second.promise;
    NodeAssert.equal(calls.length, 2);
    NodeAssert.match(calls[1]!.input, /Meaningful progress/);
    await f.coordinator.flush();
    f.close();
  },
);
