import { HostProcessPlatform, HostProcessArchitecture } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
// @effect-diagnostics nodeBuiltinImport:off - Real native FalkorDB lifecycle test with stubbed external providers.
import { afterEach, describe, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { BrainRuntime } from "./BrainRuntime.ts";

const { index } = vi.hoisted(() => ({ index: vi.fn() }));
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
const knowledge = {
  entities: [
    {
      id: "repo:demo",
      name: "Demo",
      kind: "Repository",
      description: "Real persisted node",
      source: "README.md:1",
    },
  ],
  edges: [],
  memories: [],
};
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
          await runtime.command({ action: "create", name: "First", cli: "claude" });
          await runtime.command({ action: "create", name: "Second", cli: "codex" });
          const [first, second] = (await runtime.state()).workspaces;
          index.mockResolvedValue({ knowledge, coverage: "1 of 1" });
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
          index.mockImplementationOnce(async () => {
            started.resolve();
            await release.promise;
            throw new Error("Provider unavailable");
          });
          await runtime.command({ action: "reindex", workspaceId: first!.id, sourceId: source.id });
          await started.promise;
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
          expect((await runtime.state()).workspaces[0]!.knowledge.entities).toHaveLength(1);
          await runtime.close();
          runtimes.pop();
          const reopened = new BrainRuntime(NodePath.join(directory, "state"), {
            databasePath: NodePath.join(directory, "db"),
            platform,
            architecture,
          });
          runtimes.push(reopened);
          await reopened.initialize();
          expect((await reopened.state()).workspaces[0]!.knowledge.entities).toHaveLength(1);
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
        });
      }),
    120_000,
  );
});
