import { expect, it } from "vite-plus/test";
import { ProviderInstanceId, ServerSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { selectCuratorProvider, curatorSessionKey } from "./curator.ts";
import { CuratorSessions } from "./curator-sessions.ts";

const settings = Schema.decodeUnknownSync(ServerSettings)({
  providers: { opencode: { enabled: true } },
  providerInstances: {
    "claude-work": { driver: "claudeAgent", enabled: true, config: {} },
  },
  defaultModelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
});

it.each([
  ["codex", "codex"],
  ["claude", "claudeAgent"],
  ["opencode", "opencode"],
] as const)("routes a %s Brain to %s despite the global Codex default", (cli, driver) => {
  expect(selectCuratorProvider(settings, cli).instance.driver).toBe(driver);
});
it("prefers the default instance only within the Brain's selected CLI", () => {
  const selected = selectCuratorProvider(
    {
      ...settings,
      defaultModelSelection: {
        ...settings.defaultModelSelection!,
        instanceId: ProviderInstanceId.make("claude-work"),
      },
    },
    "claude",
  );
  expect(selected.instanceId).toBe("claude-work");
});
it("fails explicitly when the selected CLI is disabled or missing, without falling back to Codex", () => {
  expect(() =>
    selectCuratorProvider(
      {
        ...settings,
        providers: {
          ...settings.providers,
          opencode: { ...settings.providers.opencode, enabled: false },
        },
      },
      "opencode",
    ),
  ).toThrow(/Enable a opencode provider/);
  expect(() => selectCuratorProvider(settings, undefined)).toThrow(/no supported extraction CLI/);
});
it("requests a fresh source window when the Brain switches CLI", async () => {
  const sessions = new CuratorSessions<string>(async () => {});
  const request = { sessionId: "chat", endpoint: "http://localhost/curator", token: "fixture" };
  const codex = curatorSessionKey({ ...request, cli: "codex" });
  const claude = curatorSessionKey({ ...request, cli: "claude" });
  try {
    await sessions.acquire(codex, true, async () => "codex context");
    sessions.release(codex);
    expect(await sessions.acquire(claude, false, async () => "wrong delta")).toBeUndefined();
    expect(await sessions.acquire(claude, true, async () => "claude context")).toBe(
      "claude context",
    );
  } finally {
    await sessions.dispose();
  }
});
