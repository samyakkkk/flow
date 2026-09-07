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
// traffic). This connection also captures channel messages; historical
// backfill uses the Web API. G10 binding/outbox delivery remain separate work.

import { SlackArchiveSync, saveSlackMessage, type SlackApi } from "./archive.js";
import { internalUserGuard } from "./access.js";
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

let archive: SlackArchiveSync | null = null;

export function slackArchiveStatus() { return archive?.status() ?? { connected: false }; }
export async function joinSlackPublicChannels() {
  if (!archive) throw new Error("Slack is not connected");
  return archive.joinPublicChannels();
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

    const auth = await app.client.auth.test({ token: botToken });
    if (!auth.team_id || !auth.user_id) throw new Error("Slack identity unavailable");
    state.botUserId = auth.user_id;
    state.botName = auth.user ?? null;
    state.team = auth.team ?? null;
    const { WebClient } = await import("@slack/web-api");
    const syncClient = new WebClient(botToken, { rejectRateLimitedCalls: true, retryConfig: { retries: 0 } });
    const api: SlackApi = async (method, args) => syncClient.apiCall(method, args);
    const authorize = internalUserGuard(auth.team_id, api);
    const teamId = auth.team_id;
    archive = new SlackArchiveSync(teamId, api);
    registerListeners(app, {
      runtime: makeRuntime(),
      get botUserId() { return state.botUserId ?? undefined; },
      authorize,
      async replyChannel(channelId, userId) {
        const info = await api("conversations.info", { channel: channelId });
        if (!info.channel) throw new Error("Channel identity unavailable");
        if (!info.channel.is_ext_shared) return channelId;
        const dm = await api("conversations.open", { users: userId });
        if (!dm.channel?.id) throw new Error("Private reply destination unavailable");
        return dm.channel.id;
      },
      capture(event) {
        if (typeof event.channel !== "string" || event.channel.startsWith("D") || event.channel_type === "im" || event.channel_type === "mpim") return;
        // Only channel events are archived; bot DMs remain session conversations.
        saveSlackMessage(teamId, event.channel, event);
      },
    });

    await app.start();
    state.app = app as unknown as { stop(): Promise<void> };
    archive.start();
    state.connectedAt = Date.now();
    state.lastError = null;
    console.log(`[slack-agent] connected as ${state.botName ?? "?"} (${state.botUserId ?? "?"}) in team ${state.team ?? "?"}`);
    return true;
  } catch (err) {
    archive?.stop();
    archive = null;
    state.lastError = String(err instanceof Error ? err.message : err).slice(0, 300);
    console.error(`[slack-agent] boot failed: ${err}`);
    return false;
  } finally {
    state.booting = false;
  }
}

export async function stopSlackAgent(): Promise<void> {
  archive?.stop();
  archive = null;
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
