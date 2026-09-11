// @effect-diagnostics nodeBuiltinImport:off - Real local transport and persistence test.
// @effect-diagnostics globalFetch:off - Verify authentication at the HTTP boundary.
import { it, expect } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
const { mkdtemp, mkdir, rm, readFile } = NodeFSP;
import * as NodeOS from "node:os";
const { tmpdir } = NodeOS;
import * as NodePath from "node:path";
const { join } = NodePath;
import * as Schema from "effect/Schema";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { ProjectId, BrainState } from "@t3tools/contracts";
import { serveSharedBrain, SharedBrainRuntime } from "./shared-runtime.ts";
import type { BrainRuntime } from "./BrainRuntime.ts";
import type { BrainCapture, BrainSessionContext } from "./session-worker.ts";
const decodeProjectId = Schema.decodeUnknownSync(ProjectId);
it("shares tools and capture over authenticated transport while isolating project bindings and replaying outages", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-shared-test-"));
  const source = join(root, "source");
  await mkdir(source);
  const sessions: string[] = [];
  const captures: BrainCapture[] = [];
  const project = decodeProjectId("test-project");
  const state: BrainState = {
    database: { status: "ready", message: "" },
    embeddings: { status: "idle", message: "" },
    github: { connected: false, login: "", message: "" },
    clis: [],
    workspaces: [
      {
        id: "brain",
        name: "Brain",
        cli: "claude",
        sources: [],
        projectIds: [project],
        knowledge: { entities: [], edges: [], memories: [] },
      },
    ],
  };
  const metadataRequests: boolean[] = [];
  const runtime = {
    state: async (_project?: ProjectId, metadataOnly = false) => {
      metadataRequests.push(metadataOnly);
      return state;
    },
    brainMemories: async (_id: string, session: string) => ({
      memories: [{ id: session, text: session, createdAt: 1788825600000, origin: "user" }],
      status: "idle",
    }),
    callBrainTool: async (
      _id: string,
      _name: string,
      _args: unknown,
      context: BrainSessionContext,
    ) => {
      sessions.push(context.session);
      return { content: [{ type: "text", text: "original orient" }] };
    },
    captureBrainEvent: async (_id: string, capture: BrainCapture) => {
      captures.push(capture);
    },
  } as unknown as BrainRuntime;
  let close = await serveSharedBrain(runtime, source);
  let a = new SharedBrainRuntime(source, join(root, "a"), "instance-a");
  const b = new SharedBrainRuntime(source, join(root, "b"), "instance-b");
  try {
    const endpoint = JSON.parse(await readFile(join(source, "brain-endpoint.json"), "utf8"));
    expect((await fetch(endpoint.url, { method: "POST", body: "{}" })).status).toBe(401);
    await a.initialize();
    await b.initialize();
    expect((await a.state()).workspaces[0]!.projectIds).toEqual([]);
    await a.state(undefined, true);
    expect(metadataRequests.at(-1)).toBe(true);
    await a.bindProject({ id: project, workspaceRoot: root }, "brain");
    expect(b.projectBrainId(project)).toBeUndefined();
    await b.bindProject({ id: project, workspaceRoot: root }, "brain");
    await a.callProjectTool(project, "orient", {}, { session: "same-thread" });
    await b.callProjectTool(project, "orient", {}, { session: "same-thread" });
    expect(sessions).toEqual(["instance-a:same-thread", "instance-b:same-thread"]);
    expect((await a.chatMemories(project, "same-thread")).memories[0]?.text).toBe(
      "instance-a:same-thread",
    );
    expect((await b.chatMemories(project, "same-thread")).memories[0]?.text).toBe(
      "instance-b:same-thread",
    );
    expect((await a.state(decodeProjectId("unbound"))).workspaces).toEqual([]);
    await close();
    const capturedAfter = await Effect.runPromise(Clock.currentTimeMillis);
    await a.captureProjectEvent(project, {
      context: { session: "same-thread" },
      receipt: "receipt-1",
      kind: "user_prompt",
      data: { text: "remember" },
    });
    await a.drainCapture();
    const pendingFiles = await NodeFSP.readdir(join(root, "a", "capture"));
    const pending = JSON.parse(
      await readFile(join(root, "a", "capture", pendingFiles[0]!), "utf8"),
    ) as { capture: BrainCapture };
    expect(pending.capture.occurredAt).toBeGreaterThanOrEqual(capturedAfter);
    expect(pending.capture.occurredAt).toBeLessThanOrEqual(
      await Effect.runPromise(Clock.currentTimeMillis),
    );
    await a.close();
    close = await serveSharedBrain(runtime, source);
    a = new SharedBrainRuntime(source, join(root, "a"), "instance-a");
    await a.initialize();
    await a.drainCapture();
    expect(captures).toHaveLength(1);
    expect(captures[0]!.context.session).toBe("instance-a:same-thread");
    expect(captures[0]!.occurredAt).toBe(pending.capture.occurredAt);
    expect(a.projectBrainId(project)).toBe("brain");
    expect(state.workspaces[0]!.projectIds).toEqual([project]);
  } finally {
    await a.close();
    await b.close();
    await close();
    await rm(root, { recursive: true, force: true });
  }
});
