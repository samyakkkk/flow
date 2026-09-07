// @effect-diagnostics nodeBuiltinImport:off - Real isolated git evidence for incremental indexing.
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { indexRepository, incrementalContext, type BuilderContext } from "./indexer.ts";
import { builderAsset } from "./builder-assets.ts";
import { run, runStreaming } from "./process.ts";
import { indexRepoPrompt } from "../../../../flow/orchestrator/src/index-prompt.ts";
vi.mock("./process.ts", async (original) => ({
  ...(await original<typeof import("./process.ts")>()),
  run: vi.fn(async (executable: string, args: string[], options: Parameters<typeof run>[2]) => {
    if (executable === process.execPath) return "";
    return (await original<typeof import("./process.ts")>()).run(executable, args, options);
  }),
  runStreaming: vi.fn(),
}));
const roots: string[] = [];
afterEach(async () => {
  vi.mocked(runStreaming).mockReset();
  for (const root of roots.splice(0)) await NodeFSP.rm(root, { recursive: true, force: true });
});
async function temp() {
  const root = await NodeFSP.mkdtemp("/tmp/flow-builder-test-");
  roots.push(root);
  return root;
}

describe("original Flow builder", () => {
  it.each(["claude", "codex", "opencode"] as const)(
    "uses the authoritative prompt, graph tools and streaming activity for %s",
    async (cli) => {
      const root = await temp();
      const events: string[] = [];
      const context: BuilderContext = {
        platform: "linux",
        graph: "isolated_brain",
        socket: "/tmp/test.sock",
        embedUrl: "http://127.0.0.1:1",
        embedToken: "test",
        workspace: root,
        branch: "main",
        onActivity: (activity) => {
          for (const event of activity?.events ?? []) events.push(event.label);
        },
      };
      vi.mocked(runStreaming).mockImplementation(async (_exe, _args, opts) => {
        const tool =
          cli === "claude"
            ? {
                type: "assistant",
                message: {
                  content: [
                    {
                      type: "tool_use",
                      name: "mcp__flow-graph__upsert_entity",
                      input: { id: "svc:api" },
                    },
                  ],
                },
              }
            : cli === "codex"
              ? {
                  type: "item.completed",
                  item: {
                    type: "mcp_tool_call",
                    server: "flow-graph",
                    tool: "upsert_entity",
                    arguments: { id: "svc:api" },
                  },
                }
              : {
                  type: "tool_use",
                  part: {
                    tool: "graph_upsert_entity",
                    state: { status: "completed", input: { id: "svc:api" } },
                  },
                };
        opts.onLine(JSON.stringify(tool));
        if (cli === "codex")
          await NodeFSP.writeFile(NodePath.join(root, "job", "summary.md"), "Indexed");
        else opts.onLine(JSON.stringify({ type: "result", result: "Indexed" }));
      });
      await indexRepository(
        cli,
        "example/api",
        root,
        NodePath.join(root, "job"),
        new AbortController().signal,
        context,
      );
      const prompt = await NodeFSP.readFile(NodePath.join(root, "job", "prompt.md"), "utf8");
      expect(prompt).toBe(
        `${builderAsset(".opencode/agents/graph-builder.md").replace(/^---\n[\s\S]*?\n---\n/, "")}\n\n${indexRepoPrompt("example/api", "main").prompt}`,
      );
      expect(events).toContain("graph_upsert_entity svc:api");
      const [exe, args, opts] = vi.mocked(runStreaming).mock.calls[0]!;
      expect(exe).toBe(cli);
      expect(opts.env.FLOW_FIXED_GRAPH).toBe("isolated_brain");
      expect(opts.env.FLOW_EMBED_URL).toBe("http://127.0.0.1:1/embed");
      expect(args).not.toContain("--tools");
    },
  );
  it("uses a real Git diff only for a same-branch indexed ancestor", async () => {
    const cwd = await temp();
    await run("git", ["init", "-b", "main"], { cwd });
    await run("git", ["config", "user.email", "test@example.com"], { cwd });
    await run("git", ["config", "user.name", "Test"], { cwd });
    await NodeFSP.writeFile(NodePath.join(cwd, "readme.md"), "first\n");
    await run("git", ["add", "."], { cwd });
    await run("git", ["commit", "-m", "first"], { cwd });
    const before = await run("git", ["rev-parse", "HEAD"], { cwd });
    await NodeFSP.writeFile(NodePath.join(cwd, "readme.md"), "second\n");
    await run("git", ["commit", "-am", "second"], { cwd });
    const inc = await incrementalContext(cwd, "main", "main", before);
    expect(inc?.from).toBe(before);
    expect(inc?.stat).toContain("readme.md");
    expect(indexRepoPrompt("api", "main", inc).prompt).toContain("Read the actual diff");
    expect(await incrementalContext(cwd, "other", "main", before)).toBeNull();
    expect(await incrementalContext(cwd, "main", "main", "f".repeat(40))).toBeNull();
  });
});
