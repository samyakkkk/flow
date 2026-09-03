// adapters/slack.ts — LEGACY Bolt Socket Mode Slack adapter. NOT BOOTED.
//
// MIGRATION(slack-agent): the launch-path Slack interface is
// src/slack-agent/ (question-answering agent). This ambient adapter is
// untested and intentionally no longer booted from index.ts or settings
// hot-apply — one Slack app must own exactly one Socket Mode connection
// (Slack round-robins events across connections and would silently split
// traffic between the two). Paths still to migrate onto slack-agent:
//   - ambient message capture → corpus (app.message handler below)
//   - mention → event-pipeline routing (processEvent "slack.mention")
//   - G10 slack-thread ↔ opencode-session binding (events.ts)
//   - outbox slack_post/dm delivery (drainer.ts uses WebClient directly)
// Until each moves, this file stays for reference; delete when empty.
//
// Original behavior:
// Boots ONLY when SLACK_BOT_TOKEN + SLACK_APP_TOKEN are set.
// Handles: app_mention → normalized slack mention event
//          message (ambient) → normalized slack ambient event (skips bot's own messages)
// Drainer (see drainer.ts) uses WebClient for sending messages.

import { randomUUID } from "node:crypto";
import { processEvent } from "../events.js";
import type { NormalizedEvent } from "../events.js";
import { getSetting } from "../settings.js";

// Dynamic import guards — only pull in bolt when tokens are present to avoid
// runtime errors in test envs where the packages may not be installed.

let slackApp: unknown = null;
let slackBotUserId: string | null = null;

export interface SlackAppHandle {
  stop(): Promise<void>;
  selfTest(): Promise<{ ok: boolean; userId: string }>;
}

/**
 * Boot the Bolt Socket-Mode app.
 * No-ops (returns null) when tokens are missing.
 */
export async function bootSlackAdapter(): Promise<SlackAppHandle | null> {
  if ((process.env.FLOW_MODE ?? "local") !== "prod") {
    console.log("[slack] disabled in local mode — ambient listening requires an always-on deployment");
    return null;
  }

  const botToken = getSetting("SLACK_BOT_TOKEN") ?? process.env.SLACK_BOT_TOKEN;
  const appToken = getSetting("SLACK_APP_TOKEN") ?? process.env.SLACK_APP_TOKEN;

  if (!botToken || !appToken) {
    console.log("[slack] SLACK_BOT_TOKEN or SLACK_APP_TOKEN not set — Slack adapter disabled");
    return null;
  }

  // Dynamic import keeps the test environment clean when bolt isn't configured
  const { App } = await import("@slack/bolt");

  const app = new App({
    token: botToken,
    appToken: appToken,
    socketMode: true,
    logLevel: (process.env.LOG_LEVEL as never) ?? "warn",
  });

  // ------------------------------------------------------------------
  // Resolve bot's own user ID so we can skip self-messages
  // ------------------------------------------------------------------
  try {
    const { WebClient } = await import("@slack/web-api");
    const wc = new WebClient(botToken);
    const authRes = await wc.auth.test();
    slackBotUserId = (authRes.user_id as string | undefined) ?? null;
    console.log(`[slack] Bot user ID: ${slackBotUserId}`);
  } catch (err) {
    console.warn(`[slack] Could not resolve bot user ID: ${err}`);
  }

  // ------------------------------------------------------------------
  // app_mention → slack.mention event
  // ------------------------------------------------------------------
  app.event("app_mention", async ({ event: ev }) => {
    const text = (ev.text as string | undefined) ?? "";
    const userId = (ev.user as string | undefined) ?? "";
    const channel = (ev.channel as string | undefined) ?? "";
    const ts = (ev.ts as string | undefined) ?? "";
    const threadTs = (ev.thread_ts as string | undefined) ?? undefined;

    const normalized: NormalizedEvent = {
      id: randomUUID(),
      source: "slack",
      type: "mention",
      ts: Math.round(parseFloat(ts) * 1000) || Date.now(),
      payload: {
        text,
        user_id: userId,
        channel,
        ts,
        thread_ts: threadTs,
        event_ts: ts,
      },
    };

    console.log(`[slack] app_mention from ${userId} in ${channel}`);
    await processEvent(normalized).catch((err) =>
      console.error("[slack] Error processing mention:", err)
    );
  });

  // ------------------------------------------------------------------
  // message → slack.ambient event (skip bot's own messages)
  // ------------------------------------------------------------------
  app.message(async ({ message }) => {
    // Only process user messages in channels
    const msg = message as unknown as Record<string, unknown>;
    const subtype = msg.subtype as string | undefined;

    // Skip bot messages, edits, deletes, etc.
    if (subtype) return;
    const userId = msg.user as string | undefined;
    if (!userId) return;
    if (slackBotUserId && userId === slackBotUserId) return;

    const text = (msg.text as string | undefined) ?? "";
    const channel = (msg.channel as string | undefined) ?? "";
    const ts = (msg.ts as string | undefined) ?? "";
    const threadTs = (msg.thread_ts as string | undefined) ?? undefined;

    const normalized: NormalizedEvent = {
      id: randomUUID(),
      source: "slack",
      type: "ambient",
      ts: Math.round(parseFloat(ts) * 1000) || Date.now(),
      payload: {
        text,
        user_id: userId,
        channel,
        ts,
        thread_ts: threadTs,
      },
    };

    await processEvent(normalized).catch((err) =>
      console.error("[slack] Error processing ambient message:", err)
    );
  });

  // Start the socket-mode connection
  await app.start();
  console.log("[slack] Bolt Socket Mode app started");

  slackApp = app;

  return {
    async stop() {
      await (app as { stop(): Promise<void> }).stop();
    },
    async selfTest() {
      const { WebClient } = await import("@slack/web-api");
      const wc = new WebClient(botToken);
      const res = await wc.auth.test();
      return {
        ok: Boolean(res.ok),
        userId: (res.user_id as string | undefined) ?? "",
      };
    },
  };
}

/**
 * Send a Slack message via chat.postMessage (used by drainer).
 */
export async function sendSlackMessage(opts: {
  channel: string;
  text: string;
  thread_ts?: string;
}): Promise<void> {
  const botToken = getSetting("SLACK_BOT_TOKEN") ?? process.env.SLACK_BOT_TOKEN;
  if (!botToken) throw new Error("SLACK_BOT_TOKEN not set");

  const { WebClient } = await import("@slack/web-api");
  const wc = new WebClient(botToken);
  await wc.chat.postMessage({
    channel: opts.channel,
    text: opts.text,
    thread_ts: opts.thread_ts,
  });
}
