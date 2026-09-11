// @effect-diagnostics nodeBuiltinImport:off - Isolated persistence tests.
import { it, expect } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
const { mkdtemp, rm } = NodeFSP;
import * as NodeOS from "node:os";
const { tmpdir } = NodeOS;
import * as NodePath from "node:path";
const { join } = NodePath;
import { ProjectId } from "@t3tools/contracts";
import { ProjectBrainBindings } from "./project-bindings.ts";

it("shares one durable choice across current and future checkouts, including explicit disconnect", async () => {
  const directory = await mkdtemp(join(tmpdir(), "brain-project-bindings-"));
  const first = {
    id: ProjectId.make("first"),
    workspaceRoot: "/first",
    repositoryIdentity: { canonicalKey: "github.com/team/repo" },
  };
  const second = { ...first, id: ProjectId.make("second"), workspaceRoot: "/second" };
  const legacy = (id: ProjectId) => (id === first.id ? "old-brain" : undefined);
  try {
    const bindings = new ProjectBrainBindings(directory);
    await bindings.initialize();
    bindings.register(first);
    bindings.register(second);
    expect(bindings.resolve(second.id, legacy)).toBe("old-brain");
    await bindings.adoptLegacy((id) => bindings.resolve(id, legacy));
    const migrated = new ProjectBrainBindings(directory);
    await migrated.initialize();
    migrated.register(second);
    expect(migrated.resolve(second.id, () => undefined)).toBe("old-brain");
    await bindings.bind(first.id, "new-brain");
    expect(bindings.resolve(second.id, legacy)).toBe("new-brain");
    const restarted = new ProjectBrainBindings(directory);
    await restarted.initialize();
    restarted.register(second);
    expect(restarted.resolve(second.id, legacy)).toBe("new-brain");
    await restarted.bind(second.id, null);
    const third = { ...first, id: ProjectId.make("third") };
    restarted.register(third);
    expect(restarted.resolve(third.id, legacy)).toBeUndefined();
    expect(restarted.configuredProjectIds()).toContain(third.id);
    expect(restarted.idsFor("old-brain", legacy, [first.id])).not.toContain(second.id);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("requires one explicit choice for conflicting legacy checkouts and keeps other repositories separate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "brain-project-conflict-"));
  const first = ProjectId.make("one");
  const second = ProjectId.make("two");
  const other = ProjectId.make("other");
  const legacy = (id: ProjectId) => (id === first ? "Samyak" : id === second ? "Flow" : undefined);
  try {
    const bindings = new ProjectBrainBindings(directory);
    for (const id of [first, second])
      bindings.register({
        id,
        workspaceRoot: `/${id}`,
        repositoryIdentity: { canonicalKey: "github.com/team/flow" },
      });
    bindings.register({
      id: other,
      workspaceRoot: "/other",
      repositoryIdentity: { canonicalKey: "github.com/team/other" },
    });
    expect(() => bindings.resolve(first, legacy)).toThrow("conflicting brains");
    expect(() => bindings.resolve(second, legacy)).toThrow("conflicting brains");
    await bindings.bind(second, "Flow");
    expect(bindings.resolve(first, legacy)).toBe("Flow");
    expect(bindings.resolve(second, legacy)).toBe("Flow");
    expect(bindings.resolve(other, legacy)).toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
