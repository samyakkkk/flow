import { ProjectBrainBindings } from "./project-bindings.ts";
import { brainResourceEnvironment } from "@flow/brain-runtime";
// @effect-diagnostics globalTimers:off - Native capture retry lifecycle is owned and stopped by this runtime.
import {
  startSessionWorker,
  type BrainCapture,
  type BrainSessionContext,
} from "./session-worker.ts";
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
const decodeConsultedNodeIds = Schema.decodeUnknownSync(Schema.Array(Schema.String));
const FLOW_NODE_IDS_META_KEY = "flow/nodeIds";
const emptyKnowledge = (): BrainKnowledge => ({ entities: [], edges: [], memories: [] });
const active = (source: Source) =>
  ["queued", "cloning", "indexing", "embedding"].includes(source.status);

/** One owner per T3 installation, shared by every workspace and renderer. */
export class BrainRuntime {
  private db: FalkorDB | undefined;
  private sessionWorkers = new Map<
    string,
    Promise<Awaited<ReturnType<typeof startSessionWorker>>>
  >();
  private sessionBridge: Promise<Awaited<ReturnType<typeof startBuilderBridge>>> | undefined;
  private captureQueue: Promise<void> = Promise.resolve();
  private captureRetry: ReturnType<typeof setTimeout> | undefined;
  private captureBacklog = new Map<string, Workspace>();
  private captureSequence = 0;
  private projectRepositories = new Map<string, Promise<string>>();
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

  readonly projectBindings: ProjectBrainBindings;
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
    this.projectBindings = new ProjectBrainBindings(directory);
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
    await this.projectBindings.initialize();
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
      for (const workspace of this.workspaces) this.queueCapture(workspace);
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
  assertAvailable() {
    if (!this.db?.isRunning || this.closed)
      throw new Error(this.database.message || "The app's brain runtime is unavailable.");
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
  async state(projectId?: ProjectId, metadataOnly = false): Promise<BrainState> {
    if (this.db && !this.db.isRunning)
      this.database = {
        status: "error",
        message: "FalkorDB stopped. Retry the local runtime; existing data has not been replaced.",
      };
    return {
      configuredProjectIds: this.projectBindings.configuredProjectIds(),
      database: this.database,
      embeddings: { status: this.embeddings.status, message: this.embeddings.message },
      github: this.github,
      clis: this.clis,
      workspaces: await Promise.all(
        this.workspaces
          .filter(
            (workspace) =>
              projectId === undefined || this.projectBrainId(projectId) === workspace.id,
          )
          .map(async (workspace) => ({
            ...workspace,
            projectIds: this.projectBindings.idsFor(
              workspace.id,
              (id) => this.legacyProjectBrainId(id),
              workspace.projectIds,
            ),
            sources: workspace.sources.map((source) => ({ ...source })),
            knowledge: metadataOnly ? emptyKnowledge() : await this.readKnowledge(workspace),
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
    if (command.action === "readChat") throw new Error("Chat must be resolved by the server.");
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
      const worker = this.sessionWorkers.get(workspace.id);
      this.sessionWorkers.delete(workspace.id);
      if (worker) await (await worker).close();
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
    this.projectBindings.register(project);
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
      await this.projectBindings.bind(project.id, workspaceId);
    });
    this.commands = result.catch(() => {});
    return result;
  }
  private sessionRepository(root: string) {
    let repo = this.projectRepositories.get(root);
    if (!repo) {
      repo = this.inspectFolder(root).then((folder) => folder.repository);
      this.projectRepositories.set(root, repo);
      repo.catch(() => this.projectRepositories.delete(root));
    }
    return repo;
  }
  private legacyProjectBrainId(projectId: ProjectId) {
    return this.workspaces.find((entry) => entry.projectIds.includes(projectId))?.id;
  }
  projectBrainId(projectId: ProjectId) {
    return this.projectBindings.resolve(projectId, (id) => this.legacyProjectBrainId(id));
  }
  private async sessionWorker(workspace: Workspace) {
    let pending = this.sessionWorkers.get(workspace.id);
    if (pending && !(await pending).alive) {
      this.sessionWorkers.delete(workspace.id);
      pending = undefined;
    }
    if (!pending) {
      pending = (async () => {
        if (!this.db?.isRunning || this.closed)
          throw new Error("The connected brain is unavailable");
        this.sessionBridge ??= startBuilderBridge(this.embeddings);
        const bridge = await this.sessionBridge;
        const directory = NodePath.join(this.directory, "workspaces", workspace.id);
        await NodeFSP.mkdir(directory, { recursive: true });
        await this.writeSessionSources(workspace);
        return startSessionWorker({
          ...brainResourceEnvironment({
            graphName: `flow_brain_${workspace.id.replaceAll("-", "")}`,
            databaseSocket: this.db.socketPath,
            embeddingUrl: bridge.url,
            embeddingToken: bridge.token,
          }),
          // Explicit LLM configuration is safe to share; resource ownership
          // variables remain scoped to this brain worker.
          ...Object.fromEntries(
            [
              "LLM_TRANSPORT",
              "LLM_MODEL_FAST",
              "LLM_BASE_URL",
              "LLM_API_KEY",
              "OPENROUTER_API_KEY",
              "DISTILLER_MODEL",
              "FLOW_DISTILLER",
            ].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]!]])),
          ),
          FLOW_PROJECT_NAME: workspace.name,
          DB_PATH: NodePath.join(directory, "flow.db"),
          JOURNAL_PATH: NodePath.join(directory, "journal.jsonl"),
          OPENCODE_WORKSPACE_DIR: directory,
          FLOW_SOURCE_REGISTRY: NodePath.join(directory, "repos.json"),
          FLOW_ADMIN_TOKEN: NodeCrypto.randomBytes(32).toString("hex"),
          INDEXER_RUNTIME: workspace.cli,
        });
      })();
      this.sessionWorkers.set(workspace.id, pending);
      pending.catch(() => {
        if (this.sessionWorkers.get(workspace.id) === pending)
          this.sessionWorkers.delete(workspace.id);
      });
    }
    return pending;
  }
  private async writeSessionSources(workspace: Workspace) {
    const directory = NodePath.join(this.directory, "workspaces", workspace.id);
    await NodeFSP.mkdir(directory, { recursive: true });
    const registry = {
      repos: workspace.sources.map((source) => ({
        name: source.repository,
        localPath: NodePath.join(directory, "repos", source.repository),
        branch: source.branch,
        kind: "code",
        lastIndexedCommit: source.lastFlowCommit,
      })),
    };
    const file = NodePath.join(directory, "repos.json");
    const temp = `${file}.${NodeCrypto.randomUUID()}.tmp`;
    await NodeFSP.writeFile(temp, JSON.stringify(registry));
    await NodeFSP.rename(temp, file);
  }
  async chatMemories(projectId: ProjectId, session: string, revision?: string) {
    const workspace = this.workspaces.find((entry) => entry.id === this.projectBrainId(projectId));
    if (!workspace) return { memories: [], status: "disabled" as const };
    const result = await this.brainMemories(workspace.id, session, revision);
    if (this.projectBrainId(projectId) !== workspace.id)
      throw new Error("The project's brain changed. Retry the request.");
    return result;
  }
  async brainMemories(workspaceId: string, session: string, revision?: string) {
    const workspace = this.workspaces.find((entry) => entry.id === workspaceId);
    if (!workspace) throw new Error("Brain is not available");
    const worker = await this.sessionWorker(workspace);
    return worker.memories(session, revision);
  }
  async callProjectTool(
    projectId: ProjectId,
    name: string,
    args: Record<string, unknown>,
    context: BrainSessionContext,
  ) {
    const workspace = this.workspaces.find((entry) => entry.id === this.projectBrainId(projectId));
    if (!workspace) throw new Error("This project has no connected brain");
    const result = await this.callBrainTool(workspace.id, name, args, context);
    if (this.projectBrainId(projectId) !== workspace.id)
      throw new Error("The project's brain changed.");
    return result;
  }
  async callBrainTool(
    workspaceId: string,
    name: string,
    args: Record<string, unknown>,
    context: BrainSessionContext,
  ) {
    const workspace = this.workspace(workspaceId);
    if (
      (name === "source_read" || name === "source_search") &&
      !workspace.sources.some((source) => source.repository === args.repo)
    )
      throw new Error("Repository is not a source of the connected brain");
    await this.writeSessionSources(workspace);
    const worker = await this.sessionWorker(workspace);
    const repo = context.workspaceRoot
      ? await this.sessionRepository(context.workspaceRoot)
      : context.repo;
    const resolvedContext = { ...context, ...(repo ? { repo } : {}) };
    const result = await worker.call(name, args, resolvedContext);
    if (name === "find_entity") {
      let nodeIds: ReadonlyArray<string> = [];
      try {
        nodeIds = decodeConsultedNodeIds(result._meta?.[FLOW_NODE_IDS_META_KEY] ?? []);
      } catch {
        // Activity metadata is optional and must never make a brain lookup fail.
      }
      if (nodeIds.length > 0) {
        await this.captureBrainEvent(workspace.id, {
          context: resolvedContext,
          receipt: `graph-${NodeCrypto.randomUUID()}`,
          kind: "graph",
          data: { verb: name, nodeIds },
        }).catch(() => {});
      }
    }
    return result;
  }
  async captureProjectEvent(projectId: ProjectId, input: BrainCapture) {
    const workspace = this.workspaces.find((entry) => entry.id === this.projectBrainId(projectId));
    if (!workspace) return;
    return this.captureBrainEvent(workspace.id, input);
  }
  async captureBrainEvent(workspaceId: string, input: BrainCapture) {
    const workspace = this.workspace(workspaceId);
    const repo = input.context.workspaceRoot
      ? await this.sessionRepository(input.context.workspaceRoot)
      : input.context.repo;
    input = { ...input, context: { ...input.context, ...(repo ? { repo } : {}) } };
    const directory = NodePath.join(this.directory, "capture", workspace.id);
    await NodeFSP.mkdir(directory, { recursive: true });
    this.captureSequence = Math.max(Date.now() * 1000, this.captureSequence + 1);
    const file = NodePath.join(directory, `${this.captureSequence}.json`);
    await NodeFSP.writeFile(file + ".tmp", JSON.stringify(input), { mode: 0o600 });
    await NodeFSP.rename(file + ".tmp", file);
    this.queueCapture(workspace);
  }
  private queueCapture(workspace: Workspace) {
    if (this.closed) return;
    this.captureQueue = this.captureQueue
      .then(async () => {
        await this.flushCapture(workspace);
        this.captureBacklog.delete(workspace.id);
      })
      .catch(() => {
        this.captureBacklog.set(workspace.id, workspace);
        if (!this.captureRetry && !this.closed) {
          this.captureRetry = setTimeout(() => {
            this.captureRetry = undefined;
            for (const entry of this.captureBacklog.values()) this.queueCapture(entry);
          }, 5000);
          this.captureRetry.unref();
        }
      });
  }
  private async flushCapture(workspace: Workspace) {
    const directory = NodePath.join(this.directory, "capture", workspace.id);
    const files = (await NodeFSP.readdir(directory).catch(() => []))
      .filter((file) => file.endsWith(".json"))
      .sort();
    if (!files.length) return;
    const worker = await this.sessionWorker(workspace);
    for (const filename of files) {
      const file = NodePath.join(directory, filename);
      await worker.capture(JSON.parse(await NodeFSP.readFile(file, "utf8")) as BrainCapture);
      await NodeFSP.unlink(file);
    }
  }
  async drainCapture() {
    await this.captureQueue;
    await Promise.all(
      [...this.sessionWorkers.values()].map(async (pending) => (await pending).drain()),
    );
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
      await this.writeSessionSources(workspace);
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
    if (this.captureRetry) clearTimeout(this.captureRetry);
    await this.commands;
    for (const controller of this.jobs.values()) controller.abort();
    await this.starting;
    await this.queue;
    await this.captureQueue;
    await Promise.allSettled(
      [...this.sessionWorkers.values()].map(async (worker) => (await worker).close()),
    );
    if (this.sessionBridge) await (await this.sessionBridge).close();
    await this.embeddings.close();
    await this.db?.close();
    if (this.ownsLock) {
      this.ownsLock = false;
      await NodeFSP.rm(NodePath.join(this.databasePath, "owner.lock"), {
        recursive: true,
        force: true,
      });
    }
  }
}
