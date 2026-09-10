import type { BrainCuratorRun, BrainCuratorResult, BrainCuratorRunner } from "@flow/brain-runtime";
import {
  ApprovalRequestId,
  CodexSettings,
  ClaudeSettings,
  OpenCodeSettings,
  DEFAULT_MODEL_BY_PROVIDER,
  ProviderDriverKind,
  type ServerSettings,
  DEFAULT_MODEL,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  resolveProviderInstanceEnabled,
  type ModelSelection,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as NodeCrypto from "node:crypto";
import { clearMcpProviderSession, setMcpProviderSession } from "../mcp/McpProviderSession.ts";
import { expandHomePath } from "../pathExpansion.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  materializeCodexShadowHome,
  resolveCodexHomeLayout,
} from "../provider/Drivers/CodexHomeLayout.ts";
import { makeCodexAdapter } from "../provider/Layers/CodexAdapter.ts";
import { withCodexAppServerClient } from "../provider/Layers/CodexProvider.ts";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import { CuratorSessions } from "./curator-sessions.ts";
import type { ProviderAdapterShape } from "../provider/Services/ProviderAdapter.ts";
import type { ProviderAdapterError } from "../provider/Errors.ts";
import { makeClaudeAdapter } from "../provider/Layers/ClaudeAdapter.ts";
import { makeOpenCodeAdapter } from "../provider/Layers/OpenCodeAdapter.ts";
import { prepareOpenCodeCurator } from "./curator-opencode.ts";

const decodeCodex = Schema.decodeUnknownEffect(CodexSettings);
const decodeClaude = Schema.decodeUnknownEffect(ClaudeSettings);
const decodeOpenCode = Schema.decodeUnknownEffect(OpenCodeSettings);

class CuratorError extends Schema.TaggedErrorClass<CuratorError>()("CuratorError", {
  message: Schema.String,
}) {}
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function codexSubscriptionIssue(
  accountResponse: unknown,
  nativeConfig: unknown,
): string | undefined {
  const account = record(accountResponse);
  if (record(account.account).type !== "chatgpt")
    return "Sign the selected Codex provider in with ChatGPT to use subscription-backed extraction.";
  const provider = record(nativeConfig).model_provider;
  if (account.requiresOpenaiAuth === false || (provider != null && provider !== "openai"))
    return "The selected Codex instance uses a custom model backend. Choose its OpenAI ChatGPT provider for subscription-backed extraction.";
  return undefined;
}
// These are appended after the instance's launch options and never written to its config.
const CURATOR_FLAGS = [
  'history.persistence="none"',
  "features.shell_tool=false",
  "features.multi_agent=false",
  "features.apps=false",
  "features.plugins=false",
  'web_search="disabled"',
  "model_auto_compact_token_limit=100000",
];
const quoteArgument = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

type Worker = {
  adapter: ProviderAdapterShape<ProviderAdapterError>;
  threadId: ThreadId;
  nativeThreadId: string;
  modelSelection: ModelSelection;
  pending: Deferred.Deferred<BrainCuratorResult, CuratorError> | undefined;
  assistantCharacters: number;
};

export function curatorSessionKey(
  request: Pick<BrainCuratorRun, "sessionId" | "endpoint" | "token" | "cli">,
): string {
  // Rebinding a project can leave the same chat active in two brains. A worker
  // restart must also replace the native session's now-stale MCP connection.
  return NodeCrypto.createHash("sha256")
    .update(JSON.stringify([request.sessionId, request.endpoint, request.token, request.cli]))
    .digest("hex");
}

export function selectCuratorProvider(settings: ServerSettings, cli: BrainCuratorRun["cli"]) {
  if (!cli || !["codex", "claude", "opencode"].includes(cli))
    throw new Error("The Brain has no supported extraction CLI configured.");
  const driver = cli === "claude" ? "claudeAgent" : cli;
  const preferred = settings.defaultModelSelection?.instanceId;
  const entries = Object.entries(deriveProviderInstanceConfigMap(settings)).filter(
    ([, entry]) => entry.driver === driver && resolveProviderInstanceEnabled(entry),
  );
  const selected = entries.find(([id]) => id === preferred) ?? entries[0];
  if (!selected)
    throw new Error(
      `Enable a ${cli} provider to extract this Brain's notes, memories, and skills.`,
    );
  return { instanceId: ProviderInstanceId.make(selected[0]), instance: selected[1] };
}

const makeWorker = (request: BrainCuratorRun, settings: ServerSettings) =>
  Effect.gen(function* () {
    const { instanceId, instance } = yield* Effect.try({
      try: () => selectCuratorProvider(settings, request.cli),
      catch: (error) => new CuratorError({ message: String(error) }),
    });
    let environment = mergeProviderInstanceEnvironment(instance.environment);
    let cwd = request.cwd;
    let nativeModel: string | undefined;
    const adapter = yield* Effect.gen(function* () {
      if (instance.driver === "claudeAgent") {
        return yield* makeClaudeAdapter(yield* decodeClaude(instance.config ?? {}), {
          instanceId,
          environment,
          observerInstructions: request.instructions,
        });
      }
      if (instance.driver === "opencode") {
        const config = yield* decodeOpenCode(instance.config ?? {});
        if (config.serverUrl)
          return yield* new CuratorError({
            message:
              "Background extraction requires a local OpenCode provider so its tools and history can be isolated. Choose an OpenCode instance without a Server URL.",
          });
        const isolated = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () => prepareOpenCodeCurator(environment),
            catch: (error) => new CuratorError({ message: String(error) }),
          }),
          (isolated) => Effect.promise(isolated.close),
        );
        environment = isolated.environment;
        cwd = isolated.directory;
        nativeModel = isolated.model;
        return yield* makeOpenCodeAdapter(
          { ...config, binaryPath: expandHomePath(config.binaryPath) },
          {
            instanceId,
            environment,
            observerInstructions: request.instructions,
          },
        );
      }
      const config = yield* decodeCodex(instance.config ?? {});
      const layout = yield* resolveCodexHomeLayout(config);
      yield* materializeCodexShadowHome(layout);
      const effectiveConfig = {
        ...config,
        binaryPath: expandHomePath(config.binaryPath),
        homePath: layout.effectiveHomePath ?? "",
      };
      // Read the effective config through the same native client T3 uses for account
      // probes. Disable every inherited MCP server for this observer's process.
      const inheritedServers = yield* Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* withCodexAppServerClient({
            ...effectiveConfig,
            cwd: request.cwd,
            environment,
          });
          const account = yield* client.request("account/read", {});
          const response = yield* client.request("config/read", {
            includeLayers: false,
            cwd: request.cwd,
          });
          const subscriptionIssue = codexSubscriptionIssue(account, response.config);
          if (subscriptionIssue) return yield* new CuratorError({ message: subscriptionIssue });
          return Object.keys(record(record(response.config).mcp_servers));
        }),
      ).pipe(Effect.timeout("20 seconds"));
      // Codex's -c parser splits dotted keys itself; TOML-quoting a key creates a
      // different literal server name and fails its transport validation.
      if (inheritedServers.some((name) => !/^[a-zA-Z0-9_-]+$/.test(name)))
        return yield* new CuratorError({
          message: "A configured MCP server name cannot be isolated for background extraction.",
        });
      const overrides = [
        ...CURATOR_FLAGS,
        ...inheritedServers.map((name) => `mcp_servers.${name}.enabled=false`),
        "mcp_servers.t3-code.enabled=true",
      ];
      const launchArgs = [
        config.launchArgs,
        ...overrides.map((value) => `-c ${quoteArgument(value)}`),
      ]
        .filter(Boolean)
        .join(" ");
      return yield* makeCodexAdapter(
        { ...effectiveConfig, launchArgs },
        {
          instanceId,
          environment,
          ephemeral: true,
          baseInstructions: request.instructions,
        },
      );
    });
    const threadId = ThreadId.make(`flow-curator-${NodeCrypto.randomUUID()}`);
    const defaultSelection = settings.defaultModelSelection;
    const model =
      defaultSelection?.instanceId === instanceId
        ? defaultSelection.model
        : (nativeModel ??
          DEFAULT_MODEL_BY_PROVIDER[ProviderDriverKind.make(instance.driver)] ??
          DEFAULT_MODEL);
    const modelSelection = createModelSelection(
      instanceId,
      model,
      instance.driver === "codex" ? [{ id: "reasoningEffort", value: "low" }] : [],
    );
    const worker: Worker = {
      adapter,
      threadId,
      nativeThreadId: "",
      modelSelection,
      pending: undefined,
      assistantCharacters: 0,
    };
    setMcpProviderSession({
      environmentId: EnvironmentId.make("flow-passive"),
      threadId,
      providerSessionId: threadId,
      providerInstanceId: instanceId,
      endpoint: request.endpoint,
      authorizationHeader: `Bearer ${request.token}`,
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => clearMcpProviderSession(threadId)));
    yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.gen(function* () {
        if (event.type === "content.delta")
          worker.assistantCharacters += event.payload.delta.length;
        if (event.type === "request.opened" && event.requestId) {
          const ownTool =
            event.payload.requestType === "mcp_elicitation_approval" &&
            event.payload.appName === "t3-code";
          yield* adapter
            .respondToRequest(
              threadId,
              ApprovalRequestId.make(event.requestId),
              ownTool ? "acceptForSession" : "decline",
            )
            .pipe(Effect.catch(() => Effect.void));
        }
        if (!worker.pending) return;
        if (event.type === "turn.completed") {
          if (event.payload.state !== "completed") {
            yield* Deferred.fail(
              worker.pending,
              new CuratorError({
                message:
                  event.payload.errorMessage ?? `Background extraction ${event.payload.state}.`,
              }),
            );
          } else {
            const usage = event.payload.tokenUsage;
            yield* Deferred.succeed(worker.pending, {
              nativeThreadId: worker.nativeThreadId,
              assistantCharacters: worker.assistantCharacters,
              ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
              ...(usage?.cachedInputTokens !== undefined
                ? { cachedInputTokens: usage.cachedInputTokens }
                : {}),
              ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
            });
          }
        } else if (event.type === "turn.aborted")
          yield* Deferred.fail(worker.pending, new CuratorError({ message: event.payload.reason }));
        else if (event.type === "runtime.error")
          yield* Deferred.fail(
            worker.pending,
            new CuratorError({
              message: "The selected provider could not complete background extraction.",
            }),
          );
      }),
    ).pipe(Effect.forkScoped);
    const session = yield* adapter.startSession({
      threadId,
      cwd,
      runtimeMode: "approval-required",
      modelSelection,
    });
    const cursor = record(session.resumeCursor);
    const nativeId = cursor.sessionId ?? cursor.resume ?? cursor.threadId;
    if (typeof nativeId !== "string")
      return yield* new CuratorError({
        message: "The selected provider did not create a background extraction session.",
      });
    worker.nativeThreadId = nativeId;
    return worker;
  });

/** Dedicated instances of T3's adapter; no orchestration thread or native event log. */
export const makeBrainCurator = Effect.gen(function* () {
  const context = yield* Effect.context<
    Effect.Services<ReturnType<typeof makeWorker>> | ServerSettingsService
  >();
  const run = Effect.runPromiseWith(context);
  const workers = new CuratorSessions<{ scope: Scope.Closeable; worker: Worker }>(({ scope }) =>
    run(Scope.close(scope, Exit.void)),
  );
  yield* Effect.addFinalizer(() => Effect.promise(() => workers.dispose()));
  const execute: BrainCuratorRunner = async (request) => {
    const settings = await run(
      Effect.flatMap(ServerSettingsService, (service) => service.getSettings),
    );
    const selected = selectCuratorProvider(settings, request.cli);
    // A provider/configuration change needs fresh bounded source context, not a delta
    // delivered into the previous CLI's native conversation.
    const sessionKey =
      curatorSessionKey(request) +
      NodeCrypto.createHash("sha256")
        .update(JSON.stringify([selected, settings.defaultModelSelection]))
        .digest("hex");
    const entry = await workers.acquire(sessionKey, request.renew, async () => {
      const scope = await run(Scope.make());
      try {
        const worker = await run(
          makeWorker(request, settings).pipe(Effect.provideService(Scope.Scope, scope)),
        );
        return { scope, worker };
      } catch (error) {
        await run(Scope.close(scope, Exit.void));
        throw error;
      }
    });
    if (!entry) return { requiresContext: true };
    const { worker } = entry;
    try {
      return await run(
        Effect.gen(function* () {
          worker.pending = yield* Deferred.make<BrainCuratorResult, CuratorError>();
          worker.assistantCharacters = 0;
          yield* worker.adapter.sendTurn({
            threadId: worker.threadId,
            input: request.input,
            modelSelection: worker.modelSelection,
          });
          return yield* Deferred.await(worker.pending);
        }).pipe(Effect.timeout("4 minutes")),
      );
    } catch (error) {
      await workers.discard(sessionKey);
      throw error;
    } finally {
      worker.pending = undefined;
      workers.release(sessionKey);
    }
  };
  return execute;
});
