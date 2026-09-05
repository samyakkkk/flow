import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "jsonc-parser";

const materializer = new URL("../../bin/lib/materialize.mjs", import.meta.url).href;

for (const harness of ["opencode", "gemini", "antigravity"]) {
  test(`${harness}-only setup installs and restores shared knowledge without Codex`, () => fixture(({ repoDir, invoke }) => {
    const skill = join(repoDir, ".agents/skills/flow/SKILL.md");
    mkdirSync(join(repoDir, ".agents/skills/flow"), { recursive: true });
    writeFileSync(skill, "Existing skill\n");
    writeFileSync(join(repoDir, "AGENTS.md"), "Existing instructions\n");
    invoke(`m.materializeRepo({ ...ctx, harnesses: [${JSON.stringify(harness)}] });`);
    assert.match(readFileSync(skill, "utf8"), /test-project/);
    assert.match(readFileSync(join(repoDir, "AGENTS.md"), "utf8"), /flow setup test-project/);
    assert.ok(!existsSync(join(repoDir, ".codex")));
    invoke("m.removeRepo(ctx.repoDir)");
    assert.equal(readFileSync(skill, "utf8"), "Existing skill\n");
    assert.equal(readFileSync(join(repoDir, "AGENTS.md"), "utf8"), "Existing instructions\n");
  }));
}

test("adding a harness retains earlier exclusions and removes both integrations", () => fixture(({ repoDir, invoke }) => {
  invoke("m.materializeRepo(ctx); m.materializeRepo({ ...ctx, harnesses: ['codex'] });");
  const ignored = spawnSync("git", ["check-ignore", ".github/mcp.json", ".codex/config.toml"], { cwd: repoDir, encoding: "utf8" });
  assert.equal(ignored.stdout.trim().split("\n").length, 2);
  invoke("m.removeRepo(ctx.repoDir)");
  assert.ok(!existsSync(join(repoDir, ".github/mcp.json")));
  assert.ok(!existsSync(join(repoDir, ".codex/config.toml")));
}));

function fixture(run) {
  const home = mkdtempSync(join(tmpdir(), "flow-materialize-"));
  const repoDir = join(home, "repo with spaces");
  mkdirSync(repoDir);
  const git = spawnSync("git", ["init", "-q", repoDir]);
  assert.equal(git.status, 0);
  const ctx = { repoDir, project: "test-project", repo: "test-repo", harnesses: ["copilot"] };
  function invoke(code) {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import * as m from ${JSON.stringify(materializer)};
      const ctx = ${JSON.stringify(ctx)};
      ${code}
    `], { env: { ...process.env, HOME: home, COPILOT_HOME: "" }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  }
  try { run({ home, repoDir, invoke }); }
  finally { rmSync(home, { recursive: true, force: true }); }
}

test("Copilot setup, repeated setup, and removal preserve user configuration", () => fixture(({ repoDir, invoke }) => {
  const originals = {
    ".vscode/mcp.json": '{\n  // My existing server\n  "servers": { "mine": { "command": "my-server" }, },\n  "inputs": [],\n}\n',
    ".github/mcp.json": '{"mcpServers":{"mine":{"command":"my-cli-server"}}}\n',
    ".github/hooks/flow.json": '{"version":1,"hooks":{"Stop":[{"type":"command","command":"my-hook"}]}}\n',
    ".github/copilot-instructions.md": "# Team rules\n\nKeep public APIs stable.\n",
    ".github/skills/flow/SKILL.md": "An existing personal skill.\n",
  };
  for (const [rel, content] of Object.entries(originals)) {
    const p = join(repoDir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  invoke("m.materializeRepo(ctx)");
  const installed = Object.fromEntries(Object.keys(originals).map((rel) => [rel, readFileSync(join(repoDir, rel), "utf8")]));
  const vscode = parse(installed[".vscode/mcp.json"]);
  assert.equal(vscode.servers.mine.command, "my-server");
  assert.equal(vscode.servers["flow-graph"].command, process.execPath);
  assert.equal(vscode.servers["flow-graph"].type, "stdio");
  assert.ok(installed[".vscode/mcp.json"].includes("// My existing server"));
  const cli = parse(installed[".github/mcp.json"]);
  assert.deepEqual(cli.mcpServers["flow-graph"], vscode.servers["flow-graph"]);
  const hooks = parse(installed[".github/hooks/flow.json"]);
  assert.deepEqual(Object.keys(hooks.hooks).sort(), ["SessionEnd", "SessionStart", "Stop", "UserPromptSubmit"]);
  assert.equal(hooks.hooks.Stop.length, 2);
  assert.match(hooks.hooks.Stop[1].command, /'--harness' 'copilot'/);
  assert.ok(!existsSync(join(repoDir, ".claude")), "Copilot installs independently of Claude");
  assert.match(readFileSync(join(repoDir, ".git/info/exclude"), "utf8"), /\.github\/hooks\/flow.json/);
  invoke("m.materializeRepo(ctx)");
  for (const [rel, text] of Object.entries(installed)) assert.equal(readFileSync(join(repoDir, rel), "utf8"), text);
  invoke("m.removeRepo(ctx.repoDir)");
  for (const [rel, text] of Object.entries(originals)) assert.equal(readFileSync(join(repoDir, rel), "utf8"), text, rel);
}));

test("removal keeps servers added after setup and deletes empty generated files", () => fixture(({ repoDir, invoke }) => {
  invoke("m.materializeRepo(ctx)");
  const path = join(repoDir, ".vscode/mcp.json");
  const file = parse(readFileSync(path, "utf8"));
  file.servers.later = { command: "later-server" };
  writeFileSync(path, JSON.stringify(file));
  invoke("m.removeRepo(ctx.repoDir)");
  assert.deepEqual(parse(readFileSync(path, "utf8")), { servers: { later: { command: "later-server" } } });
  assert.ok(!existsSync(join(repoDir, ".github")));
}));

test("bare CLI server maps and shared mode are supported", () => fixture(({ repoDir, invoke }) => {
  mkdirSync(join(repoDir, ".github"));
  const path = join(repoDir, ".github/mcp.json");
  const original = '{"mine":{"command":"server"}}\n';
  writeFileSync(path, original);
  invoke("m.materializeRepo({ ...ctx, share: true })");
  assert.ok(parse(readFileSync(path, "utf8"))["flow-graph"]);
  assert.ok(!readFileSync(join(repoDir, ".git/info/exclude"), "utf8").includes("flow:begin"));
  invoke("m.removeRepo(ctx.repoDir)");
  assert.equal(readFileSync(path, "utf8"), original);
}));

test("malformed Copilot config is reported without overwriting it", () => fixture(({ repoDir, invoke }) => {
  mkdirSync(join(repoDir, ".github/hooks"), { recursive: true });
  const path = join(repoDir, ".github/hooks/flow.json");
  writeFileSync(path, "{ broken");
  invoke(`
    import assert from "node:assert/strict";
    assert.throws(() => m.materializeRepo(ctx), /Invalid Copilot configuration/);
  `);
  assert.equal(readFileSync(path, "utf8"), "{ broken");
}));

test("comment-only Copilot MCP config is treated as empty and restored on removal", () => fixture(({ repoDir, invoke }) => {
  mkdirSync(join(repoDir, ".vscode"));
  const path = join(repoDir, ".vscode/mcp.json");
  const original = `// {
// \t"servers": {
// \t\t"landinghero-library": {
// \t\t\t"type": "http",
// \t\t\t"url": "http://localhost:8080/library-mcp"
// \t\t}
// \t},
// \t"inputs": []
// }
`;
  writeFileSync(path, original);
  invoke("m.materializeRepo(ctx)");
  const installed = readFileSync(path, "utf8");
  const parsed = parse(installed);
  assert.equal(parsed.servers["flow-graph"].type, "stdio");
  assert.ok(installed.includes("landinghero-library"));
  invoke("m.removeRepo(ctx.repoDir)");
  assert.equal(readFileSync(path, "utf8"), original);
}));

test("Copilot detection recognizes an installed VS Code extension", () => fixture(({ home, invoke }) => {
  mkdirSync(join(home, ".vscode/extensions/github.copilot-chat-1.0.0"), { recursive: true });
  assert.ok(JSON.parse(invoke("console.log(JSON.stringify(m.detectHarnesses()))")).includes("copilot"));
}));

test("removal restores pre-existing empty config maps", () => fixture(({ repoDir, invoke }) => {
  const originals = {
    ".vscode/mcp.json": '{ "servers": {} }\n',
    ".github/mcp.json": '{ "mcpServers": {} }\n',
    ".github/hooks/flow.json": '{ "hooks": {} }\n',
  };
  for (const [rel, content] of Object.entries(originals)) {
    mkdirSync(join(repoDir, rel, ".."), { recursive: true });
    writeFileSync(join(repoDir, rel), content);
  }
  invoke("m.materializeRepo(ctx); m.removeRepo(ctx.repoDir)");
  for (const [rel, content] of Object.entries(originals)) assert.equal(readFileSync(join(repoDir, rel), "utf8"), content);
}));

test("rendered hook commands preserve spaces and shell metacharacters in bindings", () => fixture(({ home, repoDir, invoke }) => {
  invoke(`m.materializeRepo({ ...ctx, project: "project with spaces", repo: "repo's $literal" })`);
  mkdirSync(join(home, ".flow/bin"), { recursive: true });
  writeFileSync(join(home, ".flow/bin/flow-hook"), "console.log(JSON.stringify(process.argv.slice(2)))");
  const hooks = parse(readFileSync(join(repoDir, ".github/hooks/flow.json"), "utf8"));
  const result = spawnSync(hooks.hooks.Stop[0].command, { shell: true, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ["--harness", "copilot", "--project", "project with spaces", "--repo", "repo's $literal", "--remote", "local"]);
}));

test("removing another tool's integration leaves unrelated Copilot config alone", () => fixture(({ repoDir, invoke }) => {
  mkdirSync(join(repoDir, ".vscode"));
  const path = join(repoDir, ".vscode/mcp.json");
  writeFileSync(path, "{ unfinished user config");
  invoke('m.materializeRepo({ ...ctx, harnesses: ["gemini"] }); m.removeRepo(ctx.repoDir)');
  assert.equal(readFileSync(path, "utf8"), "{ unfinished user config");
}));
