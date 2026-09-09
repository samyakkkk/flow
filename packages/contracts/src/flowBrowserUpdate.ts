import * as Schema from "effect/Schema";

export const FLOW_BROWSER_UPDATE_PATH = "/api/flow/browser-update";
export const FlowBrowserUpdateState = Schema.Struct({
  supported: Schema.Boolean,
  currentVersion: Schema.NullOr(Schema.String),
  readyVersion: Schema.NullOr(Schema.String),
  restarting: Schema.Boolean,
});
export type FlowBrowserUpdateState = typeof FlowBrowserUpdateState.Type;
