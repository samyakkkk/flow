// Central config — read from env on the server side only.
//
// Since the single-dashboard refactor there is ONE dashboard process for the
// whole deployment. Per-project settings (orchestrator/gateway URLs, admin
// token, repos.json path) moved to lib/registry.ts, resolved per request from
// the x-flow-project header the proxy sets. What remains here is deployment-
// level: where the data dir lives, the auth store, and the mode.
import path from "node:path";

// data/ root — flow up passes this; the fallback covers `next dev` run by
// hand from dashboard/ (cwd = dashboard → ../data).
export const FLOW_DATA_DIR =
  process.env.FLOW_DATA_DIR ?? path.resolve(process.cwd(), "..", "data");

export const FLOW_AUTH_PATH =
  process.env.FLOW_AUTH_PATH ?? path.join(FLOW_DATA_DIR, "auth.json");

// Mode gating. Local = single user on their own machine → the dashboard
// auto-authenticates (no login step). Prod = an exposed box → real accounts.
// flow up sets this to prod when ANY project on the deployment is prod.
export const FLOW_MODE = process.env.FLOW_MODE ?? "local";
export const IS_LOCAL = FLOW_MODE !== "prod";

export const SESSION_COOKIE = "flow_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days — a dev tool you leave open

// Request header carrying the project scope, set by proxy.ts when it strips
// the /p/<name> URL prefix. Server code reads it via lib/projectContext.
export const PROJECT_HEADER = "x-flow-project";
