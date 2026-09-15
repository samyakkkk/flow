import { ServerConfig } from "../config.ts";
import {
  agentSetupInstructions,
  manageAgentIntegration,
  manageAllAgentIntegrations,
  bindProjectWithAgentTools,
} from "./agent-setup.ts";
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
    const config = yield* ServerConfig;
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
        if (command.action === "agentIntegrations") {
          if (command.operation === "configure" && command.harnesses === undefined)
            return yield* failEnvironmentInternal(
              "internal_error",
              new Error("Choose coding tools."),
            );
          const preferences =
            command.operation === "configure"
              ? yield* settings.updateSettings({ brainAgentHarnesses: command.harnesses! })
              : yield* settings.getSettings;
          const snapshot = yield* projections
            .getShellSnapshot()
            .pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
          for (const project of snapshot.projects) runtime.projectBindings.register(project);
          return yield* Effect.tryPromise(async () => ({
            state: await runtime.state(undefined, true),
            agentIntegrations: await manageAllAgentIntegrations({
              operation: command.operation,
              stateDir: process.env.FLOW_SHARED_BRAIN_HOME ?? config.stateDir,
              harnesses: preferences.brainAgentHarnesses,
              projects: snapshot.projects.map((project) => ({
                id: project.id,
                workspaceRoot: project.workspaceRoot,
                workspaceId: runtime.projectBrainId(project.id) ?? null,
              })),
            }),
            error: null,
            createdWorkspaceId: null,
          })).pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
        }
        if (command.action === "agentIntegration") {
          const project = yield* projections
            .getProjectShellById(command.projectId)
            .pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
          if (Option.isNone(project))
            return yield* failEnvironmentInternal(
              "internal_error",
              new Error("Project not found."),
            );
          runtime.projectBindings.register(project.value);
          const folder = project.value.workspaceRoot;
          return yield* Effect.tryPromise(async () => {
            const workspaceId = runtime.projectBrainId(command.projectId);
            try {
              const agentIntegration = await manageAgentIntegration({
                operation: command.operation,
                folder,
                stateDir: process.env.FLOW_SHARED_BRAIN_HOME ?? config.stateDir,
                ...(workspaceId ? { workspaceId } : {}),
                ...(command.harnesses ? { harnesses: command.harnesses } : {}),
              });
              return {
                state: await runtime.state(undefined, true),
                agentIntegration,
                error: null,
                createdWorkspaceId: null,
              };
            } catch (error) {
              return {
                state: await runtime.state(undefined, true),
                error:
                  error instanceof Error ? error.message : "Could not configure coding agents.",
                createdWorkspaceId: null,
              };
            }
          }).pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
        }
        if (command.action === "agentSetup") {
          return yield* Effect.tryPromise(async () => {
            const state = await runtime.state(undefined, true);
            const workspace = state.workspaces.find((item) => item.id === command.workspaceId);
            if (!workspace) throw Error("Brain not found");
            return {
              state,
              error: null,
              createdWorkspaceId: null,
              agentSetup: agentSetupInstructions({
                stateDir: process.env.FLOW_SHARED_BRAIN_HOME ?? config.stateDir,
                workspaceId: workspace.id,
                name: workspace.name,
                repositories: workspace.sources.map((source) => source.repository),
              }),
            };
          }).pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
        }
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
        if (Option.isSome(project)) runtime.projectBindings.register(project.value);
        const relatedProjects = Option.isSome(project)
          ? yield* Effect.forEach(runtime.projectBindings.members(project.value.id), (id) =>
              projections
                .getProjectShellById(id)
                .pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error))),
            )
          : [];
        const agentHarnesses = (yield* settings.getSettings).brainAgentHarnesses;
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
              await bindProjectWithAgentTools({
                folders: relatedProjects.flatMap((related) =>
                  Option.isSome(related) ? [related.value.workspaceRoot] : [],
                ),
                stateDir: process.env.FLOW_SHARED_BRAIN_HOME ?? config.stateDir,
                workspaceId: command.workspaceId,
                harnesses: agentHarnesses,
                bind: () => runtime.bindProject(project.value, command.workspaceId),
              });
            } else if (command.action === "listGithubRepositories") {
              repositories = await runtime.listGithubRepositories(command.workspaceId);
            } else if (command.action === "listGithubBranches") {
              branches = await runtime.listGithubBranches(command.repository, command.workspaceId);
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
