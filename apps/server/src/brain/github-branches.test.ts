import { describe, expect, it, vi, beforeEach } from "vite-plus/test";
import { BrainRuntime } from "./BrainRuntime.ts";
import { BrainCliUnavailableError, run } from "./process.ts";

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

const refs = "abc\trefs/heads/main\ndef\trefs/heads/feature/new-brain\nabc\trefs/heads/main\n";
const expected = ["main", "feature/new-brain"];

describe("GitHub branch discovery", () => {
  it("uses existing HTTPS Git access without gh, preserving branch names with slashes", async () => {
    vi.mocked(run).mockImplementation(async (binary) => {
      if (binary === "gh") throw new BrainCliUnavailableError("gh");
      return refs;
    });
    expect(await runtime.listGithubBranches("https://github.com/octocat/Spoon-Knife.git")).toEqual(
      expected,
    );
    expect(run).toHaveBeenCalledExactlyOnceWith("git", [
      "ls-remote",
      "--heads",
      "--",
      "https://github.com/octocat/Spoon-Knife.git",
    ]);
  });
  it("uses SSH Git access when HTTPS is unavailable", async () => {
    vi.mocked(run)
      .mockRejectedValueOnce(new Error("HTTPS authentication failed"))
      .mockResolvedValueOnce(refs);
    expect(await runtime.listGithubBranches("octocat/Spoon-Knife")).toEqual(expected);
    expect(run).toHaveBeenLastCalledWith("git", [
      "ls-remote",
      "--heads",
      "--",
      "git@github.com:octocat/Spoon-Knife.git",
    ]);
    expect(run).toHaveBeenCalledTimes(2);
  });
  it("falls back to paginated GitHub API access when Git is missing", async () => {
    vi.mocked(run)
      .mockRejectedValueOnce(new BrainCliUnavailableError("git"))
      .mockResolvedValueOnce("main\nfeature/new-brain\nmain\n");
    expect(await runtime.listGithubBranches("octocat/Spoon-Knife")).toEqual(expected);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith("gh", [
      "api",
      "repos/octocat/Spoon-Knife/branches?per_page=100",
      "--paginate",
      "--jq",
      ".[].name",
    ]);
  });
  it("uses gh authentication when neither Git transport has access", async () => {
    vi.mocked(run)
      .mockRejectedValueOnce(new Error("HTTPS failed"))
      .mockRejectedValueOnce(new Error("SSH failed"))
      .mockResolvedValueOnce("main\n");
    expect(await runtime.listGithubBranches("octocat/Spoon-Knife")).toEqual(["main"]);
    expect(run).toHaveBeenCalledTimes(3);
  });
  it("does not require another tool for an empty repository", async () => {
    vi.mocked(run).mockResolvedValue("");
    expect(await runtime.listGithubBranches("octocat/Spoon-Knife")).toEqual([]);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("rejects invalid repository paths before running a command", async () => {
    await expect(runtime.listGithubBranches("owner/repo/../../user")).rejects.toThrow(
      "Enter a GitHub repository",
    );
    expect(run).not.toHaveBeenCalled();
  });
  it("explains that either CLI can list branches when both are missing", async () => {
    vi.mocked(run).mockImplementation(async (binary) => {
      throw new BrainCliUnavailableError(binary);
    });
    await expect(runtime.listGithubBranches("octocat/Spoon-Knife")).rejects.toThrow(
      "Install Git or GitHub CLI (`gh`)",
    );
  });
  it("provides access troubleshooting without exposing command output", async () => {
    vi.mocked(run).mockRejectedValue(new Error("private diagnostic"));
    await expect(runtime.listGithubBranches("octocat/Spoon-Knife")).rejects.toThrow(
      "Check repository access through Git (HTTPS or SSH), or sign in with `gh auth login`",
    );
  });
  it("keeps deployment-owned access isolated from local credential fallbacks", async () => {
    const branches = vi.fn().mockRejectedValue(new Error("Cloud credentials unavailable"));
    const hosted = new BrainRuntime("/tmp/flow-hosted-branch-list-test", {
      platform: "linux",
      architecture: "x64",
      githubAccess: {
        branches,
        repositories: vi.fn(),
        status: vi.fn(),
        gitEnvironment: vi.fn(),
      },
    });
    await expect(hosted.listGithubBranches("octocat/Spoon-Knife")).rejects.toThrow(
      "Cloud credentials unavailable",
    );
    expect(run).not.toHaveBeenCalled();
  });
});

it("preserves the missing-gh explanation when browsing repositories", async () => {
  vi.mocked(run).mockRejectedValue(new BrainCliUnavailableError("gh"));
  await expect(runtime.listGithubRepositories()).rejects.toThrow(
    "GitHub CLI (`gh`) was not found on PATH",
  );
});
