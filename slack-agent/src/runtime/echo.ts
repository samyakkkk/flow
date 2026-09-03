// runtime/echo.ts — trivial runtime for smoke tests: echoes the prompt back.

import type { AgentRuntime, RuntimeAnswer, RuntimeQuery } from "./types.js";

export class EchoRuntime implements AgentRuntime {
  readonly name = "echo";

  async ask(query: RuntimeQuery): Promise<RuntimeAnswer> {
    query.onStatus?.("Echoing…");
    return {
      markdown: `You said: ${query.prompt}\n\n_(echo runtime — ${query.transcript.length} prior turns, surface: ${query.context.surface})_`,
    };
  }
}
