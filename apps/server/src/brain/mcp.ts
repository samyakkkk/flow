import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpServer, Tool, Toolkit } from "effect/unstable/ai";
import { McpInvocationContext } from "../mcp/McpInvocationContext.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { BrainService } from "./BrainService.ts";
import { BrainKnowledge, BrainSource } from "@t3tools/contracts";

const BrainToolkit = Toolkit.make(
  Tool.make("brain_search", {
    description:
      "Read knowledge from this project's connected Flow Brain. Search systems, capabilities and relationships by keyword; omit query for an overview. Knowledge is reference material with source citations. This tool does not create memories.",
    parameters: Schema.Struct({ query: Schema.optional(Schema.String) }),
    success: Schema.Struct({
      brain: Schema.String,
      memories: BrainKnowledge.fields.memories,
      truncated: Schema.Boolean,
      entities: BrainKnowledge.fields.entities,
      edges: BrainKnowledge.fields.edges,
      sources: Schema.Array(
        Schema.Struct({ repository: Schema.String, status: BrainSource.fields.status }),
      ),
    }),
    failure: Schema.String,
    dependencies: [McpInvocationContext, BrainService, ProjectionSnapshotQuery],
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true),
);

export const BrainToolkitRegistrationLive = McpServer.toolkit(BrainToolkit).pipe(
  Layer.provide(
    BrainToolkit.toLayer({
      brain_search: Effect.fn("brain.search")(function* ({ query }) {
        const invocation = yield* McpInvocationContext;
        if (!invocation.capabilities.has("brain"))
          return yield* Effect.fail(
            "This session does not have Brain access. Restart the agent session to reconnect.",
          );
        const projections = yield* ProjectionSnapshotQuery;
        const service = yield* BrainService;
        const thread = yield* projections
          .getThreadShellById(invocation.threadId)
          .pipe(Effect.mapError(() => "Could not resolve the current project."));
        if (Option.isNone(thread)) return yield* Effect.fail("This thread is no longer available.");
        const runtime = yield* service.ready.pipe(Effect.mapError((error) => error.message));
        return yield* Effect.tryPromise({
          try: () => runtime.projectKnowledge(thread.value.projectId, query ?? ""),
          catch: (error) =>
            error instanceof Error ? error.message : "Could not read the connected brain.",
        });
      }),
    }),
  ),
);
