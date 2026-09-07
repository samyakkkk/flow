import { HostProcessPlatform, HostProcessArchitecture } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ServerConfig } from "../config.ts";
import { BrainRuntime } from "./BrainRuntime.ts";

class BrainServiceError extends Schema.TaggedErrorClass<BrainServiceError>()("BrainServiceError", {
  message: Schema.String,
}) {}
export class BrainService extends Context.Service<
  BrainService,
  {
    readonly ready: Effect.Effect<BrainRuntime, BrainServiceError>;
  }
>()("t3/brain/BrainService") {
  static readonly layer = Layer.effect(
    BrainService,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const path = yield* Path.Path;
      const platform = yield* HostProcessPlatform;
      const architecture = yield* HostProcessArchitecture;
      const runtime = new BrainRuntime(path.join(config.stateDir, "brain"), {
        platform,
        architecture,
      });
      let initialization: Promise<void> | undefined;
      yield* Effect.addFinalizer(() => Effect.promise(() => runtime.close()));
      return BrainService.of({
        ready: Effect.tryPromise({
          try: async () => {
            initialization ??= runtime.initialize();
            await initialization;
            return runtime;
          },
          catch: (cause) =>
            new BrainServiceError({
              message: cause instanceof Error ? cause.message : "Could not open the brain.",
            }),
        }),
      });
    }),
  );
}
