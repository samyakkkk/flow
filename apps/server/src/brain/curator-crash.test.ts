// @effect-diagnostics nodeBuiltinImport:off - Exercises an actual owned worker crash and durable SQLite state.
// @effect-diagnostics globalFetch:off - Calls the worker's private MCP endpoint.
import { expect, it } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";
import type { BrainCuratorRun } from "@flow/brain-runtime";
import { startSessionWorker } from "./session-worker.ts";

async function writeNotes(request: BrainCuratorRun, revision: number, text: string) {
  const seq = Math.max(
    ...[...request.input.matchAll(/\[E(\d+) /g)].map((match) => Number(match[1])),
  );
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
      params: {
        name: "write_document",
        arguments: { kind: "notes", expectedRevision: revision, text, evidence: [seq] },
      },
    }),
  });
  expect(response.status).toBe(200);
  const reply = (await response.json()) as { result: { isError?: boolean } };
  expect(reply.result.isError).not.toBe(true);
}

it("recovers a partial notes write after the worker dies before its completion receipt", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "flow-curator-crash-"));
  const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
  const entry =
    process.env.T3_TEST_BRAIN_ENTRY ??
    NodePath.resolve(here, "../../../../flow-t3/shared/orchestrator/src/brain-runtime.ts");
  const environment = {
    GRAPH_NAME: "crash_test",
    FALKOR_SOCKET: NodePath.join(directory, "unused.socket"),
    FLOW_EMBED_URL: "http://127.0.0.1:1",
    FLOW_EMBED_TOKEN: "test-embedding",
    FLOW_ADMIN_TOKEN: "test-private",
    DB_PATH: NodePath.join(directory, "flow.db"),
    JOURNAL_PATH: NodePath.join(directory, "journal.jsonl"),
    OPENCODE_WORKSPACE_DIR: directory,
    FLOW_DISTILLER: "1",
    FLOW_SESSION_SEARCH: "0",
  };
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/^(FLOW_|FALKOR_|GRAPH_|GATEWAY_|ORCHESTRATOR_|OPENCODE_|DB_PATH$|JOURNAL_PATH$|LLM_|OPENROUTER_)/.test(
          key,
        ),
    ),
  );
  const child = NodeChildProcess.fork(entry, [], {
    execArgv: entry.endsWith(".ts")
      ? [
          "--import",
          NodePath.resolve(
            here,
            "../../../../flow-t3/shared/graph-gateway/node_modules/tsx/dist/loader.mjs",
          ),
        ]
      : [],
    env: { ...inherited, ...environment, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  function waitFor(predicate: (message: Record<string, unknown>) => boolean) {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const cleanup = () => {
        child.off("message", message);
        child.off("exit", exited);
        child.off("error", failed);
      };
      const message = (value: unknown) => {
        if (
          typeof value === "object" &&
          value !== null &&
          predicate(value as Record<string, unknown>)
        ) {
          cleanup();
          resolve(value as Record<string, unknown>);
        }
      };
      const exited = () => {
        cleanup();
        reject(new Error("Worker exited before expected receipt"));
      };
      const failed = (error: Error) => {
        cleanup();
        reject(error);
      };
      child.on("message", message);
      child.once("exit", exited);
      child.once("error", failed);
    });
  }
  let resumed: Awaited<ReturnType<typeof startSessionWorker>> | undefined;
  try {
    await waitFor((message) => message.ready === true);
    const requested = waitFor((message) => typeof message.curatorRequest === "number");
    child.send({
      id: 1,
      method: "capture",
      params: {
        context: { session: "crash-chat", repo: "flow" },
        receipt: "first",
        kind: "user_prompt",
        data: { text: "Investigate a failed regression without changing its original assertion." },
        closed: true,
      },
    });
    const message = await requested;
    const request = message.curatorRun as BrainCuratorRun;
    await writeNotes(
      request,
      1,
      "The original regression assertion must be retained. Investigation is unfinished.",
    );
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
    const before = new NodeSqlite.DatabaseSync(environment.DB_PATH, { readOnly: true });
    try {
      expect(
        before.prepare("SELECT last_seq, status FROM brain_curation_sessions").get(),
      ).toMatchObject({ last_seq: 0, status: "extracting" });
      expect(
        before.prepare("SELECT revision FROM brain_documents WHERE kind='notes'").get()?.revision,
      ).toBe(2);
    } finally {
      before.close();
    }
    let calls = 0;
    resumed = await startSessionWorker(environment, false, entry, async (retry) => {
      calls++;
      expect(retry.renew).toBe(true);
      expect(retry.input).toContain("Investigation is unfinished.");
      expect(retry.input).toContain("Investigate a failed regression");
      await writeNotes(
        retry,
        2,
        "Recovered the original request after a worker crash. Investigation remains unfinished; no check has passed.",
      );
      return {
        nativeThreadId: "fake-recovery",
        assistantCharacters: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
      };
    });
    await resumed.drain();
    const notes = await resumed.memories("crash-chat");
    expect(calls).toBe(1);
    expect(notes.status).toBe("idle");
    expect(notes.notes?.revision).toBe(3);
    expect(notes.notes?.text).toContain("no check has passed");
    expect(notes.documents).toEqual([]);
    const after = new NodeSqlite.DatabaseSync(environment.DB_PATH, { readOnly: true });
    try {
      expect(after.prepare("SELECT last_seq FROM brain_curation_sessions").get()?.last_seq).toBe(2);
      expect(after.prepare("SELECT COUNT(*) AS n FROM memory_distill_jobs").get()?.n).toBe(0);
      expect(after.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
    } finally {
      after.close();
    }
  } finally {
    await resumed?.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGKILL");
      await exited;
    }
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
}, 30_000);
