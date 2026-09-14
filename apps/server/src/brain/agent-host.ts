import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ServerSettings } from "@t3tools/contracts";
import type { BrainCuratorRun, BrainCuratorRunner } from "@flow/brain-runtime";
import { layerHeadless } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { AnalyticsService } from "../telemetry/AnalyticsService.ts";
import { OpenCodeRuntimeLive } from "../provider/opencodeRuntime.ts";
import { makeBrainCurator } from "./curator.ts";

class BrainAgentError extends Schema.TaggedErrorClass<BrainAgentError>()("BrainAgentError", {
  message: Schema.String,
}) {}

class BrainAgent extends Context.Service<BrainAgent, BrainCuratorRunner>()(
  "t3/brain/agent-host/BrainAgent",
) {}

/** Embed the same isolated T3 provider adapters used by desktop background tasks. */
export function createBrainAgentHost(directory: string, settings: () => unknown) {
  const read = Effect.flatMap(
    Effect.sync(settings),
    Schema.decodeUnknownEffect(ServerSettings),
  ).pipe(Effect.orDie);
  const configuration = Layer.succeed(ServerSettingsService, {
    start: Effect.void,
    ready: Effect.void,
    getSettings: read,
    updateSettings: () => Effect.die("Update settings through the owning Brain host."),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.succeed(Stream.empty),
  });
  const runtime = ManagedRuntime.make(
    Layer.effect(BrainAgent, makeBrainCurator).pipe(
      Layer.provide(Layer.mergeAll(configuration, OpenCodeRuntimeLive, AnalyticsService.layerTest)),
      Layer.provide(layerHeadless(directory, directory)),
      Layer.provide(NodeServices.layer),
    ),
  );
  return {
    run: (request: BrainCuratorRun, signal?: AbortSignal) =>
      runtime.runPromise(
        Effect.flatMap(BrainAgent, (run) =>
          Effect.tryPromise({
            try: () => run({ ...request, ...(signal ? { signal } : {}) }),
            catch: (error) =>
              new BrainAgentError({
                message: error instanceof Error ? error.message : String(error),
              }),
          }),
        ),
        signal ? { signal } : undefined,
      ),
    close: () => runtime.dispose(),
  };
}
