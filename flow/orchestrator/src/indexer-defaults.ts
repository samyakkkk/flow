export type IndexerBackend = "opencode" | "codex" | "claude";
export const INDEXER_DEFAULT_MODELS: Record<IndexerBackend, string> = {
  opencode: "opencode/deepseek-v4-flash-free", // a free model opencode ships; zero keys needed
  codex: "gpt-5.6-luna",
  claude: "sonnet", // CLI alias; resolves to Claude Sonnet 5 today
};
