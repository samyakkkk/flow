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
  type ProjectId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { FalkorDB } from "falkordblite";
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { BrainEmbeddings } from "./embeddings.ts";
import { indexRepository } from "./indexer.ts";
import { startBuilderBridge } from "./builder-bridge.ts";
import { githubRepository, run } from "./process.ts";

type Source = { -readonly [K in keyof BrainSource]: BrainSource[K] };
type Workspace = {
  id: string;
  name: string;
  cli: BrainWorkspace["cli"];
  sources: Source[];
  projectIds: ProjectId[];
};
const decodeWorkspaces = Schema.decodeUnknownSync(Schema.Array(WorkspaceSchema));
const decodeStoredKnowledge = Schema.decodeUnknownSync(WorkspaceSchema.fields.knowledge);
const decodeGithubRepositories = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      name: Schema.String,
      private: Schema.Boolean,
      description: Schema.optional(Schema.String),
      defaultBranch: Schema.optional(Schema.String),
    }),
  ),
);
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
  private commands: Promise<unknown> = Promise.resolve();
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
        projectIds: [...(workspace.projectIds ?? [])],
        sources: workspace.sources.map((source) =>
          active({ ...source })
            ? {
                ...source,
                status: "queued",
                reindexRequested: false,
                message: "Resuming indexing after restart…",
              }
            : { ...source },
        ),
      }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("Brain workspace registry could not be read. It has been left untouched.", {
          cause: error,
        });
    }
    this.clis = await Promise.all(
      (["claude", "codex", "opencode"] as const).map(async (id) => ({
        id,
        installed: await run(id, ["--version"]).then(
          () => true,
          () => false,
        ),
      })),
    );
    await this.refreshGithub();
    await this.start();
    if (this.db?.isRunning)
      await Promise.all(this.workspaces.map((workspace) => this.ensureWorkspaceGraph(workspace)));
    if (this.db?.isRunning) {
      for (const workspace of this.workspaces)
        for (const source of workspace.sources)
          if (source.status === "queued") await this.enqueue(workspace, source);
    }
  }
  private async ensureWorkspaceGraph(workspace: Workspace) {
    const graph = this.db!.selectGraph(`brain_${workspace.id.replaceAll("-", "")}`);
    await graph.query(
      "MERGE (brain:Brain {id: $id}) SET brain.name = $name, brain.createdAt = coalesce(brain.createdAt, $createdAt)",
      { params: { id: workspace.id, name: workspace.name, createdAt: new Date().toISOString() } },
    );
    await this.flowGraph(workspace).query("RETURN 1 AS ready");
    return graph;
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
  private flowGraph(workspace: Workspace) {
    return this.db!.selectGraph(`flow_brain_${workspace.id.replaceAll("-", "")}`);
  }
  private async readKnowledge(workspace: Workspace): Promise<BrainKnowledge> {
    if (this.db?.isRunning && workspace.sources.some((source) => source.pipeline === "flow")) {
      const graph = this.flowGraph(workspace);
      // Read the canonical graph, including writes from an in-flight builder.
      // Never send embedding vectors or wait for a final provider response.
      const [nodes, relations] = await Promise.all([
        graph.roQuery<{
          id: string;
          name: string;
          kind: string;
          description: string;
          source: string;
          properties: Record<string, string>;
        }>(
          "MATCH (n) WHERE n.id IS NOT NULL RETURN n.id AS id, coalesce(n.name,n.id) AS name, labels(n)[0] AS kind, coalesce(n.description,'') AS description, coalesce(n.evidence,'') AS source, {aliases:n.aliases, purpose:n.purpose, uses:n.uses, does_not_use:n.does_not_use, sensitive_to:n.sensitive_to, not_sensitive_to:n.not_sensitive_to, triage_note:n.triage_note, confidence:n.confidence} AS properties ORDER BY n.id",
        ),
        graph.roQuery<{ from: string; to: string; label: string }>(
          "MATCH (a)-[r]->(b) WHERE a.id IS NOT NULL AND b.id IS NOT NULL RETURN a.id AS from, b.id AS to, type(r) AS label",
        ),
      ]);
      return {
        entities: (nodes.data ?? []).map((node) => {
          node.properties = Object.fromEntries(
            Object.entries(node.properties ?? {}).filter(
              ([, value]) => typeof value === "string" && value.length > 0,
            ),
          );
          const source = workspace.sources.find((source) =>
            node.source.startsWith(`${source.repository} `),
          );
          if (!source || source.localPath) return node;
          const evidence = node.source.slice(source.repository.length + 1);
          const match = /^(.*):(\d+)$/.exec(evidence);
          return match
            ? {
                ...node,
                source: `https://github.com/${source.repository}/blob/${source.evidenceCommit || source.commit || source.branch || "HEAD"}/${match[1]!.split("/").map(encodeURIComponent).join("/")}#L${match[2]}`,
              }
            : node;
        }),
        edges: relations.data ?? [],
        memories: [],
      };
    }
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
        if (source.localPath) return path;
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
  command(command: BrainCommand) {
    const result = this.commands.then(() => this.executeCommand(command));
    this.commands = result.catch(() => {});
    return result;
  }
  private async executeCommand(command: BrainCommand) {
    if (this.closed) throw new Error("Brain runtime is shutting down.");
    if (command.action === "read") return null;
    if (command.action === "listGithubRepositories" || command.action === "listGithubBranches")
      return null;
    if (command.action === "bindProject")
      throw new Error("Project connections must be resolved by the server.");
    if (command.action === "start") {
      await this.start();
      return null;
    }
    if (command.action === "refreshGithub") {
      await this.refreshGithub();
      return null;
    }
    if (command.action === "create") {
      const name = command.name.trim();
      if (!name || name.length > 80)
        throw new Error("Workspace name must contain 1–80 characters.");
      if (this.workspaces.some((workspace) => workspace.name.toLowerCase() === name.toLowerCase()))
        throw new Error("A brain with that name already exists.");
      if (!this.db?.isRunning)
        throw new Error("The local brain could not be started. Retry after checking the app logs.");
      if (!this.clis.find((cli) => cli.id === command.cli)?.installed)
        throw new Error(`Install ${command.cli} before using it to create a brain.`);
      const workspace: Workspace = {
        id: NodeCrypto.randomUUID(),
        name,
        cli: command.cli,
        sources: [],
        projectIds: [],
      };
      const graph = await this.ensureWorkspaceGraph(workspace);
      this.workspaces.push(workspace);
      try {
        await this.save();
      } catch (error) {
        this.workspaces = this.workspaces.filter((entry) => entry.id !== workspace.id);
        await graph.delete().catch(() => {});
        throw error;
      }
      return workspace.id;
    }
    const workspace = this.workspace(command.workspaceId);
    if (command.action === "configure") {
      if (!this.clis.some((cli) => cli.id === command.cli && cli.installed))
        throw new Error(`Install ${command.cli} before choosing it.`);
      const previous = workspace.cli;
      workspace.cli = command.cli;
      try {
        await this.save();
      } catch (error) {
        workspace.cli = previous;
        throw error;
      }
      return null;
    }
    if (command.action === "removeSource") {
      const source = workspace.sources.find((entry) => entry.id === command.sourceId);
      if (!source) throw new Error("Source not found.");
      if (active(source)) throw new Error("Cancel indexing before removing this source.");
      const previous = workspace.sources;
      workspace.sources = workspace.sources.filter((entry) => entry !== source);
      try {
        await this.save();
      } catch (error) {
        workspace.sources = previous;
        throw error;
      }
      return null;
    }
    if (command.action === "cancel") {
      const source = workspace.sources.find((entry) => entry.id === command.sourceId);
      if (!source) throw new Error("Source not found.");
      source.reindexRequested = false;
      this.jobs.get(source.id)?.abort();
      if (active(source)) {
        source.status = "cancelled";
        source.message = "Indexing cancelled. Knowledge already written is preserved.";
        await this.save();
      }
      return null;
    }
    if (!this.db?.isRunning)
      throw new Error("Start the local FalkorDB runtime before importing a repository.");
    if (!this.clis.find((cli) => cli.id === workspace.cli)?.installed)
      throw new Error(`Install ${workspace.cli} and refresh the app before indexing.`);
    let source: Source;
    let previousSource: Source | undefined;
    if (command.action === "import" || command.action === "importFolder") {
      const folder =
        command.action === "importFolder" ? await this.inspectFolder(command.path) : null;
      const repository =
        command.action === "import" ? githubRepository(command.repository) : folder!.repository;
      const branch = command.action === "import" ? (command.branch?.trim() ?? "") : "";
      if (branch) await run("git", ["check-ref-format", "--branch", branch]);
      if (
        workspace.sources.some((entry) =>
          folder?.localPath
            ? entry.localPath === folder.localPath
            : !entry.localPath && entry.repository.toLowerCase() === repository.toLowerCase(),
        )
      )
        throw new Error("That repository is already connected. Use Reindex to update it.");
      source = {
        id: NodeCrypto.randomUUID(),
        repository,
        ...(folder?.localPath ? { localPath: folder.localPath } : {}),
        branch,
        commit: "",
        revision: "",
        status: "queued",
        message: "Waiting for the shared indexer…",
        indexedAt: null,
      };
      workspace.sources.push(source);
      if (folder && !folder.hasCommit) {
        source.status = "waiting";
        source.message = "Make the first Git commit, then index this source.";
        try {
          await this.save();
        } catch (error) {
          workspace.sources = workspace.sources.filter((entry) => entry !== source);
          throw error;
        }
        return null;
      }
    } else {
      const found = workspace.sources.find((entry) => entry.id === command.sourceId);
      if (!found) throw new Error("Source not found.");
      source = found;
      if (this.jobs.has(source.id)) {
        // Flow coalesces repeated requests into one follow-up pass per repository.
        source.reindexRequested = true;
        await this.save();
        return null;
      }
      previousSource = { ...source };
      source.status = "queued";
      source.message = "Waiting for the shared indexer…";
    }
    try {
      await this.enqueue(workspace, source);
    } catch (error) {
      if (previousSource) Object.assign(source, previousSource);
      else workspace.sources = workspace.sources.filter((entry) => entry !== source);
      throw error;
    }
    return null;
  }
  private async enqueue(workspace: Workspace, source: Source) {
    const controller = new AbortController();
    this.jobs.set(source.id, controller);
    const cli = workspace.cli;
    try {
      await this.save();
    } catch (error) {
      this.jobs.delete(source.id);
      throw error;
    }
    this.queue = this.queue
      .then(async () => {
        try {
          if (!controller.signal.aborted)
            await this.index(workspace, source, cli, controller.signal);
        } catch (error) {
          source.status = this.closed
            ? "queued"
            : controller.signal.aborted
              ? "cancelled"
              : "error";
          source.message = controller.signal.aborted
            ? "Indexing cancelled. Knowledge already written is preserved."
            : error instanceof Error
              ? error.message
              : "Indexing failed. Retry to continue.";
          await this.save();
        } finally {
          this.jobs.delete(source.id);
          if (source.reindexRequested && !this.closed && source.status !== "cancelled") {
            source.reindexRequested = false;
            source.status = "queued";
            source.message = "Waiting for the shared indexer…";
            await this.enqueue(workspace, source);
          }
        }
      })
      .catch(() => {
        this.database = {
          status: "error",
          message: "Could not persist the indexing job state. Check disk space and permissions.",
        };
      });
  }
  private async inspectFolder(path: string) {
    if (!NodePath.isAbsolute(path))
      throw new Error("Choose an absolute folder path on this computer.");
    const localPath = await NodeFSP.realpath(path);
    if (!(await NodeFSP.stat(localPath)).isDirectory()) throw new Error("Choose a folder.");
    const origin = await run("git", ["remote", "get-url", "origin"], { cwd: localPath }).catch(
      () => "",
    );
    let repository = NodePath.basename(localPath);
    let github = false;
    if (/^(https:\/\/github\.com\/|git@github\.com:)/i.test(origin)) {
      repository = githubRepository(origin.replace(/^git@github\.com:/i, "https://github.com/"));
      github = true;
    }
    const hasCommit = await run("git", ["rev-parse", "--verify", "HEAD"], { cwd: localPath }).then(
      () => true,
      () => false,
    );
    return {
      repository,
      localPath: github ? undefined : localPath,
      hasCommit: github || hasCommit,
    };
  }
  /** Resolve the path from T3's project record, never from an agent's arguments. */
  bindProject(project: { id: ProjectId; workspaceRoot: string }, workspaceId: string | null) {
    const result = this.commands.then(async () => {
      if (this.closed) throw new Error("Brain runtime is shutting down.");
      const workspace = workspaceId ? this.workspace(workspaceId) : null;
      if (workspace) {
        const folder = await this.inspectFolder(project.workspaceRoot);
        const existing = workspace.sources.find((source) =>
          folder.localPath
            ? source.localPath === folder.localPath
            : !source.localPath &&
              source.repository.toLowerCase() === folder.repository.toLowerCase(),
        );
        if (!existing)
          await this.executeCommand({
            action: "importFolder",
            workspaceId: workspace.id,
            path: project.workspaceRoot,
          });
      }
      const previous = this.workspaces.map((entry) => [...entry.projectIds]);
      for (const entry of this.workspaces)
        entry.projectIds = entry.projectIds.filter((id) => id !== project.id);
      workspace?.projectIds.push(project.id);
      try {
        await this.save();
      } catch (error) {
        this.workspaces.forEach((entry, i) => {
          entry.projectIds = previous[i]!;
        });
        throw error;
      }
    });
    this.commands = result.catch(() => {});
    return result;
  }
  projectBrainId(projectId: ProjectId) {
    return this.workspaces.find((entry) => entry.projectIds.includes(projectId))?.id;
  }
  async projectChatContext(projectId: ProjectId) {
    // Binding is authoritative on the environment server, including worktree chats.
    if (!this.projectBrainId(projectId)) return undefined;
    return this.projectKnowledge(projectId, "");
  }
  async projectKnowledge(projectId: ProjectId, query: string) {
    const workspace = this.workspaces.find((entry) => entry.projectIds.includes(projectId));
    if (!workspace)
      throw new Error("This project has no brain connected. Choose one on the Brain page.");
    if (!this.db?.isRunning)
      throw new Error("The connected brain is unavailable. Reconnect and retry.");
    const knowledge = await this.readKnowledge(workspace);
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const entities = knowledge.entities
      .filter(
        (entry) =>
          terms.length === 0 ||
          terms.some((term) =>
            `${entry.name} ${entry.description} ${entry.kind}`.toLowerCase().includes(term),
          ),
      )
      .slice(0, 40);
    const ids = new Set(entities.map((entry) => entry.id));
    return {
      brain: workspace.name,
      memories: knowledge.memories.slice(0, 20),
      truncated: entities.length < knowledge.entities.length || knowledge.memories.length > 20,
      entities,
      edges: knowledge.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)),
      sources: workspace.sources.map(({ repository, status }) => ({ repository, status })),
    };
  }
  async listGithubBranches(repository: string) {
    const name = githubRepository(repository);
    const rows = await run("gh", [
      "api",
      `repos/${name}/branches?per_page=100`,
      "--paginate",
      "--jq",
      ".[].name",
    ]);
    return [
      ...new Set(
        rows
          .split("\n")
          .map((branch) => branch.trim())
          .filter(Boolean),
      ),
    ];
  }
  async listGithubRepositories() {
    await this.refreshGithub();
    if (!this.github.connected)
      throw new Error(
        "Connect GitHub in Settings → Source control to browse private repositories.",
      );
    const rows = await run("gh", [
      "api",
      "user/repos?per_page=100&sort=pushed",
      "--paginate",
      "--jq",
      '.[] | {name: .full_name, private: .private, description: (.description // ""), defaultBranch: (.default_branch // "")}',
    ]);
    return decodeGithubRepositories(
      rows
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    ).slice(0, 1000);
  }
  private async index(
    workspace: Workspace,
    source: Source,
    cli: BrainWorkspace["cli"],
    signal: AbortSignal,
  ) {
    const revision = NodeCrypto.randomUUID();
    const directory = NodePath.join(this.directory, "jobs", revision);
    const workspacePath = NodePath.join(this.directory, "workspaces", workspace.id);
    const repoPath = NodePath.join(workspacePath, "repos", source.repository);
    await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
    await NodeFSP.mkdir(NodePath.dirname(repoPath), { recursive: true, mode: 0o700 });
    source.status = "cloning";
    source.message = `Reading ${source.repository}…`;
    source.activity = { toolCalls: 0, filesRead: 0, graphWrites: 0, events: [] };
    await this.save();
    const exists = await NodeFSP.stat(NodePath.join(repoPath, ".git")).then(
      () => true,
      () => false,
    );
    if (exists) {
      // Only app-owned clones live here; users' work folders are never checked out.
      await run("git", ["fetch", "--prune", "origin", ...(source.branch ? [source.branch] : [])], {
        cwd: repoPath,
        signal,
        timeout: 5 * 60_000,
      });
      await run("git", ["checkout", "-B", source.branch || "main", "FETCH_HEAD"], {
        cwd: repoPath,
        signal,
      });
    } else if (source.localPath) {
      await run(
        "git",
        ["clone", "--no-local", "--single-branch", "--no-tags", "--", source.localPath, repoPath],
        { signal, timeout: 5 * 60_000 },
      );
    } else if (this.github.connected) {
      await run(
        "gh",
        [
          "repo",
          "clone",
          source.repository,
          repoPath,
          "--",
          "--single-branch",
          "--no-tags",
          ...(source.branch ? ["--branch", source.branch] : []),
        ],
        { signal, timeout: 5 * 60_000 },
      );
    } else {
      await run(
        "git",
        [
          "clone",
          "--single-branch",
          "--no-tags",
          ...(source.branch ? ["--branch", source.branch] : []),
          "--",
          `https://github.com/${source.repository}.git`,
          repoPath,
        ],
        { signal, timeout: 5 * 60_000 },
      );
    }
    const commit = await run("git", ["rev-parse", "HEAD"], { cwd: repoPath, signal });
    const branch = await run("git", ["branch", "--show-current"], { cwd: repoPath, signal });
    const previousCommit = source.lastFlowCommit;
    const previousBranch = source.lastFlowBranch;
    await this.flowGraph(workspace).query("RETURN 1 AS ready");
    source.pipeline = "flow";
    source.evidenceCommit = commit;
    source.status = "indexing";
    source.message = `${workspace.cli === "claude" ? "Claude Code" : workspace.cli === "codex" ? "Codex" : "OpenCode"} is building the knowledge graph…`;
    await this.save();
    const bridge = await startBuilderBridge(this.embeddings);
    try {
      const result = await indexRepository(cli, source.repository, repoPath, directory, signal, {
        platform: this.host.platform,
        graph: `flow_brain_${workspace.id.replaceAll("-", "")}`,
        socket: this.db!.socketPath,
        embedUrl: bridge.url,
        embedToken: bridge.token,
        workspace: workspacePath,
        branch,
        previousCommit,
        previousBranch,
        onActivity: (activity) => {
          if (activity)
            source.activity = {
              ...activity.counts,
              events: activity.events.map((event) => ({ ...event })),
            };
        },
      });
      signal.throwIfAborted();
      // Same orchestrator-owned freshness metadata as Flow. Update the builder's
      // repository node; do not manufacture a disconnected node for a different ID convention.
      await this.flowGraph(workspace).query(
        "MATCH (n:Repository) WHERE n.id = $id OR n.name = $name SET n.default_branch = $branch, n.head_commit = $commit, n.indexed_at = $at",
        {
          params: {
            id: `repo:${source.repository}`,
            name: source.repository,
            branch,
            commit,
            at: new Date().toISOString(),
          },
        },
      );
      source.commit = commit;
      source.branch = branch;
      source.lastFlowCommit = commit;
      source.lastFlowBranch = branch;
      source.revision = revision;
      source.status = "ready";
      source.indexedAt = new Date().toISOString();
      source.summary = result.summary;
      source.message = `${result.incremental ? "Incremental update" : "Indexed"} · ${cli}`;
      await this.save();
    } finally {
      await bridge.close();
    }
  }
  async drain() {
    let pending: Promise<void>;
    do {
      pending = this.queue;
      await pending;
    } while (pending !== this.queue);
  }
  /** Test seam for verifying that creation establishes the graph immediately. */
  async dbGraphNames() {
    return this.db?.list() ?? [];
  }
  async close() {
    this.closed = true;
    await this.commands;
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
