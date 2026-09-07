import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpServer } from "effect/unstable/ai";
import { McpInvocationContext } from "../mcp/McpInvocationContext.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { BrainService } from "./BrainService.ts";
import { originalBrainTools } from "./session-worker.ts";

// Discover the original MCP's schemas, descriptions and annotations verbatim.
// The T3 boundary only authenticates the chat and resolves its selected brain.
export const BrainToolkitRegistrationLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* McpServer.McpServer;
    const service = yield* BrainService;
    const projections = yield* ProjectionSnapshotQuery;
    const tools = yield* Effect.promise(originalBrainTools);
    for (const tool of tools) {
      yield* registry.addTool({
        tool,
        annotations: Context.empty(),
        handle: (args: Record<string, unknown>) =>
          Effect.gen(function* () {
            const scope = yield* Effect.serviceOption(McpInvocationContext);
            if (Option.isNone(scope) || !scope.value.capabilities.has("brain"))
              return yield* Effect.fail("This session does not have Brain access.");
            const thread = yield* projections
              .getThreadShellById(scope.value.threadId)
              .pipe(Effect.mapError(() => "Could not resolve the chat's project."));
            if (Option.isNone(thread)) return yield* Effect.fail("The chat no longer exists.");
            const project = yield* projections
              .getProjectShellById(thread.value.projectId)
              .pipe(Effect.mapError(() => "Could not resolve the project's work folder."));
            const workspaceRoot = Option.isSome(project) ? project.value.workspaceRoot : undefined;
            const runtime = yield* service.ready.pipe(Effect.mapError((error) => error.message));
            return yield* Effect.tryPromise({
              try: () =>
                runtime.callProjectTool(thread.value.projectId, tool.name, args, {
                  session: scope.value.threadId,
                  ...(workspaceRoot ? { workspaceRoot } : {}),
                  ...(thread.value.branch ? { branch: thread.value.branch } : {}),
                }),
              catch: (error) =>
                error instanceof Error ? error.message : "The connected brain is unavailable.",
            });
          }).pipe(
            Effect.catch((error) =>
              Effect.succeed({ isError: true, content: [{ type: "text" as const, text: error }] }),
            ),
          ),
      });
    }
  }),
);
