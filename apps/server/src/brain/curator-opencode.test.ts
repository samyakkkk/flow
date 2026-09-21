// @effect-diagnostics nodeBuiltinImport:off - Verifies isolated native storage using temporary fixture files.
import { expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  lightSibling,
  openCodeCuratorConfig,
  parseVerboseModels,
  prepareOpenCodeCurator,
} from "./curator-opencode.ts";

it("keeps provider configuration while removing coding tools and inherited integrations", () => {
  const config = openCodeCuratorConfig([
    `{
    // The CLI accepts JSONC.
    "provider": {"custom": {"options": {"baseURL": "https://example.invalid"}}},
    "model": "custom/model", "mcp": {"unrelated": {"command": ["danger"]}},
    "plugin": ["unrelated-plugin"], "permission": "allow", "instructions": ["AGENTS.md"],
  }`,
  ]);
  expect(config).toMatchObject({
    model: "custom/model",
    provider: { custom: { options: { baseURL: "https://example.invalid" } } },
    mcp: {},
    plugin: [],
    instructions: [],
    permission: { "*": "deny", "t3-code_*": "allow" },
    share: "disabled",
  });
});
it("isolates native history and config, retains only credential sharing, and cleans up", async () => {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "flow-curator-fixture-"));
  const authDirectory = NodePath.join(home, ".local/share/opencode");
  await NodeFSP.mkdir(authDirectory, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(authDirectory, "auth.json"),
    '{"openai":{"type":"oauth","access":"fixture"}}',
  );
  await NodeFSP.writeFile(NodePath.join(authDirectory, "opencode.db"), "untouched fixture");
  let isolated: Awaited<ReturnType<typeof prepareOpenCodeCurator>> | undefined;
  try {
    isolated = await prepareOpenCodeCurator({
      HOME: home,
      PATH: process.env.PATH,
      OPENCODE_PERMISSION: "allow",
      OPENCODE_DB: "/must-not-open",
      OPENCODE_AUTO_SHARE: "true",
    });
    expect(isolated.environment.HOME).toBe(isolated.directory);
    expect(isolated.environment.OPENCODE_PERMISSION).toBeUndefined();
    expect(isolated.environment.OPENCODE_AUTO_SHARE).toBeUndefined();
    expect(isolated.environment.OPENCODE_DB).toContain(isolated.directory);
    const privateAuth = NodePath.join(isolated.environment.XDG_DATA_HOME!, "opencode/auth.json");
    expect(await NodeFSP.realpath(privateAuth)).toBe(
      await NodeFSP.realpath(NodePath.join(authDirectory, "auth.json")),
    );
    await isolated.close();
    await expect(NodeFSP.stat(isolated.directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await NodeFSP.readFile(NodePath.join(authDirectory, "opencode.db"), "utf8")).toBe(
      "untouched fixture",
    );
  } finally {
    await isolated?.close();
    await NodeFSP.rm(home, { recursive: true, force: true });
  }
});

it("falls back to the model OpenCode last ran when its config names none", async () => {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "flow-curator-home-"));
  const state = NodePath.join(home, ".local", "state", "opencode");
  await NodeFSP.mkdir(state, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(state, "model.json"),
    JSON.stringify({ recent: [{ providerID: "opencode-go", modelID: "glm-5.2" }] }),
  );
  // No catalogue is reachable, so their own model is kept.
  const isolated = await prepareOpenCodeCurator({ HOME: home }, { binaryPath: "/no/opencode" });
  try {
    expect(isolated.model).toBe("opencode-go/glm-5.2");
  } finally {
    await isolated.close();
    await NodeFSP.rm(home, { recursive: true, force: true });
  }
});

const tools = { capabilities: { toolcall: true } };
const bedrock = [
  {
    id: "us.anthropic.claude-sonnet-5",
    family: "claude-sonnet",
    release_date: "2026-06-30",
    ...tools,
  },
  {
    id: "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
    family: "claude-haiku",
    release_date: "2025-10-15",
    ...tools,
  },
  {
    id: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    family: "claude-haiku",
    release_date: "2025-10-15",
    ...tools,
  },
  {
    id: "us.anthropic.claude-3-5-haiku-20241022-v1:0",
    family: "claude-haiku",
    release_date: "2024-10-22",
    status: "deprecated",
    ...tools,
  },
  { id: "us.amazon.nova-micro-v1:0", family: "nova-micro", release_date: "2024-12-03", ...tools },
  { id: "us.amazon.nova-pro-v1:0", family: "nova-pro", release_date: "2024-12-03", ...tools },
];
// A flat-rate plan prices every model at zero, so nothing here can be ranked by cost.
const zaiPlan = [
  { id: "glm-5.3", family: "glm", release_date: "2026-08-14", ...tools },
  { id: "glm-4.7-flash", family: "glm-flash", release_date: "2026-01-19", ...tools },
  { id: "glm-5.3-flash", family: "glm-flash", release_date: "2026-08-26", ...tools },
];

it("moves a Bedrock Claude user to the current Haiku in their own region", () => {
  expect(lightSibling("amazon-bedrock/us.anthropic.claude-sonnet-5", bedrock)).toBe(
    "amazon-bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0",
  );
});
it("moves a Z.AI plan user to the newest GLM-Flash without any price signal", () => {
  expect(lightSibling("zai-coding-plan/glm-5.3", zaiPlan)).toBe("zai-coding-plan/glm-5.3-flash");
});
it("keeps their own model when it is already light or its vendor has no light sibling", () => {
  expect(lightSibling("zai-coding-plan/glm-5.3-flash", zaiPlan)).toBe(
    "zai-coding-plan/glm-5.3-flash",
  );
  // Bedrock grants access per vendor: a Nova user is not moved onto Anthropic.
  expect(lightSibling("amazon-bedrock/us.amazon.nova-pro-v1:0", bedrock)).toBe(
    "amazon-bedrock/us.amazon.nova-pro-v1:0",
  );
  expect(lightSibling("custom/unlisted", bedrock)).toBe("custom/unlisted");
});
it("reads the catalogue the OpenCode CLI prints", () => {
  const stdout = [
    "zai-coding-plan/glm-5.3",
    JSON.stringify({ id: "glm-5.3", family: "glm", capabilities: { toolcall: true } }, null, 2),
    "zai-coding-plan/glm-5.3-flash",
    JSON.stringify({ id: "glm-5.3-flash", family: "glm-flash", variants: { low: {} } }, null, 2),
  ].join("\n");
  expect(parseVerboseModels(stdout).map((model) => model.id)).toEqual(["glm-5.3", "glm-5.3-flash"]);
});
