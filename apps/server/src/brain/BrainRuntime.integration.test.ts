import { builderTestClient } from "./builder-test-client.ts";
import type { BuilderContext } from "./indexer.ts";
import { HostProcessPlatform, HostProcessArchitecture } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
// @effect-diagnostics nodeBuiltinImport:off - Real native FalkorDB lifecycle test with stubbed external providers.
import { afterEach, describe, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { BrainRuntime } from "./BrainRuntime.ts";
import { ProjectId, BrainWorkspace } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
const decodeRegistry = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(BrainWorkspace)),
);

const encodeRegistry = Schema.encodeSync(Schema.fromJsonString(Schema.Array(BrainWorkspace)));
const decodeProjectBindings = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
);

const { index, captureState } = vi.hoisted(() => ({
  index: vi.fn(),
  captureState: {
    fail: false,
    receipts: [] as unknown[],
    resources: [] as Record<string, string>[],
  },
}));
vi.mock("./session-worker.ts", async (original) => {
  const module = await original<typeof import("./session-worker.ts")>();
  return {
    ...module,
    startSessionWorker: async (env: Record<string, string>, catalog?: boolean) => {
      if (!catalog) captureState.resources.push(env);
      const worker = await module.startSessionWorker(
        { ...env, FLOW_DISTILLER: "0", FLOW_SESSION_SEARCH: "0" },
        catalog,
        process.env.T3_TEST_BRAIN_ENTRY,
      );
      const capture = worker.capture;
      worker.capture = async (input) => {
        if (captureState.fail) throw new Error("Simulated unavailable worker");
        const result = await capture(input);
        captureState.receipts.push(result);
        return result;
      };
      return worker;
    },
  };
});
vi.mock("./indexer.ts", () => ({ indexRepository: index }));
vi.mock("./process.ts", async (original) => ({
  ...(await original<typeof import("./process.ts")>()),
  run: vi.fn(async (binary: string, args: string[]) => {
    if (binary === "gh" && args[0] === "api") return '{"login":"test-user"}';
    if (args[0] === "rev-parse") return "a".repeat(40);
    if (args[0] === "branch") return "main";
    return "installed";
  }),
}));
vi.mock("./embeddings.ts", () => ({
  BrainEmbeddings: class {
    status = "ready";
    message = "test model";
    async embed() {
      return [1, 0, 0];
    }
    async close() {}
  },
}));
async function writeDemo(
  _cli: string,
  repository: string,
  _repoPath: string,
  _jobPath: string,
  _signal: AbortSignal,
  context: BuilderContext,
) {
  const client = await builderTestClient(context);
  try {
    const result = await client.call("upsert_entity", {
      graph: "wrong_brain",
      type: "Repository",
      id: `repo:${repository}`,
      name: "Demo",
      description: "Real persisted node",
      confirm: true,
      provenance: {
        actor: "model-supplied",
        evidence: `${repository} README.md:1`,
        confidence: "high",
      },
    });
    expect(result.status).toMatch(/created|updated/);
  } finally {
    await client.close();
  }
  return { summary: "Demo indexed", incremental: false };
}
const directories: string[] = [];
const runtimes: BrainRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const directory of directories.splice(0))
    await NodeFSP.rm(directory, { recursive: true, force: true });
  index.mockReset();
});

describe("native brain persistence", () => {
  it.effect(
    "shares one database, isolates workspaces, preserves the last good index on failure, and survives restart",
    () =>
      Effect.gen(function* () {
        const platform = yield* HostProcessPlatform;
        const architecture = yield* HostProcessArchitecture;
        if (
          !(
            (platform === "darwin" && architecture === "arm64") ||
            (platform === "linux" && architecture === "x64")
          )
        )
          return;
        yield* Effect.promise(async () => {
          const directory = await NodeFSP.mkdtemp("/tmp/flow-brain-test-");
          directories.push(directory);
          const runtime = new BrainRuntime(NodePath.join(directory, "state"), {
            databasePath: NodePath.join(directory, "db"),
            platform,
            architecture,
          });
          runtimes.push(runtime);
          await runtime.initialize();
          expect((await runtime.state()).database.status).toBe("ready");
          const firstId = await runtime.command({ action: "create", name: "First", cli: "claude" });
          const secondId = await runtime.command({
            action: "create",
            name: "Second",
            cli: "codex",
          });
          const [first, second] = (await runtime.state()).workspaces;
          expect(firstId).toBe(first?.id);
          expect(secondId).toBe(second?.id);
          expect(await runtime.dbGraphNames()).toEqual(
            expect.arrayContaining([
              `brain_${first!.id.replaceAll("-", "")}`,
              `brain_${second!.id.replaceAll("-", "")}`,
            ]),
          );
          await expect(
            runtime.command({ action: "create", name: "first", cli: "claude" }),
          ).rejects.toThrow("already exists");
          index.mockImplementation(writeDemo);
          await runtime.command({
            action: "import",
            workspaceId: first!.id,
            repository: "octocat/Hello-World",
          });
          await runtime.drain();
          const firstState = await runtime.state();
          expect(firstState.workspaces[0]!.knowledge.entities[0]?.name).toBe("Demo");
          expect(firstState.workspaces[1]!.knowledge.entities).toHaveLength(0);
          expect(firstState.workspaces[0]!.knowledge.entities[0]?.source).toContain(
            `/blob/${"a".repeat(40)}/README.md#L1`,
          );
          const source = firstState.workspaces[0]!.sources[0]!;
          const started = Promise.withResolvers<void>();
          const release = Promise.withResolvers<void>();
          index.mockImplementationOnce(
            async (_cli, repository, _repoPath, _jobPath, _signal, context: BuilderContext) => {
              const client = await builderTestClient(context);
              try {
                const duplicate = await client.call("upsert_entity", {
                  type: "Repository",
                  id: "repo:duplicate",
                  name: "Demo",
                  provenance: { actor: "model" },
                });
                expect(duplicate.status).toBe("similar_exists");
                await client.call("upsert_entity", {
                  type: "Service",
                  id: "svc:live",
                  name: "Live API",
                  description: "Service from another repository",
                  confirm: true,
                  provenance: {
                    actor: "model",
                    evidence: "other/repo src/api.ts:1",
                    confidence: "high",
                  },
                });
                await client.call("upsert_entity", {
                  type: "UsageContract",
                  id: "contract:api",
                  name: "API behavior",
                  confirm: true,
                  props: {
                    purpose: "Read results",
                    uses: "status",
                    does_not_use: "billing",
                    sensitive_to: "status shape",
                    not_sensitive_to: "retention",
                    triage_note: "Check consumers",
                  },
                  provenance: {
                    actor: "model",
                    evidence: "other/repo src/api.ts:1",
                    confidence: "high",
                  },
                });
                const inspected = await client.call("get_entity", { id: "svc:live" });
                expect(inspected).toEqual(
                  expect.objectContaining({
                    node: expect.objectContaining({
                      props: expect.objectContaining({ created_by: "test:builder" }),
                    }),
                  }),
                );
                await client.call("upsert_relation", {
                  from: `repo:${repository}`,
                  to: "svc:live",
                  type: "USES",
                  provenance: { actor: "model", evidence: "README.md:1", confidence: "high" },
                });
              } finally {
                await client.close();
              }
              started.resolve();
              await release.promise;
              throw new Error("Provider unavailable");
            },
          );
          await runtime.command({ action: "reindex", workspaceId: first!.id, sourceId: source.id });
          await started.promise;
          const during = (await runtime.state()).workspaces[0]!;
          expect(during.sources[0]!.status).toBe("indexing");
          expect(during.knowledge.entities.some((node) => node.id === "svc:live")).toBe(true);
          expect(during.knowledge.edges).toEqual(
            expect.arrayContaining([expect.objectContaining({ to: "svc:live", label: "USES" })]),
          );
          expect(await runtime.dbGraphNames()).not.toContain("wrong_brain");
          expect(
            during.knowledge.entities.find((node) => node.id === "contract:api")?.properties
              ?.does_not_use,
          ).toBe("billing");
          await runtime.command({
            action: "import",
            workspaceId: second!.id,
            repository: "octocat/Spoon-Knife",
          });
          const queued = (await runtime.state()).workspaces[1]!.sources[0]!;
          expect(queued.status).toBe("queued");
          expect(index).toHaveBeenCalledTimes(2);
          await runtime.command({ action: "cancel", workspaceId: second!.id, sourceId: queued.id });
          release.resolve();
          await runtime.drain();
          expect(index).toHaveBeenCalledTimes(2);
          expect((await runtime.state()).workspaces[1]!.sources[0]!.status).toBe("cancelled");
          expect((await runtime.state()).workspaces[0]!.sources[0]!.status).toBe("error");
          expect((await runtime.state()).workspaces[0]!.knowledge.entities).toHaveLength(3);
          await runtime.close();
          runtimes.pop();
          const reopened = new BrainRuntime(NodePath.join(directory, "state"), {
            databasePath: NodePath.join(directory, "db"),
            platform,
            architecture,
          });
          runtimes.push(reopened);
          await reopened.initialize();
          expect((await reopened.state()).workspaces[0]!.knowledge.entities).toHaveLength(3);
          expect(
            (await reopened.state()).workspaces.find((workspace) => workspace.id === second!.id)
              ?.cli,
          ).toBe("codex");
          const duplicate = new BrainRuntime(NodePath.join(directory, "state"), {
            databasePath: NodePath.join(directory, "db"),
            platform,
            architecture,
          });
          runtimes.push(duplicate);
          await duplicate.initialize();
          expect((await duplicate.state()).database.status).toBe("error");
          expect((await reopened.state()).database.status).toBe("ready");
          const repoFolder = NodePath.join(directory, "local-repo");
          await NodeFSP.mkdir(repoFolder);
          const project = { id: ProjectId.make("project-one"), workspaceRoot: repoFolder };
          const otherProject = { id: ProjectId.make("project-two"), workspaceRoot: repoFolder };
          await expect(reopened.bindProject(project, "missing-brain")).rejects.toThrow("not found");
          await reopened.bindProject(project, first!.id);
          const context = {
            session: "integration-chat",
            repo: "octocat/Hello-World",
            branch: "main",
          };
          captureState.resources.length = 0;
          const orient = await reopened.callProjectTool(project.id, "orient", {}, context);
          expect(orient.isError).not.toBe(true);
          expect(
            orient.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n"),
          ).toContain("CONNECTED PROJECT");
          const orientations = await Promise.all(
            ["alpha-repo", "beta-repo"].map((repo) =>
              reopened.callProjectTool(project.id, "orient", {}, { ...context, repo }),
            ),
          );
          expect(
            orientations[0]!.content
              .flatMap((item) => (item.type === "text" ? [item.text] : []))
              .join("\n"),
          ).toContain('repo "alpha-repo"');
          expect(
            orientations[1]!.content
              .flatMap((item) => (item.type === "text" ? [item.text] : []))
              .join("\n"),
          ).toContain('repo "beta-repo"');
          const found = await reopened.callProjectTool(
            project.id,
            "find_entity",
            { q: "Demo" },
            context,
          );
          expect(found.isError).not.toBe(true);
          expect(
            found.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n"),
          ).toContain("Demo");
          const denied = await reopened.callProjectTool(
            project.id,
            "read_query",
            { graph: "other-brain", cypher: "MATCH (n) RETURN n" },
            context,
          );
          expect(denied.isError).toBe(true);
          const saved = await reopened.callProjectTool(
            project.id,
            "remember",
            { text: "The integration sentinel uses zebrapotato isolation." },
            context,
          );
          expect(saved.isError).not.toBe(true);
          await reopened.captureProjectEvent(project.id, {
            context,
            receipt: "user-1",
            kind: "user_prompt",
            data: { text: "Preserve the complete Flow brain" },
          });
          await reopened.captureProjectEvent(project.id, {
            context,
            receipt: "user-1",
            kind: "user_prompt",
            data: { text: "Preserve the complete Flow brain" },
          });
          await reopened.drainCapture();
          expect(captureState.receipts[0]).toEqual(captureState.receipts[1]);
          const memory = await reopened.callProjectTool(
            project.id,
            "search_knowledge",
            { query: "zebrapotato" },
            context,
          );
          expect(
            memory.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n"),
          ).toContain("zebrapotato");

          await reopened.drain();
          const chatNotes = await reopened.chatMemories(project.id, context.session);
          expect(chatNotes.memories.some((note) => note.text.includes("zebrapotato"))).toBe(true);
          expect((await reopened.chatMemories(project.id, "another-chat")).memories).toEqual([]);
          expect(chatNotes.revision).toBeTruthy();
          const changed = reopened.chatMemories(project.id, context.session, chatNotes.revision);
          await reopened.callProjectTool(
            project.id,
            "remember",
            { text: "Live updates use another zebrapotato sentinel." },
            context,
          );
          await reopened.drain();
          const updatedNotes = await changed;
          expect(updatedNotes.revision).not.toBe(chatNotes.revision);
          expect(updatedNotes.memories.length).toBeGreaterThan(chatNotes.memories.length);

          const sourceCount = (await reopened.state()).workspaces[0]!.sources.length;
          await reopened.bindProject(project, first!.id);
          await reopened.bindProject(otherProject, first!.id);
          expect((await reopened.state()).workspaces[0]!.sources).toHaveLength(sourceCount);
          expect(reopened.projectBrainId(project.id)).toBe(first!.id);
          await reopened.bindProject(project, second!.id);
          const isolated = await reopened.callProjectTool(
            project.id,
            "search_knowledge",
            { query: "zebrapotato" },
            context,
          );
          expect(new Set(captureState.resources.map((env) => env.GRAPH_NAME)).size).toBe(2);
          expect(new Set(captureState.resources.map((env) => env.FALKOR_SOCKET)).size).toBe(1);
          expect(new Set(captureState.resources.map((env) => env.FLOW_EMBED_URL)).size).toBe(1);
          expect(new Set(captureState.resources.map((env) => env.FLOW_EMBED_TOKEN)).size).toBe(1);

          expect(
            isolated.content
              .flatMap((item) => (item.type === "text" ? [item.text] : []))
              .join("\n"),
          ).not.toContain("zebrapotato");
          await reopened.drain();
          expect(reopened.projectBrainId(project.id)).toBe(second!.id);
          expect(reopened.projectBrainId(otherProject.id)).toBe(first!.id);
          expect((await reopened.state()).workspaces[0]!.sources).toHaveLength(sourceCount);
          await reopened.bindProject(project, null);
          await expect(reopened.callProjectTool(project.id, "orient", {}, context)).rejects.toThrow(
            "no connected brain",
          );
          const boundState = await reopened.state();
          expect(boundState.workspaces[0]!.projectIds).toEqual([otherProject.id]);
          expect(boundState.workspaces[1]!.projectIds).toEqual([]);
          expect(
            decodeProjectBindings(
              await NodeFSP.readFile(
                NodePath.join(directory, "state", "project-brains.json"),
                "utf8",
              ),
            ),
          ).toEqual({
            [`project:${project.id}`]: null,
            [`project:${otherProject.id}`]: first!.id,
          });
          const races = await Promise.allSettled([
            reopened.command({ action: "create", name: "Race", cli: "claude" }),
            reopened.command({ action: "create", name: "race", cli: "claude" }),
          ]);
          expect(races.filter((result) => result.status === "fulfilled")).toHaveLength(1);
          const localSource = (await reopened.state()).workspaces[0]!.sources.find(
            (entry) => entry.localPath,
          );
          expect(localSource).toBeDefined();
          await reopened.command({
            action: "removeSource",
            workspaceId: first!.id,
            sourceId: localSource!.id,
          });
          expect((await reopened.state()).workspaces[0]!.sources).toHaveLength(sourceCount - 1);
          const passStarted = Promise.withResolvers<void>();
          const passRelease = Promise.withResolvers<void>();
          const beforePasses = index.mock.calls.length;
          index.mockImplementationOnce(async (...args) => {
            passStarted.resolve();
            await passRelease.promise;
            return writeDemo(...(args as Parameters<typeof writeDemo>));
          });
          await reopened.command({
            action: "reindex",
            workspaceId: first!.id,
            sourceId: source.id,
          });
          await passStarted.promise;
          await reopened.command({
            action: "reindex",
            workspaceId: first!.id,
            sourceId: source.id,
          });
          await reopened.command({
            action: "reindex",
            workspaceId: first!.id,
            sourceId: source.id,
          });
          passRelease.resolve();
          await reopened.drain();
          expect(index.mock.calls.length - beforePasses).toBe(2);
          // The builder may use a normalized ID; freshness updates must not add a second repository.
          const aliasBrain = await reopened.command({
            action: "create",
            name: "Alias",
            cli: "claude",
          });
          index.mockImplementationOnce(
            async (_cli, repository, _repoPath, _jobPath, _signal, context: BuilderContext) => {
              const client = await builderTestClient(context);
              try {
                await client.call("upsert_entity", {
                  type: "Repository",
                  id: "repo:normalized",
                  name: repository,
                  description: "Actual builder node",
                  provenance: { actor: "model", evidence: "README.md:1" },
                });
              } finally {
                await client.close();
              }
              return { summary: "Indexed", incremental: false };
            },
          );
          await reopened.command({
            action: "import",
            workspaceId: aliasBrain!,
            repository: "octocat/Variant",
          });
          await reopened.drain();
          expect(
            (await reopened.state()).workspaces
              .find((entry) => entry.id === aliasBrain)
              ?.knowledge.entities.map((node) => node.id),
          ).toEqual(["repo:normalized"]);
          captureState.fail = true;
          await reopened.captureProjectEvent(otherProject.id, {
            context,
            receipt: "recover-after-crash",
            kind: "user_prompt",
            data: { text: "Retain the durable capture" },
          });
          await reopened.drainCapture();
          const spool = NodePath.join(directory, "state", "capture", first!.id);
          expect((await NodeFSP.readdir(spool)).length).toBeGreaterThan(0);
          captureState.fail = false;
          await reopened.close();
          runtimes.splice(runtimes.indexOf(reopened), 1);
          const file = NodePath.join(directory, "state", "workspaces.json");
          const crashed = decodeRegistry(await NodeFSP.readFile(file, "utf8")).map((workspace) => ({
            ...workspace,
            sources: workspace.sources.map((entry) =>
              entry.id === source.id ? { ...entry, status: "indexing" as const } : entry,
            ),
          }));
          await NodeFSP.writeFile(file, encodeRegistry(crashed));
          const recovered = new BrainRuntime(NodePath.join(directory, "state"), {
            databasePath: NodePath.join(directory, "db"),
            platform,
            architecture,
          });
          runtimes.push(recovered);
          const beforeRecovery = index.mock.calls.length;
          await recovered.initialize();
          await recovered.drain();
          await recovered.drainCapture();
          expect(await NodeFSP.readdir(spool)).toHaveLength(0);
          const retainedMemory = await recovered.callProjectTool(
            otherProject.id,
            "search_knowledge",
            { query: "zebrapotato" },
            context,
          );
          expect(
            retainedMemory.content
              .flatMap((item) => (item.type === "text" ? [item.text] : []))
              .join("\n"),
          ).toContain("zebrapotato");
          expect(
            (await recovered.chatMemories(otherProject.id, context.session)).memories.some((note) =>
              note.text.includes("zebrapotato"),
            ),
          ).toBe(true);
          expect((await recovered.chatMemories(otherProject.id, "other-thread")).memories).toEqual(
            [],
          );
          expect(index.mock.calls.length - beforeRecovery).toBe(1);
          expect((await recovered.state()).workspaces[0]!.sources[0]!.status).toBe("ready");
        });
      }),
    120_000,
  );
});
