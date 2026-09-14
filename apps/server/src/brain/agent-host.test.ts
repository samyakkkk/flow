// @effect-diagnostics nodeBuiltinImport:off - Isolated host error propagation test.
import { expect, it, vi } from "vite-plus/test";
vi.mock("./curator.ts", async () => {
  const Effect = await import("effect/Effect");
  return {
    makeBrainCurator: Effect.succeed(async () => {
      throw new Error("Provider request timed out.");
    }),
  };
});
import { createBrainAgentHost } from "./agent-host.ts";
it("preserves the provider failure instead of replacing it with Effect.tryPromise", async () => {
  const host = createBrainAgentHost("/tmp/flow-agent-error-test", () => ({}));
  try {
    await expect(
      host.run({
        cli: "opencode",
        sessionId: "error-test",
        cwd: "/tmp",
        renew: true,
        endpoint: "http://127.0.0.1:1/mcp",
        token: "fixture",
        instructions: "",
        input: "",
      }),
    ).rejects.toThrow("Provider request timed out.");
  } finally {
    await host.close();
  }
});
