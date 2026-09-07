import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";

test("Codex adapter launch preserves injected MCPs without changing other backends", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "flow-agent-runtime-"));
  const env = {
    DB_PATH: join(dir, "flow.db"),
    FLOW_SESSION_SEARCH: "0",
    CODEX_PATH: process.execPath,
    CLAUDE_CODE_EXECUTABLE: process.execPath,
    DISABLE_MCP_CONFIG_FILTERING: "false",
  };
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const launches: NodeJS.ProcessEnv[] = [];
  // Exercise the real runtime launch and ACP handshake without starting an agent.
  t.mock.method(childProcess, "spawn", (_command: string, _args: string[], options: childProcess.SpawnOptions) => {
    launches.push({ ...options.env });
    const proc = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
    });
    const input = createInterface({ input: proc.stdin });
    input.on("line", (line) => {
      const request = JSON.parse(line);
      const result = request.method === "initialize"
        ? { protocolVersion: 1, agentCapabilities: {} }
        : request.method === "session/new"
          ? { sessionId: "probe", configOptions: [] }
          : {};
      proc.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
    });
    t.after(() => {
      input.close();
      proc.stdin.end();
      proc.stdout.end();
      proc.stderr.end();
      proc.exitCode = 0;
      proc.emit("exit", 0);
    });
    return proc;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  const { probeAgentOptions } = await import("../src/agents/runtime.js");
  for (const backend of ["codex", "claude"] as const) {
    const result = await probeAgentOptions(backend);
    assert.ok(!("error" in result), JSON.stringify(result));
  }
  assert.equal(launches.length, 2);
  assert.equal(launches[0].DISABLE_MCP_CONFIG_FILTERING, "true");
  assert.equal(launches[0].CODEX_PATH, process.execPath);
  assert.equal(launches[1].DISABLE_MCP_CONFIG_FILTERING, "false");
  assert.equal(process.env.DISABLE_MCP_CONFIG_FILTERING, "false");
});
