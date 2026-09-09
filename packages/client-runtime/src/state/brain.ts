import type { BrainCommand, BrainResponse } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Option from "effect/Option";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { makeEnvironmentHttpApiUrlBuilder } from "../rpc/http.ts";

/** Apply a readChat reply within one thread's controller. */
export function retainChatContextOnError(
  previous: BrainResponse | null,
  next: BrainResponse,
): BrainResponse {
  if (
    !next.error ||
    next.chatMemories ||
    !previous?.chatMemories ||
    previous.state.workspaces.length !== 1 ||
    next.state.workspaces.length !== 1 ||
    previous.state.workspaces[0]?.id !== next.state.workspaces[0]?.id
  )
    return next;
  return { ...next, chatMemories: previous.chatMemories };
}

export const requestBrain = Effect.fn("clientRuntime.brain.request")(function* (
  command: BrainCommand,
) {
  const supervisor = yield* EnvironmentSupervisor;
  const prepared = yield* SubscriptionRef.get(supervisor.prepared);
  if (Option.isNone(prepared))
    return yield* Effect.fail(new Error("Connect to a computer before opening its brain."));
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: prepared.value,
    signer,
    remoteAuthorization,
    method: "POST",
    timeoutMs: 60_000,
    url: (base) => makeEnvironmentHttpApiUrlBuilder(base).brain.request(),
    request: ({ client, headers }) => client.brain.request({ payload: { command }, headers }),
  });
});
