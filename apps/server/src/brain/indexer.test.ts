// @effect-diagnostics nodeBuiltinImport:off - Temporary Git repository verifies evidence isolation.
import { describe, expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { collectEvidence, validateKnowledge } from "./indexer.ts";
import { githubRepository, run } from "./process.ts";

const evidence = new Map([["README.md", "First line\nSecond line\n"]]);
const knowledge = {
  entities: [
    {
      id: "repo:demo",
      name: "Demo",
      kind: "Repository",
      description: "Demo",
      source: "README.md:2",
    },
  ],
  edges: [],
  memories: [],
};
describe("brain indexing boundaries", () => {
  it("accepts only GitHub repository identities, not commands or filesystem targets", () => {
    expect(githubRepository("https://github.com/octocat/Spoon-Knife.git")).toBe(
      "octocat/Spoon-Knife",
    );
    for (const input of [
      "../../etc",
      "file:///tmp/repo",
      "https://evil.example/owner/repo",
      "--upload-pack=x",
      "owner/repo?token=x",
      "owner/repo;id",
    ])
      expect(() => githubRepository(input)).toThrow();
  });
  it("rejects fabricated citations, invalid relations and duplicate entity identities", () => {
    expect(validateKnowledge(knowledge, evidence).entities).toHaveLength(1);
    expect(() =>
      validateKnowledge(
        { ...knowledge, entities: [{ ...knowledge.entities[0], source: "README.md:99" }] },
        evidence,
      ),
    ).toThrow();
    expect(() =>
      validateKnowledge(
        { ...knowledge, entities: [knowledge.entities[0], knowledge.entities[0]] },
        evidence,
      ),
    ).toThrow();
    expect(() =>
      validateKnowledge(
        { ...knowledge, edges: [{ from: "repo:demo", to: "missing", label: "USES" }] },
        evidence,
      ),
    ).toThrow();
    expect(() =>
      validateKnowledge(
        { ...knowledge, entities: [{ ...knowledge.entities[0], kind: "Injected) DELETE" }] },
        evidence,
      ),
    ).toThrow();
  });
  it("reads committed blobs without following symlinks or including environment files", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "brain-evidence-"));
    try {
      await run("git", ["init", "-q", directory]);
      await NodeFSP.writeFile(NodePath.join(directory, "README.md"), "\nFirst line\nSecond line\n");
      await NodeFSP.writeFile(NodePath.join(directory, ".env.local"), "SECRET=do-not-index");
      await NodeFSP.symlink(".env.local", NodePath.join(directory, "notes.md"));
      await run("git", ["add", "."], { cwd: directory });
      await run(
        "git",
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          "-c",
          "core.hooksPath=/dev/null",
          "commit",
          "-qm",
          "fixture",
        ],
        { cwd: directory },
      );
      const result = await collectEvidence(directory, new AbortController().signal);
      expect([...result.evidence.keys()]).toEqual(["README.md"]);
      expect(result.evidence.get("README.md")).toBe("\nFirst line\nSecond line\n");
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});
