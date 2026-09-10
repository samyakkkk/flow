import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as ConfigProvider from "effect/ConfigProvider";
import {
  HttpClient,
  HttpClientResponse,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { requestFlowBrowserUpdate } from "./flowBrowserUpdate.ts";
import { flowBrowserUpdateRoute } from "./http.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";

const state = {
  supported: true,
  currentVersion: "1.0.0",
  readyVersion: "1.1.0",
  restarting: false,
};
const environment = {
  FLOW_RELEASE_CONTROL_URL: "http://127.0.0.1:12345",
  FLOW_RELEASE_CONTROL_TOKEN: "private-supervisor-token",
};
const config = (env: Record<string, string>) =>
  ConfigProvider.layer(ConfigProvider.fromEnv({ env }));

describe("Flow browser update bridge", () => {
  it.effect("is unavailable on unmanaged servers and cannot apply updates there", () =>
    Effect.gen(function* () {
      const client = HttpClient.make(() => Effect.die("Must not call supervisor"));
      const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provide(config({})),
          Effect.provideService(HttpClient.HttpClient, client),
        );
      expect(yield* provide(requestFlowBrowserUpdate(false))).toEqual({
        supported: false,
        currentVersion: null,
        readyVersion: null,
        restarting: false,
      });
      expect(Exit.isFailure(yield* provide(requestFlowBrowserUpdate(true)).pipe(Effect.exit))).toBe(
        true,
      );
    }),
  );
  it.effect("forwards only to the local authenticated supervisor and decodes its state", () =>
    Effect.gen(function* () {
      const requests: string[] = [];
      const client = HttpClient.make((request) => {
        requests.push(request.url);
        expect(request.headers.authorization).toBe("Bearer private-supervisor-token");
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response(JSON.stringify(state))),
        );
      });
      for (const apply of [false, true]) {
        const result = yield* requestFlowBrowserUpdate(apply).pipe(
          Effect.provide(config(environment)),
          Effect.provideService(HttpClient.HttpClient, client),
        );
        expect(result).toEqual(state);
      }
      expect(requests).toEqual([
        "http://127.0.0.1:12345/update-status",
        "http://127.0.0.1:12345/apply-update",
      ]);
      const result = yield* requestFlowBrowserUpdate(true).pipe(
        Effect.provide(
          config({ ...environment, FLOW_RELEASE_CONTROL_URL: "https://external.example" }),
        ),
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.exit,
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(requests).toHaveLength(2);
    }),
  );
  it.effect("requires operate scope before issuing a restart", () =>
    Effect.gen(function* () {
      const auth = {
        authenticateHttpRequest: () => Effect.succeed({ scopes: ["orchestration:read"] }),
      } as unknown as EnvironmentAuth.EnvironmentAuth["Service"];
      const response = yield* flowBrowserUpdateRoute(true).pipe(
        Effect.provide(config(environment)),
        Effect.provideService(EnvironmentAuth.EnvironmentAuth, auth),
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request("http://localhost/api/flow/browser-update", {
              method: "POST",
              headers: { "content-type": "application/json" },
            }),
          ),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("Must not call supervisor")),
        ),
      );
      expect(HttpServerResponse.toWeb(response).status).toBe(403);
    }),
  );
});
