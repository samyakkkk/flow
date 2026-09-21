import { expect, it } from "vite-plus/test";
import { ProviderInstanceId, ServerSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  selectCuratorModel,
  selectCuratorProvider,
  selectLocalCuratorCli,
  curatorSessionKey,
} from "./curator.ts";
import { CuratorSessions } from "./curator-sessions.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
const settings = decodeSettings({
  providers: { opencode: { enabled: true } },
  providerInstances: {
    "claude-work": { driver: "claudeAgent", enabled: true, config: {} },
  },
  defaultModelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
});

it("uses this environment's preferred provider for a remote Brain's local extraction", () => {
  expect(selectLocalCuratorCli(settings)).toBe("codex");
  expect(
    selectLocalCuratorCli({
      ...settings,
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("claude-work"),
        model: "sonnet",
      },
    }),
  ).toBe("claude");
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
it("runs the agent chosen in Brain settings even while its chat provider is switched off", () => {
  // OpenCode, Cursor and Grok are off by default; that switch is about chat, not notes.
  const off = {
    ...settings,
    providers: {
      ...settings.providers,
      opencode: { ...settings.providers.opencode, enabled: false },
    },
  };
  expect(selectCuratorProvider(off, "opencode").instance.driver).toBe("opencode");
});
it("prefers an enabled instance of the chosen agent over a disabled one", () => {
  const two = decodeSettings({
    providers: { opencode: { enabled: false } },
    providerInstances: { "opencode-work": { driver: "opencode", enabled: true, config: {} } },
  });
  expect(selectCuratorProvider(two, "opencode").instanceId).toBe("opencode-work");
});
it("fails explicitly for an unsupported agent, without falling back to Codex", () => {
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
it("writes notes with the inexpensive model, not the chat default", () => {
  expect(selectCuratorModel("claudeAgent")).toBe("claude-haiku-4-5");
  expect(selectCuratorModel("codex")).toBe("gpt-5.6-luna");
});
it("never guesses an OpenCode model the user may not have", () => {
  expect(selectCuratorModel("opencode", "opencode-go/glm-5.2")).toBe("opencode-go/glm-5.2");
  expect(() => selectCuratorModel("opencode")).toThrow(/which OpenCode model/);
});
