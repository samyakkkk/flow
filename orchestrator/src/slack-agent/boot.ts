// slack-agent/boot.ts — lifecycle for the Slack agent (THE Slack interface).
//
// This is the launch-path Slack integration: a Socket Mode agent that answers
// questions when asked (DMs, group DMs, @mentions + threads, Slack Connect).
// It boots whenever SLACK_BOT_TOKEN + SLACK_APP_TOKEN are set — local or prod
// mode alike (Socket Mode dials out, so a laptop works as well as a server).
//
// The legacy ambient adapter (../adapters/slack.ts) is intentionally NOT
// booted anymore: one Slack app must own exactly one Socket Mode connection
// (Slack round-robins events across connections, which would silently split
// traffic). MIGRATION(slack-agent): ambient capture, G10 thread binding, and
// outbox slack_post delivery will move onto this module over time.

import { getSetting } from "../settings.js";
import { registerListeners } from "./listeners.js";
import { EchoRuntime, FlowRuntime } from "./runtime.js";
import { engagedCount } from "./engagement.js";
import { inflightCount } from "./cancel.js";

interface SlackAgentState {
  app: { stop(): Promise<void> } | null;
  botUserId: string | null;
  botName: string | null;
  team: string | null;
  connectedAt: number | null;
  lastError: string | null;
  booting: boolean;
}

const state: SlackAgentState = {
  app: null,
  botUserId: null,
  botName: null,
  team: null,
  connectedAt: null,
  lastError: null,
  booting: false,
};

function makeRuntime() {
  return process.env.SLACK_AGENT_RUNTIME === "echo" ? new EchoRuntime() : new FlowRuntime();
}

/** Boot the agent if tokens are configured. Safe to call repeatedly. */
export async function bootSlackAgent(): Promise<boolean> {
  if (state.booting) return false;
  const botToken = getSetting("SLACK_BOT_TOKEN");
  const appToken = getSetting("SLACK_APP_TOKEN");

  if (!botToken || !appToken) {
    console.log("[slack-agent] tokens not set — agent disabled (connect from the dashboard)");
    return false;
  }
  if (state.app) return true; // already connected

  state.booting = true;
  try {
    // Dynamic import keeps test envs clean when bolt isn't configured.
    const { App, LogLevel } = await import("@slack/bolt");
    const app = new App({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: (process.env.LOG_LEVEL as never) ?? LogLevel.WARN,
    });

    registerListeners(app, {
      runtime: makeRuntime(),
      get botUserId() {
        return state.botUserId ?? undefined;
      },
    });

    try {
      const auth = await app.client.auth.test({ token: botToken });
      state.botUserId = (auth.user_id as string | undefined) ?? null;
      state.botName = (auth.user as string | undefined) ?? null;
      state.team = (auth.team as string | undefined) ?? null;
    } catch (err) {
      console.warn(`[slack-agent] auth.test failed: ${err}`);
    }

    await app.start();
    state.app = app as unknown as { stop(): Promise<void> };
    state.connectedAt = Date.now();
    state.lastError = null;
    console.log(`[slack-agent] connected as ${state.botName ?? "?"} (${state.botUserId ?? "?"}) in team ${state.team ?? "?"}`);
    return true;
  } catch (err) {
    state.lastError = String(err instanceof Error ? err.message : err).slice(0, 300);
    console.error(`[slack-agent] boot failed: ${err}`);
    return false;
  } finally {
    state.booting = false;
  }
}

export async function stopSlackAgent(): Promise<void> {
  const app = state.app;
  state.app = null;
  state.botUserId = null;
  state.botName = null;
  state.team = null;
  state.connectedAt = null;
  if (app) {
    try {
      await app.stop();
      console.log("[slack-agent] stopped");
    } catch (err) {
      console.warn(`[slack-agent] stop error: ${err}`);
    }
  }
}

/**
 * Settings hot-apply hook: reconnect with new tokens, or disconnect when the
 * dashboard cleared them.
 */
export async function restartSlackAgent(): Promise<void> {
  await stopSlackAgent();
  await bootSlackAgent();
}

export function slackAgentStatus(): {
  configured: boolean;
  connected: boolean;
  bot_user_id: string | null;
  bot_name: string | null;
  team: string | null;
  connected_at: number | null;
  last_error: string | null;
  engaged_threads: number;
  inflight_runs: number;
} {
  return {
    configured: Boolean(getSetting("SLACK_BOT_TOKEN") && getSetting("SLACK_APP_TOKEN")),
    connected: state.app !== null,
    bot_user_id: state.botUserId,
    bot_name: state.botName,
    team: state.team,
    connected_at: state.connectedAt,
    last_error: state.lastError,
    engaged_threads: engagedCount(),
    inflight_runs: inflightCount(),
  };
}
