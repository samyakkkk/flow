import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { BrainService } from "./BrainService.ts";
import type { BrainRuntime } from "./BrainRuntime.ts";
import { BrainToolkitRegistrationLive } from "./mcp.ts";
import { McpInvocationContext } from "../mcp/McpInvocationContext.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "brain-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const scope = {
  environmentId: EnvironmentId.make("brain-test"),
  threadId: ThreadId.make("thread-a"),
  providerSessionId: "session-a",
  providerInstanceId: ProviderInstanceId.make("claude"),
  capabilities: new Set(["brain"] as const),
  issuedAt: 1,
};
const projectId = ProjectId.make("project-a");

it.effect(
  "MCP resolves the project from its authenticated thread and refuses a session without Brain access",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const readProjects: string[] = [];
        const runtime = {
          chatMemories: async (id: ProjectId, session: string) => {
            expect(id).toBe(projectId);
            expect(session).toBe(scope.threadId);
            return {
              memories: [
                { id: "note-a", text: "Only this chat", createdAt: 1, origin: "user_stated" },
              ],
              status: "idle",
            };
          },
          callProjectTool: async (id: ProjectId) => {
            readProjects.push(id);
            return { content: [{ type: "text", text: "Only project A's brain" }] };
          },
        } as unknown as BrainRuntime;
        const projections = {
          getProjectShellById: () => Effect.succeed(Option.none()),
          getThreadShellById: (id: ThreadId) => {
            expect(id).toBe(scope.threadId);
            return Effect.succeed(Option.some({ projectId } as OrchestrationThreadShell));
          },
        } as unknown as ProjectionSnapshotQuery["Service"];
        const layer = BrainToolkitRegistrationLive.pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provideMerge(Layer.succeed(BrainService, { ready: Effect.succeed(runtime) })),
          Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, projections)),
        );
        yield* Effect.gen(function* () {
          const server = yield* McpServer.McpServer;
          const result = yield* server
            .callTool({ name: "search_knowledge", arguments: { query: "architecture" } })
            .pipe(
              Effect.provideService(McpSchema.McpServerClient, client),
              Effect.provideService(McpInvocationContext, scope),
            );
          expect(result.isError).not.toBe(true);
          expect(readProjects).toEqual([projectId]);
          const memories = yield* server
            .callTool({ name: "get_chat_memories", arguments: { session: "other-chat" } })
            .pipe(
              Effect.provideService(McpSchema.McpServerClient, client),
              Effect.provideService(McpInvocationContext, scope),
            );
          expect(memories.content).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: "text",
                text: expect.stringContaining("Only this chat"),
              }),
            ]),
          );
          const deniedMemories = yield* server
            .callTool({ name: "get_chat_memories", arguments: {} })
            .pipe(Effect.provideService(McpSchema.McpServerClient, client));
          expect(deniedMemories.isError).toBe(true);
          const denied = yield* server.callTool({ name: "search_knowledge", arguments: {} }).pipe(
            Effect.provideService(McpSchema.McpServerClient, client),
            Effect.provideService(McpInvocationContext, {
              ...scope,
              capabilities: new Set<"brain">(),
            }),
          );
          expect(denied.isError).toBe(true);
          expect(readProjects).toEqual([projectId]);
        }).pipe(Effect.provide(layer));
      }),
    ),
);
