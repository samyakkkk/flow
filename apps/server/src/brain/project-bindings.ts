// @effect-diagnostics nodeBuiltinImport:off - Atomic brain association storage.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import type { ProjectId } from "@t3tools/contracts";

const decode = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.NullOr(Schema.String)));
type Project = {
  id: ProjectId;
  workspaceRoot: string;
  repositoryIdentity?: { canonicalKey: string } | null | undefined;
};

/** A repository's brain is independent of its checkout ids. Null records an explicit disconnect. */
export class ProjectBrainBindings {
  private projects = new Map<ProjectId, string>();
  private choices: Record<string, string | null> = {};
  private readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
  }
  async initialize() {
    try {
      this.choices = decode(
        JSON.parse(
          await NodeFSP.readFile(NodePath.join(this.directory, "project-brains.json"), "utf8"),
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  register(project: Project) {
    if (!project.repositoryIdentity && this.projects.has(project.id)) return;
    this.projects.set(
      project.id,
      project.repositoryIdentity?.canonicalKey
        ? `repository:${project.repositoryIdentity.canonicalKey}`
        : `project:${project.id}`,
    );
  }
  configuredProjectIds() {
    return [...this.projects.keys()].filter((id) => Object.hasOwn(this.choices, this.key(id)));
  }
  private key(id: ProjectId) {
    return this.projects.get(id) ?? `project:${id}`;
  }
  members(id: ProjectId) {
    const key = this.key(id);
    return [
      ...new Set([
        id,
        ...[...this.projects].filter(([, value]) => value === key).map(([member]) => member),
      ]),
    ];
  }
  resolve(id: ProjectId, legacy: (id: ProjectId) => string | undefined) {
    const key = this.key(id);
    if (Object.hasOwn(this.choices, key)) return this.choices[key] ?? undefined;
    const previous = new Set(
      this.members(id)
        .map(legacy)
        .filter((value) => value !== undefined),
    );
    if (previous.size > 1)
      throw new Error(
        "This project's checkouts have conflicting brains. Choose one brain for the project in Settings → Projects.",
      );
    return previous.values().next().value;
  }
  idsFor(
    workspace: string,
    legacy: (id: ProjectId) => string | undefined,
    fallback: readonly ProjectId[],
  ) {
    return [...new Set([...this.projects.keys(), ...fallback])].filter((id) => {
      try {
        return this.resolve(id, legacy) === workspace;
      } catch {
        return legacy(id) === workspace;
      }
    });
  }
  async adoptLegacy(resolveCurrent: (id: ProjectId) => string | undefined) {
    const next = { ...this.choices };
    let changed = false;
    for (const id of this.projects.keys()) {
      const key = this.key(id);
      if (Object.hasOwn(next, key)) continue;
      try {
        const workspace = resolveCurrent(id);
        if (workspace) {
          next[key] = workspace;
          changed = true;
        }
      } catch {
        /* Conflicting legacy choices require the user to select one. */
      }
    }
    if (changed) await this.persist(next);
  }
  async bind(id: ProjectId, workspace: string | null) {
    await this.persist({ ...this.choices, [this.key(id)]: workspace });
  }
  private async persist(next: Record<string, string | null>) {
    await NodeFSP.mkdir(this.directory, { recursive: true });
    const file = NodePath.join(this.directory, "project-brains.json");
    const temp = `${file}.${NodeCrypto.randomUUID()}.tmp`;
    await NodeFSP.writeFile(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
    await NodeFSP.rename(temp, file);
    this.choices = next;
  }
}
