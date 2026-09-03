// runtime/index.ts — pick the AgentRuntime implementation from config.

import type { Config } from "../config.js";
import { EchoRuntime } from "./echo.js";
import { FlowRuntime } from "./flow.js";
import type { AgentRuntime } from "./types.js";

export function makeRuntime(config: Config): AgentRuntime {
  if (config.runtime === "echo") return new EchoRuntime();
  return new FlowRuntime({
    orchestratorUrl: config.orchestratorUrl,
    adminToken: config.adminToken,
    answerTimeoutMs: config.answerTimeoutMs,
  });
}

export type { AgentRuntime, RuntimeAnswer, RuntimeQuery, TranscriptTurn, Surface } from "./types.js";
