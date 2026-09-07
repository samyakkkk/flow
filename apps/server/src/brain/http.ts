import { HostProcessPlatform, HostProcessArchitecture } from "@t3tools/shared/hostProcess";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as Path from "effect/Path";
import {
  annotateEnvironmentRequest,
  requireEnvironmentScope,
  failEnvironmentInternal,
} from "../auth/http.ts";
import { ServerConfig } from "../config.ts";
import { BrainRuntime } from "./BrainRuntime.ts";

export const brainHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "brain",
  Effect.fnUntraced(function* (handlers) {
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
    return handlers.handle(
      "request",
      Effect.fn("environment.brain.request")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        yield* requireEnvironmentScope(
          args.payload.command.action === "read"
            ? AuthOrchestrationReadScope
            : AuthOrchestrationOperateScope,
        );
        return yield* Effect.tryPromise(async () => {
          initialization ??= runtime.initialize();
          await initialization;
          let error: string | null = null;
          try {
            await runtime.command(args.payload.command);
          } catch (cause) {
            error = cause instanceof Error ? cause.message : "Brain operation failed.";
          }
          return { state: await runtime.state(), error };
        }).pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
      }),
    );
  }),
);
