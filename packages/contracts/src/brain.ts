import * as Schema from "effect/Schema";
import { ProjectId, ThreadId } from "./baseSchemas.ts";

export const BrainCli = Schema.Literals(["claude", "codex", "opencode"]);
export type BrainCli = typeof BrainCli.Type;
export const BrainEntity = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: Schema.String,
  description: Schema.String,
  source: Schema.String,
  properties: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export const BrainMemory = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["Decision", "Preference", "Gotcha"]),
  title: Schema.String,
  body: Schema.String,
  source: Schema.String,
  entityIds: Schema.Array(Schema.String),
});
export const BrainDocumentSummary = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["notes", "memory", "skill"]),
  name: Schema.String,
  description: Schema.String,
  revision: Schema.Number,
  sessionId: Schema.String,
  repo: Schema.NullOr(Schema.String),
  lifecycle: Schema.Literals(["standing", "temporal", "issue"]),
  status: Schema.Literals(["active", "resolved", "superseded"]),
  halfLifeDays: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  observedAt: Schema.optionalKey(Schema.Number),
});
export type BrainDocumentSummary = typeof BrainDocumentSummary.Type;
export const BrainDocument = Schema.Struct({ ...BrainDocumentSummary.fields, text: Schema.String });
export type BrainDocument = typeof BrainDocument.Type;
export const BrainKnowledge = Schema.Struct({
  entities: Schema.Array(BrainEntity),
  edges: Schema.Array(
    Schema.Struct({ from: Schema.String, to: Schema.String, label: Schema.String }),
  ),
  memories: Schema.Array(BrainMemory),
  documents: Schema.optionalKey(Schema.Array(BrainDocumentSummary)),
});
export type BrainKnowledge = typeof BrainKnowledge.Type;
export const BrainSource = Schema.Struct({
  id: Schema.String,
  repository: Schema.String,
  localPath: Schema.optional(Schema.String),
  branch: Schema.String,
  commit: Schema.String,
  revision: Schema.String,
  status: Schema.Literals([
    "queued",
    "cloning",
    "indexing",
    "embedding",
    "ready",
    "error",
    "cancelled",
    "waiting",
  ]),
  message: Schema.String,
  indexedAt: Schema.NullOr(Schema.String),
  pipeline: Schema.optional(Schema.Literal("flow")),
  evidenceCommit: Schema.optional(Schema.String),
  lastFlowCommit: Schema.optional(Schema.String),
  lastFlowBranch: Schema.optional(Schema.String),
  reindexRequested: Schema.optional(Schema.Boolean),
  activity: Schema.optional(
    Schema.Struct({
      toolCalls: Schema.Number,
      filesRead: Schema.Number,
      graphWrites: Schema.Number,
      events: Schema.Array(
        Schema.Struct({
          seq: Schema.Number,
          ts: Schema.Number,
          kind: Schema.String,
          label: Schema.String,
        }),
      ),
    }),
  ),
  summary: Schema.optional(Schema.String),
});
export type BrainSource = typeof BrainSource.Type;
export const BrainWorkspace = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  cli: BrainCli,
  sources: Schema.Array(BrainSource),
  projectIds: Schema.optional(Schema.Array(ProjectId)),
  knowledge: BrainKnowledge,
});
export type BrainWorkspace = typeof BrainWorkspace.Type;
export const BrainState = Schema.Struct({
  configuredProjectIds: Schema.optional(Schema.Array(ProjectId)),
  database: Schema.Struct({
    status: Schema.Literals(["stopped", "ready", "error"]),
    message: Schema.String,
  }),
  embeddings: Schema.Struct({
    status: Schema.Literals(["idle", "loading", "ready", "error"]),
    message: Schema.String,
  }),
  github: Schema.Struct({
    connected: Schema.Boolean,
    login: Schema.String,
    message: Schema.String,
  }),
  clis: Schema.Array(Schema.Struct({ id: BrainCli, installed: Schema.Boolean })),
  workspaces: Schema.Array(BrainWorkspace),
});
export type BrainState = typeof BrainState.Type;
export const ChatMemoryList = Schema.Struct({
  revision: Schema.optionalKey(Schema.String),
  consultedNodeIds: Schema.optionalKey(Schema.Array(Schema.String)),
  memories: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      text: Schema.String,
      createdAt: Schema.Number,
      origin: Schema.String,
    }),
  ),
  status: Schema.Literals(["idle", "extracting", "error", "disabled"]),
  notes: Schema.optionalKey(Schema.NullOr(BrainDocument)),
  documents: Schema.optionalKey(Schema.Array(BrainDocumentSummary)),
  extractionError: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type ChatMemoryList = typeof ChatMemoryList.Type;
export const BrainCommand = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("read"),
    metadataOnly: Schema.optional(Schema.Boolean),
    projectId: Schema.optional(ProjectId),
  }),
  Schema.Struct({
    action: Schema.Literal("readChat"),
    threadId: ThreadId,
    revision: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ action: Schema.Literal("start") }),
  Schema.Struct({
    action: Schema.Literal("readDocument"),
    workspaceId: Schema.String,
    documentId: Schema.String,
  }),
  Schema.Struct({ action: Schema.Literal("refreshGithub") }),
  Schema.Struct({ action: Schema.Literal("listGithubRepositories") }),
  Schema.Struct({ action: Schema.Literal("listGithubBranches"), repository: Schema.String }),
  Schema.Struct({
    action: Schema.Literal("bindProject"),
    workspaceId: Schema.NullOr(Schema.String),
    projectId: ProjectId,
  }),
  Schema.Struct({ action: Schema.Literal("create"), name: Schema.String, cli: BrainCli }),
  Schema.Struct({ action: Schema.Literal("configure"), workspaceId: Schema.String, cli: BrainCli }),
  Schema.Struct({
    action: Schema.Literal("import"),
    workspaceId: Schema.String,
    repository: Schema.String,
    branch: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    action: Schema.Literal("reindex"),
    workspaceId: Schema.String,
    sourceId: Schema.String,
  }),
  Schema.Struct({
    action: Schema.Literal("importFolder"),
    workspaceId: Schema.String,
    path: Schema.String,
  }),
  Schema.Struct({
    action: Schema.Literal("removeSource"),
    workspaceId: Schema.String,
    sourceId: Schema.String,
  }),
  Schema.Struct({
    action: Schema.Literal("cancel"),
    workspaceId: Schema.String,
    sourceId: Schema.String,
  }),
]);
export type BrainCommand = typeof BrainCommand.Type;
export const BrainResponse = Schema.Struct({
  state: BrainState,
  chatMemories: Schema.optional(ChatMemoryList),
  document: Schema.optionalKey(Schema.NullOr(BrainDocument)),
  error: Schema.NullOr(Schema.String),
  createdWorkspaceId: Schema.NullOr(Schema.String),
  branches: Schema.optional(Schema.Array(Schema.String)),
  repositories: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        private: Schema.Boolean,
        description: Schema.optional(Schema.String),
        defaultBranch: Schema.optional(Schema.String),
      }),
    ),
  ),
});
export type BrainResponse = typeof BrainResponse.Type;
