import { afterEach, expect, test, vi } from "vite-plus/test";
import { BrainRuntime } from "./BrainRuntime.ts";

const { installed } = vi.hoisted(() => ({ installed: new Set<string>() }));
vi.mock("./process.ts", async (original) => ({
  ...(await original<typeof import("./process.ts")>()),
  run: vi.fn(async (binary: string) => {
    if (!installed.has(binary)) throw new Error("CLI not installed");
    return "1.0.0";
  }),
}));

afterEach(() => {
  installed.clear();
  vi.restoreAllMocks();
});

test("discovers a CLI installed after the Brain runtime started", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
  const runtime = new BrainRuntime("/tmp/flow-cli-discovery-test", {
    platform: "linux",
    architecture: "x64",
  });
  expect((await runtime.state()).clis.find((cli) => cli.id === "codex")?.installed).toBe(false);
  installed.add("codex");
  now.mockReturnValue(16_000);
  expect((await runtime.state()).clis.find((cli) => cli.id === "codex")?.installed).toBe(true);
  installed.delete("codex");
  now.mockReturnValue(22_000);
  expect((await runtime.state()).clis.find((cli) => cli.id === "codex")?.installed).toBe(false);
});
