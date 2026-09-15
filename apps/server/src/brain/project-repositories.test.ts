// @effect-diagnostics nodeBuiltinImport:off - Native filesystem fixtures exercise the local adapter.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { projectRepositories } from "./project-repositories.ts";

it("finds independent repositories under one project and excludes plain folders and worktrees", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "brain-project-tree-"));
  try {
    await NodeFSP.mkdir(NodePath.join(root, "team", "api", ".git"), { recursive: true });
    await NodeFSP.mkdir(NodePath.join(root, "web", ".git"), { recursive: true });
    await NodeFSP.mkdir(NodePath.join(root, "notes"));
    await NodeFSP.mkdir(NodePath.join(root, "worktree"));
    await NodeFSP.writeFile(
      NodePath.join(root, "worktree", ".git"),
      "gitdir: /elsewhere/.git/worktrees/task",
    );
    await NodeFSP.mkdir(NodePath.join(root, "node_modules", "dependency", ".git"), {
      recursive: true,
    });
    const paths = await projectRepositories(root);
    expect(
      paths.map((path) =>
        path.slice(path.indexOf("brain-project-tree-")).split("/").slice(1).NodePath.join("/"),
      ),
    ).toEqual(["team/api", "web"]);
    expect(await projectRepositories(NodePath.join(root, "notes"))).toEqual([]);
    expect(await projectRepositories(NodePath.join(root, "web"))).toHaveLength(1);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
