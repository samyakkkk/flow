// @effect-diagnostics nodeBuiltinImport:off - the bundled-client fallback is
// plain Node fs/path (see ElectronProtocol.ts); the fixtures here match it.
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Option from "effect/Option";
import { beforeEach, vi } from "vite-plus/test";

const { handleMock, netFetchMock, unhandleMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  netFetchMock: vi.fn(),
  unhandleMock: vi.fn(),
}));

vi.mock("electron", () => ({
  net: { fetch: netFetchMock },
  protocol: { handle: handleMock, unhandle: unhandleMock },
}));

import * as ElectronProtocol from "./ElectronProtocol.ts";

describe("ElectronProtocol", () => {
  beforeEach(() => {
    handleMock.mockReset();
    netFetchMock.mockReset();
    unhandleMock.mockReset();
  });

  it.effect("proxies the stable renderer origin to the current app server", () =>
    Effect.gen(function* () {
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      netFetchMock.mockResolvedValue(new Response("ok"));

      yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol({
            scheme: "flow-dev",
            resolveTarget: () => Effect.succeed(Option.some(new URL("http://127.0.0.1:3773/"))),
            bundledClientDir: "/nonexistent-client",
            clerkFrontendApiHostname: "clerk.t3.codes",
          });
          assert.isDefined(handler);

          const response = yield* Effect.promise(() =>
            handler!(
              new Request("flow-dev://app/api/health?verbose=1", {
                headers: {
                  accept: "application/json",
                  origin: "flow-dev://app",
                  referer: "flow-dev://app/",
                  "sec-fetch-site": "same-origin",
                },
              }),
            ),
          );
          assert.equal(yield* Effect.promise(() => response.text()), "ok");
          assert.include(
            response.headers.get("content-security-policy") ?? "",
            "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://clerk.t3.codes https://challenges.cloudflare.com",
          );
          assert.include(
            response.headers.get("content-security-policy") ?? "",
            "connect-src 'self' http: https: ws: wss:",
          );
          assert.include(
            response.headers.get("content-security-policy") ?? "",
            "img-src 'self' flow-dev: blob: data: http: https:",
          );
          assert.include(
            response.headers.get("content-security-policy") ?? "",
            "font-src 'self' flow-dev: data:",
          );
        }),
      );

      assert.deepEqual(
        handleMock.mock.calls.map((call) => call[0]),
        ["flow-dev"],
      );
      assert.equal(netFetchMock.mock.calls[0]?.[0], "http://127.0.0.1:3773/api/health?verbose=1");
      const forwardedHeaders = new Headers(netFetchMock.mock.calls[0]?.[1]?.headers);
      assert.equal(forwardedHeaders.get("accept"), "application/json");
      assert.isNull(forwardedHeaders.get("origin"));
      assert.isNull(forwardedHeaders.get("referer"));
      assert.isNull(forwardedHeaders.get("sec-fetch-site"));
      assert.deepEqual(unhandleMock.mock.calls, [["flow-dev"]]);
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it.effect("rejects custom protocol requests for another host", () =>
    Effect.gen(function* () {
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });

      const response = yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol({
            scheme: "t3code",
            resolveTarget: () => Effect.succeed(Option.some(new URL("http://127.0.0.1:3773/"))),
            bundledClientDir: "/nonexistent-client",
            clerkFrontendApiHostname: undefined,
          });
          return yield* Effect.promise(() => handler!(new Request("flow://other/")));
        }),
      );

      assert.equal(response.status, 404);
      assert.equal(netFetchMock.mock.calls.length, 0);
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it.effect("retries transient renderer target failures", () =>
    Effect.gen(function* () {
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      netFetchMock
        .mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:5733"))
        .mockResolvedValueOnce(new Response("ready"));

      const response = yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol({
            scheme: "flow-dev",
            resolveTarget: () => Effect.succeed(Option.some(new URL("http://127.0.0.1:5733/"))),
            bundledClientDir: "/nonexistent-client",
            clerkFrontendApiHostname: undefined,
          });
          return yield* Effect.promise(() => handler!(new Request("flow-dev://app/")));
        }),
      );

      assert.equal(yield* Effect.promise(() => response.text()), "ready");
      assert.equal(netFetchMock.mock.calls.length, 2);
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it.effect("preserves protocol registration failures", () =>
    Effect.gen(function* () {
      const cause = new Error("protocol registration failed");
      handleMock.mockImplementationOnce(() => {
        throw cause;
      });

      const protocol = yield* ElectronProtocol.ElectronProtocol;
      const error = yield* Effect.scoped(
        protocol.registerDesktopProtocol({
          scheme: "flow-dev",
          resolveTarget: () => Effect.succeed(Option.some(new URL("http://127.0.0.1:3773/"))),
          bundledClientDir: "/nonexistent-client",
          clerkFrontendApiHostname: undefined,
        }),
      ).pipe(Effect.flip);

      assert.instanceOf(error, ElectronProtocol.ElectronProtocolRegistrationError);
      assert.equal(error.scheme, "flow-dev");
      assert.strictEqual(error.cause, cause);
      assert.equal(error.message, 'Failed to register Electron protocol scheme "flow-dev".');
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it.effect("preserves protocol unregistration failures", () =>
    Effect.gen(function* () {
      const cause = new Error("protocol unregistration failed");
      unhandleMock.mockImplementationOnce(() => {
        throw cause;
      });

      const protocol = yield* ElectronProtocol.ElectronProtocol;
      const exit = yield* Effect.exit(
        Effect.scoped(
          protocol.registerDesktopProtocol({
            scheme: "t3code",
            resolveTarget: () => Effect.succeed(Option.some(new URL("http://127.0.0.1:3773/"))),
            bundledClientDir: "/nonexistent-client",
            clerkFrontendApiHostname: undefined,
          }),
        ),
      );

      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, ElectronProtocol.ElectronProtocolUnregistrationError);
        assert.equal(error.scheme, "t3code");
        assert.strictEqual(error.cause, cause);
        assert.equal(error.message, 'Failed to unregister Electron protocol scheme "t3code".');
      }
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it.effect("follows the attached server as it changes, resolving per request", () =>
    Effect.gen(function* () {
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      netFetchMock.mockResolvedValue(new Response("ok"));
      let target = new URL("http://127.0.0.1:3773/");

      yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol({
            scheme: "flow",
            resolveTarget: () => Effect.sync(() => Option.some(target)),
            bundledClientDir: "/nonexistent-client",
            clerkFrontendApiHostname: undefined,
          });

          yield* Effect.promise(() => handler!(new Request("flow://app/api/health")));
          target = new URL("http://127.0.0.1:9999/");
          yield* Effect.promise(() => handler!(new Request("flow://app/api/health")));
        }),
      );

      assert.deepEqual(
        netFetchMock.mock.calls.map((call) => call[0]),
        ["http://127.0.0.1:3773/api/health", "http://127.0.0.1:9999/api/health"],
      );
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  describe("without a reachable server", () => {
    const withBundledClient = <A, E, R>(
      use: (clientDir: string) => Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> =>
      Effect.acquireUseRelease(
        Effect.promise(async () => {
          const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "flow-client-"));
          await NodeFSP.mkdir(NodePath.join(dir, "assets"));
          await NodeFSP.writeFile(NodePath.join(dir, "index.html"), "<html>shell</html>");
          await NodeFSP.writeFile(NodePath.join(dir, "assets", "app.js"), "export {};");
          return dir;
        }),
        use,
        (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
      );

    const request = (clientDir: string, url: string, headers?: Record<string, string>) =>
      Effect.gen(function* () {
        let handler: ((value: Request) => Promise<Response>) | undefined;
        handleMock.mockImplementation((_scheme, nextHandler) => {
          handler = nextHandler;
        });
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const protocol = yield* ElectronProtocol.ElectronProtocol;
            yield* protocol.registerDesktopProtocol({
              scheme: "flow",
              resolveTarget: () => Effect.succeed(Option.none()),
              bundledClientDir: clientDir,
              clerkFrontendApiHostname: undefined,
            });
            return yield* Effect.promise(() =>
              handler!(new Request(url, { headers: headers ?? {} })),
            );
          }),
        );
      });

    it.effect("serves the bundled shell for the root and for unknown client routes", () =>
      withBundledClient((clientDir) =>
        Effect.gen(function* () {
          for (const url of ["flow://app/", "flow://app/unknown/route"]) {
            const response = yield* request(clientDir, url, { accept: "text/html" });
            assert.equal(response.status, 200);
            assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
            assert.equal(yield* Effect.promise(() => response.text()), "<html>shell</html>");
            assert.include(
              response.headers.get("content-security-policy") ?? "",
              "default-src 'self'",
            );
          }
          assert.equal(netFetchMock.mock.calls.length, 0);
        }),
      ).pipe(Effect.provide(ElectronProtocol.layer)),
    );

    it.effect("serves bundled assets with their own content type", () =>
      withBundledClient((clientDir) =>
        Effect.gen(function* () {
          const response = yield* request(clientDir, "flow://app/assets/app.js");
          assert.equal(response.status, 200);
          assert.equal(response.headers.get("content-type"), "text/javascript; charset=utf-8");
          assert.equal(yield* Effect.promise(() => response.text()), "export {};");
          assert.include(
            response.headers.get("content-security-policy") ?? "",
            "default-src 'self'",
          );
        }),
      ).pipe(Effect.provide(ElectronProtocol.layer)),
    );

    it.effect("refuses paths that escape the bundled client directory", () =>
      withBundledClient((clientDir) =>
        Effect.gen(function* () {
          // URL parsing already collapses literal `..`; the encoded-slash form
          // survives into the pathname, so the resolve-inside check is what
          // stops it.
          const response = yield* request(
            clientDir,
            "flow://app/assets/%2e%2e%2f%2e%2e%2fetc/passwd",
          );
          assert.equal(response.status, 403);
        }),
      ).pipe(Effect.provide(ElectronProtocol.layer)),
    );

    it.effect("fails server paths as server failures instead of serving the shell", () =>
      withBundledClient((clientDir) =>
        Effect.gen(function* () {
          for (const path of ["/api/x", "/ws", "/oauth/callback", "/.well-known/t3/environment"]) {
            const response = yield* request(clientDir, `flow://app${path}`, {
              accept: "text/html",
            });
            assert.equal(response.status, 503);
            assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
            assert.deepEqual((yield* Effect.promise(() => response.json())) as unknown, {
              error: "flow-service-unavailable",
              detail: "The Flow service is not reachable.",
            });
            assert.include(
              response.headers.get("content-security-policy") ?? "",
              "default-src 'self'",
            );
          }
        }),
      ).pipe(Effect.provide(ElectronProtocol.layer)),
    );
  });

  it("keeps executable sources host-restricted while allowing runtime network resources", () => {
    const policy = ElectronProtocol.makeDesktopContentSecurityPolicy({
      scheme: "t3code",
      clerkFrontendApiHostname: "clerk.t3.codes",
    });
    const directives = Object.fromEntries(
      policy.split("; ").map((directive) => {
        const [name, ...sources] = directive.split(" ");
        return [name, sources];
      }),
    );

    assert.deepEqual(directives["script-src"], [
      "'self'",
      "'unsafe-inline'",
      "'wasm-unsafe-eval'",
      "https://clerk.t3.codes",
      "https://challenges.cloudflare.com",
    ]);
    assert.deepEqual(directives["connect-src"], ["'self'", "http:", "https:", "ws:", "wss:"]);
    assert.deepEqual(directives["img-src"], [
      "'self'",
      "t3code:",
      "blob:",
      "data:",
      "http:",
      "https:",
    ]);
    assert.deepEqual(directives["media-src"], ["'self'", "t3code:", "blob:", "http:", "https:"]);
    assert.deepEqual(directives["font-src"], ["'self'", "t3code:", "data:"]);
  });
});
