import {
  DesktopFlowServiceActionResultSchema,
  DesktopFlowServiceStatusSchema,
  type DesktopFlowServiceActionResult,
  type DesktopFlowServiceStatus,
} from "@t3tools/contracts";
import { HostProcessPlatform, HostProcessUserId } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as FlowService from "../../backend/flowService.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

// The Flow service outlives the app, so Settings needs to describe it and act
// on it. All three methods fail soft: a status read reports whatever it could
// learn, and an action reports why it did not happen. Nothing here rejects at
// the renderer — a settings panel that vanishes on a bad read is a worse answer
// than one that says the service is unreachable.

/** Host facts the plain service module takes as input, plus whatever a test
    overrode. Reading them here keeps that module free of `process`. */
const resolveInput = (overrides: Partial<FlowService.FlowServiceInput>) =>
  Effect.gen(function* () {
    const host = yield* HostProcessPlatform;
    const uid = yield* HostProcessUserId;
    return { host, uid: uid ?? 0, ...overrides } satisfies FlowService.FlowServiceInput;
  });

const unreadableStatus = (
  input: FlowService.FlowServiceInput,
  detail: string,
): DesktopFlowServiceStatus => {
  const location = FlowService.unitLocation({ host: input.host });
  return {
    installed: false,
    loaded: false,
    current: false,
    label: location.label,
    unitPath: location.path,
    instance: {
      phase: "invalid",
      environmentId: null,
      dataHome: null,
      serverOrigin: null,
      error: detail,
    },
  };
};

const actionFailure = (detail: string): DesktopFlowServiceActionResult => ({
  ok: false,
  reason: "failed",
  detail,
});

/** `overrides` is the test seam: production registers the methods with none,
    so they read the real registry and run the real service manager. */
export const makeFlowServiceIpcMethods = (
  overrides: Partial<FlowService.FlowServiceInput> = {},
) => ({
  getFlowServiceStatus: DesktopIpc.makeIpcMethod({
    channel: IpcChannels.GET_FLOW_SERVICE_STATUS_CHANNEL,
    payload: Schema.Void,
    result: DesktopFlowServiceStatusSchema,
    handler: Effect.fn("desktop.ipc.flowService.getStatus")(function* () {
      const input = yield* resolveInput(overrides);
      return yield* Effect.promise(() => FlowService.readFlowServiceStatus(input)).pipe(
        Effect.catchCause((cause) => Effect.succeed(unreadableStatus(input, Cause.pretty(cause)))),
      );
    }),
  }),

  stopFlowService: DesktopIpc.makeIpcMethod({
    channel: IpcChannels.STOP_FLOW_SERVICE_CHANNEL,
    payload: Schema.Void,
    result: DesktopFlowServiceActionResultSchema,
    handler: Effect.fn("desktop.ipc.flowService.stop")(function* () {
      const input = yield* resolveInput(overrides);
      return yield* Effect.promise(() => FlowService.stopFlowService(input)).pipe(
        Effect.catchCause((cause) => Effect.succeed(actionFailure(Cause.pretty(cause)))),
      );
    }),
  }),

  startFlowService: DesktopIpc.makeIpcMethod({
    channel: IpcChannels.START_FLOW_SERVICE_CHANNEL,
    payload: Schema.Void,
    result: DesktopFlowServiceActionResultSchema,
    handler: Effect.fn("desktop.ipc.flowService.start")(function* () {
      const input = yield* resolveInput(overrides);
      return yield* Effect.promise(() =>
        FlowService.startFlowService({
          ...input,
          fallbackNodePath: process.execPath,
          fallbackNodeEnv: { ELECTRON_RUN_AS_NODE: "1" },
        }),
      ).pipe(Effect.catchCause((cause) => Effect.succeed(actionFailure(Cause.pretty(cause)))));
    }),
  }),

  restartFlowService: DesktopIpc.makeIpcMethod({
    channel: IpcChannels.RESTART_FLOW_SERVICE_CHANNEL,
    payload: Schema.Void,
    result: DesktopFlowServiceActionResultSchema,
    handler: Effect.fn("desktop.ipc.flowService.restart")(function* () {
      const input = yield* resolveInput(overrides);
      return yield* Effect.promise(() => FlowService.restartFlowService(input)).pipe(
        Effect.catchCause((cause) => Effect.succeed(actionFailure(Cause.pretty(cause)))),
      );
    }),
  }),
});

const methods = makeFlowServiceIpcMethods();

export const getFlowServiceStatus = methods.getFlowServiceStatus;
export const stopFlowService = methods.stopFlowService;
export const restartFlowService = methods.restartFlowService;
export const startFlowService = methods.startFlowService;
