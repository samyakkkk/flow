// @effect-diagnostics nodeBuiltinImport:off - Test-only stdio MCP client for the original gateway process.
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";
import { builderMcpCommand } from "./builder-assets.ts";
import type { BuilderContext } from "./indexer.ts";

export async function builderTestClient(context: BuilderContext) {
  const spec = builderMcpCommand();
  const child = NodeChildProcess.spawn(spec.command, spec.args, {
    env: {
      ...process.env,
      GATEWAY_MCP_MODE: "builder",
      GATEWAY_MCP_READONLY: "0",
      GRAPH_NAME: context.graph,
      FLOW_FIXED_GRAPH: context.graph,
      FALKOR_SOCKET: context.socket,
      FLOW_EMBED_URL: `${context.embedUrl}/embed`,
      FLOW_EMBED_TOKEN: context.embedToken,
      FLOW_ACTOR: "test:builder",
      JOURNAL_PATH: `${context.workspace}/journal.jsonl`,
      FLOW_MEMORY_URL: "",
      ORCHESTRATOR_URL: context.embedUrl,
      FLOW_ACTIVITY_URL: "",
      FLOW_JOB_ID: "",
      FLOW_WRITE_SCOPE: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let nextId = 0;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const lines = NodeReadline.createInterface({ input: child.stdout });
  let diagnostics = "";
  child.stderr.on("data", (data) => {
    diagnostics = (diagnostics + String(data)).slice(-4000);
  });
  child.on("exit", () => {
    for (const item of pending.values())
      item.reject(new Error(diagnostics || "Builder MCP exited"));
    pending.clear();
  });
  lines.on("line", (line) => {
    try {
      const response = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
      if (response.id === undefined) return;
      const item = pending.get(response.id);
      if (!item) return;
      pending.delete(response.id);
      if (response.error) item.reject(new Error(JSON.stringify(response.error)));
      else item.resolve(response.result);
    } catch {
      /* non-protocol diagnostic */
    }
  });
  const rpc = (method: string, params: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "flow-test", version: "1" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  return {
    async call(name: string, args: Record<string, unknown>) {
      const result = (await rpc("tools/call", { name, arguments: args })) as {
        content: { text: string }[];
        isError?: boolean;
      };
      if (result.isError) throw new Error(result.content.map((item) => item.text).join("\n"));
      return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    },
    async close() {
      const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
      child.stdin.end();
      await exited;
      lines.close();
    },
  };
}
