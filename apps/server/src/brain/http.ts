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
import { ServerSettingsService } from "../serverSettings.ts";
import { BrainService } from "./BrainService.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { AnalyticsService } from "../telemetry/AnalyticsService.ts";

const ANALYTICS_COMMANDS = new Set([
  "start",
  "refreshGithub",
  "bindProject",
  "create",
  "configure",
  "import",
  "reindex",
  "importFolder",
  "removeSource",
  "cancel",
]);

export const brainHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "brain",
  Effect.fnUntraced(function* (handlers) {
    const service = yield* BrainService;
    const projections = yield* ProjectionSnapshotQuery;
    const settings = yield* ServerSettingsService;
    const analytics = yield* AnalyticsService;
    return handlers.handle(
      "request",
      Effect.fn("environment.brain.request")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        yield* requireEnvironmentScope(
          [
            "read",
            "readChat",
            "readDocument",
            "listGithubRepositories",
            "listGithubBranches",
          ].includes(args.payload.command.action)
            ? AuthOrchestrationReadScope
            : AuthOrchestrationOperateScope,
        );
        const runtime = yield* service.ready.pipe(
          Effect.catch((error) => failEnvironmentInternal("internal_error", error)),
        );
        const command = args.payload.command;
        if (command.action === "readDocument") {
          return yield* Effect.tryPromise(async () => ({
            state: await runtime.state(undefined, true),
            document: await runtime.brainDocument(command.workspaceId, command.documentId),
            error: null,
            createdWorkspaceId: null,
          })).pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
        }
        if (command.action === "read" && command.projectId) {
          const selectedProject = yield* projections
            .getProjectShellById(command.projectId)
            .pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
          if (Option.isSome(selectedProject))
            runtime.projectBindings.register(selectedProject.value);
        }
        if (command.action === "readChat") {
          const thread = yield* projections
            .getThreadShellById(command.threadId)
            .pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
          if (Option.isNone(thread))
            return yield* failEnvironmentInternal("internal_error", new Error("Chat not found."));
          const chatProject = yield* projections
            .getProjectShellById(thread.value.projectId)
            .pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
          if (Option.isSome(chatProject)) runtime.projectBindings.register(chatProject.value);
          return yield* Effect.tryPromise(async () => {
            try {
              return {
                state: await runtime.state(thread.value.projectId),
                chatMemories: await runtime.chatMemories(
                  thread.value.projectId,
                  command.threadId,
                  command.revision,
                ),
                error: null,
                createdWorkspaceId: null,
              };
            } catch (cause) {
              return {
                state: await runtime.state(thread.value.projectId, true),
                error: cause instanceof Error ? cause.message : "Could not load brain context.",
                createdWorkspaceId: null,
              };
            }
          }).pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
        }
        const project =
          command.action === "bindProject"
            ? yield* projections
                .getProjectShellById(command.projectId)
                .pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)))
            : Option.none();
        const response = yield* Effect.tryPromise(async () => {
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
              runtime.projectBindings.register(project.value);
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
            state: await runtime.state(
              undefined,
              command.action === "bindProject" ||
                (command.action === "read" && command.metadataOnly === true),
            ),
            error,
            createdWorkspaceId,
            ...(branches ? { branches } : {}),
            ...(repositories ? { repositories } : {}),
          };
        }).pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
        if (command.action === "bindProject" && !response.error) {
          yield* settings
            .updateSettings({
              projectBrainSetupComplete: Object.fromEntries(
                runtime.projectBindings.members(command.projectId).map((id) => [id, true]),
              ),
            })
            .pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
        }
        if (ANALYTICS_COMMANDS.has(command.action)) {
          yield* analytics.record("brain.command.completed", {
            action: command.action,
            success: response.error === null,
            ...(command.action === "create" || command.action === "configure"
              ? { cli: command.cli }
              : {}),
            ...(command.action === "bindProject"
              ? { connected: command.workspaceId !== null }
              : {}),
            workspaceCount: response.state.workspaces.length,
            sourceCount: response.state.workspaces.reduce(
              (total, workspace) => total + workspace.sources.length,
              0,
            ),
            indexedSourceCount: response.state.workspaces.reduce(
              (total, workspace) =>
                total + workspace.sources.filter((source) => source.status === "ready").length,
              0,
            ),
          });
        }
        return response;
      }),
    );
  }),
);
