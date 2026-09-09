/** Host-neutral boundary used by local T3 and private cloud hosts. */
export interface BrainSessionContext {
  repo?: string;
  branch?: string;
  session: string;
  workspaceRoot?: string;
}
export interface BrainCapture {
  context: BrainSessionContext;
  receipt: string;
  /** Original event time in Unix milliseconds, retained through delayed delivery. */
  occurredAt?: number;
  kind: "user_prompt" | "update" | "error" | "created" | "graph";
  data: unknown;
  closed?: boolean;
}
/** The Brain owns curation; its host supplies subscription-backed execution. */
export interface BrainCuratorRun {
  sessionId: string;
  input: string;
  instructions: string;
  endpoint: string;
  token: string;
  cwd: string;
  renew: boolean;
}
export interface BrainCuratorResult {
  nativeThreadId: string;
  assistantCharacters: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}
/** A retired native segment needs a renewed original source window before it can continue. */
export type BrainCuratorReply = BrainCuratorResult | { requiresContext: true };
export type BrainCuratorRunner = (request: BrainCuratorRun) => Promise<BrainCuratorReply>;
export interface BrainHostResources {
  /** The host owns one database process; each brain has a distinct graph name. */
  graphName: string;
  databaseSocket: string;
  /** Workers borrow the host's loaded embedding model. No local fallback. */
  embeddingUrl: string;
  embeddingToken: string;
}
export function brainResourceEnvironment(resources: BrainHostResources): Record<string, string> {
  if (!resources.graphName || !resources.databaseSocket || !resources.embeddingToken) {
    throw new Error("Brain workers require the host's shared database and embedding service.");
  }
  const url = new URL(resources.embeddingUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Brain embedding service must use HTTP or HTTPS.");
  }
  return {
    GRAPH_NAME: resources.graphName,
    FALKOR_SOCKET: resources.databaseSocket,
    FLOW_EMBED_URL: resources.embeddingUrl,
    FLOW_EMBED_TOKEN: resources.embeddingToken,
  };
}
