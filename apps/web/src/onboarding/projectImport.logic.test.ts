import { EnvironmentId, ProjectId, type AgentSessionProjectCandidate } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  groupOnboardingProjects,
  githubRepositoryKey,
  matchGithubProjects,
  matchRemoteBrainSources,
  folderMatchesRemoteSource,
  isSuggestedBrainProject,
  projectIsWithinFolder,
  partitionOnboardingProjects,
  onboardingProjectKey,
  resolveOnboardingLandingProject,
  resolveOnboardingProjectId,
} from "./projectImport.logic";

const now = Date.parse("2026-08-22T12:00:00.000Z");

function candidate(
  path: string,
  overrides: Partial<AgentSessionProjectCandidate> = {},
): AgentSessionProjectCandidate {
  return {
    title: path.split("/").at(-1) ?? path,
    path,
    sources: ["codex"],
    threadCount: 3,
    lastActiveAt: "2026-08-20T12:00:00.000Z",
    alreadyImported: false,
    git: { remoteKey: null, repository: null },
    ...overrides,
  };
}

const github = (repository: string) => ({
  remoteKey: `github.com/${repository.toLowerCase()}`,
  repository,
});

describe("partitionOnboardingProjects", () => {
  it("keeps existing projects available for thread history import", () => {
    const imported = candidate("/projects/current", { alreadyImported: true });
    const available = candidate("/projects/other");

    expect(partitionOnboardingProjects([imported, available], now)).toEqual({
      available: [imported, available],
      recent: [imported, available],
    });
  });

  it("keeps projects older than 30 days out of the default selection", () => {
    const recent = candidate("/projects/recent");
    const older = candidate("/projects/older", {
      lastActiveAt: "2026-07-01T12:00:00.000Z",
    });

    expect(partitionOnboardingProjects([recent, older], now)).toEqual({
      available: [recent, older],
      recent: [recent],
    });
  });

  it("keeps future activity out of the default selection", () => {
    const recent = candidate("/projects/recent");
    const future = candidate("/projects/future", {
      lastActiveAt: "2026-08-23T12:00:00.000Z",
    });

    expect(partitionOnboardingProjects([recent, future], now)).toEqual({
      available: [recent, future],
      recent: [recent],
    });
  });

  it("keeps non-git folders and thin histories out of the default selection", () => {
    const repo = candidate("/projects/repo");
    const folder = candidate("/projects/folder", { git: null });
    const thin = candidate("/projects/thin", { threadCount: 2 });

    expect(partitionOnboardingProjects([repo, folder, thin], now).recent).toEqual([repo]);
  });
});

describe("groupOnboardingProjects", () => {
  it("groups clones by origin, keeps local repos separate, and folds non-git folders away", () => {
    const main = candidate("/code/t3code", {
      git: github("pingdotgg/t3code"),
      threadCount: 79,
      lastActiveAt: "2026-08-21T12:00:00.000Z",
    });
    const clone = candidate("/code/clones/t3code-2", {
      git: github("pingdotgg/t3code"),
      threadCount: 13,
      lastActiveAt: "2026-08-10T12:00:00.000Z",
    });
    const older = candidate("/code/fleet", {
      git: github("t3dotgg/fleet"),
      threadCount: 295,
      lastActiveAt: "2026-08-22T00:00:00.000Z",
    });
    const local = candidate("/code/scratch-repo", { title: "scratch-repo" });
    const folder = candidate("/tmp/notes", { git: null });

    const grouped = groupOnboardingProjects([main, clone, older, local, folder]);

    expect(grouped.other).toEqual([folder]);
    expect(
      grouped.repositories.map((group) => ({
        label: group.label,
        paths: group.candidates.map((item) => item.path),
        threadCount: group.threadCount,
        lastActiveAt: group.lastActiveAt,
      })),
    ).toEqual([
      {
        label: "t3dotgg/fleet",
        paths: ["/code/fleet"],
        threadCount: 295,
        lastActiveAt: "2026-08-22T00:00:00.000Z",
      },
      {
        label: "pingdotgg/t3code",
        paths: ["/code/t3code", "/code/clones/t3code-2"],
        threadCount: 92,
        lastActiveAt: "2026-08-21T12:00:00.000Z",
      },
      {
        label: "scratch-repo",
        paths: ["/code/scratch-repo"],
        threadCount: 3,
        lastActiveAt: "2026-08-20T12:00:00.000Z",
      },
    ]);
  });
});

describe("resolveOnboardingProjectId", () => {
  const localEnvironmentId = EnvironmentId.make("local");
  const remoteEnvironmentId = EnvironmentId.make("remote");
  const localProjectId = ProjectId.make("local-project");

  it("uses the scanned project ID before the project reaches the client", () => {
    expect(
      resolveOnboardingProjectId(
        [],
        localEnvironmentId,
        candidate("/projects/repo", { projectId: localProjectId }),
      ),
    ).toBe(localProjectId);
  });

  it("uses the scanned project ID when the client still has an older project at that root", () => {
    expect(
      resolveOnboardingProjectId(
        [
          {
            id: ProjectId.make("stale-project"),
            environmentId: localEnvironmentId,
            workspaceRoot: "/projects/repo",
          },
        ],
        localEnvironmentId,
        candidate("/projects/repo", { projectId: localProjectId }),
      ),
    ).toBe(localProjectId);
  });

  it("returns null to create a project when neither the scan nor the client has a project ID", () => {
    expect(
      resolveOnboardingProjectId([], localEnvironmentId, candidate("/projects/new")),
    ).toBeNull();
  });

  it("finds an existing project by normalized root in the target environment", () => {
    expect(
      resolveOnboardingProjectId(
        [
          {
            id: ProjectId.make("remote-project"),
            environmentId: remoteEnvironmentId,
            workspaceRoot: "C:\\Work\\Repo",
          },
          {
            id: localProjectId,
            environmentId: localEnvironmentId,
            workspaceRoot: "C:\\Work\\Repo\\",
          },
        ],
        localEnvironmentId,
        candidate("c:/work/repo"),
      ),
    ).toBe(localProjectId);
  });

  it("does not reuse a project from another environment", () => {
    expect(
      resolveOnboardingProjectId(
        [
          {
            id: ProjectId.make("remote-project"),
            environmentId: remoteEnvironmentId,
            workspaceRoot: "/projects/repo",
          },
        ],
        localEnvironmentId,
        candidate("/projects/repo"),
      ),
    ).toBeNull();
  });

  it("finds an alias after the scanner returns its persisted project root", () => {
    expect(
      resolveOnboardingProjectId(
        [
          {
            id: localProjectId,
            environmentId: localEnvironmentId,
            workspaceRoot: "/real/projects/repo",
          },
        ],
        localEnvironmentId,
        candidate("/real/projects/repo"),
      ),
    ).toBe(localProjectId);
  });

  it("finds the current root owner when the scan has no project ID", () => {
    const recreatedProjectId = ProjectId.make("recreated-project");
    expect(
      resolveOnboardingProjectId(
        [
          {
            id: localProjectId,
            environmentId: localEnvironmentId,
            workspaceRoot: "/projects/other",
          },
          {
            id: recreatedProjectId,
            environmentId: localEnvironmentId,
            workspaceRoot: "/projects/repo",
          },
        ],
        localEnvironmentId,
        candidate("/projects/repo"),
      ),
    ).toBe(recreatedProjectId);
  });

  it("does not reuse a moved project when the scan has no project ID", () => {
    expect(
      resolveOnboardingProjectId(
        [
          {
            id: localProjectId,
            environmentId: localEnvironmentId,
            workspaceRoot: "/projects/moved",
          },
        ],
        localEnvironmentId,
        candidate("/projects/repo"),
      ),
    ).toBeNull();
  });
});

describe("resolveOnboardingLandingProject", () => {
  it("skips a failed first project for a later project with imported history", () => {
    expect(
      resolveOnboardingLandingProject(
        ["/projects/failed", "/projects/imported"],
        new Map([["/projects/imported", "imported"]]),
        new Map([["/projects/imported", "imported"]]),
      ),
    ).toBe("imported");
  });

  it("prefers a partial first import that added history", () => {
    expect(
      resolveOnboardingLandingProject(
        ["/projects/partial", "/projects/complete"],
        new Map([["/projects/partial", "partial"]]),
        new Map([["/projects/complete", "complete"]]),
      ),
    ).toBe("partial");
  });

  it("uses a completed zero-history project when no import added history", () => {
    expect(
      resolveOnboardingLandingProject(
        ["/projects/empty", "/projects/failed"],
        new Map(),
        new Map([["/projects/empty", "empty"]]),
      ),
    ).toBe("empty");
  });

  it("keeps an earlier successful import available on retry", () => {
    expect(
      resolveOnboardingLandingProject(
        ["/projects/imported", "/projects/retry"],
        new Map([["/projects/imported", "imported"]]),
        new Map([["/projects/imported", "imported"]]),
      ),
    ).toBe("imported");
  });

  it("ignores cached successes outside the current retry selection", () => {
    expect(
      resolveOnboardingLandingProject(
        ["/projects/current"],
        new Map([["/projects/previous", "previous"]]),
        new Map([
          ["/projects/previous", "previous"],
          ["/projects/current", "current"],
        ]),
      ),
    ).toBe("current");
  });
});

describe("projects on multiple computers", () => {
  it("keeps identical paths independent when selecting a landing project after partial imports", () => {
    const first = onboardingProjectKey(EnvironmentId.make("first"), "/code/app");
    const second = onboardingProjectKey(EnvironmentId.make("second"), "/code/app");
    const completed = new Map([[first, "first-project"]]);
    expect(completed.has(second)).toBe(false);
    expect(resolveOnboardingLandingProject([second], completed, completed)).toBeUndefined();
    completed.set(second, "second-project");
    expect(resolveOnboardingLandingProject([second, first], completed, completed)).toBe(
      "second-project",
    );
  });

  it("preserves computer identity when choosing recent projects", () => {
    const first = { ...candidate("/code/app"), environmentId: "first" };
    const second = { ...candidate("/code/app"), environmentId: "second" };
    expect(partitionOnboardingProjects([first, second], now).recent).toEqual([first, second]);
  });
});

describe("Brain project suggestions", () => {
  it("hides internal Brain folders even when their parent was chosen", () => {
    expect(isSuggestedBrainProject("/tmp/test/userdata/brain/workspaces/uuid", ["/tmp/test"])).toBe(
      false,
    );
    expect(isSuggestedBrainProject("/home/me/project/.t3/worktrees/task")).toBe(false);
    expect(isSuggestedBrainProject("/home/me/flow/data/projects/demo/workspace/repos/app")).toBe(
      false,
    );
  });
  it("offers temporary projects only after explicit folder selection", () => {
    expect(isSuggestedBrainProject("/private/tmp/test/app")).toBe(false);
    expect(isSuggestedBrainProject("/private/tmp/test/app", ["/tmp/test"])).toBe(true);
    expect(isSuggestedBrainProject("/home/me/projects/app")).toBe(true);
  });
  it("matches nested folders without matching siblings with the same prefix", () => {
    expect(projectIsWithinFolder("/private/tmp/test/team/app", "/tmp/test")).toBe(true);
    expect(projectIsWithinFolder("/tmp/testing/app", "/tmp/test")).toBe(false);
  });
});

describe("GitHub additions reuse local projects", () => {
  it("normalizes GitHub URL forms and rejects other hosts", () => {
    expect(githubRepositoryKey("git@github.com:Team/App.git")).toBe("team/app");
    expect(githubRepositoryKey("https://github.com/team/app/")).toBe("team/app");
    expect(githubRepositoryKey("https://example.com/team/app")).toBeNull();
  });
  it("selects the local checkout by remote identity", () => {
    const checkout = candidate("/work/different-name", { git: github("team/app") });
    expect(matchGithubProjects("https://github.com/TEAM/APP.git", [checkout], [])).toEqual([
      checkout,
    ]);
  });
  it("reuses a parent project and deduplicates its matching checkouts", () => {
    const parentId = ProjectId.make("parent");
    const matches = matchGithubProjects(
      "team/app",
      [
        candidate("/work/team/api", { git: github("team/app") }),
        candidate("/work/team/copy", { git: github("team/app") }),
      ],
      [{ path: "/work/team", title: "Team", projectId: parentId }],
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ path: "/work/team", title: "Team", projectId: parentId });
  });
  it("does not reuse a child's project id for a newly selected parent", () => {
    const matches = matchGithubProjects(
      "team/app",
      [
        candidate("/work/team/app", {
          git: github("team/app"),
          projectId: ProjectId.make("child"),
        }),
      ],
      [{ path: "/work/team", title: "Team" }],
    );
    expect(matches[0]?.projectId).toBeUndefined();
  });
  it("keeps repositories without a checkout source-only and ignores internal clones", () => {
    expect(
      matchGithubProjects(
        "team/app",
        [
          candidate("/work/app", { git: github("other/app") }),
          candidate("/home/me/.t3/userdata/brain/workspaces/id/repo", { git: github("team/app") }),
        ],
        [],
      ),
    ).toEqual([]);
  });
});

describe("matchRemoteBrainSources", () => {
  const checkout = candidate("/work/app", { git: github("team/app") });
  const other = candidate("/work/site", { git: github("team/site") });

  it("matches a connected Brain's repositories to their local clones", () => {
    const { matched, unmatched } = matchRemoteBrainSources(
      ["https://github.com/team/app", "https://github.com/team/site"],
      [checkout, other],
      [],
    );

    expect(matched.map((entry) => entry.repository)).toEqual([
      "https://github.com/team/app",
      "https://github.com/team/site",
    ]);
    expect(matched[0]!.candidates.map((entry) => entry.path)).toEqual(["/work/app"]);
    expect(unmatched).toEqual([]);
  });

  it("reports repositories without a local clone, and non-GitHub sources, as unmatched", () => {
    const { matched, unmatched } = matchRemoteBrainSources(
      ["https://github.com/team/app", "https://github.com/team/absent", "https://git.acme.dev/x/y"],
      [checkout],
      [],
    );

    expect(matched.map((entry) => entry.repository)).toEqual(["https://github.com/team/app"]);
    expect(unmatched).toEqual(["https://github.com/team/absent", "https://git.acme.dev/x/y"]);
  });

  it("reports one entry for sources that name the same repository", () => {
    const { matched } = matchRemoteBrainSources(
      ["https://github.com/team/app", "git@github.com:TEAM/app.git"],
      [checkout],
      [],
    );

    expect(matched).toHaveLength(1);
  });

  it("skips internal indexing clones the picker already hides", () => {
    const indexed = candidate("/home/me/.t3/userdata/brain/workspaces/w1/repos/app", {
      git: github("team/app"),
    });

    expect(
      matchRemoteBrainSources(["https://github.com/team/app"], [indexed], []).unmatched,
    ).toEqual(["https://github.com/team/app"]);
  });
});

describe("folderMatchesRemoteSource", () => {
  it("accepts a clone of the same repository, whatever the URL form", () => {
    expect(
      folderMatchesRemoteSource("https://github.com/team/app", "git@github.com:TEAM/app.git"),
    ).toBe(true);
  });

  it("rejects a different repository, a non-GitHub origin, and a folder without one", () => {
    expect(
      folderMatchesRemoteSource("https://github.com/team/app", "https://github.com/team/site"),
    ).toBe(false);
    expect(
      folderMatchesRemoteSource("https://git.acme.dev/team/app", "https://git.acme.dev/team/app"),
    ).toBe(false);
    expect(folderMatchesRemoteSource("https://github.com/team/app", null)).toBe(false);
  });
});
