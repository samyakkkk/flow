// index-queue.test.ts — per-repo coalescing queue for index_repo jobs:
// a job arriving mid-index parks instead of failing, the newest parked
// request supersedes the older one, the parked job runs when the running
// one releases, and every transition lands in the index_log trail.

// Setup: in-memory DB before any imports that touch db
process.env.DB_PATH = ":memory:";
process.env.FLOW_ADMIN_TOKEN = "test-token-queue";
process.env.FLOW_FAKE_OPENCODE = "1";
process.env.FLOW_DRAIN_DISABLE = "1";

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import type { Job } from "../src/opencode.js";

let enqueueJob: (opts: {
  type: "index_repo";
  input: Record<string, unknown>;
  repo?: string;
}) => Promise<{ id: string }>;
let getJob: (id: string) => Job | null;
let readIndexLog: (opts?: { repo?: string; limit?: number }) => {
  repo: string;
  event: string;
  job_id: string | null;
  detail: Record<string, unknown> | null;
}[];

before(async () => {
  const opencode = await import("../src/opencode.js");
  enqueueJob = opencode.enqueueJob;
  getJob = opencode.getJob;
  ({ readIndexLog } = await import("../src/index-log.js"));
});

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor: condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("per-repo index queue", () => {
  test("mid-index job parks and runs after; newest parked request wins", async () => {
    const a = await enqueueJob({
      type: "index_repo",
      input: { repo: "queue-r1", branch: "main", url: "x", simulate_delay_ms: 400 },
    });
    await waitFor(() => getJob(a.id)?.status === "running");

    // Both arrive mid-index: b parks, then c supersedes b.
    const b = await enqueueJob({
      type: "index_repo",
      input: { repo: "queue-r1", branch: "main", url: "x" },
    });
    const c = await enqueueJob({
      type: "index_repo",
      input: { repo: "queue-r1", branch: "dev", url: "x" },
    });

    await waitFor(() => getJob(b.id)?.status === "failed");
    const bErr = JSON.parse(getJob(b.id)!.result_json!) as { error: string };
    assert.equal(bErr.error, `superseded:${c.id}`);

    await waitFor(() => getJob(a.id)?.status === "done");
    await waitFor(() => getJob(c.id)?.status === "done");

    // c ran with its own (newest) input — the dev-branch request survived.
    assert.equal(getJob(c.id)!.input.branch, "dev");

    // The trail tells the whole story, oldest → newest.
    const events = readIndexLog({ repo: "queue-r1" })
      .reverse()
      .map((r) => r.event);
    // b and c are both enqueued before either setImmediate fires, so the
    // park/supersede pair lands after both enqueued rows.
    assert.deepEqual(events, [
      "enqueued", // a
      "started",  // a
      "enqueued", // b
      "enqueued", // c
      "parked",   // b
      "superseded", // b by c
      "parked",   // c
      "done",     // a
      "started",  // c
      "done",     // c
    ]);
  });

  test("cross-repo index jobs run one at a time — graph coherence default", async () => {
    const first = await enqueueJob({
      type: "index_repo",
      input: { repo: "queue-r2", branch: "main", url: "x", simulate_delay_ms: 300 },
    });
    const second = await enqueueJob({
      type: "index_repo",
      input: { repo: "queue-r3", branch: "main", url: "x" },
    });

    await waitFor(() => getJob(first.id)?.status === "running");
    // r3 waits for the slot: a builder must see r2's COMPLETE subgraph to
    // attach cross-repo links instead of racing into duplicates.
    assert.equal(getJob(second.id)?.status, "queued");
    await waitFor(() => getJob(first.id)?.status === "done");
    await waitFor(() => getJob(second.id)?.status === "done");
  });

  test("FLOW_MAX_CONCURRENT_INDEXES>1 opts into parallel repos", async () => {
    process.env.FLOW_MAX_CONCURRENT_INDEXES = "2";
    try {
      const slow = await enqueueJob({
        type: "index_repo",
        input: { repo: "queue-r4", branch: "main", url: "x", simulate_delay_ms: 300 },
      });
      const fast = await enqueueJob({
        type: "index_repo",
        input: { repo: "queue-r5", branch: "main", url: "x" },
      });

      await waitFor(() => getJob(fast.id)?.status === "done");
      // r5 finished while r4 is still running — two slots, two repos.
      assert.equal(getJob(slow.id)?.status, "running");
      await waitFor(() => getJob(slow.id)?.status === "done");
    } finally {
      delete process.env.FLOW_MAX_CONCURRENT_INDEXES;
    }
  });
});
