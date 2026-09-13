// @effect-diagnostics nodeBuiltinImport:off - Exercises host-selected modules in an isolated worker.
import { it, expect } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { startSessionWorker } from "./session-worker.ts";

it("loads only a host-selected integration with its owning Brain storage and tools", async () => {
  const directory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "flow-integration-worker-"),
  );
  const extension = NodePath.join(directory, "integration.mjs");
  await NodeFSP.writeFile(
    extension,
    `export function createIntegration(host) {
    host.database.exec('CREATE TABLE integration_fixture(value TEXT)');
    return {
      async configure(config) { host.database.prepare('INSERT INTO integration_fixture VALUES (?)').run(config.value); return { configured: true }; },
      async action(action) {
        if (action === 'read') return { rows: host.database.prepare('SELECT value FROM integration_fixture').all(), tools: host.tools.map(tool => tool.name) };
        if (action === 'tools') return host.call('list_skills', {}, 'fixture');
        throw Error('Unknown integration operation');
      },
      async close() { host.database.prepare('INSERT INTO integration_fixture VALUES (?)').run('closed'); }
    };
  }`,
  );
  const environment = {
    GRAPH_NAME: "integration_fixture",
    FALKOR_SOCKET: NodePath.join(directory, "unused.socket"),
    FLOW_EMBED_URL: "http://127.0.0.1:1",
    FLOW_EMBED_TOKEN: "fixture-embedding-token",
    FLOW_ADMIN_TOKEN: "fixture-admin-token",
    DB_PATH: NodePath.join(directory, "flow.db"),
    JOURNAL_PATH: NodePath.join(directory, "journal.jsonl"),
    OPENCODE_WORKSPACE_DIR: directory,
    FLOW_DISTILLER: "0",
    FLOW_POLL_DISABLE: "1",
    FLOW_DRAIN_DISABLE: "1",
  };
  const plain = await startSessionWorker(environment);
  try {
    await expect(plain.integration("read")).rejects.toThrow("no integration configured");
  } finally {
    await plain.close();
  }
  const worker = await startSessionWorker({
    ...environment,
    FLOW_BRAIN_INTEGRATION: NodeURL.pathToFileURL(extension).href,
  });
  try {
    expect(await worker.configureIntegration({ value: "private host fixture" })).toEqual({
      configured: true,
    });
    const result = (await worker.integration("read")) as {
      rows: { value: string }[];
      tools: string[];
    };
    expect(result.rows).toEqual([{ value: "private host fixture" }]);
    expect(result.tools).toContain("source_read");
    expect(await worker.integration("tools")).toHaveProperty("content");
    await expect(worker.integration("unknown")).rejects.toThrow("Unknown integration operation");
  } finally {
    await worker.close();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
