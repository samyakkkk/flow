// @effect-diagnostics globalTimers:off - Node child lifecycle timers must work outside an Effect runtime.
// @effect-diagnostics nodeBuiltinImport:off - Owns the isolated original Flow runtime process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Schema from "effect/Schema";
import { McpSchema } from "effect/unstable/ai";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const decodeTools = Schema.decodeUnknownSync(Schema.Array(McpSchema.Tool));
const decodeResult = Schema.decodeUnknownSync(McpSchema.CallToolResult);
export interface BrainSessionContext {
  repo?: string;
  branch?: string;
  session: string;
  workspaceRoot?: string;
}
export interface BrainCapture {
  context: BrainSessionContext;
  receipt: string;
  kind: "user_prompt" | "update" | "error" | "created";
  data: unknown;
  closed?: boolean;
}
export async function startSessionWorker(
  environment: Record<string, string>,
  catalog = false,
  entry?: string,
) {
  const packaged = NodePath.join(here, "brain-runtime.mjs");
  const filename =
    entry ??
    (NodeFS.existsSync(packaged)
      ? packaged
      : NodePath.resolve(here, "../../../../flow/orchestrator/src/brain-runtime.ts"));
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/^(FLOW_|FALKOR_|GRAPH_|GATEWAY_|ORCHESTRATOR_|OPENCODE_|DB_PATH$|JOURNAL_PATH$|LLM_|OPENROUTER_)/.test(
          key,
        ),
    ),
  );
  const child = NodeChildProcess.fork(filename, catalog ? ["--catalog"] : [], {
    execArgv: filename.endsWith(".ts")
      ? [
          "--import",
          NodePath.resolve(here, "../../../../flow/graph-gateway/node_modules/tsx/dist/loader.mjs"),
        ]
      : [],
    env: {
      ...inherited,
      ...environment,
      FLOW_GATEWAY_MCP: NodeFS.existsSync(packaged)
        ? NodePath.join(here, "mcp.mjs")
        : NodePath.resolve(here, "../../../../flow/graph-gateway/src/mcp.ts"),
      ELECTRON_RUN_AS_NODE: "1",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stdout?.resume();
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr = (stderr + String(chunk)).slice(-4000);
  });
  let nextId = 0;
  const pending = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (error: Error) => void }
  >();
  let exited = false;
  const exit = new Promise<void>((resolve) =>
    child.once("exit", () => {
      exited = true;
      resolve();
    }),
  );
  const ready = new Promise<ReadonlyArray<McpSchema.Tool>>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Flow brain startup timed out"));
    }, 30000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", () => {
      clearTimeout(timeout);
      const error = new Error(`Flow brain worker exited. ${stderr}`);
      reject(error);
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    });
    child.on(
      "message",
      (message: {
        ready?: boolean;
        tools?: unknown;
        id?: number;
        result?: unknown;
        error?: string;
      }) => {
        if (message.ready) {
          clearTimeout(timeout);
          try {
            resolve(decodeTools(message.tools));
          } catch {
            child.kill();
            reject(new Error("Invalid Flow tool catalog"));
          }
        } else if (message.id !== undefined) {
          const request = pending.get(message.id);
          pending.delete(message.id);
          if (message.error) request?.reject(new Error(message.error));
          else request?.resolve(message.result);
        }
      },
    );
  });
  const tools = await ready;
  async function request(method: string, params: unknown) {
    if (!child.connected) throw new Error("Flow brain is not connected");
    const id = ++nextId;
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Flow brain request timed out"));
      }, 30000);
      pending.set(id, {
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      child.send({ id, method, params }, (error) => {
        if (error) {
          pending.get(id)?.reject(error);
          pending.delete(id);
        }
      });
    });
  }
  return {
    tools,
    get alive() {
      return child.connected && !exited;
    },
    async call(name: string, args: Record<string, unknown>, context: BrainSessionContext) {
      return decodeResult(await request("call", { name, arguments: args, context }));
    },
    drain: () => request("drain", {}),
    capture: (input: BrainCapture) => request("capture", input),
    async close() {
      if (!catalog && child.connected) await request("drain", {}).catch(() => {});
      if (child.connected) child.disconnect();
      const timeout = setTimeout(() => {
        if (!exited) child.kill();
      }, 3000);
      await exit;
      clearTimeout(timeout);
    },
  };
}
export async function originalBrainTools() {
  const worker = await startSessionWorker({}, true);
  await worker.close();
  return worker.tools;
}
