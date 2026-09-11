import { GRAPH_PREAMBLE } from "../../../../flow-t3/shared/orchestrator/src/agents/graph-preamble.ts";
import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  EventId,
  ProviderDriverKind,
  ThreadId,
  type OrchestrationThreadShell,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { BrainService } from "./BrainService.ts";
import type { BrainRuntime } from "./BrainRuntime.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  makeBrainChatContextLoader,
  makeBrainChatCapture,
  captureRuntimeEvent,
} from "./chat-context.ts";

it("retains the provider event's original timestamp for delayed Brain capture", () => {
  const createdAt = "2026-01-02T03:04:05.000Z";
  const captured = captureRuntimeEvent({
    eventId: EventId.make("historical-delta"),
    provider: ProviderDriverKind.make("codex"),
    threadId: ThreadId.make("chat"),
    createdAt,
    type: "content.delta",
    payload: { streamKind: "assistant_text", delta: "The focused check passed." },
  });
  expect(captured?.occurredAt).toBe(Date.parse(createdAt));
  expect(captured?.data).toMatchObject({ content: { text: "The focused check passed." } });
});

it("retains provider failures and interruption reasons for passive recovery", () => {
  const base = {
    eventId: EventId.make("provider-failure"),
    provider: ProviderDriverKind.make("codex"),
    threadId: ThreadId.make("chat"),
    createdAt: "2026-01-02T03:04:05.000Z",
  };
  const failure = captureRuntimeEvent({
    ...base,
    type: "runtime.error",
    payload: { message: "Subscription limit reached.", class: "provider_error" },
  });
  expect(failure?.kind).toBe("error");
  expect(failure?.data).toMatchObject({ message: "Subscription limit reached." });
  const aborted = captureRuntimeEvent({
    ...base,
    type: "turn.aborted",
    payload: { reason: "User stopped the interrupted verification." },
  });
  expect(aborted?.closed).toBe(true);
  expect(aborted?.data).toMatchObject({
    state: "interrupted",
    reason: "User stopped the interrupted verification.",
  });
  const exited = captureRuntimeEvent({
    ...base,
    type: "session.exited",
    payload: { reason: "Provider process disconnected.", recoverable: true },
  });
  expect(exited?.closed).toBe(true);
  expect(exited?.data).toMatchObject({
    state: "session exited",
    reason: "Provider process disconnected.",
  });
});

it.effect(
  "uses real orient output, preserves it uncapped, and respects changing/disconnected bindings",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("worktree-chat");
      const projectId = ProjectId.make("project");
      let binding: string | undefined;
      let reads = 0;
      let race = false;
      let fail = false;
      let captures = 0;
      const orientText = "Original curated orientation\n" + "x".repeat(30000);
      const runtime = {
        projectBrainId: () => binding,
        callProjectTool: async (
          project: ProjectId,
          name: string,
          _args: unknown,
          context: unknown,
        ) => {
          expect(project).toBe(projectId);
          expect(name).toBe("orient");
          expect(context).toMatchObject({
            session: threadId,
            workspaceRoot: "/project",
            branch: "feature",
          });
          reads++;
          if (race) binding = "other";
          return { isError: fail, content: [{ type: "text", text: orientText }] };
        },
        captureProjectEvent: async () => {
          captures++;
        },
      } as unknown as BrainRuntime;
      const projections = {
        getThreadShellById: () =>
          Effect.succeed(Option.some({ projectId, branch: "feature" } as OrchestrationThreadShell)),
        getProjectShellById: () =>
          Effect.succeed(Option.some({ workspaceRoot: "/project" } as OrchestrationProjectShell)),
      } as unknown as ProjectionSnapshotQuery["Service"];
      const [load, capture] = yield* Effect.all([
        makeBrainChatContextLoader(),
        makeBrainChatCapture(),
      ]).pipe(
        Effect.provideService(BrainService, { ready: Effect.succeed(runtime) }),
        Effect.provideService(ProjectionSnapshotQuery, projections),
      );
      expect(yield* load(threadId)).toEqual({ bindingKey: "" });
      yield* capture(threadId, {
        receipt: "unconnected",
        kind: "user_prompt",
        data: { text: "hello" },
      });
      expect(reads).toBe(0);
      expect(captures).toBe(0);
      binding = "team";
      const initialContext = (yield* load(threadId, "")).context;
      expect(initialContext).toContain(orientText);
      expect(initialContext).toContain(GRAPH_PREAMBLE);
      expect(yield* load(threadId, "team")).toEqual({ bindingKey: "team" });
      expect(reads).toBe(1);
      yield* capture(
        threadId,
        { receipt: "event-1", kind: "user_prompt", data: { text: "user" } },
        "team",
      );
      expect(captures).toBe(1);
      binding = undefined;
      expect((yield* load(threadId, "team")).context).toContain("disconnected");
      yield* capture(threadId, { receipt: "event-2", kind: "user_prompt", data: {} }, "team");
      expect(captures).toBe(1);
      binding = "team";
      fail = true;
      expect(yield* load(threadId).pipe(Effect.flip)).toContain("orient failed");
      fail = false;
      race = true;
      expect(yield* load(threadId).pipe(Effect.flip)).toContain("brain changed");
    }),
);
