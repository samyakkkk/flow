// Central config — read from env on the server side only.
export const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL ?? "http://127.0.0.1:7500";
export const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://127.0.0.1:7433";
export const FLOW_ADMIN_TOKEN = process.env.FLOW_ADMIN_TOKEN ?? "";

export const SESSION_COOKIE = "flow_session";
export const SESSION_MAX_AGE = 60 * 60 * 24; // 24 hours
