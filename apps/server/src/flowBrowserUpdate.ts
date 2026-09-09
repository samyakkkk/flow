import { FlowBrowserUpdateState } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

export class FlowBrowserUpdateError extends Schema.TaggedError<FlowBrowserUpdateError>()(
  "FlowBrowserUpdateError",
  { cause: Schema.Defect() },
) {}

export const requestFlowBrowserUpdate = Effect.fn("requestFlowBrowserUpdate")(function* (
  apply: boolean,
) {
  const config = yield* Config.all({
    url: Config.string("FLOW_RELEASE_CONTROL_URL").pipe(Config.option),
    token: Config.string("FLOW_RELEASE_CONTROL_TOKEN").pipe(Config.option),
  });
  if (Option.isNone(config.url) || Option.isNone(config.token)) {
    if (apply)
      return yield* new FlowBrowserUpdateError({
        cause: "This server is not managed by the Flow release installer.",
      });
    return {
      supported: false,
      currentVersion: null,
      readyVersion: null,
      restarting: false,
    } satisfies FlowBrowserUpdateState;
  }
  const configuredUrl = config.url.value;
  const url = yield* Effect.try({
    try: () => new URL(configuredUrl),
    catch: (cause) => new FlowBrowserUpdateError({ cause }),
  });
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password)
    return yield* new FlowBrowserUpdateError({ cause: "Invalid local supervisor address." });
  const client = yield* HttpClient.HttpClient;
  return yield* client
    .post(new URL(apply ? "/apply-update" : "/update-status", url).href, {
      headers: { authorization: `Bearer ${config.token.value}` },
    })
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(FlowBrowserUpdateState)),
      Effect.timeout("10 seconds"),
      Effect.mapError((cause) => new FlowBrowserUpdateError({ cause })),
    );
});
