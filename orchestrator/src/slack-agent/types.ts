// slack-agent/types.ts — runtime seam types (no Slack imports, no side effects).

export interface TranscriptTurn {
  role: "user" | "assistant";
  text: string;
}

export type Surface = "dm" | "group_dm" | "channel";

export interface RuntimeQuery {
  /** The user's message with bot mentions stripped. */
  prompt: string;
  /** Prior turns in this thread, oldest first (excludes the current prompt). */
  transcript: TranscriptTurn[];
  context: {
    surface: Surface;
    channelId: string;
    threadTs: string;
    userId: string;
    teamId?: string;
  };
  signal?: AbortSignal;
  /** Optional progress callback — surfaced as the Slack "running" status. */
  onStatus?: (status: string) => void;
}

export interface RuntimeAnswer {
  markdown: string;
  citations?: { kind: string; ref: string }[];
  confidence?: number;
}

export interface AgentRuntime {
  readonly name: string;
  ask(query: RuntimeQuery): Promise<RuntimeAnswer>;
}
