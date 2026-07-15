// job-activity.test.ts — the live indexer activity feed: per-backend JSONL
// extractors, counts, ring-buffer caps, and live-only clearing on finish.
import { describe, test } from "node:test";
import assert from "node:assert";
import {
  activityForRepo,
  finishActivity,
  recordActivityLine,
  startActivity,
} from "../src/job-activity.js";

// Real line shapes captured from live runs (opencode 1.18.1) and the
// documented stream formats for claude -p --output-format stream-json and
// codex exec --json.
const OPENCODE_READ =
  '{"type":"tool_use","timestamp":1,"sessionID":"s","part":{"type":"tool","tool":"read","callID":"c","state":{"status":"completed","input":{"filePath":"/x/data/projects/p/workspace/repos/stackblocks-v1/src/auth.ts"}}}}';
const OPENCODE_UPSERT =
  '{"type":"tool_use","timestamp":1,"sessionID":"s","part":{"type":"tool","tool":"graph_upsert","callID":"c","state":{"status":"completed","input":{"type":"Repository","id":"repo:stackblocks-v1","name":"stackblocks-v1"}}}}';
const OPENCODE_PENDING =
  '{"type":"tool_use","timestamp":1,"sessionID":"s","part":{"type":"tool","tool":"read","callID":"c","state":{"status":"running","input":{}}}}';
const CLAUDE_TOOL =
  '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__flow-graph__upsert_entity","input":{"id":"svc:api"}}]}}';
const CODEX_CMD = '{"type":"item.completed","item":{"type":"command_execution","command":"git log --oneline"}}';

describe("job-activity", () => {
  test("extracts terse labels and counts per backend", () => {
    startActivity("job1", "stackblocks-v1", "opencode");
    recordActivityLine("job1", "opencode", OPENCODE_READ);
    recordActivityLine("job1", "opencode", OPENCODE_UPSERT);
    recordActivityLine("job1", "opencode", OPENCODE_PENDING); // not completed — ignored
    recordActivityLine("job1", "opencode", "not json"); // ignored
    recordActivityLine("job1", "opencode", '{"type":"text","part":{}}'); // ignored

    const a = activityForRepo("stackblocks-v1");
    assert.ok(a);
    assert.equal(a.status, "running");
    assert.equal(a.events.length, 2);
    assert.equal(a.events[0].label, "read repos/stackblocks-v1/src/auth.ts");
    assert.equal(a.events[0].kind, "file");
    assert.equal(a.events[1].label, "graph_upsert repo:stackblocks-v1");
    assert.equal(a.events[1].kind, "graph");
    assert.deepEqual(a.counts, { toolCalls: 2, filesRead: 1, graphWrites: 1 });
  });

  test("claude and codex lines extract too", () => {
    startActivity("job2", "repo-b", "claude");
    recordActivityLine("job2", "claude", CLAUDE_TOOL);
    let a = activityForRepo("repo-b");
    assert.equal(a?.events[0].label, "graph_upsert_entity svc:api");
    assert.equal(a?.events[0].kind, "graph");
    assert.equal(a?.counts.graphWrites, 1);

    startActivity("job3", "repo-c", "codex");
    recordActivityLine("job3", "codex", CODEX_CMD);
    a = activityForRepo("repo-c");
    assert.equal(a?.events[0].label, "bash git log --oneline");
    assert.equal(a?.events[0].kind, "bash");
  });

  test("finish keeps counts but clears the ticker (live-only)", () => {
    startActivity("job4", "repo-d", "opencode");
    recordActivityLine("job4", "opencode", OPENCODE_READ);
    finishActivity("job4", "done");
    const a = activityForRepo("repo-d");
    assert.equal(a?.status, "done");
    assert.equal(a?.events.length, 0);
    assert.equal(a?.counts.toolCalls, 1);
  });

  test("ring buffer caps events; labels are truncated", () => {
    startActivity("job5", "repo-e", "opencode");
    for (let i = 0; i < 250; i++) recordActivityLine("job5", "opencode", OPENCODE_READ);
    const long =
      '{"type":"tool_use","part":{"type":"tool","tool":"bash","state":{"status":"completed","input":{"command":"' +
      "x".repeat(500) +
      '"}}}}';
    recordActivityLine("job5", "opencode", long);
    const a = activityForRepo("repo-e");
    assert.ok(a && a.events.length <= 200);
    assert.ok(a.events[a.events.length - 1].label.length <= 120);
  });

  test("no repo → no activity (chat jobs are invisible)", () => {
    startActivity("job6", "", "opencode");
    recordActivityLine("job6", "opencode", OPENCODE_READ); // must not throw
    assert.equal(activityForRepo(""), null);
  });
});
