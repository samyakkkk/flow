// mode.ts — Exposes GET /v1/mode {mode, gates} for dashboard + CLI health checks.
// FLOW_MODE defaults to "local" when unset (safe: no ambient Slack listener).

import type { FastifyInstance } from "fastify";

export type FlowMode = "local" | "prod";

export function getFlowMode(): FlowMode {
  const raw = process.env.FLOW_MODE ?? "local";
  return raw === "prod" ? "prod" : "local";
}

export function registerModeRoute(app: FastifyInstance): void {
  app.get("/v1/mode", async () => ({
    mode: getFlowMode(),
    gates: {
      slack: "prod_only",
    },
  }));
}
