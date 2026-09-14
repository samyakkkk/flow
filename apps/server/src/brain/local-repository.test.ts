// @effect-diagnostics nodeBuiltinImport:off - Disposable real Git repositories exercise the indexing checkout boundary.
import { afterEach, expect, it, vi } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { BrainRuntime } from "./BrainRuntime.ts";
import { BrainCliUnavailableError, run } from "./process.ts";

vi.mock("./process.ts", async (original) => {
  const module = await original<typeof import("./process.ts")>();
  return {
    ...module,
    run: vi.fn((...args: Parameters<typeof module.run>) => {
      if (args[0] === "gh") throw new Error("GitHub CLI is unavailable");
      return module.run(...args);
    }),
  };
});
const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  for (const root of roots.splice(0)) await NodeFSP.rm(root, { recursive: true, force: true });
});

it.each(["git@github.com:example/private.git", "https://github.com/example/private.git"])(
  "prepares and updates a local indexing checkout without gh or remote access: %s",
  async (origin) => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "flow-local-index-"));
    roots.push(root);
    const folderPath = NodePath.join(root, "selected");
    await NodeFSP.mkdir(folderPath);
    const git = (args: string[]) => run("git", args, { cwd: folderPath });
    await git(["init", "--initial-branch=main"]);
    await git(["remote", "add", "origin", origin]);
    const commit = async (message: string) => {
      await NodeFSP.writeFile(NodePath.join(folderPath, "README.md"), message);
      await git(["add", "README.md"]);
      await git([
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        message,
      ]);
      return git(["rev-parse", "HEAD"]);
    };
    const runtime = new BrainRuntime(NodePath.join(root, "brain"), {
      platform: "darwin",
      architecture: "arm64",
    });
    const empty = await runtime["inspectFolder"](folderPath);
    expect(empty.hasCommit).toBe(false);
    const first = await commit("first");
    const folder = await runtime["inspectFolder"](folderPath);
    expect(folder).toEqual({
      repository: "example/private",
      localPath: await NodeFSP.realpath(folderPath),
      github: true,
      hasCommit: true,
    });
    const workspace = {
      id: "test",
      name: "Test",
      cli: "codex" as const,
      sources: [],
      projectIds: [],
    };
    const source = {
      id: "source",
      repository: folder.repository,
      localPath: folder.localPath,
      branch: "",
      commit: "",
      revision: "",
      status: "queued" as const,
      message: "",
      indexedAt: null,
    };
    // Stop at the graph boundary; this test exercises real Git preparation, not the model/database.
    runtime["flowGraph"] = () => {
      throw new Error("checkout ready for indexing");
    };
    const prepare = () =>
      runtime["index"](workspace, source, "codex", new AbortController().signal);
    await expect(prepare()).rejects.toThrow("checkout ready for indexing");
    const checkout = NodePath.join(
      root,
      "brain",
      "workspaces",
      workspace.id,
      "repos",
      folder.repository,
    );
    expect(await run("git", ["rev-parse", "HEAD"], { cwd: checkout })).toBe(first);
    const second = await commit("second");
    await expect(prepare()).rejects.toThrow("checkout ready for indexing");
    expect(await run("git", ["rev-parse", "HEAD"], { cwd: checkout })).toBe(second);
    expect(vi.mocked(run).mock.calls.some(([binary]) => binary === "gh")).toBe(false);
  },
);

it("reports missing Git instead of telling users to make their first commit", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "flow-no-git-"));
  roots.push(root);
  const runtime = new BrainRuntime(NodePath.join(root, "brain"), {
    platform: "darwin",
    architecture: "arm64",
  });
  vi.mocked(run)
    .mockRejectedValueOnce(new BrainCliUnavailableError("git"))
    .mockRejectedValueOnce(new BrainCliUnavailableError("git"));
  await expect(runtime["inspectFolder"](root)).rejects.toThrow("Git (`git`) was not found on PATH");
});
