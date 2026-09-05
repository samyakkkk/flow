// Optional compatibility test against the installed OpenCode binary. A local
// deterministic model endpoint issues tool calls; no provider key or credits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { cloudOpencodeConfig } from "../src/agents/cloud-tool-policy.js";

test("real OpenCode loads the cloud hook and refuses source edits before executing tools", {
  skip: !process.env.FLOW_TEST_OPENCODE_BIN,
  timeout: 90_000,
}, async () => {
  const exec = promisify(execFile);
  const root = mkdtempSync(path.join(tmpdir(), "flow-opencode-smoke-"));
  const source = path.join(root, "repos", "api");
  const tree = path.join(root, "worktrees", "api", "task");
  mkdirSync(source, { recursive: true });
  writeFileSync(path.join(source, "file.txt"), "base\n");
  const git = (...args: string[]) => execFileSync("git", ["-C", source, ...args], { stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "base");
  git("worktree", "add", "-b", "flow/test", tree, "HEAD");
  // Reuse installed plugin dependencies; a smoke test should not depend on
  // OpenCode's background npm install or the user's home configuration.
  const configDir = path.join(root, "config", "opencode");
  mkdirSync(configDir, { recursive: true });
  symlinkSync(fileURLToPath(new URL("../../node_modules", import.meta.url)), path.join(configDir, "node_modules"));
  const pkg = { dependencies: { "@opencode-ai/plugin": "1.17.20" } };
  writeFileSync(path.join(configDir, "package.json"), JSON.stringify(pkg));
  writeFileSync(path.join(configDir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": pkg } }));
  let created = false;
  let turn = 0;
  let sawBlock = false;
  let sawShellBlock = false;
  const observedTools = new Set<string>();
  const server = createServer(async (req, res) => {
    let input = "";
    for await (const chunk of req) input += chunk;
    if (req.url?.endsWith("/workspace")) {
      assert.equal(req.headers.authorization, "Bearer smoke-token");
      const args = JSON.parse(input);
      if (args.edit) created = true;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ repos: [{ name: "api", source, baseBranch: "main", ...(created ? {
        worktree: { path: tree, branch: "flow/test", base_commit: "fixture" },
      } : {}) }] }));
      return;
    }
    if (req.url?.endsWith("/chat/completions")) {
      const body = JSON.parse(input);
      for (const entry of body.tools ?? []) observedTools.add(entry.function.name);
      if (input.includes("Shared checkout edit blocked")) sawBlock = true;
      if (input.includes("without changing directories")) sawShellBlock = true;
      const calls = [
        { name: "write", args: { filePath: path.join(source, "file.txt"), content: "should not land\n" } },
        { name: "read", args: { filePath: path.join(tree, "file.txt") } },
        { name: "write", args: { filePath: path.join(tree, "file.txt"), content: "changed\n" } },
        { name: "bash", args: { command: "git switch -c unexpected", workdir: tree } },
        { name: "bash", args: { command: "git diff --stat", workdir: tree } },
      ];
      const next = body.tools?.length ? calls[turn++] : undefined;
      res.setHeader("content-type", "text/event-stream");
      const chunk = (delta: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({
        id: "test", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`);
      if (next) {
        chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${turn}`, type: "function", function: { name: next.name, arguments: JSON.stringify(next.args) } }] });
        chunk({}, "tool_calls");
      } else {
        chunk({ role: "assistant", content: "Finished fixture" });
        chunk({}, "stop");
      }
      res.end("data: [DONE]\n\n");
      return;
    }
    res.writeHead(404).end();
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const config = cloudOpencodeConfig({
      provider: { fixture: {
        npm: "@ai-sdk/openai-compatible", name: "Fixture", options: { baseURL: `${url}/v1`, apiKey: "fixture" },
        models: { fixture: { name: "Fixture", limit: { context: 32_000, output: 4096 }, tool_call: true } },
      } },
      small_model: "fixture/fixture",
    });
    const env = {
      ...process.env,
      FLOW_MODE: "prod", FLOW_JOB_ID: "smoke-job", FLOW_JOB_TOKEN: "smoke-token", ORCHESTRATOR_URL: url,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_PROJECT_CONFIG: "true",
      OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
      OPENCODE_TEST_HOME: root,
      XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
      XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
    };
    const child = exec(process.env.FLOW_TEST_OPENCODE_BIN!, [
      "run", "--print-logs", "--log-level", "DEBUG", "--format", "json", "--agent", "flow-cloud", "-m", "fixture/fixture", "--dir", root, "Run the fixture",
    ], { cwd: root, env, timeout: 45_000, maxBuffer: 4 * 1024 * 1024 });
    child.child.stdin?.end(); // OpenCode reads piped stdin before starting the turn.
    const result = await child.catch((err) => {
      throw new Error(`OpenCode smoke failed: ${err.message}\n${String(err.stdout).slice(-8000)}\n${String(err.stderr).slice(-12000)}`);
    });
    assert.ok(observedTools.has("flow_workspace"), `Plugin tool not loaded: ${result.stderr}`);
    assert.ok(sawBlock, `Before-hook did not reject the shared path: ${result.stdout}`);
    assert.ok(sawShellBlock, `Before-hook did not reject the branch change: ${result.stdout}`);
    assert.equal(readFileSync(path.join(source, "file.txt"), "utf8"), "base\n");
    assert.equal(readFileSync(path.join(tree, "file.txt"), "utf8"), "changed\n");
    const branch = await exec("git", ["-C", source, "branch", "--show-current"]);
    assert.equal(branch.stdout.trim(), "main");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
