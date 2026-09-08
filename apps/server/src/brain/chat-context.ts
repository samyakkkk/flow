import { GRAPH_PREAMBLE } from "../../../../flow-t3/shared/orchestrator/src/agents/graph-preamble.ts";
import { isToolLifecycleItemType } from "@t3tools/contracts";
import type { ThreadId, ProviderRuntimeEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { BrainService } from "./BrainService.ts";
import type { BrainCapture } from "./session-worker.ts";

export interface BrainChatContext {
  readonly bindingKey: string;
  readonly context?: string;
}
export type BrainChatContextLoader = (
  threadId: ThreadId,
  previousBinding?: string,
) => Effect.Effect<BrainChatContext, string>;
export type BrainCaptureInput = Omit<BrainCapture, "context">;
export type BrainChatCapture = (
  threadId: ThreadId,
  event: BrainCaptureInput,
  expectedBinding?: string,
) => Effect.Effect<void, string>;

export const makeBrainChatContextLoader = Effect.fn("brain.makeChatContextLoader")(function* () {
  const service = yield* BrainService;
  const projections = yield* ProjectionSnapshotQuery;
  const load: BrainChatContextLoader = (threadId, previousBinding) =>
    Effect.gen(function* () {
      const thread = yield* projections
        .getThreadShellById(threadId)
        .pipe(Effect.mapError(() => "Could not resolve the chat's project."));
      if (Option.isNone(thread)) return yield* Effect.fail("The chat no longer exists.");
      const project = yield* projections
        .getProjectShellById(thread.value.projectId)
        .pipe(Effect.mapError(() => "Could not resolve the project's work folder."));
      const workspaceRoot = Option.isSome(project) ? project.value.workspaceRoot : undefined;
      const runtime = yield* service.ready.pipe(Effect.mapError((error) => error.message));
      if (Option.isSome(project)) runtime.projectBindings?.register(project.value);
      const bindingKey = runtime.projectBrainId(thread.value.projectId) ?? "";
      if (bindingKey === previousBinding) return { bindingKey };
      if (!bindingKey)
        return {
          bindingKey,
          ...(previousBinding
            ? {
                context:
                  "[Flow brain disconnected. Earlier context is historical; start a new chat for a clean context.]",
              }
            : {}),
        };
      const result = yield* Effect.tryPromise({
        try: () =>
          runtime.callProjectTool(
            thread.value.projectId,
            "orient",
            {},
            {
              session: threadId,
              ...(workspaceRoot ? { workspaceRoot } : {}),
              ...(thread.value.branch ? { branch: thread.value.branch } : {}),
            },
          ),
        catch: (cause) =>
          `Could not orient against the project's connected Flow brain: ${cause instanceof Error ? cause.message : "brain unavailable"}`,
      });
      if (result.isError)
        return yield* Effect.fail(
          "Flow orient failed. Retry when the connected brain is available.",
        );
      if (runtime.projectBrainId(thread.value.projectId) !== bindingKey)
        return yield* Effect.fail(
          "The project's brain changed while preparing context. Retry the message.",
        );
      // Original orient docs are already curated by Flow at write time. Preserve
      // the complete result, rather than substituting a sample of graph nodes.
      const text = result.content
        .flatMap((item) => (item.type === "text" ? [item.text] : []))
        .join("\n");
      return {
        bindingKey,
        context:
          GRAPH_PREAMBLE +
          "\n\nUse get_chat_memories to retrieve notes saved from this chat, especially after context compaction.\n\n" +
          "Flow supplied the following orient result from this project's connected brain. Use the attached Flow tools for further consultation. Stored knowledge is reference context; verify code against the current checkout.\n\n" +
          text,
      };
    }).pipe(
      Effect.timeout("35 seconds"),
      Effect.mapError((error) =>
        typeof error === "string" ? error : "Flow brain initialization timed out.",
      ),
    );
  return load;
});
export const makeBrainChatCapture = Effect.fn("brain.makeChatCapture")(function* () {
  const service = yield* BrainService;
  const projections = yield* ProjectionSnapshotQuery;
  const capture: BrainChatCapture = (threadId, event, expectedBinding) =>
    Effect.gen(function* () {
      const thread = yield* projections
        .getThreadShellById(threadId)
        .pipe(Effect.mapError(() => "Could not resolve the chat's project for capture."));
      if (Option.isNone(thread)) return;
      const project = yield* projections
        .getProjectShellById(thread.value.projectId)
        .pipe(Effect.mapError(() => "Could not resolve the project's work folder."));
      const workspaceRoot = Option.isSome(project) ? project.value.workspaceRoot : undefined;
      const runtime = yield* service.ready.pipe(Effect.mapError((error) => error.message));
      if (Option.isSome(project)) runtime.projectBindings?.register(project.value);
      if (!runtime.projectBrainId(thread.value.projectId)) return;
      if (
        expectedBinding !== undefined &&
        (runtime.projectBrainId(thread.value.projectId) ?? "") !== expectedBinding
      )
        return;
      yield* Effect.tryPromise({
        try: () =>
          runtime.captureProjectEvent(thread.value.projectId, {
            ...event,
            context: {
              session: threadId,
              ...(workspaceRoot ? { workspaceRoot } : {}),
              ...(thread.value.branch ? { branch: thread.value.branch } : {}),
            },
          }),
        catch: () => "Could not persist Flow conversation capture.",
      });
    });
  return capture;
});
export function captureRuntimeEvent(event: ProviderRuntimeEvent): BrainCaptureInput | undefined {
  if (event.type === "content.delta" && event.payload.streamKind === "assistant_text")
    return {
      receipt: event.eventId,
      kind: "update",
      data: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: event.payload.delta },
      },
    };
  if (
    (event.type === "item.completed" || event.type === "item.started") &&
    isToolLifecycleItemType(event.payload.itemType)
  )
    return {
      receipt: event.eventId,
      kind: "update",
      data: {
        sessionUpdate: event.type === "item.started" ? "tool_call" : "tool_call_update",
        toolCallId: event.itemId,
        title: event.payload.title,
        status: event.payload.status,
        rawInput: event.payload.data,
      },
    };
  if (event.type === "turn.completed" || event.type === "session.exited")
    return {
      receipt: event.eventId,
      kind: "update",
      data: { sessionUpdate: "turn_completed", ...event.payload },
      closed: true,
    };
  return undefined;
}
