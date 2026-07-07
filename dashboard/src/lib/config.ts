// Central config — read from env on the server side only.
export const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL ?? "http://127.0.0.1:7500";
export const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://127.0.0.1:7433";
export const FLOW_ADMIN_TOKEN = process.env.FLOW_ADMIN_TOKEN ?? "";

// Mode gating. Local = single user on their own machine → the dashboard
// auto-authenticates from FLOW_ADMIN_TOKEN (no login step). Prod = an exposed
// box → a real login is required. Defaults to local (this is a local-first tool).
export const FLOW_MODE = process.env.FLOW_MODE ?? "local";
export const IS_LOCAL = FLOW_MODE !== "prod";

export const SESSION_COOKIE = "flow_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days — a dev tool you leave open
