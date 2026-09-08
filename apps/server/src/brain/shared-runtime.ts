// @effect-diagnostics nodeBuiltinImport:off - Private local instance transport.
// @effect-diagnostics globalFetch:off - Local transport outside the Effect runtime.
// @effect-diagnostics globalTimers:off - Persisted capture retry lifecycle.
// @effect-diagnostics globalDate:off - Ordered durable spool filenames.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeHttp from "node:http";
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import { McpSchema } from "effect/unstable/ai";
import { BrainCommand, BrainState, ProjectId } from "@t3tools/contracts";
import type { BrainRuntime } from "./BrainRuntime.ts";
import type { BrainCapture, BrainSessionContext } from "./session-worker.ts";
export type BrainClient = Pick<
  BrainRuntime,
  | "projectBrainId"
  | "callProjectTool"
  | "captureProjectEvent"
  | "bindProject"
  | "listGithubRepositories"
  | "listGithubBranches"
  | "command"
  | "state"
  | "close"
>;
const Context = Schema.Struct({
  session: Schema.String,
  repo: Schema.optionalKey(Schema.String),
  branch: Schema.optionalKey(Schema.String),
  workspaceRoot: Schema.optionalKey(Schema.String),
});
const Capture = Schema.Struct({
  context: Context,
  receipt: Schema.String,
  kind: Schema.Literals(["user_prompt", "update", "error", "created"]),
  data: Schema.Unknown,
  closed: Schema.optionalKey(Schema.Boolean),
});
const Request = Schema.Struct({
  method: Schema.Literals(["state", "command", "call", "capture", "repositories", "branches"]),
  instance: Schema.String,
  workspace: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  args: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  context: Schema.optional(Context),
  capture: Schema.optional(Capture),
  command: Schema.optional(BrainCommand),
});
const decodeRequest = Schema.decodeUnknownSync(Request);
const decodeDescriptor = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ url: Schema.String, token: Schema.String })),
);
export async function serveSharedBrain(runtime: BrainRuntime, stateDir: string) {
  const token = NodeCrypto.randomBytes(32).toString("hex");
  const server = NodeHttp.createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (
      request.method !== "POST" ||
      request.url !== "/" ||
      request.headers.authorization !== `Bearer ${token}`
    ) {
      response.writeHead(401).end("{}");
      return;
    }
    try {
      let body = "";
      for await (const chunk of request) {
        body += String(chunk);
        if (body.length > 4 * 1024 * 1024) throw Error("Request too large");
      }
      const input = decodeRequest(JSON.parse(body));
      if (!/^[a-zA-Z0-9-]{1,100}$/.test(input.instance)) throw Error("Invalid source instance");
      let result: unknown;
      switch (input.method) {
        case "state":
          result = await runtime.state();
          break;
        case "repositories":
          result = await runtime.listGithubRepositories();
          break;
        case "branches":
          if (!input.name) throw Error("Missing repository");
          result = await runtime.listGithubBranches(input.name);
          break;
        case "command":
          if (!input.command || input.command.action === "bindProject")
            throw Error("Project bindings belong to the calling instance");
          result = await runtime.command(input.command);
          break;
        case "call":
          if (!input.workspace || !input.name || !input.context)
            throw Error("Missing brain/tool/context");
          result = await runtime.callBrainTool(input.workspace, input.name, input.args ?? {}, {
            ...input.context,
            session: `${input.instance}:${input.context.session}`,
          });
          break;
        case "capture":
          if (!input.workspace || !input.capture) throw Error("Missing brain/capture");
          await runtime.captureBrainEvent(input.workspace, {
            ...input.capture,
            context: {
              ...input.capture.context,
              session: `${input.instance}:${input.capture.context.session}`,
            },
          });
          result = null;
          break;
      }
      response.end(JSON.stringify({ result }));
    } catch (error) {
      response.writeHead(503).end(
        JSON.stringify({
          error: error instanceof Error ? error.message : "Brain request failed",
        }),
      );
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No brain transport address");
  const file = NodePath.join(stateDir, "brain-endpoint.json");
  await NodeFSP.writeFile(
    file,
    JSON.stringify({ url: `http://127.0.0.1:${address.port}`, token }),
    {
      mode: 0o600,
    },
  );
  return async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await NodeFSP.rm(file, { force: true });
  };
}
const decodeReply = Schema.decodeUnknownSync(
  Schema.Struct({
    result: Schema.optional(Schema.Unknown),
    error: Schema.optionalKey(Schema.String),
  }),
);
const decodeBindings = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);
const decodeState = Schema.decodeUnknownSync(BrainState);
const decodeProjectId = Schema.decodeUnknownSync(ProjectId);
const decodeToolResult = Schema.decodeUnknownSync(McpSchema.CallToolResult);
const decodeWorkspaceId = Schema.decodeUnknownSync(Schema.NullOr(Schema.String));
const decodeRepositories = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ name: Schema.String, private: Schema.Boolean })),
);
const decodeBranches = Schema.decodeUnknownSync(Schema.Array(Schema.String));
export class SharedBrainRuntime implements BrainClient {
  private bindings: Record<string, string> = {};
  private queue = Promise.resolve();
  private writes = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private sequence = Date.now() * 1000;
  private readonly source: string;
  private readonly directory: string;
  private readonly instance: string;
  constructor(source: string, directory: string, instance: string) {
    this.source = source;
    this.directory = directory;
    this.instance = instance;
  }
  private async request(
    method: (typeof Request.Type)["method"],
    input: Record<string, unknown> = {},
  ): Promise<unknown> {
    const endpoint = decodeDescriptor(
      await NodeFSP.readFile(NodePath.join(this.source, "brain-endpoint.json"), "utf8"),
    );
    const url = new URL(endpoint.url);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1")
      throw Error("Shared brain must be a local managed instance");
    const response = await fetch(endpoint.url, {
      method: "POST",
      headers: { authorization: `Bearer ${endpoint.token}`, "content-type": "application/json" },
      body: JSON.stringify({ method, instance: this.instance, ...input }),
      signal: AbortSignal.timeout(30000),
    });
    const reply = decodeReply(await response.json());
    if (!response.ok || reply.error) throw Error(reply.error || "Shared brain is unavailable");
    return reply.result;
  }
  async initialize() {
    await NodeFSP.mkdir(NodePath.join(this.directory, "capture"), { recursive: true });
    try {
      this.bindings = decodeBindings(
        await NodeFSP.readFile(NodePath.join(this.directory, "bindings.json"), "utf8"),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const state = await this.state();
    if (state.database.status !== "ready")
      throw new Error(state.database.message || "Shared brain unavailable");
    this.flush();
  }
  projectBrainId(project: ProjectId) {
    return this.bindings[project];
  }
  async state() {
    const state = decodeState(await this.request("state"));
    return {
      ...state,
      workspaces: state.workspaces.map((w) => ({
        ...w,
        projectIds: Object.entries(this.bindings)
          .filter(([, id]) => id === w.id)
          .map(([id]) => decodeProjectId(id)),
      })),
    };
  }
  bindProject(project: { id: ProjectId; workspaceRoot: string }, workspace: string | null) {
    const pending = this.writes.then(async () => {
      if (workspace && !(await this.state()).workspaces.some((w) => w.id === workspace))
        throw Error("Brain is not available on the source instance");
      const next = { ...this.bindings };
      if (workspace) next[project.id] = workspace;
      else delete next[project.id];
      const file = NodePath.join(this.directory, "bindings.json");
      await NodeFSP.writeFile(file + ".tmp", JSON.stringify(next), { mode: 0o600 });
      await NodeFSP.rename(file + ".tmp", file);
      this.bindings = next;
    });
    this.writes = pending.catch(() => {});
    return pending;
  }
  async callProjectTool(
    project: ProjectId,
    name: string,
    args: Record<string, unknown>,
    context: BrainSessionContext,
  ) {
    const workspace = this.bindings[project];
    if (!workspace) throw Error("This project has no connected shared brain");
    return decodeToolResult(await this.request("call", { workspace, name, args, context }));
  }
  async captureProjectEvent(project: ProjectId, capture: BrainCapture) {
    const workspace = this.bindings[project];
    if (!workspace) return;
    this.sequence = Math.max(this.sequence + 1, Date.now() * 1000);
    const file = NodePath.join(this.directory, "capture", `${this.sequence}.json`);
    await NodeFSP.writeFile(file + ".tmp", JSON.stringify({ workspace, capture }), { mode: 0o600 });
    await NodeFSP.rename(file + ".tmp", file);
    this.flush();
  }
  private flush() {
    this.queue = this.queue
      .then(async () => {
        for (const name of (await NodeFSP.readdir(NodePath.join(this.directory, "capture")))
          .filter((n) => n.endsWith(".json"))
          .sort()) {
          const file = NodePath.join(this.directory, "capture", name);
          await this.request("capture", JSON.parse(await NodeFSP.readFile(file, "utf8")));
          await NodeFSP.unlink(file);
        }
      })
      .catch(() => {
        if (!this.closed && !this.timer) {
          this.timer = setTimeout(() => {
            this.timer = undefined;
            this.flush();
          }, 5000);
          this.timer.unref();
        }
      });
  }
  async command(command: BrainCommand) {
    return decodeWorkspaceId(await this.request("command", { command }));
  }
  async listGithubRepositories() {
    return [...decodeRepositories(await this.request("repositories"))];
  }
  async listGithubBranches(repository: string) {
    return [...decodeBranches(await this.request("branches", { name: repository }))];
  }
  async drainCapture() {
    await this.queue;
  }
  async close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    await this.writes;
    await this.queue;
  }
}
