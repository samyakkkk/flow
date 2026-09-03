// listeners/index.ts — Slack event wiring.
//
// Participation rules (the agent only speaks where explicitly invoked):
//   • 1:1 DM with the agent            → every message
//   • group DM that includes the agent → every message (adding it = inviting it)
//   • channels / Slack Connect         → only on @mention, then plain replies
//     in that thread keep the conversation going (engagement store)
// Existing human-to-human DMs are structurally out of reach: Slack only
// delivers message.im for the agent's own DM conversations.

import type { App } from "@slack/bolt";
import { cancelRun } from "../cancel.js";
import { isEngaged, markEngaged } from "../engagement.js";
import { respond, stripMentions } from "../respond.js";
import type { SayFn, SayStreamFn, SetStatusFn, SlackClientLike } from "../respond.js";
import type { AgentRuntime, Surface } from "../runtime/index.js";
import { getThreadContext, setThreadContext } from "./thread-context.js";

const SUGGESTED_PROMPTS = [
  { title: "What is this project?", message: "Give me an overview of this project — what it is and how it fits together." },
  { title: "Find a past decision", message: "What did we decide about deployment and infrastructure?" },
  { title: "Recent work", message: "What has the team been working on recently?" },
];

export interface ListenerDeps {
  runtime: AgentRuntime;
  botUserId: string | undefined;
}

// Bolt's event payloads vary by type and its agent-era typings are still
// settling; handlers read fields defensively off a generic record.
type Ev = Record<string, unknown>;

export function registerListeners(app: App, deps: ListenerDeps): void {
  // ----------------------------------------------------------------
  // Messages: DMs, group DMs, and engaged channel threads
  // ----------------------------------------------------------------
  app.event("message", async (raw) => {
    const { client, context, logger, say } = raw as unknown as {
      client: SlackClientLike;
      context: Record<string, unknown>;
      logger: { info(m: string): void; warn(m: string): void; error(m: string): void };
      say: SayFn;
    };
    const bolt = raw as unknown as { sayStream?: SayStreamFn; setStatus?: SetStatusFn };
    const event = (raw as unknown as { event: Ev }).event;

    if (event.subtype) return;
    if (event.bot_id) return;
    const userId = event.user as string | undefined;
    if (!userId) return;
    const botUserId = deps.botUserId ?? (context.botUserId as string | undefined);
    if (botUserId && userId === botUserId) return;

    const channelId = (event.channel as string | undefined) ?? "";
    const ts = (event.ts as string | undefined) ?? "";
    const threadTs = (event.thread_ts as string | undefined) ?? ts;
    const channelType = event.channel_type as string | undefined;
    const text = (event.text as string | undefined) ?? "";

    let surface: Surface;
    if (channelType === "im") surface = "dm";
    else if (channelType === "mpim") surface = "group_dm";
    else {
      // Channel or private channel (incl. Slack Connect): only continue
      // conversations in threads where the agent is already engaged. Fresh
      // invocations go through app_mention.
      surface = "channel";
      const inEngagedThread = Boolean(event.thread_ts) && isEngaged(channelId, threadTs);
      if (!inEngagedThread) return;
      // Mentions inside engaged threads also fire app_mention — let that
      // handler own them to avoid double replies.
      if (botUserId && text.includes(`<@${botUserId}>`)) return;
    }

    const prompt = stripMentions(text);
    if (!prompt) return;

    logger.info(`[slack-agent] ${surface} message from ${userId} in ${channelId} (thread ${threadTs})`);
    await respond({
      client,
      logger,
      runtime: deps.runtime,
      botUserId,
      surface,
      channelId,
      threadTs,
      messageTs: ts,
      userId,
      teamId: event.team as string | undefined,
      prompt,
      viewingContext: getThreadContext(channelId, threadTs),
      sayStream: bolt.sayStream,
      setStatus: bolt.setStatus,
      say,
    });
  });

  // ----------------------------------------------------------------
  // @mentions in channels (incl. Slack Connect)
  // ----------------------------------------------------------------
  app.event("app_mention", async (raw) => {
    const { client, context, logger, say } = raw as unknown as {
      client: SlackClientLike;
      context: Record<string, unknown>;
      logger: { info(m: string): void; warn(m: string): void; error(m: string): void };
      say: SayFn;
    };
    const bolt = raw as unknown as { sayStream?: SayStreamFn; setStatus?: SetStatusFn };
    const event = (raw as unknown as { event: Ev }).event;

    const channelId = (event.channel as string | undefined) ?? "";
    const ts = (event.ts as string | undefined) ?? "";
    const threadTs = (event.thread_ts as string | undefined) ?? ts;
    const userId = (event.user as string | undefined) ?? "";
    const prompt = stripMentions((event.text as string | undefined) ?? "");

    markEngaged(channelId, threadTs);

    if (!prompt) {
      await say({ text: "Hi! Ask me anything about the codebase, past decisions, or team memory.", thread_ts: threadTs });
      return;
    }

    logger.info(`[slack-agent] mention from ${userId} in ${channelId} (thread ${threadTs})`);
    await respond({
      client,
      logger,
      runtime: deps.runtime,
      botUserId: deps.botUserId ?? (context.botUserId as string | undefined),
      surface: "channel",
      channelId,
      threadTs,
      messageTs: ts,
      userId,
      teamId: event.team as string | undefined,
      prompt,
      viewingContext: getThreadContext(channelId, threadTs),
      sayStream: bolt.sayStream,
      setStatus: bolt.setStatus,
      say,
    });
  });

  // ----------------------------------------------------------------
  // Agent container: suggested prompts + thread context
  // ----------------------------------------------------------------
  app.event("app_home_opened", async (raw) => {
    const { client, logger } = raw as unknown as {
      client: { assistant: { threads: { setSuggestedPrompts(args: Record<string, unknown>): Promise<unknown> } } };
      logger: { warn(m: string): void };
    };
    const event = (raw as unknown as { event: Ev }).event;
    if (event.tab !== "messages") return;
    try {
      // Under agent_view, prompts pin to the top of the Messages tab — no
      // thread_ts required.
      await client.assistant.threads.setSuggestedPrompts({
        channel_id: event.channel as string,
        title: "How can I help you today?",
        prompts: SUGGESTED_PROMPTS,
      });
    } catch (err) {
      logger.warn(`[slack-agent] setSuggestedPrompts failed: ${err}`);
    }
  });

  app.event("assistant_thread_started" as never, async (raw: unknown) => {
    const { client, logger } = raw as {
      client: { assistant: { threads: { setSuggestedPrompts(args: Record<string, unknown>): Promise<unknown> } } };
      logger: { warn(m: string): void };
    };
    const event = (raw as { event: Ev }).event;
    const thread = (event.assistant_thread ?? {}) as Ev;
    const channelId = thread.channel_id as string | undefined;
    const threadTs = thread.thread_ts as string | undefined;
    if (!channelId || !threadTs) return;
    setThreadContext(channelId, threadTs, thread.context as Record<string, unknown> | undefined);
    try {
      await client.assistant.threads.setSuggestedPrompts({
        channel_id: channelId,
        thread_ts: threadTs,
        title: "How can I help you today?",
        prompts: SUGGESTED_PROMPTS,
      });
    } catch (err) {
      logger.warn(`[slack-agent] setSuggestedPrompts (thread) failed: ${err}`);
    }
  });

  app.event("assistant_thread_context_changed" as never, async (raw: unknown) => {
    const event = (raw as { event: Ev }).event;
    const thread = (event.assistant_thread ?? {}) as Ev;
    const channelId = thread.channel_id as string | undefined;
    const threadTs = thread.thread_ts as string | undefined;
    if (!channelId || !threadTs) return;
    setThreadContext(channelId, threadTs, thread.context as Record<string, unknown> | undefined);
  });

  // ----------------------------------------------------------------
  // Native stop button
  // ----------------------------------------------------------------
  app.event("agent_session_stopped" as never, async (raw: unknown) => {
    const { client, logger } = raw as {
      client: { apiCall(method: string, args: Record<string, unknown>): Promise<unknown> };
      logger: { info(m: string): void; warn(m: string): void };
    };
    const event = (raw as { event: Ev }).event;
    const channelId = (event.channel_id ?? event.channel) as string | undefined;
    const threadTs = event.thread_ts as string | undefined;
    if (!channelId || !threadTs) return;

    const hadRun = cancelRun(channelId, threadTs);
    logger.info(`[slack-agent] stop requested for ${channelId}:${threadTs} (in-flight: ${hadRun})`);

    // Slack does not transition the session out of "processing" on its own.
    try {
      await client.apiCall("agents.sessions.setStatus", {
        channel_id: channelId,
        thread_ts: threadTs,
        status: "active",
      });
    } catch (err) {
      logger.warn(`[slack-agent] agents.sessions.setStatus failed: ${err}`);
    }
  });
}
