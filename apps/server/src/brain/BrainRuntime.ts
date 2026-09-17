import { projectRepositories, hasProjectRepositorySource } from "./project-repositories.ts";
import type { GithubAccess } from "../../../../flow-t3/shared/runtime/src/github.ts";
import { cloudSignInTarget, signInToCloud, CloudClient } from "./cloud-client.ts";
import { ProjectBrainBindings } from "./project-bindings.ts";
import { brainResourceEnvironment, type BrainCuratorRunner } from "@flow/brain-runtime";
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
  type BrainCli,
  type BrainCommand,
  type ChatMemoryList,
  type BrainTransferRequest,
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
import { BrainCliUnavailableError, githubRepository, run } from "./process.ts";
import { chooseNotesCli, classifyAgentIssue } from "./agent-issue.ts";
import type {
  BrainContributor,
  BrainDocumentSync,
  BrainDocumentSyncAck,
} from "../../../../flow-t3/shared/orchestrator/src/curation/types.ts";

type Source = { -readonly [K in keyof BrainSource]: BrainSource[K] };
type Workspace = {
  id: string;
  name: string;
  cli: BrainWorkspace["cli"];
  sources: Source[];
  projectIds: ProjectId[];
  remote?: NonNullable<BrainWorkspace["remote"]>;
  migration?: NonNullable<BrainWorkspace["migration"]>;
};
type BrainAnalyticsProperties = Readonly<Record<string, string | number | boolean>>;
type BrainAnalyticsRecorder = (
  event: string,
  properties: BrainAnalyticsProperties,
) => Promise<void>;
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
  private cloudInstance = "";
  private cloudClients = new Map<string, { token: string; client: CloudClient }>();
  private migrations = new Map<string, Promise<void>>();
  private sessionWorkers = new Map<
    string,
    Promise<Awaited<ReturnType<typeof startSessionWorker>>>
  >();
  private sessionBridge: Promise<Awaited<ReturnType<typeof startBuilderBridge>>> | undefined;
  private captureQueue: Promise<void> = Promise.resolve();
  private captureRetry: ReturnType<typeof setTimeout> | undefined;
  private captureBacklog = new Map<string, Workspace>();
  private documentSyncQueue: Promise<void> = Promise.resolve();
  private documentSyncRetry: ReturnType<typeof setTimeout> | undefined;
  private documentSyncBacklog = new Map<string, Workspace>();
  private documentSyncQueued = new Set<string>();
  private documentSyncAgain = new Set<string>();
  private documentSyncErrors = new Map<string, string>();
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
  private cliCheckedAt = 0;
  private checkingClis: Promise<void> | undefined;
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
  private readonly githubAccess: GithubAccess | undefined;
  private readonly integrationEntry: string | undefined;
  private readonly integrationConfigurations = new Map<string, unknown>();
  private readonly runCurator: BrainCuratorRunner | undefined;
  private readonly runIndexer: BrainCuratorRunner | undefined;
  private readonly localCuratorCli: (() => Promise<"claude" | "codex" | "opencode">) | undefined;
  private readonly captureToolActivity: boolean;
  private readonly recordAnalytics: BrainAnalyticsRecorder | undefined;
  constructor(
    directory: string,
    options: {
      githubAccess?: GithubAccess;
      databasePath?: string;
      platform: NodeJS.Platform;
      architecture: NodeJS.Architecture;
      runCurator?: BrainCuratorRunner;
      /** Trusted host-owned worker module; never selected by a client or model. */
      integrationEntry?: string;
      runIndexer?: BrainCuratorRunner;
      localCuratorCli?: () => Promise<"claude" | "codex" | "opencode">;
      captureToolActivity?: boolean;
      recordAnalytics?: BrainAnalyticsRecorder;
    },
  ) {
    this.directory = directory;
    this.projectBindings = new ProjectBrainBindings(directory);
    this.host = options;
    this.runCurator = options.runCurator;
    this.integrationEntry = options.integrationEntry;
    this.runIndexer = options.runIndexer;
    this.localCuratorCli = options.localCuratorCli;
    this.captureToolActivity = options.captureToolActivity ?? true;
    this.githubAccess = options.githubAccess;
    this.recordAnalytics = options.recordAnalytics;
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
  private async recordMetric(event: string, properties: BrainAnalyticsProperties) {
    await this.recordAnalytics?.(event, properties).catch(() => {});
  }
  async initialize() {
    await this.projectBindings.initialize();
    await NodeFSP.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const instanceFile = NodePath.join(this.directory, "cloud-instance");
    try {
      this.cloudInstance = (await NodeFSP.readFile(instanceFile, "utf8")).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.cloudInstance = NodeCrypto.randomUUID();
      await NodeFSP.writeFile(instanceFile, this.cloudInstance, { mode: 0o600 });
    }
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
    await this.refreshClis();
    await this.refreshGithub();
    await this.start();
    if (this.db?.isRunning)
      await Promise.all(
        this.workspaces
          .filter((w) => !w.remote)
          .map((workspace) => this.ensureWorkspaceGraph(workspace)),
      );
    for (const workspace of this.workspaces)
      if (workspace.migration) this.resumeMigration(workspace);
    if (this.db?.isRunning) {
      for (const workspace of this.workspaces) this.queueCapture(workspace);
      for (const workspace of this.workspaces.filter((w) => !w.remote))
        for (const source of workspace.sources)
          if (!workspace.migration && source.status === "queued")
            await this.enqueue(workspace, source);
      for (const workspace of this.workspaces.filter((w) => w.remote))
        this.queueDocumentSync(workspace);
    }
  }
  private resumeMigration(workspace: Workspace) {
    if (this.migrations.has(workspace.id)) return;
    const pending = this.moveToCloud(workspace)
      .catch(async (error: unknown) => {
        if (workspace.migration) {
          workspace.migration = {
            ...workspace.migration,
            status: "error",
            message:
              error instanceof Error ? error.message : "Brain transfer failed. Reconnect to retry.",
          };
          await this.save();
        }
      })
      .finally(() => this.migrations.delete(workspace.id));
    this.migrations.set(workspace.id, pending);
  }
  private async moveToCloud(workspace: Workspace) {
    const migration = workspace.migration!;
    const token = await NodeFSP.readFile(
      NodePath.join(this.directory, "cloud-credentials", workspace.id),
      "utf8",
    );
    const client = new CloudClient(
      migration.endpoint,
      token,
      this.cloudInstance,
      migration.brainId,
    );
    const directory = NodePath.join(this.directory, "migration", workspace.id);
    await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
    const snapshot = NodePath.join(directory, "snapshot.json");
    if (
      !(await NodeFSP.stat(snapshot).then(
        () => true,
        () => false,
      ))
    ) {
      await this.captureQueue;
      const worker = await this.sessionWorker(workspace);
      await worker.drain();
      await worker.exportBrain(snapshot);
    }
    const bytes = await NodeFSP.readFile(snapshot);
    const digest = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
    const size = 256 * 1024;
    const count = Math.ceil(bytes.length / size);
    if (count > 1024) throw new Error("Brain transfer exceeds the supported 256 MB snapshot size.");
    for (let index = 0; index < count; index++) {
      await client.transfer({
        source: workspace.id,
        digest,
        count,
        index,
        data: bytes.subarray(index * size, (index + 1) * size).toString("base64"),
      });
      workspace.migration = {
        ...migration,
        message: `Transferring Brain: ${index + 1} of ${count} parts…`,
      };
    }
    const receipt = await client.transfer({
      source: workspace.id,
      digest,
      count,
      repositories: workspace.sources.map((s) => ({
        repository: s.repository,
        branch: s.branch,
        // GitHub folders retain owner/repository identity even when indexed locally.
        localOnly: Boolean(s.localPath) && !s.repository.includes("/"),
      })),
    });
    if (receipt.digest !== digest) throw new Error("Cloud did not confirm the Brain snapshot.");
    const worker = this.sessionWorkers.get(workspace.id);
    if (worker) {
      await (await worker).close();
      this.sessionWorkers.delete(workspace.id);
    }
    const previous = workspace.migration!;
    workspace.remote = {
      ...(migration.account ? { account: migration.account } : {}),
      endpoint: migration.endpoint,
      brainId: migration.brainId,
      status: "ready",
      message: "Connected to cloud",
    };
    delete workspace.migration;
    try {
      await this.save();
    } catch (error) {
      delete workspace.remote;
      workspace.migration = previous;
      throw error;
    }
    // Resume local curation; its durable document outbox publishes subsequent revisions.
    this.queueCapture(workspace);
    this.queueDocumentSync(workspace);
  }
  async receiveTransfer(workspaceId: string, instance: string, transfer: BrainTransferRequest) {
    const work = this.commands.then(async () => {
      const workspace = this.workspace(workspaceId);
      if (workspace.remote || workspace.migration)
        throw new Error("Transfers require a local authoritative Brain.");
      const { source, digest, count, index, data } = transfer;
      if (
        !/^[a-zA-Z0-9-]{1,100}$/.test(instance) ||
        !/^[a-zA-Z0-9-]{1,100}$/.test(source) ||
        !/^[a-f0-9]{64}$/.test(digest) ||
        !Number.isInteger(count) ||
        count < 1 ||
        count > 1024
      )
        throw new Error("Invalid Brain transfer.");
      const directory = NodePath.join(this.directory, "incoming", instance, source, digest);
      await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
      if (index !== undefined) {
        if (
          !Number.isInteger(index) ||
          index < 0 ||
          index >= count ||
          typeof data !== "string" ||
          data.length > 350000 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
        )
          throw new Error("Invalid Brain transfer part.");
        await NodeFSP.writeFile(
          NodePath.join(directory, String(index)),
          Buffer.from(data, "base64"),
          { mode: 0o600 },
        );
        return { digest, documents: 0 };
      }
      const parts = [];
      for (let part = 0; part < count; part++)
        parts.push(await NodeFSP.readFile(NodePath.join(directory, String(part))));
      const bytes = Buffer.concat(parts);
      if (NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== digest)
        throw new Error("Incomplete or corrupt Brain transfer.");
      const path = NodePath.join(directory, "snapshot.json");
      await NodeFSP.writeFile(path, bytes, { mode: 0o600 });
      const receipt = await (
        await this.sessionWorker(workspace)
      ).importBrain(path, instance, source);
      for (const repo of transfer.repositories ?? []) {
        const repository = repo.localOnly ? repo.repository : githubRepository(repo.repository);
        if (workspace.sources.some((s) => s.repository.toLowerCase() === repository.toLowerCase()))
          continue;
        const available =
          !repo.localOnly && this.clis.some((c) => c.id === workspace.cli && c.installed);
        const entry: Source = {
          id: NodeCrypto.randomUUID(),
          repository,
          branch: repo.branch,
          commit: "",
          revision: "",
          indexedAt: null,
          status: available ? "queued" : "error",
          message: repo.localOnly
            ? "Push this local repository to GitHub and add it to Cloud."
            : available
              ? "Waiting for the shared indexer…"
              : `Install ${workspace.cli} on Cloud, then reindex.`,
        };
        workspace.sources.push(entry);
        if (available) await this.enqueue(workspace, entry);
        else await this.save();
      }
      return receipt;
    });
    this.commands = work.catch(() => {});
    return work;
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
    if (this.githubAccess) {
      try {
        this.github = await this.githubAccess.status();
      } catch (error) {
        this.github = {
          connected: false,
          login: "",
          message: error instanceof Error ? error.message : "GitHub unavailable",
        };
      }
      return;
    }
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
    } catch (error) {
      this.github = {
        connected: false,
        login: "",
        message:
          error instanceof Error
            ? error.message
            : "GitHub is unavailable. Check Settings → Source control.",
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
    const curated = this.db?.isRunning
      ? await (await this.sessionWorker(workspace)).knowledge()
      : { documents: [], memories: [] };
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
        ...curated,
      };
    }
    if (!this.db?.isRunning) return emptyKnowledge();
    const graph = this.db.selectGraph(`brain_${workspace.id.replaceAll("-", "")}`);
    const combined = {
      entities: [] as BrainKnowledge["entities"][number][],
      edges: [] as BrainKnowledge["edges"][number][],
      memories: [...curated.memories] as BrainKnowledge["memories"][number][],
      documents: curated.documents,
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
  private async refreshClis() {
    if (this.checkingClis) return this.checkingClis;
    if (this.clis.length && Date.now() - this.cliCheckedAt < 5_000) return;
    this.checkingClis = (async () => {
      this.clis = await Promise.all(
        (["claude", "codex", "opencode"] as const).map(async (id) => ({
          id,
          installed: await run(id, ["--version"]).then(
            () => true,
            () => false,
          ),
        })),
      );
      this.cliCheckedAt = Date.now();
    })();
    try {
      await this.checkingClis;
    } finally {
      this.checkingClis = undefined;
    }
  }
  async state(projectId?: ProjectId, metadataOnly = false): Promise<BrainState> {
    // Provider installation can finish after the shared Brain runtime starts.
    await this.refreshClis();
    if (this.db && !this.db.isRunning)
      this.database = {
        status: "error",
        message: "FalkorDB stopped. Retry the local runtime; existing data has not been replaced.",
      };
    return {
      transferVersion: 1,
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
          .map(async (workspace) => {
            let result: BrainWorkspace = { ...workspace, knowledge: emptyKnowledge() };
            if (workspace.remote) {
              try {
                const client = await this.cloud(workspace);
                const remoteState = await client.state(metadataOnly);
                if (remoteState.database.status !== "ready")
                  throw new Error(remoteState.database.message);
                const remote = remoteState.workspaces.find(
                  (w) => w.id === workspace.remote!.brainId,
                );
                if (!remote) throw new Error("The connected cloud Brain no longer exists.");
                result = {
                  ...remote,
                  id: workspace.id,
                  remote: {
                    ...workspace.remote,
                    status: !metadataOnly && client.cache?.error ? "error" : "ready",
                    message:
                      !metadataOnly && client.cache?.error
                        ? `Showing cached cloud data. ${client.cache.error}`
                        : "Connected to cloud",
                    github: remoteState.github,
                    clis: remoteState.clis,
                  },
                };
              } catch (error) {
                result = {
                  ...result,
                  remote: {
                    ...workspace.remote,
                    status: "error",
                    message: error instanceof Error ? error.message : "Cloud Brain unavailable",
                  },
                };
              }
            } else
              result = {
                ...workspace,
                sources: workspace.sources.map((source) => ({ ...source })),
                knowledge: metadataOnly ? emptyKnowledge() : await this.readKnowledge(workspace),
              };
            return {
              ...result,
              ...(workspace.remote ? { notesCli: await this.notesCli(workspace) } : {}),
              projectIds: this.projectBindings.idsFor(
                workspace.id,
                (id) => this.legacyProjectBrainId(id),
                workspace.projectIds,
              ),
            };
          }),
      ),
    };
  }
  /**
   * The agent on this computer that writes conversation notes. A local Brain
   * uses its own agent. A cloud Brain uses the one chosen here when it is
   * installed, else the machine default's provider, else any installed agent.
   */
  private async notesCli(workspace: Workspace): Promise<BrainCli> {
    if (!workspace.remote) return workspace.cli;
    return chooseNotesCli({
      remote: true,
      chosen: workspace.cli,
      installed: this.clis.filter((cli) => cli.installed).map((cli) => cli.id),
      machineDefault: await this.localCuratorCli?.().catch(() => undefined),
    });
  }
  private async cloud(workspace: Workspace) {
    if (!workspace.remote) throw new Error("Brain is not remote.");
    const token = await NodeFSP.readFile(
      NodePath.join(this.directory, "cloud-credentials", workspace.id),
      "utf8",
    );
    const cached = this.cloudClients.get(workspace.id);
    if (
      cached?.token === token &&
      cached.client.endpoint === workspace.remote.endpoint &&
      cached.client.brainId === workspace.remote.brainId
    )
      return cached.client;
    void cached?.client.cache?.close();
    const client = new CloudClient(
      workspace.remote.endpoint,
      token,
      this.cloudInstance,
      workspace.remote.brainId,
      NodePath.join(this.directory, "cloud-cache", workspace.id),
    );
    this.cloudClients.set(workspace.id, { token, client });
    return client;
  }
  private async remoteContext(context: BrainSessionContext) {
    const { workspaceRoot, ...rest } = context;
    return {
      ...rest,
      ...(workspaceRoot ? { repo: await this.sessionRepository(workspaceRoot) } : {}),
    };
  }
  command(command: BrainCommand) {
    const result = this.commands.then(() => this.executeCommand(command));
    this.commands = result.catch(() => {});
    return result;
  }
  private async executeCommand(command: BrainCommand) {
    if (
      command.action === "agentSetup" ||
      command.action === "agentIntegration" ||
      command.action === "agentTools"
    )
      throw new Error("Request setup instructions through the environment API.");
    if (this.closed) throw new Error("Brain runtime is shutting down.");
    if (command.action === "connectCloud") {
      // The curator that writes conversation notes runs on this machine, so the
      // CLI must exist here even though the graph lives remotely.
      if (command.cli && !this.clis.some((cli) => cli.id === command.cli && cli.installed))
        throw new Error(`Install ${command.cli} before choosing it.`);
      const target = cloudSignInTarget(command.endpoint);
      const previous = this.workspaces.find(
        (w) => (w.remote?.endpoint ?? w.migration?.endpoint) === target.endpoint,
      );
      const legacyToken = previous
        ? await NodeFSP.readFile(
            NodePath.join(this.directory, "cloud-credentials", previous.id),
            "utf8",
          ).catch(() => undefined)
        : undefined;
      const credentials = await signInToCloud(
        command.endpoint,
        command.email,
        command.password,
        legacyToken ? { instance: this.cloudInstance, legacyToken } : undefined,
      );

      if (previous?.remote?.account && previous.remote.account.id !== credentials.account.id)
        throw new Error(
          `This connection belongs to ${previous.remote.account.email}. Disconnect it before using a different account.`,
        );
      const client = new CloudClient(credentials.endpoint, credentials.token, this.cloudInstance);
      const remote = await client.state(true);
      if (remote.database.status !== "ready" || remote.workspaces.length !== 1)
        throw new Error("The cloud endpoint must serve exactly one ready Brain.");
      const brain = remote.workspaces[0]!;
      const connected = this.workspaces.find(
        (w) => w.remote?.brainId === brain.id && w.remote.endpoint === client.endpoint,
      );
      if (connected && (!command.workspaceId || command.workspaceId === connected.id)) {
        await NodeFSP.writeFile(
          NodePath.join(this.directory, "cloud-credentials", connected.id),
          credentials.token,
          { mode: 0o600 },
        );
        connected.remote = {
          ...connected.remote!,
          account: credentials.account,
          status: "ready",
          message: "Connected to cloud",
        };
        const previousCli = connected.cli;
        if (command.cli) connected.cli = command.cli;
        await this.save();
        if (connected.cli !== previousCli) {
          const worker = this.sessionWorkers.get(connected.id);
          this.sessionWorkers.delete(connected.id);
          if (worker) await (await worker).close();
        }
        this.queueDocumentSync(connected);
        return connected.id;
      }
      if (command.workspaceId) {
        if (remote.transferVersion !== 1)
          throw new Error("Update the Cloud Brain before moving local knowledge to it.");
        const workspace = this.workspace(command.workspaceId);
        if (workspace.remote) throw new Error("This Brain is already remote.");
        if (
          workspace.migration &&
          (workspace.migration.endpoint !== client.endpoint ||
            workspace.migration.brainId !== brain.id)
        )
          throw new Error("Resume this Brain's transfer to its original Cloud destination.");
        // Freeze new local writes before taking the snapshot; capture keeps its durable outbox.
        const dir = NodePath.join(this.directory, "cloud-credentials");
        await NodeFSP.mkdir(dir, { recursive: true, mode: 0o700 });
        await NodeFSP.writeFile(NodePath.join(dir, workspace.id), credentials.token, {
          mode: 0o600,
        });
        workspace.migration = {
          account: credentials.account,
          endpoint: client.endpoint,
          brainId: brain.id,
          status: "transferring",
          message: "Preparing Brain transfer…",
        };
        await this.save();
        for (const source of workspace.sources) this.jobs.get(source.id)?.abort();
        this.resumeMigration(workspace);
        return workspace.id;
      }
      if (
        this.workspaces.some(
          (w) => w.remote?.brainId === brain.id && w.remote.endpoint === client.endpoint,
        )
      )
        throw new Error("This cloud Brain is already connected.");
      const id = NodeCrypto.randomUUID();
      const dir = NodePath.join(this.directory, "cloud-credentials");
      await NodeFSP.mkdir(dir, { recursive: true, mode: 0o700 });
      await NodeFSP.writeFile(NodePath.join(dir, id), credentials.token, { mode: 0o600 });
      const workspace: Workspace = {
        id,
        name: brain.name,
        cli: command.cli ?? brain.cli,
        sources: [],
        projectIds: [],
        remote: {
          account: credentials.account,
          endpoint: client.endpoint,
          brainId: brain.id,
          status: "ready",
          message: "Connected to cloud",
        },
      };
      this.workspaces.push(workspace);
      try {
        await this.save();
      } catch (error) {
        this.workspaces = this.workspaces.filter((w) => w.id !== id);
        await NodeFSP.rm(NodePath.join(dir, id), { force: true });
        throw error;
      }
      return id;
    }
    if (command.action === "disconnectCloud") {
      const workspace = this.workspace(command.workspaceId);
      if (!workspace.remote) throw new Error("This Brain is local.");
      const ids = this.projectBindings.idsFor(
        workspace.id,
        (id) => this.legacyProjectBrainId(id),
        workspace.projectIds,
      );
      for (const id of ids) await this.projectBindings.bind(id, null);
      const previous = this.workspaces;
      this.workspaces = this.workspaces.filter((w) => w !== workspace);
      try {
        await this.save();
      } catch (error) {
        this.workspaces = previous;
        throw error;
      }
      const cloud = this.cloudClients.get(workspace.id)?.client;
      this.cloudClients.delete(workspace.id);
      await cloud?.cache?.close();
      await NodeFSP.rm(NodePath.join(this.directory, "cloud-cache", workspace.id), {
        recursive: true,
        force: true,
      });
      await NodeFSP.rm(NodePath.join(this.directory, "cloud-credentials", workspace.id), {
        force: true,
      });
      return null;
    }
    if (
      "workspaceId" in command &&
      command.workspaceId &&
      this.workspace(command.workspaceId).migration
    )
      throw new Error("This Brain is moving to Cloud. Reconnect to retry if the transfer failed.");
    if (command.action === "read") return null;
    if (command.action === "readChat") throw new Error("Chat must be resolved by the server.");
    if (command.action === "readDocument")
      throw new Error("Document reads must be resolved by the server.");
    if (command.action === "listGithubRepositories" || command.action === "listGithubBranches")
      return null;
    if (command.action === "bindProject")
      throw new Error("Project connections must be resolved by the server.");
    if (command.action === "start") {
      await this.start();
      return null;
    }
    if (command.action === "refreshGithub") {
      if (command.workspaceId) {
        const workspace = this.workspace(command.workspaceId);
        if (workspace.remote) {
          await (await this.cloud(workspace)).command({ action: "refreshGithub" });
          return null;
        }
      }
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
    if (command.action === "configureNotes") {
      // Notes are written on this computer even for a cloud Brain, so this
      // choice is local and never forwarded.
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
    if (workspace.remote) {
      const client = await this.cloud(workspace);
      if (command.action === "importFolder") {
        const folder = await this.inspectFolder(command.path);
        if (!folder.github)
          throw new Error(
            "Cloud Brains require a GitHub repository. Push this folder to GitHub first.",
          );
        await client.command({
          action: "import",
          workspaceId: workspace.remote.brainId,
          repository: folder.repository,
        });
      } else await client.command({ ...command, workspaceId: workspace.remote.brainId });
      return null;
    }
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
        const startedAt = Date.now();
        const incremental = Boolean(source.lastFlowCommit);
        try {
          if (!controller.signal.aborted) {
            await this.index(workspace, source, cli, controller.signal);
            await this.recordMetric("brain.source.indexed", {
              success: true,
              cancelled: false,
              incremental,
              sourceType: source.localPath ? "local" : "github",
              cli,
              durationMs: Date.now() - startedAt,
            });
          } else {
            await this.recordMetric("brain.source.indexed", {
              success: false,
              cancelled: true,
              incremental,
              sourceType: source.localPath ? "local" : "github",
              cli,
              durationMs: Date.now() - startedAt,
            });
          }
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
          await this.recordMetric("brain.source.indexed", {
            success: false,
            cancelled: controller.signal.aborted,
            incremental,
            sourceType: source.localPath ? "local" : "github",
            cli,
            durationMs: Date.now() - startedAt,
          });
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
      (error) => {
        if (error instanceof BrainCliUnavailableError) throw error;
        return false;
      },
    );
    return {
      repository,
      localPath,
      github,
      hasCommit,
    };
  }
  /** Resolve the path from T3's project record, never from an agent's arguments. */
  bindProject(project: { id: ProjectId; workspaceRoot: string }, workspaceId: string | null) {
    this.projectBindings.register(project);
    const result = this.commands.then(async () => {
      if (this.closed) throw new Error("Brain runtime is shutting down.");
      const workspace = workspaceId ? this.workspace(workspaceId) : null;
      const repositories = workspace ? await projectRepositories(project.workspaceRoot) : [];
      if (workspace?.remote) {
        const cloud = await this.cloud(workspace);
        const remote = await cloud.state(true);
        if (remote.database.status !== "ready") throw new Error("Cloud Brain is unavailable.");
        const brain = remote.workspaces.find((entry) => entry.id === workspace.remote!.brainId);
        if (!brain) throw new Error("Cloud Brain no longer exists.");
        const existing = new Set(brain.sources.map((source) => source.repository.toLowerCase()));
        for (const path of repositories) {
          const folder = await this.inspectFolder(path);
          if (!folder.github) continue;
          if (existing.has(folder.repository.toLowerCase())) continue;
          await cloud.command({
            action: "import",
            workspaceId: workspace.remote.brainId,
            repository: folder.repository,
          });
          existing.add(folder.repository.toLowerCase());
        }
      } else if (workspace) {
        for (const path of repositories) {
          const folder = await this.inspectFolder(path);
          if (hasProjectRepositorySource(workspace.sources, folder)) continue;
          await this.executeCommand({ action: "importFolder", workspaceId: workspace.id, path });
        }
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
        // The chat-owning environment selects its own installed provider. Cloud
        // availability and its maintenance CLI must not gate local capture.
        const worker = await startSessionWorker(
          {
            ...brainResourceEnvironment({
              graphName: `flow_brain_${workspace.id.replaceAll("-", "")}`,
              databaseSocket: this.db.socketPath,
              embeddingUrl: `${bridge.url}/embed`,
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
              ].flatMap((key) =>
                process.env[key] === undefined ? [] : [[key, process.env[key]!]],
              ),
            ),
            ...(this.integrationEntry ? { FLOW_BRAIN_INTEGRATION: this.integrationEntry } : {}),
            FLOW_PROJECT_NAME: workspace.name,
            DB_PATH: NodePath.join(directory, "flow.db"),
            JOURNAL_PATH: NodePath.join(directory, "journal.jsonl"),
            OPENCODE_WORKSPACE_DIR: directory,
            FLOW_SOURCE_REGISTRY: NodePath.join(directory, "repos.json"),
            FLOW_ADMIN_TOKEN: NodeCrypto.randomBytes(32).toString("hex"),
            INDEXER_RUNTIME: workspace.cli,
            FLOW_CURATOR_SOURCE_TOOLS: workspace.remote ? "0" : "1",
          },
          false,
          undefined,
          this.runCurator
            ? async (request) =>
                this.runCurator!({
                  ...request,
                  cli: await this.notesCli(workspace),
                  sessionId: `${workspace.id}:${request.sessionId}`,
                })
            : undefined,
          workspace.remote ? () => this.queueDocumentSync(workspace) : undefined,
        );
        const configuration = this.integrationConfigurations.get(workspace.id);
        if (configuration !== undefined) await worker.configureIntegration(configuration);
        return worker;
      })();
      this.sessionWorkers.set(workspace.id, pending);
      pending.catch(() => {
        if (this.sessionWorkers.get(workspace.id) === pending)
          this.sessionWorkers.delete(workspace.id);
      });
    }
    return pending;
  }
  /** Cloud-only administration; never exposed to Brain tools or auto-enabled locally. */
  async configureIntegration(workspaceId: string, config: unknown) {
    const workspace = this.workspaces.find((entry) => entry.id === workspaceId);
    if (!workspace || workspace.remote) throw new Error("Integrations require an owned Brain.");
    const worker = await this.sessionWorker(workspace);
    this.integrationConfigurations.set(workspaceId, config);
    return worker.configureIntegration(config);
  }
  async integration(workspaceId: string, action: string) {
    const workspace = this.workspaces.find((entry) => entry.id === workspaceId);
    if (!workspace || workspace.remote) throw new Error("Integrations require an owned Brain.");
    return (await this.sessionWorker(workspace)).integration(action);
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
    if (workspace.migration) throw new Error("Brain is moving to Cloud.");
    if (workspace.remote) {
      // This chat's extraction state lives here. A remote fetch must not delay
      // note retrieval; the shared library and graph use the cloud connection.
      const local = await (await this.sessionWorker(workspace)).memories(session, revision);
      const syncError = this.documentSyncErrors.get(workspace.id);
      return {
        ...(await this.withNotesAgent(workspace, local)),
        ...(syncError
          ? {
              extractionError:
                local.extractionError || `Cloud synchronization pending: ${syncError}`,
            }
          : {}),
      };
    }
    const worker = await this.sessionWorker(workspace);
    return this.withNotesAgent(workspace, await worker.memories(session, revision));
  }
  private async withNotesAgent(
    workspace: Workspace,
    memories: ChatMemoryList,
  ): Promise<ChatMemoryList> {
    const curatorCli = await this.notesCli(workspace);
    const issue =
      memories.status === "error"
        ? classifyAgentIssue(memories.extractionError, curatorCli, "Notes")
        : undefined;
    return { ...memories, curatorCli, ...(issue ? { extractionIssue: issue } : {}) };
  }
  async brainDocument(workspaceId: string, documentId: string) {
    const workspace = this.workspaces.find((entry) => entry.id === workspaceId);
    if (!workspace) throw new Error("Brain is not available");
    if (workspace.remote)
      return (
        (await (await this.sessionWorker(workspace)).document(documentId)) ??
        (await this.cloud(workspace)).document(documentId)
      );
    return (await this.sessionWorker(workspace)).document(documentId);
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
    if (workspace.migration)
      throw new Error("Brain is moving to Cloud. Retry when transfer completes.");
    if (workspace.remote && name !== "remember") {
      const result = await (
        await this.cloud(workspace)
      ).call(name, args, await this.remoteContext(context));
      if (name === "find_entity" && this.captureToolActivity) {
        let nodeIds: ReadonlyArray<string> = [];
        try {
          nodeIds = decodeConsultedNodeIds(result._meta?.[FLOW_NODE_IDS_META_KEY] ?? []);
        } catch {}
        if (nodeIds.length)
          await this.captureBrainEvent(workspace.id, {
            context,
            receipt: `graph-${NodeCrypto.randomUUID()}`,
            kind: "graph",
            data: { verb: name, nodeIds },
          }).catch(() => {});
      }
      return result;
    }
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
    if (name === "find_entity" && this.captureToolActivity) {
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
    const occurredAt = input.occurredAt ?? Date.now();
    const workspace = this.workspace(workspaceId);
    const repo = input.context.workspaceRoot
      ? await this.sessionRepository(input.context.workspaceRoot)
      : input.context.repo;
    input = { ...input, occurredAt, context: { ...input.context, ...(repo ? { repo } : {}) } };
    const directory = NodePath.join(this.directory, "capture", workspace.id);
    await NodeFSP.mkdir(directory, { recursive: true });
    this.captureSequence = Math.max(Date.now() * 1000, this.captureSequence + 1);
    const file = NodePath.join(directory, `${this.captureSequence}.json`);
    await NodeFSP.writeFile(file + ".tmp", JSON.stringify(input), { mode: 0o600 });
    await NodeFSP.rename(file + ".tmp", file);
    this.queueCapture(workspace);
  }
  private queueDocumentSync(workspace: Workspace) {
    if (this.closed || !workspace.remote) return;
    if (this.documentSyncQueued.has(workspace.id)) {
      this.documentSyncAgain.add(workspace.id);
      return;
    }
    this.documentSyncQueued.add(workspace.id);
    this.documentSyncQueue = this.documentSyncQueue
      .then(async () => {
        const worker = await this.sessionWorker(workspace);
        for (;;) {
          const items = await worker.pendingSync();
          if (!items.length) break;
          const acknowledgements = await (await this.cloud(workspace)).sync(items);
          await worker.acknowledgeSync(acknowledgements);
        }
        this.documentSyncBacklog.delete(workspace.id);
        this.documentSyncErrors.delete(workspace.id);
      })
      .catch((error: unknown) => {
        this.documentSyncBacklog.set(workspace.id, workspace);
        this.documentSyncErrors.set(
          workspace.id,
          error instanceof Error ? error.message : "Cloud Brain unavailable.",
        );
        if (!this.documentSyncRetry && !this.closed) {
          this.documentSyncRetry = setTimeout(() => {
            this.documentSyncRetry = undefined;
            for (const entry of this.documentSyncBacklog.values()) this.queueDocumentSync(entry);
          }, 5_000);
          this.documentSyncRetry.unref();
        }
      })
      .finally(() => {
        this.documentSyncQueued.delete(workspace.id);
        // A write can land just after pendingSync returned an empty batch.
        if (this.documentSyncAgain.delete(workspace.id)) this.queueDocumentSync(workspace);
      });
  }
  private queueCapture(workspace: Workspace) {
    if (this.closed || workspace.migration) return;
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
    if (workspace.migration) return;
    const worker = await this.sessionWorker(workspace);
    for (const filename of files) {
      const file = NodePath.join(directory, filename);
      await worker.capture(JSON.parse(await NodeFSP.readFile(file, "utf8")) as BrainCapture);
      await NodeFSP.unlink(file);
    }
  }
  async drainCapture() {
    await Promise.all(this.migrations.values());
    await this.captureQueue;
    await Promise.all(
      [...this.sessionWorkers.values()].map(async (pending) => (await pending).drain()),
    );
    for (const workspace of this.workspaces.filter((entry) => entry.remote))
      this.queueDocumentSync(workspace);
    let syncing;
    do {
      syncing = this.documentSyncQueue;
      await syncing;
    } while (syncing !== this.documentSyncQueue);
  }
  async syncBrainDocuments(
    workspaceId: string,
    origin: string,
    items: BrainDocumentSync[],
    contributor?: BrainContributor,
  ): Promise<BrainDocumentSyncAck[]> {
    const workspace = this.workspace(workspaceId);
    if (workspace.remote) throw new Error("Cannot synchronize through another cloud Brain.");
    return (await this.sessionWorker(workspace)).syncDocuments(origin, items, contributor);
  }
  async listGithubBranches(repository: string, workspaceId?: string) {
    if (workspaceId) {
      const workspace = this.workspace(workspaceId);
      if (workspace.remote) return (await this.cloud(workspace)).branches(repository);
    }
    const name = githubRepository(repository);
    if (this.githubAccess) return this.githubAccess.branches(name);
    let gitError: unknown;
    for (const url of [`https://github.com/${name}.git`, `git@github.com:${name}.git`]) {
      try {
        const refs = await run("git", ["ls-remote", "--heads", "--", url]);
        return [
          ...new Set(
            refs.split("\n").flatMap((line) => {
              const ref = line.split("\t")[1];
              return ref?.startsWith("refs/heads/") ? [ref.slice("refs/heads/".length)] : [];
            }),
          ),
        ];
      } catch (error) {
        gitError = error;
        if (error instanceof BrainCliUnavailableError) break;
      }
    }
    try {
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
    } catch (error) {
      if (
        gitError instanceof BrainCliUnavailableError &&
        error instanceof BrainCliUnavailableError
      ) {
        throw new Error(
          "Install Git or GitHub CLI (`gh`) on the machine running Flow to list GitHub branches. Neither was found on PATH.",
          { cause: error },
        );
      }
      throw new Error(
        "Could not list repository branches using Git or GitHub CLI. Check repository access through Git (HTTPS or SSH), or sign in with `gh auth login`.",
        { cause: error },
      );
    }
  }

  async listGithubRepositories(workspaceId?: string) {
    if (workspaceId) {
      const workspace = this.workspace(workspaceId);
      if (workspace.remote) return (await this.cloud(workspace)).repositories();
    }
    if (this.githubAccess) return this.githubAccess.repositories();
    await this.refreshGithub();
    if (!this.github.connected) throw new Error(this.github.message);
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
    const gitEnv = source.localPath ? undefined : await this.githubAccess?.gitEnvironment();
    if (exists) {
      // Only app-owned clones live here; users' work folders are never checked out.
      await run(
        "git",
        [
          "fetch",
          "--prune",
          source.localPath || "origin",
          ...(source.branch ? [source.branch] : []),
        ],
        {
          cwd: repoPath,
          ...(gitEnv ? { env: gitEnv } : {}),
          signal,
          timeout: 5 * 60_000,
        },
      );
      await run("git", ["checkout", "-B", source.branch || "main", "FETCH_HEAD"], {
        cwd: repoPath,
        ...(gitEnv ? { env: gitEnv } : {}),
        signal,
      });
    } else if (source.localPath) {
      await run(
        "git",
        ["clone", "--no-local", "--single-branch", "--no-tags", "--", source.localPath, repoPath],
        { signal, timeout: 5 * 60_000, ...(gitEnv ? { env: gitEnv } : {}) },
      );
    } else if (this.github.connected && !this.githubAccess) {
      await run("git", ["--version"], { signal });
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
        { signal, timeout: 5 * 60_000, ...(gitEnv ? { env: gitEnv } : {}) },
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
        { signal, timeout: 5 * 60_000, ...(gitEnv ? { env: gitEnv } : {}) },
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
        runAgent: this.runIndexer,
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
    this.integrationConfigurations.clear();
    if (this.captureRetry) clearTimeout(this.captureRetry);
    if (this.documentSyncRetry) clearTimeout(this.documentSyncRetry);
    await this.commands;
    await Promise.allSettled(this.migrations.values());
    for (const controller of this.jobs.values()) controller.abort();
    await this.starting;
    await this.queue;
    await this.captureQueue;
    await this.documentSyncQueue;
    await Promise.all([...this.cloudClients.values()].map(({ client }) => client.cache?.close()));
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
