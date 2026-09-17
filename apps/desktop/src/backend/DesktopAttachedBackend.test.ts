// @effect-diagnostics nodeBuiltinImport:off - the compatibility probe is a real HTTP read, so the fixture serves a real descriptor.
import { createServer, type Server } from "node:http";
import { once } from "node:events";

import { afterEach, assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as DesktopAttachedBackend from "./DesktopAttachedBackend.ts";
import * as DesktopBackendManager from "./DesktopBackendManager.ts";
import type { ServiceDiscoveryResult } from "./serviceDiscovery.ts";

const servers: Server[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    await new Promise((resolve) => server?.close(() => resolve(undefined)));
  }
});

/** A server answering `/.well-known/t3/environment` with `body`. Returns its
    origin, which stands in for what a live service's `/status` reports. */
async function descriptorServer(body: unknown): Promise<string> {
  const server = createServer((request, response) => {
    if (request.url !== "/.well-known/t3/environment") {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(body));
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return `http://127.0.0.1:${String(port)}`;
}

const readyDescriptor = (overrides: Record<string, unknown> = {}) => ({
  environmentId: "11111111-1111-4111-8111-111111111111",
  label: "Flow service",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "1.2.3",
  capabilities: {},
  desktopProtocol: 1,
  ...overrides,
});

const DATA_HOME = "/tmp/flow-attach-test-home";

const environment: DesktopAttachedBackend.AttachedBackendEnvironment = {
  executablePath: "/test/electron",
  backendEntryPath: "/test/server/bin.mjs",
  backendCwd: "/test",
};

function makeInstance(input: {
  readonly discoveries: ReadonlyArray<ServiceDiscoveryResult>;
  readonly credential?: string;
  readonly onPreflightFailed?: (
    failure: DesktopBackendManager.PreflightFailure,
  ) => Effect.Effect<boolean>;
}) {
  return Effect.gen(function* () {
    const readyUrls: string[] = [];
    const mints: string[] = [];
    const remaining = yield* Ref.make([...input.discoveries]);
    const instance = yield* DesktopAttachedBackend.makeAttachedBackendInstance({
      id: DesktopBackendManager.PRIMARY_INSTANCE_ID,
      label: Effect.succeed("Local environment"),
      environment,
      discover: () =>
        Ref.modify(remaining, (queue) =>
          queue.length > 1 ? ([queue[0]!, queue.slice(1)] as const) : ([queue[0]!, queue] as const),
        ),
      mintCredential: ({ dataHome }) =>
        Effect.sync(() => {
          mints.push(dataHome);
          return `${input.credential ?? "credential"}-${String(mints.length)}`;
        }),
      onReady: (httpBaseUrl) =>
        Effect.sync(() => {
          readyUrls.push(httpBaseUrl.href);
        }),
      ...(input.onPreflightFailed ? { onPreflightFailed: input.onPreflightFailed } : {}),
    });
    return { instance, readyUrls, mints };
  });
}

const ready = (origin: string): ServiceDiscoveryResult => ({
  status: "ready",
  environmentId: "environment",
  dataHome: DATA_HOME,
  runningCode: "/releases/current",
  serverOrigin: origin,
});

describe("desktop attached backend", () => {
  it.effect("attaches to a compatible service and mints a credential per request", () =>
    Effect.gen(function* () {
      const origin = yield* Effect.promise(() => descriptorServer(readyDescriptor()));
      const { instance, readyUrls, mints } = yield* makeInstance({ discoveries: [ready(origin)] });

      yield* instance.start;

      const snapshot = yield* instance.snapshot;
      assert.isTrue(snapshot.ready);
      // Nothing was spawned, so there is no pid to report.
      assert.isTrue(Option.isNone(snapshot.activePid));
      assert.isTrue(instance.detached);
      assert.deepEqual(readyUrls, [`${origin}/`]);

      // The bridge reads the config over a synchronous IPC channel, so it
      // must be runnable with runSync: no minting inside it.
      const first = Effect.runSync(instance.currentConfig);
      assert.isTrue(Option.isSome(first));
      const config = Option.getOrThrow(first);
      assert.equal(config.httpBaseUrl.origin, origin);
      assert.isTrue(Option.isNone(config.preflightFailure));
      assert.equal(config.bootstrap.desktopBootstrapToken, "");
      assert.deepEqual(mints, []);

      // Single-use credentials: every request mints its own against the
      // service's own data home.
      assert.deepEqual(yield* instance.mintBootstrapCredential!, Option.some("credential-1"));
      assert.deepEqual(yield* instance.mintBootstrapCredential!, Option.some("credential-2"));
      assert.deepEqual(mints, [DATA_HOME, DATA_HOME]);

      // The renderer protocol asks for the address on every request, so it
      // must not go through the minting path.
      assert.deepEqual(
        Option.map(yield* instance.httpBaseUrl!, (url) => url.origin),
        Option.some(origin),
      );
      assert.deepEqual(mints, [DATA_HOME, DATA_HOME]);
    }),
  );

  it.effect("reports no address while it is not attached", () =>
    Effect.gen(function* () {
      const { instance } = yield* makeInstance({
        discoveries: [{ status: "stopped", reason: "Service status: stopped." }],
      });

      assert.isTrue(Option.isNone(yield* instance.httpBaseUrl!));
      yield* instance.start;
      assert.isTrue(Option.isNone(yield* instance.httpBaseUrl!));
    }),
  );

  // Live clock: the poll between discoveries is a real sleep.
  it.live("waits out a starting service before attaching", () =>
    Effect.gen(function* () {
      const origin = yield* Effect.promise(() => descriptorServer(readyDescriptor()));
      const { instance } = yield* makeInstance({
        discoveries: [
          { status: "starting", environmentId: "environment", dataHome: DATA_HOME },
          ready(origin),
        ],
      });

      yield* instance.start;

      assert.isTrue((yield* instance.snapshot).ready);
    }),
  );

  for (const [name, descriptor] of [
    ["absent", readyDescriptor({ desktopProtocol: undefined })],
    ["out of range", readyDescriptor({ desktopProtocol: 99 })],
    ["malformed", readyDescriptor({ desktopProtocol: "one" })],
  ] as const) {
    it.effect(`refuses a service whose protocol generation is ${name}`, () =>
      Effect.gen(function* () {
        const origin = yield* Effect.promise(() => descriptorServer(descriptor));
        const { instance, readyUrls } = yield* makeInstance({ discoveries: [ready(origin)] });

        yield* instance.start;

        assert.isFalse((yield* instance.snapshot).ready);
        assert.deepEqual(readyUrls, []);
        const config = Option.getOrThrow(yield* instance.currentConfig);
        const failure = Option.getOrThrow(config.preflightFailure);
        assert.equal(failure.attach?.kind, "incompatible");
        assert.isTrue(failure.fatal);
        // No credential is minted for a service we refuse to talk to.
        assert.equal(config.bootstrap.desktopBootstrapToken, "");
      }),
    );
  }

  it.effect("reports an unreachable service rather than attaching to it", () =>
    Effect.gen(function* () {
      const { instance } = yield* makeInstance({
        discoveries: [
          {
            status: "unreachable",
            environmentId: "environment",
            dataHome: DATA_HOME,
            reason: "Service could not be reached.",
          },
        ],
      });

      yield* instance.start;

      const failure = Option.getOrThrow(
        Option.getOrThrow(yield* instance.currentConfig).preflightFailure,
      );
      assert.equal(failure.attach?.kind, "unreachable");
      assert.equal(failure.attach?.detail, "Service could not be reached.");
    }),
  );

  it.effect("distinguishes a stopped service from one that was never installed", () =>
    Effect.gen(function* () {
      const stopped = yield* makeInstance({
        discoveries: [{ status: "stopped", environmentId: "environment", dataHome: DATA_HOME }],
      });
      yield* stopped.instance.start;
      assert.equal(
        Option.getOrThrow(Option.getOrThrow(yield* stopped.instance.currentConfig).preflightFailure)
          .attach?.kind,
        "stopped",
      );

      const absent = yield* makeInstance({ discoveries: [{ status: "not-configured" }] });
      yield* absent.instance.start;
      assert.equal(
        Option.getOrThrow(Option.getOrThrow(yield* absent.instance.currentConfig).preflightFailure)
          .attach?.kind,
        "not-installed",
      );
    }),
  );

  it.effect("retries once the failure handler asks for it", () =>
    Effect.gen(function* () {
      const origin = yield* Effect.promise(() => descriptorServer(readyDescriptor()));
      const retries = yield* Ref.make(0);
      const { instance } = yield* makeInstance({
        discoveries: [{ status: "stopped", environmentId: "environment" }, ready(origin)],
        onPreflightFailed: () => Ref.modify(retries, (count) => [count === 0, count + 1] as const),
      });

      yield* instance.start;

      assert.isTrue((yield* instance.snapshot).ready);
      assert.equal(yield* Ref.get(retries), 1);
    }),
  );

  it.effect("stops without touching the service", () =>
    Effect.gen(function* () {
      const origin = yield* Effect.promise(() => descriptorServer(readyDescriptor()));
      const { instance, mints } = yield* makeInstance({ discoveries: [ready(origin)] });
      yield* instance.start;

      yield* instance.stop();

      const snapshot = yield* instance.snapshot;
      assert.isFalse(snapshot.desiredRunning);
      assert.isFalse(snapshot.ready);
      assert.isTrue(Option.isNone(snapshot.activePid));
      // The service is still there: the config is still readable after a stop
      // and a credential can still be minted for it.
      assert.isTrue(Option.isSome(yield* instance.currentConfig));
      assert.isTrue(Option.isSome(yield* instance.mintBootstrapCredential!));
      assert.equal(mints.length, 1);
      assert.isFalse(yield* instance.waitForReady(Duration.millis(10)));
    }),
  );
});
