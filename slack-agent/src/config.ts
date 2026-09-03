// config.ts — environment parsing for the slack-agent service.
//
// The service is Slack-only plumbing; the answering brain lives behind the
// AgentRuntime interface (src/runtime). Flow is the default runtime and needs
// the orchestrator URL + admin token.

export interface Config {
  /** HTTP port for health/status (and Slack events in HTTP mode). Default 80. */
  port: number;
  botToken: string | undefined;
  appToken: string | undefined;
  signingSecret: string | undefined;
  runtime: "flow" | "echo";
  orchestratorUrl: string;
  adminToken: string | undefined;
  /** How long the runtime may work on one question before we give up. */
  answerTimeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.SLACK_AGENT_PORT ?? 80),
    botToken: env.SLACK_BOT_TOKEN,
    appToken: env.SLACK_APP_TOKEN,
    signingSecret: env.SLACK_SIGNING_SECRET,
    runtime: env.SLACK_AGENT_RUNTIME === "echo" ? "echo" : "flow",
    orchestratorUrl: (env.FLOW_ORCHESTRATOR_URL ?? "http://localhost:7500").replace(/\/$/, ""),
    adminToken: env.FLOW_ADMIN_TOKEN,
    answerTimeoutMs: Number(env.SLACK_AGENT_ANSWER_TIMEOUT_MS ?? 300_000),
  };
}
