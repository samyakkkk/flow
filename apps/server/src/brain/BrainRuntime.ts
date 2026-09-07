import { prepareNativeFalkor } from "./native.ts";
// @effect-diagnostics globalDate:off - Persisted wall-clock timestamps at the native adapter boundary.
// @effect-diagnostics nodeBuiltinImport:off - Native database/CLI adapter owns Node lifecycle and filesystem I/O.
import {
  BrainWorkspace as WorkspaceSchema,
  type BrainCommand,
  type BrainState,
  type BrainSource,
  type BrainWorkspace,
  type BrainKnowledge,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { FalkorDB } from "falkordblite";
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { BrainEmbeddings } from "./embeddings.ts";
import { indexRepository } from "./indexer.ts";
import { githubRepository, run } from "./process.ts";

type Source = { -readonly [K in keyof BrainSource]: BrainSource[K] };
type Workspace = { id: string; name: string; cli: BrainWorkspace["cli"]; sources: Source[] };
const decodeWorkspaces = Schema.decodeUnknownSync(Schema.Array(WorkspaceSchema));
const decodeStoredKnowledge = Schema.decodeUnknownSync(WorkspaceSchema.fields.knowledge);
const emptyKnowledge = (): BrainKnowledge => ({ entities: [], edges: [], memories: [] });
const active = (source: Source) =>
  ["queued", "cloning", "indexing", "embedding"].includes(source.status);

/** One owner per T3 installation, shared by every workspace and renderer. */
export class BrainRuntime {
  private db: FalkorDB | undefined;
  private starting: Promise<void> | undefined;
  private database: BrainState["database"] = {
    status: "stopped",
    message: "Preparing the local FalkorDB runtime…",
  };
  private github: BrainState["github"] = {
    connected: false,
    login: "",
    message: "Public repositories work without sign-in. Checking GitHub CLI…",
  };
  private clis: BrainState["clis"] = [];
  private workspaces: Workspace[] = [];
  private jobs = new Map<string, AbortController>();
  private queue: Promise<void> = Promise.resolve();
  private writes: Promise<void> = Promise.resolve();
  private closed = false;
  private ownsLock = false;
  private readonly databasePath: string;
  readonly embeddings: BrainEmbeddings;

  readonly directory: string;
  readonly host: { platform: NodeJS.Platform; architecture: NodeJS.Architecture };
  constructor(
    directory: string,
    options: {
      databasePath?: string;
      platform: NodeJS.Platform;
      architecture: NodeJS.Architecture;
    },
  ) {
    this.directory = directory;
    this.host = options;
    // FalkorDBLite requires a <104-byte Unix socket path on macOS. Worktree
    // paths routinely exceed that. Stable hashed storage also isolates dev homes.
    this.databasePath =
      options.databasePath ??
      NodePath.join(
        NodeOS.homedir(),
        ".flow-brain",
        NodeCrypto.createHash("sha256").update(directory).digest("hex").slice(0, 12),
      );
    this.embeddings = new BrainEmbeddings(NodePath.join(directory, "models"));
  }
  async initialize() {
    await NodeFSP.mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const saved = decodeWorkspaces(
        JSON.parse(
          await NodeFSP.readFile(NodePath.join(this.directory, "workspaces.json"), "utf8"),
        ),
      );
      this.workspaces = saved.map((workspace) => ({
        ...workspace,
        sources: workspace.sources.map((source) =>
          active({ ...source })
            ? {
                ...source,
                status: "error",
                message: "Indexing was interrupted. Retry to continue.",
              }
            : { ...source },
        ),
      }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("Brain workspace registry could not be read. It has been left untouched.");
    }
    this.clis = await Promise.all(
      (["claude", "codex"] as const).map(async (id) => ({
        id,
        installed: await run(id, ["--version"]).then(
          () => true,
          () => false,
        ),
      })),
    );
    await this.refreshGithub();
    await this.start();
  }
  private save() {
    const data = JSON.stringify(
      this.workspaces.map((workspace) => ({ ...workspace, knowledge: emptyKnowledge() })),
      null,
      2,
    );
    const pending = this.writes.then(async () => {
      const target = NodePath.join(this.directory, "workspaces.json");
      const temp = `${target}.${NodeCrypto.randomUUID()}.tmp`;
      await NodeFSP.writeFile(temp, data, { mode: 0o600 });
      await NodeFSP.rename(temp, target);
    });
    this.writes = pending.catch(() => {});
    return pending;
  }
  async start() {
    if (this.db?.isRunning) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      try {
        if (this.closed) throw new Error("Brain runtime is shutting down.");
        await NodeFSP.mkdir(this.databasePath, { recursive: true, mode: 0o700 });
        const lock = NodePath.join(this.databasePath, "owner.lock");
        try {
          await NodeFSP.mkdir(lock);
          this.ownsLock = true;
        } catch {
          const pid = Number(
            await NodeFSP.readFile(NodePath.join(lock, "pid"), "utf8").catch(() => "0"),
          );
          let alive = pid <= 0;
          try {
            if (pid > 0) {
              process.kill(pid, 0);
              alive = true;
            }
          } catch {
            /* exited owner */
          }
          if (alive)
            throw new Error(
              "This brain runtime is already open in another server. Connect to that server instead.",
            );
          await NodeFSP.rm(lock, { recursive: true });
          await NodeFSP.mkdir(lock);
          this.ownsLock = true;
        }
        await NodeFSP.writeFile(NodePath.join(lock, "pid"), String(process.pid), { mode: 0o600 });
        const binaries = await prepareNativeFalkor(
          this.databasePath,
          this.host.platform,
          this.host.architecture,
        );
        this.db = await FalkorDB.open({
          ...binaries,
          path: this.databasePath,
          logLevel: "warning",
          additionalConfig: { appendonly: "yes", appendfsync: "always" },
        });
        await this.db.selectGraph("flow_runtime").query("RETURN 1 AS ready");
        this.database = {
          status: "ready",
          message: "Native FalkorDB · persistent · shared across workspaces · no Docker",
        };
      } catch (error) {
        this.database = {
          status: "error",
          message: error instanceof Error ? error.message : "Could not start native FalkorDB.",
        };
        await this.db?.close().catch(() => {});
        this.db = undefined;
        if (this.ownsLock) {
          await NodeFSP.rm(NodePath.join(this.databasePath, "owner.lock"), {
            recursive: true,
            force: true,
          });
          this.ownsLock = false;
        }
      }
    })().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }
  private async refreshGithub() {
    try {
      const value = JSON.parse(await run("gh", ["api", "user", "--jq", "{login: .login}"])) as {
        login?: string;
      };
      if (!value.login) throw new Error("No GitHub account");
      this.github = {
        connected: true,
        login: value.login,
        message: "Using this machine’s GitHub CLI sign-in. Repository access is read-only.",
      };
    } catch {
      this.github = {
        connected: false,
        login: "",
        message:
          "Public repositories work now. For private repositories, sign in to GitHub in Settings → Source control, then refresh here.",
      };
    }
  }
  private workspace(id: string) {
    const workspace = this.workspaces.find((entry) => entry.id === id);
    if (!workspace) throw new Error("Workspace not found.");
    return workspace;
  }
  private async readKnowledge(workspace: Workspace): Promise<BrainKnowledge> {
    if (!this.db?.isRunning) return emptyKnowledge();
    const graph = this.db.selectGraph(`brain_${workspace.id.replaceAll("-", "")}`);
    const combined = {
      entities: [] as BrainKnowledge["entities"][number][],
      edges: [] as BrainKnowledge["edges"][number][],
      memories: [] as BrainKnowledge["memories"][number][],
    };
    for (const source of workspace.sources) {
      if (!source.revision) continue;
      const result = await graph.roQuery<{ data: string }>(
        "MATCH (s:BrainIndex {sourceId: $sourceId, revision: $revision}) RETURN s.data AS data",
        { params: { sourceId: source.id, revision: source.revision } },
      );
      const row = result.data?.[0];
      if (!row) throw new Error("An index is missing from FalkorDB. Retry indexing this source.");
      const knowledge = decodeStoredKnowledge(JSON.parse(row.data));
      const prefix = (id: string) => `${source.id}:${id}`;
      const citation = (path: string) => {
        const match = /^(.*):(\d+)$/.exec(path);
        return match
          ? `https://github.com/${source.repository}/blob/${source.commit}/${match[1]!.split("/").map(encodeURIComponent).join("/")}#L${match[2]}`
          : path;
      };
      combined.entities.push(
        ...knowledge.entities.map((entity) => ({
          ...entity,
          id: prefix(entity.id),
          source: citation(entity.source),
        })),
      );
      combined.edges.push(
        ...knowledge.edges.map((edge) => ({
          ...edge,
          from: prefix(edge.from),
          to: prefix(edge.to),
        })),
      );
      combined.memories.push(
        ...knowledge.memories.map((memory) => ({
          ...memory,
          id: prefix(memory.id),
          source: citation(memory.source),
          entityIds: memory.entityIds.map(prefix),
        })),
      );
    }
    return combined;
  }
  async state(): Promise<BrainState> {
    if (this.db && !this.db.isRunning)
      this.database = {
        status: "error",
        message: "FalkorDB stopped. Retry the local runtime; existing data has not been replaced.",
      };
    return {
      database: this.database,
      embeddings: { status: this.embeddings.status, message: this.embeddings.message },
      github: this.github,
      clis: this.clis,
      workspaces: await Promise.all(
        this.workspaces.map(async (workspace) => ({
          ...workspace,
          sources: workspace.sources.map((source) => ({ ...source })),
          knowledge: await this.readKnowledge(workspace),
        })),
      ),
    };
  }
  async command(command: BrainCommand) {
    if (this.closed) throw new Error("Brain runtime is shutting down.");
    if (command.action === "read") return;
    if (command.action === "start") return this.start();
    if (command.action === "refreshGithub") return this.refreshGithub();
    if (command.action === "create") {
      const name = command.name.trim();
      if (!name || name.length > 80)
        throw new Error("Workspace name must contain 1–80 characters.");
      this.workspaces.push({ id: NodeCrypto.randomUUID(), name, cli: command.cli, sources: [] });
      await this.save();
      return;
    }
    const workspace = this.workspace(command.workspaceId);
    if (command.action === "configure") {
      workspace.cli = command.cli;
      await this.save();
      return;
    }
    if (command.action === "cancel") {
      const source = workspace.sources.find((entry) => entry.id === command.sourceId);
      if (!source) throw new Error("Source not found.");
      this.jobs.get(source.id)?.abort();
      if (active(source)) {
        source.status = "cancelled";
        source.message = "Indexing cancelled. The previous index is preserved.";
        await this.save();
      }
      return;
    }
    if (!this.db?.isRunning)
      throw new Error("Start the local FalkorDB runtime before importing a repository.");
    if (!this.clis.find((cli) => cli.id === workspace.cli)?.installed)
      throw new Error(`Install ${workspace.cli} and refresh the app before indexing.`);
    let source: Source;
    if (command.action === "import") {
      const repository = githubRepository(command.repository);
      if (
        workspace.sources.some(
          (entry) => entry.repository.toLowerCase() === repository.toLowerCase(),
        )
      )
        throw new Error("That repository is already connected. Use Reindex to update it.");
      source = {
        id: NodeCrypto.randomUUID(),
        repository,
        branch: "",
        commit: "",
        revision: "",
        status: "queued",
        message: "Waiting for the shared indexer…",
        indexedAt: null,
      };
      workspace.sources.push(source);
    } else {
      const found = workspace.sources.find((entry) => entry.id === command.sourceId);
      if (!found) throw new Error("Source not found.");
      source = found;
      if (this.jobs.has(source.id)) throw new Error("This repository already has an indexing job.");
      source.status = "queued";
      source.message = "Waiting for the shared indexer…";
    }
    const controller = new AbortController();
    this.jobs.set(source.id, controller);
    const cli = workspace.cli;
    await this.save();
    this.queue = this.queue
      .then(async () => {
        try {
          if (!controller.signal.aborted)
            await this.index(workspace, source, cli, controller.signal);
        } catch (error) {
          source.status = controller.signal.aborted ? "cancelled" : "error";
          source.message = controller.signal.aborted
            ? "Indexing cancelled. The previous index is preserved."
            : error instanceof Error
              ? error.message
              : "Indexing failed. Retry to continue.";
          await this.save();
        } finally {
          this.jobs.delete(source.id);
        }
      })
      .catch(() => {
        this.database = {
          status: "error",
          message: "Could not persist the indexing job state. Check disk space and permissions.",
        };
      });
  }
  private async index(
    workspace: Workspace,
    source: Source,
    cli: BrainWorkspace["cli"],
    signal: AbortSignal,
  ) {
    const revision = NodeCrypto.randomUUID();
    const directory = NodePath.join(this.directory, "jobs", revision);
    const repoPath = NodePath.join(directory, "repository");
    await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
    source.status = "cloning";
    source.message = `Cloning ${source.repository} from GitHub…`;
    await this.save();
    if (this.github.connected)
      await run(
        "gh",
        [
          "repo",
          "clone",
          source.repository,
          repoPath,
          "--",
          "--depth",
          "1",
          "--single-branch",
          "--no-tags",
        ],
        { signal, timeout: 5 * 60_000 },
      );
    else
      await run(
        "git",
        [
          "clone",
          "--depth",
          "1",
          "--single-branch",
          "--no-tags",
          "--",
          `https://github.com/${source.repository}.git`,
          repoPath,
        ],
        { signal, timeout: 5 * 60_000 },
      );
    const commit = await run("git", ["rev-parse", "HEAD"], { cwd: repoPath, signal });
    const branch = await run("git", ["branch", "--show-current"], { cwd: repoPath, signal });
    source.status = "indexing";
    source.message = `${cli === "claude" ? "Claude Code" : "Codex"} is building the architecture graph…`;
    await this.save();
    const { knowledge, coverage } = await indexRepository(
      cli,
      source.repository,
      repoPath,
      NodePath.join(directory, "analysis"),
      signal,
    );
    signal.throwIfAborted();
    source.status = "embedding";
    source.message = "Creating local embeddings and writing to FalkorDB…";
    await this.save();
    const graph = this.db!.selectGraph(`brain_${workspace.id.replaceAll("-", "")}`);
    for (const entity of knowledge.entities) {
      const vector = await this.embeddings.embed(`${entity.name}\n${entity.description}`);
      signal.throwIfAborted();
      // Kinds are validated against the shared Flow ontology before interpolation.
      await graph.query(
        `CREATE (n:BrainEntity:${entity.kind} {id: $id, sourceId: $sourceId, revision: $revision, name: $name, description: $description, source: $source, embedding: vecf32($vector)})`,
        {
          params: {
            id: entity.id,
            sourceId: source.id,
            revision,
            name: entity.name,
            description: entity.description,
            source: entity.source,
            vector,
          },
        },
      );
    }
    for (const edge of knowledge.edges) {
      signal.throwIfAborted();
      await graph.query(
        `MATCH (a:BrainEntity {id: $from, sourceId: $sourceId, revision: $revision}), (b:BrainEntity {id: $to, sourceId: $sourceId, revision: $revision}) CREATE (a)-[:${edge.label}]->(b)`,
        { params: { from: edge.from, to: edge.to, sourceId: source.id, revision } },
      );
    }
    for (const memory of knowledge.memories) {
      const vector = await this.embeddings.embed(`${memory.title}\n${memory.body}`);
      signal.throwIfAborted();
      await graph.query(
        "CREATE (:BrainMemory {id: $id, sourceId: $sourceId, revision: $revision, data: $data, embedding: vecf32($vector)})",
        {
          params: {
            id: memory.id,
            sourceId: source.id,
            revision,
            data: JSON.stringify(memory),
            vector,
          },
        },
      );
    }
    signal.throwIfAborted();
    await graph.query(
      "CREATE (:BrainIndex {sourceId: $sourceId, revision: $revision, data: $data})",
      { params: { sourceId: source.id, revision, data: JSON.stringify(knowledge) } },
    );
    // Publish only after the complete index is durable (AOF fsync=always).
    const previous = {
      commit: source.commit,
      branch: source.branch,
      revision: source.revision,
      indexedAt: source.indexedAt,
    };
    source.commit = commit;
    source.branch = branch;
    source.revision = revision;
    source.status = "ready";
    source.indexedAt = new Date().toISOString();
    source.message = `${coverage} · ${cli}`;
    try {
      await this.save();
    } catch (error) {
      Object.assign(source, previous);
      throw error;
    }
  }
  async drain() {
    await this.queue;
  }
  async close() {
    this.closed = true;
    for (const controller of this.jobs.values()) controller.abort();
    await this.starting;
    await this.queue;
    await this.embeddings.close();
    await this.db?.close();
    if (this.ownsLock)
      await NodeFSP.rm(NodePath.join(this.databasePath, "owner.lock"), {
        recursive: true,
        force: true,
      });
  }
}
