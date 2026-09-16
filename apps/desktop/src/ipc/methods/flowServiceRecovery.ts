import {
  DesktopFlowServiceAdoptionSchema,
  DesktopFlowServiceRecoveryResultSchema,
  type DesktopFlowServiceAdoption,
  type DesktopFlowServiceRecoveryResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as FlowServiceRecovery from "../../backend/flowServiceRecovery.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as ElectronShell from "../../electron/ElectronShell.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

// The four things the in-window recovery screen can do when the desktop could
// not attach to the Flow service. Like the Settings panel next door, every
// method fails soft: a screen whose only job is to get the user unstuck must
// never be the thing that throws.
//
// None of these starts a server of ours. Retry re-runs the attach (which may
// adopt again), open-in-browser hands the *running* service to the browser,
// and the legacy relaunch is the one path back to a private child — explicitly
// chosen by the user, for one launch.

const failed = (detail: string): DesktopFlowServiceRecoveryResult => ({ ok: false, detail });
const succeeded: DesktopFlowServiceRecoveryResult = { ok: true, detail: null };

/** Injected so each method is testable without Electron, a filesystem or a
    real service. Production wires the real pool, shell and app. */
export interface FlowServiceRecoverySeams {
  readonly retryAttach: Effect.Effect<void>;
  readonly readAdoption: () => Promise<DesktopFlowServiceAdoption | null>;
  readonly mintPairingUrl: () => Promise<FlowServiceRecovery.MintedPairingUrl>;
  readonly openExternal: (url: string) => Effect.Effect<boolean>;
  readonly requestLegacyBackend: () => Promise<void>;
  readonly relaunch: Effect.Effect<void>;
}

export const makeFlowServiceRecoveryIpcMethods = <R>(
  resolveSeams: Effect.Effect<FlowServiceRecoverySeams, never, R>,
) => ({
  retryFlowServiceAttach: DesktopIpc.makeIpcMethod({
    channel: IpcChannels.RETRY_FLOW_SERVICE_ATTACH_CHANNEL,
    payload: Schema.Void,
    result: DesktopFlowServiceRecoveryResultSchema,
    handler: Effect.fn("desktop.ipc.flowServiceRecovery.retryAttach")(function* () {
      const seams = yield* resolveSeams;
      return yield* seams.retryAttach.pipe(
        Effect.as(succeeded),
        Effect.catchCause((cause) => Effect.succeed(failed(Cause.pretty(cause)))),
      );
    }),
  }),

  getFlowServiceAdoption: DesktopIpc.makeIpcMethod({
    channel: IpcChannels.GET_FLOW_SERVICE_ADOPTION_CHANNEL,
    payload: Schema.Void,
    result: Schema.NullOr(DesktopFlowServiceAdoptionSchema),
    handler: Effect.fn("desktop.ipc.flowServiceRecovery.getAdoption")(function* () {
      const seams = yield* resolveSeams;
      return yield* Effect.promise(() => seams.readAdoption()).pipe(
        Effect.catchCause(() => Effect.succeed(null)),
      );
    }),
  }),

  openFlowServiceInBrowser: DesktopIpc.makeIpcMethod({
    channel: IpcChannels.OPEN_FLOW_SERVICE_IN_BROWSER_CHANNEL,
    payload: Schema.Void,
    result: DesktopFlowServiceRecoveryResultSchema,
    handler: Effect.fn("desktop.ipc.flowServiceRecovery.openInBrowser")(function* () {
      const seams = yield* resolveSeams;
      return yield* Effect.gen(function* () {
        const minted = yield* Effect.promise(() => seams.mintPairingUrl());
        if (!minted.ok || minted.pairingUrl === undefined)
          return failed(minted.detail ?? "A pairing link could not be created.");
        // The credential lives in this URL, so it goes to the OS browser and
        // nowhere else. The renderer learns only whether it opened.
        const opened = yield* seams.openExternal(minted.pairingUrl);
        return opened ? succeeded : failed("The browser could not be opened.");
      }).pipe(Effect.catchCause((cause) => Effect.succeed(failed(Cause.pretty(cause)))));
    }),
  }),

  relaunchWithLegacyBackend: DesktopIpc.makeIpcMethod({
    channel: IpcChannels.RELAUNCH_WITH_LEGACY_BACKEND_CHANNEL,
    payload: Schema.Void,
    result: DesktopFlowServiceRecoveryResultSchema,
    handler: Effect.fn("desktop.ipc.flowServiceRecovery.relaunchLegacy")(function* () {
      const seams = yield* resolveSeams;
      return yield* Effect.gen(function* () {
        // The marker is written before the relaunch, never after: a relaunch
        // that races the write would come back attached and look like the
        // button did nothing.
        yield* Effect.promise(() => seams.requestLegacyBackend());
        yield* seams.relaunch;
        return succeeded;
      }).pipe(Effect.catchCause((cause) => Effect.succeed(failed(Cause.pretty(cause)))));
    }),
  }),
});

const productionSeams = Effect.gen(function* () {
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronShell = yield* ElectronShell.ElectronShell;
  const recoveryEnvironment: FlowServiceRecovery.RecoveryEnvironment = {
    homeDirectory: environment.homeDirectory,
    stateDir: environment.stateDir,
    executablePath: process.execPath,
    backendEntryPath: environment.backendEntryPath,
    backendCwd: environment.backendCwd,
  };
  return {
    retryAttach: pool.retryPrimaryAttach,
    readAdoption: () => FlowServiceRecovery.readFlowServiceAdoption(recoveryEnvironment),
    mintPairingUrl: () => FlowServiceRecovery.mintServicePairingUrl(recoveryEnvironment),
    openExternal: (url) => electronShell.openExternal(url),
    requestLegacyBackend: () =>
      FlowServiceRecovery.requestLegacyBackendOnNextLaunch(environment.stateDir),
    // `app.relaunch` cannot carry an environment variable on any platform
    // (RelaunchOptions is `{ args, execPath }`), which is why the request is a
    // marker file rather than FLOW_DESKTOP_LEGACY_BACKEND in the child's env.
    relaunch: electronApp
      .relaunch({ args: process.argv.slice(1) })
      .pipe(Effect.andThen(electronApp.exit(0))),
  } satisfies FlowServiceRecoverySeams;
});

const methods = makeFlowServiceRecoveryIpcMethods(productionSeams);

export const retryFlowServiceAttach = methods.retryFlowServiceAttach;
export const getFlowServiceAdoption = methods.getFlowServiceAdoption;
export const openFlowServiceInBrowser = methods.openFlowServiceInBrowser;
export const relaunchWithLegacyBackend = methods.relaunchWithLegacyBackend;
