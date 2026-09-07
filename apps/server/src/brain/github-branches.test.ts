import { describe, expect, it, vi, beforeEach } from "vite-plus/test";
import { BrainRuntime } from "./BrainRuntime.ts";
import { run } from "./process.ts";

vi.mock("./process.ts", async (original) => ({
  ...(await original<typeof import("./process.ts")>()),
  run: vi.fn(),
}));

const runtime = new BrainRuntime("/tmp/flow-branch-list-test", {
  platform: "darwin",
  architecture: "arm64",
});
beforeEach(() => {
  vi.mocked(run).mockReset();
});

describe("GitHub branch discovery", () => {
  it("loads all pages, preserving branch names with slashes", async () => {
    vi.mocked(run).mockResolvedValue("main\nfeature/new-brain\nrelease/v2\nmain\n");
    expect(await runtime.listGithubBranches("https://github.com/octocat/Spoon-Knife.git")).toEqual([
      "main",
      "feature/new-brain",
      "release/v2",
    ]);
    expect(run).toHaveBeenCalledWith("gh", [
      "api",
      "repos/octocat/Spoon-Knife/branches?per_page=100",
      "--paginate",
      "--jq",
      ".[].name",
    ]);
  });
  it("rejects invalid repository paths before calling GitHub", async () => {
    await expect(runtime.listGithubBranches("owner/repo/../../user")).rejects.toThrow(
      "Enter a GitHub repository",
    );
    expect(run).not.toHaveBeenCalled();
  });
  it("surfaces GitHub failures for the branch retry control", async () => {
    vi.mocked(run).mockRejectedValue(new Error("GitHub is unavailable"));
    await expect(runtime.listGithubBranches("octocat/Spoon-Knife")).rejects.toThrow(
      "GitHub is unavailable",
    );
  });
});
