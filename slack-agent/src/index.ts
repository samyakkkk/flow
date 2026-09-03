// index.ts — slack-agent boot.
//
// Slack is one communication interface to an AgentRuntime (default: Flow's
// ask pipeline). Connectivity is Socket Mode when SLACK_APP_TOKEN is present
// (dev default — no public URL needed); with only a signing secret, Bolt's
// HTTP receiver serves /slack/events on the same port instead.
//
// Port 80 (SLACK_AGENT_PORT) always serves GET /health and GET / so the
// service is observable regardless of connectivity mode.

import "dotenv/config";
import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { engagedCount } from "./engagement.js";
import { inflightCount } from "./cancel.js";
import { registerListeners } from "./listeners/index.js";
import { makeRuntime } from "./runtime/index.js";

const config = loadConfig();
const runtime = makeRuntime(config);

let slackStatus: "disconnected" | "socket" | "http" = "disconnected";
let botUserId: string | undefined;
let team: string | undefined;

function healthPayload() {
  return {
    status: "ok",
    service: "slack-agent",
    port: config.port,
    runtime: runtime.name,
    slack: slackStatus,
    bot_user_id: botUserId ?? null,
    team: team ?? null,
    engaged_threads: engagedCount(),
    inflight_runs: inflightCount(),
    ts: Date.now(),
  };
}

async function main() {
  const socketMode = Boolean(config.appToken);

  if (!config.botToken) {
    console.error("[slack-agent] SLACK_BOT_TOKEN not set — starting health server only.");
    console.error("[slack-agent] Create the app from slack-agent/manifest.json, install it, and set SLACK_BOT_TOKEN + SLACK_APP_TOKEN in slack-agent/.env");
  } else {
    const { App, LogLevel } = await import("@slack/bolt");

    const app = socketMode
      ? new App({
          token: config.botToken,
          appToken: config.appToken,
          socketMode: true,
          logLevel: (process.env.LOG_LEVEL as never) ?? LogLevel.INFO,
        })
      : new App({
          token: config.botToken,
          signingSecret: config.signingSecret,
          logLevel: (process.env.LOG_LEVEL as never) ?? LogLevel.INFO,
          customRoutes: [
            {
              path: "/health",
              method: ["GET"],
              handler: (_req, res) => {
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify(healthPayload()));
              },
            },
          ],
        });

    registerListeners(app, {
      runtime,
      get botUserId() {
        return botUserId;
      },
    });

    // Resolve the bot identity (used to skip self-messages and label transcript turns).
    try {
      const auth = await app.client.auth.test({ token: config.botToken });
      botUserId = auth.user_id as string | undefined;
      team = (auth.team as string | undefined) ?? undefined;
      console.log(`[slack-agent] bot user ${botUserId} in team ${team}`);
    } catch (err) {
      console.warn(`[slack-agent] auth.test failed: ${err}`);
    }

    if (socketMode) {
      await app.start();
      slackStatus = "socket";
      console.log("[slack-agent] Socket Mode connected");
    } else {
      await app.start(config.port);
      slackStatus = "http";
      console.log(`[slack-agent] HTTP receiver listening on :${config.port} (/slack/events)`);
    }
  }

  // In socket mode (or token-less boot) Bolt holds no port — expose health ourselves.
  if (slackStatus !== "http") {
    const server = createServer((req, res) => {
      if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(healthPayload()));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    server.listen(config.port, () => {
      console.log(`[slack-agent] health server on :${config.port} (runtime: ${runtime.name}, slack: ${slackStatus})`);
    });
    server.on("error", (err) => {
      console.error(`[slack-agent] health server failed on :${config.port}: ${err}`);
      process.exit(1);
    });
  }
}

main().catch((err) => {
  console.error(`[slack-agent] fatal: ${err}`);
  process.exit(1);
});
