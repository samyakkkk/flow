import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { HostProcessPlatform, HostProcessArchitecture } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ServerConfig } from "../config.ts";
import { SharedBrainRuntime, serveSharedBrain, type BrainClient } from "./shared-runtime.ts";
import { BrainRuntime } from "./BrainRuntime.ts";
import { makeBrainCurator } from "./curator.ts";

class BrainServiceError extends Schema.TaggedErrorClass<BrainServiceError>()("BrainServiceError", {
  message: Schema.String,
}) {}
export class BrainService extends Context.Service<
  BrainService,
  {
    readonly ready: Effect.Effect<BrainClient, BrainServiceError>;
  }
>()("t3/brain/BrainService") {
  static readonly layer = Layer.effect(
    BrainService,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const path = yield* Path.Path;
      const platform = yield* HostProcessPlatform;
      const architecture = yield* HostProcessArchitecture;
      const projections = yield* ProjectionSnapshotQuery;
      const registerProjects = (runtime: BrainClient) =>
        Effect.gen(function* () {
          const snapshot = yield* projections
            .getShellSnapshot()
            .pipe(Effect.mapError((error) => new BrainServiceError({ message: String(error) })));
          for (const project of snapshot.projects) runtime.projectBindings.register(project);
          yield* Effect.tryPromise({
            try: () => runtime.projectBindings.adoptLegacy((id) => runtime.projectBrainId(id)),
            catch: (error) => new BrainServiceError({ message: String(error) }),
          });
        });
      if (process.env.FLOW_SHARED_BRAIN_HOME) {
        const shared = new SharedBrainRuntime(
          process.env.FLOW_SHARED_BRAIN_HOME,
          path.join(config.stateDir, "shared-brain"),
          process.env.FLOW_MANAGED_INSTANCE_ID ?? "",
        );
        yield* Effect.addFinalizer(() => Effect.promise(() => shared.close()));
        yield* Effect.tryPromise({
          try: () => shared.initialize(),
          catch: (cause) =>
            new BrainServiceError({
              message: cause instanceof Error ? cause.message : "Shared brain unavailable",
            }),
        });
        yield* registerProjects(shared);
        return BrainService.of({ ready: Effect.succeed(shared) });
      }
      const runCurator = yield* makeBrainCurator;
      const runtime = new BrainRuntime(path.join(config.stateDir, "brain"), {
        platform,
        architecture,
        runCurator,
      });
      yield* Effect.addFinalizer(() => Effect.promise(() => runtime.close()));
      yield* Effect.tryPromise({
        try: async () => {
          await runtime.initialize();
          runtime.assertAvailable();
        },
        catch: (cause) =>
          new BrainServiceError({
            message: cause instanceof Error ? cause.message : "Could not open the brain.",
          }),
      });
      if (process.env.FLOW_MANAGED_INSTANCE_ID) {
        const close = yield* Effect.tryPromise({
          try: () => serveSharedBrain(runtime, config.stateDir),
          catch: (cause) =>
            new BrainServiceError({
              message: cause instanceof Error ? cause.message : "Brain transport unavailable",
            }),
        });
        yield* Effect.addFinalizer(() => Effect.promise(close));
      }
      yield* registerProjects(runtime);
      return BrainService.of({ ready: Effect.succeed(runtime) });
    }),
  );
}
