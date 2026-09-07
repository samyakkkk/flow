import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as Option from "effect/Option";
import {
  annotateEnvironmentRequest,
  requireEnvironmentScope,
  failEnvironmentInternal,
} from "../auth/http.ts";
import { BrainService } from "./BrainService.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

export const brainHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "brain",
  Effect.fnUntraced(function* (handlers) {
    const service = yield* BrainService;
    const projections = yield* ProjectionSnapshotQuery;
    return handlers.handle(
      "request",
      Effect.fn("environment.brain.request")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        yield* requireEnvironmentScope(
          ["read", "listGithubRepositories", "listGithubBranches"].includes(
            args.payload.command.action,
          )
            ? AuthOrchestrationReadScope
            : AuthOrchestrationOperateScope,
        );
        const runtime = yield* service.ready.pipe(
          Effect.catch((error) => failEnvironmentInternal("internal_error", error)),
        );
        const command = args.payload.command;
        const project =
          command.action === "bindProject"
            ? yield* projections
                .getProjectShellById(command.projectId)
                .pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)))
            : Option.none();
        return yield* Effect.tryPromise(async () => {
          let error: string | null = null;
          let createdWorkspaceId: string | null = null;
          let branches: string[] | undefined;
          let repositories: { name: string; private: boolean }[] | undefined;
          try {
            if (command.action === "bindProject") {
              if (Option.isNone(project))
                throw new Error(
                  "Project not found on this computer. Retry after it finishes being created.",
                );
              await runtime.bindProject(project.value, command.workspaceId);
            } else if (command.action === "listGithubRepositories") {
              repositories = await runtime.listGithubRepositories();
            } else if (command.action === "listGithubBranches") {
              branches = await runtime.listGithubBranches(command.repository);
            } else createdWorkspaceId = await runtime.command(command);
          } catch (cause) {
            error = cause instanceof Error ? cause.message : "Brain operation failed.";
          }
          return {
            state: await runtime.state(),
            error,
            createdWorkspaceId,
            ...(branches ? { branches } : {}),
            ...(repositories ? { repositories } : {}),
          };
        }).pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
      }),
    );
  }),
);
