import type { BrainCuratorRun, BrainCuratorResult, BrainCuratorRunner } from "@flow/brain-runtime";
import {
  ApprovalRequestId,
  CodexSettings,
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
import type { CodexAdapterShape } from "../provider/Services/CodexAdapter.ts";

const decodeSettings = Schema.decodeUnknownSync(CodexSettings);
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
  adapter: CodexAdapterShape;
  threadId: ThreadId;
  nativeThreadId: string;
  modelSelection: ModelSelection;
  pending: Deferred.Deferred<BrainCuratorResult, CuratorError> | undefined;
  assistantCharacters: number;
};

export function curatorSessionKey(
  request: Pick<BrainCuratorRun, "sessionId" | "endpoint" | "token">,
): string {
  // Rebinding a project can leave the same chat active in two brains. A worker
  // restart must also replace the native session's now-stale MCP connection.
  return NodeCrypto.createHash("sha256")
    .update(JSON.stringify([request.sessionId, request.endpoint, request.token]))
    .digest("hex");
}

const makeWorker = (request: BrainCuratorRun) =>
  Effect.gen(function* () {
    const settings = yield* (yield* ServerSettingsService).getSettings;
    const preferred = settings.defaultModelSelection?.instanceId;
    const entries = Object.entries(deriveProviderInstanceConfigMap(settings)).filter(
      ([, entry]) => entry.driver === "codex" && resolveProviderInstanceEnabled(entry),
    );
    const selected = entries.find(([id]) => id === preferred) ?? entries[0];
    if (!selected)
      return yield* new CuratorError({
        message:
          "Enable a Codex provider to extract notes, memories, and skills with your subscription.",
      });
    const instanceId = ProviderInstanceId.make(selected[0]);
    const instance = selected[1];
    const config = decodeSettings(instance.config ?? {});
    const environment = mergeProviderInstanceEnvironment(instance.environment);
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
    const adapter = yield* makeCodexAdapter(
      { ...effectiveConfig, launchArgs },
      {
        instanceId,
        environment,
        ephemeral: true,
        baseInstructions: request.instructions,
      },
    );
    const threadId = ThreadId.make(`flow-curator-${NodeCrypto.randomUUID()}`);
    const modelSelection = createModelSelection(instanceId, DEFAULT_MODEL, [
      { id: "reasoningEffort", value: "low" },
    ]);
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
                message: event.payload.errorMessage ?? `Codex extraction ${event.payload.state}.`,
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
            new CuratorError({ message: "Codex could not complete background extraction." }),
          );
      }),
    ).pipe(Effect.forkScoped);
    const session = yield* adapter.startSession({
      threadId,
      cwd: request.cwd,
      runtimeMode: "approval-required",
      modelSelection,
    });
    const nativeId = record(session.resumeCursor).threadId;
    if (typeof nativeId !== "string")
      return yield* new CuratorError({
        message: "Codex did not create an ephemeral extraction session.",
      });
    worker.nativeThreadId = nativeId;
    return worker;
  });

/** Dedicated instances of T3's adapter; no orchestration thread or native event log. */
export const makeBrainCurator = Effect.gen(function* () {
  const context = yield* Effect.context<Effect.Services<ReturnType<typeof makeWorker>>>();
  const run = Effect.runPromiseWith(context);
  const workers = new CuratorSessions<{ scope: Scope.Closeable; worker: Worker }>(({ scope }) =>
    run(Scope.close(scope, Exit.void)),
  );
  yield* Effect.addFinalizer(() => Effect.promise(() => workers.dispose()));
  const execute: BrainCuratorRunner = async (request) => {
    const sessionKey = curatorSessionKey(request);
    const entry = await workers.acquire(sessionKey, request.renew, async () => {
      const scope = await run(Scope.make());
      try {
        const worker = await run(
          makeWorker(request).pipe(Effect.provideService(Scope.Scope, scope)),
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
