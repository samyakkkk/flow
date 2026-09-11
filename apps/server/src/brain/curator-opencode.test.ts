// @effect-diagnostics nodeBuiltinImport:off - Verifies isolated native storage using temporary fixture files.
import { expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { openCodeCuratorConfig, prepareOpenCodeCurator } from "./curator-opencode.ts";

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
