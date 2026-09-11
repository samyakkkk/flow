import { expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ServerSettingsService } from "../serverSettings.ts";
import { ServerConfig } from "../config.ts";
import { AnalyticsService } from "../telemetry/AnalyticsService.ts";
import { OpenCodeRuntimeLive } from "../provider/opencodeRuntime.ts";
import { makeBrainCurator } from "./curator.ts";
import type { BrainCuratorRun } from "@flow/brain-runtime";

const { starts, stops, prompts } = vi.hoisted(() => ({
  starts: [] as string[],
  stops: [] as string[],
  prompts: [] as string[],
}));
function adapter(driver: string) {
  return Effect.gen(function* () {
    const events = yield* Queue.unbounded<unknown>();
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        stops.push(driver);
      }),
    );
    return {
      streamEvents: Stream.fromQueue(events),
      startSession: () =>
        Effect.sync(() => {
          starts.push(driver);
          return {
            resumeCursor:
              driver === "claude" ? { resume: "claude-native" } : { threadId: "codex-native" },
          };
        }),
      sendTurn: (request: { input: string }) =>
        Effect.gen(function* () {
          prompts.push(request.input);
          yield* Queue.offer(events, { type: "content.delta", payload: { delta: "done" } });
          yield* Queue.offer(events, { type: "turn.completed", payload: { state: "completed" } });
        }),
    };
  });
}
vi.mock("../provider/Layers/ClaudeAdapter.ts", () => ({
  makeClaudeAdapter: () => adapter("claude"),
}));
vi.mock("../provider/Layers/CodexAdapter.ts", () => ({ makeCodexAdapter: () => adapter("codex") }));
vi.mock("../provider/Drivers/CodexHomeLayout.ts", () => ({
  resolveCodexHomeLayout: () => Effect.succeed({}),
  materializeCodexShadowHome: () => Effect.void,
}));
vi.mock("../provider/Layers/CodexProvider.ts", () => ({
  withCodexAppServerClient: () =>
    Effect.succeed({
      client: {
        request: (method: string) =>
          Effect.succeed(
            method === "account/read" ? { account: { type: "chatgpt" } } : { config: {} },
          ),
      },
    }),
}));

it.effect(
  "runs the selected adapter, reuses warm context, and renews it after switching the Brain CLI",
  () =>
    Effect.gen(function* () {
      const request: BrainCuratorRun = {
        cli: "codex",
        sessionId: "chat",
        input: "original bounded context",
        instructions: "curate",
        cwd: "/tmp",
        endpoint: "http://localhost/curator",
        token: "fixture",
        renew: true,
      };
      yield* Effect.scoped(
        Effect.gen(function* () {
          const run = yield* makeBrainCurator;
          const first = yield* Effect.promise(() => run(request));
          expect(first).toMatchObject({ nativeThreadId: "codex-native", assistantCharacters: 4 });
          yield* Effect.promise(() => run({ ...request, input: "delta", renew: false }));
          expect(starts).toEqual(["codex"]);
          const switched = yield* Effect.promise(() =>
            run({ ...request, cli: "claude", renew: false }),
          );
          expect(switched).toEqual({ requiresContext: true });
          expect(prompts).toEqual(["original bounded context", "delta"]);
          const renewed = yield* Effect.promise(() => run({ ...request, cli: "claude" }));
          expect(renewed).toMatchObject({
            nativeThreadId: "claude-native",
            assistantCharacters: 4,
          });
          expect(starts).toEqual(["codex", "claude"]);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              ServerSettingsService.layerTest(),
              OpenCodeRuntimeLive,
              AnalyticsService.layerTest,
            ).pipe(
              Layer.provideMerge(ServerConfig.layerTest("/tmp", "/tmp")),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        ),
      );
      expect(stops.toSorted()).toEqual(["claude", "codex"]);
    }),
);
