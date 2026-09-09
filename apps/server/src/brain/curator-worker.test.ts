// @effect-diagnostics nodeBuiltinImport:off - Exercises the real isolated worker process and SQLite boundary.
// @effect-diagnostics globalFetch:off - Exercises the private MCP HTTP endpoint.
import { it, expect } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeSqlite from "node:sqlite";
import { startSessionWorker } from "./session-worker.ts";
import type { BrainCuratorRun } from "@flow/brain-runtime";

it("captures immediately, curates all documents over private MCP, and advances only after a host receipt", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "flow-curator-worker-"));
  const sourceRoot = NodePath.join(directory, "source");
  await NodeFSP.mkdir(sourceRoot);
  await NodeFSP.writeFile(
    NodePath.join(sourceRoot, "SKILL.md"),
    "---\nname: isolated-test\ndescription: Test with isolated state.\n---\nRun a focused check.\n",
  );
  NodeChildProcess.execFileSync("git", ["init", "-q", sourceRoot]);
  NodeChildProcess.execFileSync("git", ["-C", sourceRoot, "add", "SKILL.md"]);
  NodeChildProcess.execFileSync("git", [
    "-C",
    sourceRoot,
    "-c",
    "user.name=Flow Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "test fixture",
  ]);
  const registry = NodePath.join(directory, "sources.json");
  await NodeFSP.writeFile(
    registry,
    JSON.stringify({ repos: [{ name: "flow", localPath: sourceRoot }] }),
  );
  const requests: BrainCuratorRun[] = [];
  const originalTime = Date.parse("2026-01-02T03:04:05Z");
  let skillId = "";
  let fail = false;
  const environment = {
    GRAPH_NAME: "curator_test",
    FALKOR_SOCKET: NodePath.join(directory, "unused.socket"),
    FLOW_EMBED_URL: "http://127.0.0.1:1",
    FLOW_EMBED_TOKEN: "test-embedding-token",
    FLOW_ADMIN_TOKEN: "test-private-token",
    DB_PATH: NodePath.join(directory, "flow.db"),
    JOURNAL_PATH: NodePath.join(directory, "journal.jsonl"),
    OPENCODE_WORKSPACE_DIR: directory,
    FLOW_DISTILLER: "1",
    FLOW_SESSION_SEARCH: "0",
    FLOW_SOURCE_REGISTRY: registry,
  };
  const run = async (request: BrainCuratorRun) => {
    requests.push(request);
    if (fail) throw new Error("Simulated subscription limit");
    const references = [...request.input.matchAll(/\[E(\d+) /g)].map((match) => Number(match[1]));
    const seq = Math.max(...references);
    async function call(name: string, args: Record<string, unknown>) {
      const response = await fetch(request.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${request.token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
      expect(response.status).toBe(200);
      return (await response.json()) as {
        result: { isError?: boolean; content: Array<{ text: string }> };
      };
    }
    const current = await call("read_document", { id: `notes:${request.sessionId}` });
    const note = JSON.parse(current.result.content[0]!.text) as { revision: number };
    const saved = await call("write_document", {
      kind: "notes",
      expectedRevision: note.revision,
      text: `The user described a testing procedure. Processed through E${seq}.`,
      evidence: [seq],
    });
    expect(saved.result.isError).not.toBe(true);
    if (!skillId) {
      const memory = await call("write_document", {
        kind: "memory",
        name: "Use isolated test state",
        description: "Keep test data separate.",
        text: "Testing uses isolated state, as the user described.",
        evidence: [seq],
      });
      expect(memory.result.isError).not.toBe(true);
      const skill = await call("write_document", {
        kind: "skill",
        name: "Verify a local test",
        description: "Use for the user's isolated local testing procedure.",
        text: "Create isolated state, run the focused check, and inspect its result. This procedure was user-reported.",
        evidence: [seq],
      });
      skillId = (JSON.parse(skill.result.content[0]!.text) as { id: string }).id;
    }
    const source = await call("source_read", { repo: "flow", path: "SKILL.md" });
    expect(source.result.isError).not.toBe(true);
    expect(source.result.content[0]!.text).toContain("isolated-test");
    const foreign = await call("source_read", { repo: "unregistered", path: "SKILL.md" });
    expect(foreign.result.isError).toBe(true);
    const forbidden = await call("read_evidence", { seq: seq + 1000 });
    expect(forbidden.result.isError).toBe(true);
    return {
      nativeThreadId: "fake-ephemeral",
      assistantCharacters: 5,
      inputTokens: 100,
      cachedInputTokens: 80,
      outputTokens: 20,
    };
  };
  let worker = await startSessionWorker(environment, false, process.env.T3_TEST_BRAIN_ENTRY, run);
  try {
    await worker.capture({
      context: { session: "chat", repo: "flow" },
      receipt: "first",
      occurredAt: originalTime,
      kind: "user_prompt",
      data: {
        text: "Our local testing procedure uses isolated state: create it, run the focused check, then inspect its result.",
      },
    });
    await worker.drain();
    const chat = await worker.memories("chat");
    expect(chat.status).toBe("idle");
    expect(chat.notes?.text).toContain("testing procedure");
    expect(chat.notes?.observedAt).toBe(originalTime);
    expect(requests[0]?.input).toContain("2026-01-02T03:04:05.000Z");
    expect(chat.documents?.map((doc) => doc.kind).sort()).toEqual(["memory", "skill"]);
    expect((await worker.document(skillId))?.text).toMatch(/^---\nname: "verify-a-local-test"/);
    expect((await worker.knowledge()).documents).toHaveLength(2);
    const skills = await worker.call("list_skills", { query: "testing" }, { session: "chat" });
    expect(skills.isError).not.toBe(true);
    expect(
      skills.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(),
    ).toContain(skillId);
    expect((await worker.memories("unrelated")).documents).toEqual([]);
    const hidden = await worker.call(
      "read_document",
      { id: "notes:t3-chat" },
      { session: "unrelated" },
    );
    expect(hidden.isError).toBe(true);
    fail = true;
    await worker.capture({
      context: { session: "chat", repo: "flow" },
      receipt: "second",
      kind: "user_prompt",
      data: { text: "Keep the useful diagnosis even after an incident is resolved." },
      closed: true,
    });
    await worker.drain();
    const failed = await worker.memories("chat");
    expect(failed.status).toBe("error");
    expect(failed.extractionError).toContain("subscription limit");
    expect(failed.notes?.revision).toBe(chat.notes?.revision);
    fail = false;
    await worker.drain();
    expect((await worker.memories("chat")).status).toBe("idle");
    expect(requests.at(-1)?.renew).toBe(true);
    expect(requests.at(-1)?.input).toContain("Keep the useful diagnosis");
    await worker.close();
    worker = await startSessionWorker(environment, false, process.env.T3_TEST_BRAIN_ENTRY, run);
    await worker.capture({
      context: { session: "chat", repo: "flow" },
      receipt: "after-restart",
      kind: "user_prompt",
      data: { text: "Preserve the saved procedure after the worker restarts." },
      closed: true,
    });
    await worker.drain();
    expect((await worker.memories("chat")).status).toBe("idle");
    expect(requests.at(-1)?.input).toContain("after the worker restarts");
    const database = new NodeSqlite.DatabaseSync(environment.DB_PATH, { readOnly: true });
    try {
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM memory_distill_jobs").get()?.count,
      ).toBe(0);
      expect(database.prepare("SELECT COUNT(*) AS count FROM llm_log").get()?.count).toBe(0);
    } finally {
      database.close();
    }
  } finally {
    await worker.close();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
}, 30_000);
