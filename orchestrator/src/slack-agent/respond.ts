// slack-agent/respond.ts — shared answer path for every surface (DM, group DM, channel,
// Slack Connect, threads). Sets the running status, gathers thread context,
// asks the runtime, and streams the answer back with the agent-session UX.

import { beginRun, endRun } from "./cancel.js";
import { markEngaged } from "./engagement.js";
import type { AgentRuntime, Surface, TranscriptTurn } from "./types.js";

// Bolt v5's sayStream/setStatus middleware args, typed loosely so we don't
// fight the framework's still-evolving agent types.
export type SayStreamFn = (args?: Record<string, unknown>) => {
  append(chunk: { markdown_text: string }): Promise<unknown>;
  stop(args?: Record<string, unknown>): Promise<unknown>;
};
export type SetStatusFn = (args: Record<string, unknown>) => Promise<unknown>;
export type SayFn = (args: { text: string; thread_ts?: string }) => Promise<unknown>;

export interface SlackClientLike {
  conversations: {
    replies(args: { channel: string; ts: string; limit?: number }): Promise<{
      messages?: Array<{ user?: string; bot_id?: string; text?: string; subtype?: string; ts?: string }>;
    }>;
  };
  chat: {
    postMessage(args: { channel: string; text: string; thread_ts?: string }): Promise<unknown>;
  };
}

export interface RespondArgs {
  client: SlackClientLike;
  logger: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
  runtime: AgentRuntime;
  botUserId: string | undefined;
  surface: Surface;
  channelId: string;
  threadTs: string;
  messageTs: string;
  userId: string;
  teamId?: string;
  prompt: string;
  /** Extra context line (e.g. from assistant_thread_context) folded into the query. */
  viewingContext?: string;
  sayStream?: SayStreamFn;
  setStatus?: SetStatusFn;
  say?: SayFn;
}

const LOADING_MESSAGES = [
  "Searching the knowledge graph…",
  "Reading past sessions and decisions…",
  "Cross-checking memory and code anchors…",
  "Writing up the answer…",
];

const FOOTER_BLOCKS = [
  {
    type: "context",
    elements: [{ type: "mrkdwn", text: "Flow answers from the team knowledge graph and memory — verify before acting." }],
  },
];

export async function respond(args: RespondArgs): Promise<void> {
  const { client, logger, runtime } = args;
  const controller = beginRun(args.channelId, args.threadTs);

  const setStatusSafe = async (status: string, loading = false) => {
    if (!args.setStatus) return;
    try {
      await args.setStatus(loading ? { status, loading_messages: LOADING_MESSAGES } : { status });
    } catch {
      // Status is best-effort: not every surface supports agent sessions.
    }
  };

  try {
    await setStatusSafe("Thinking…", true);

    const transcript =
      args.threadTs !== args.messageTs
        ? await fetchTranscript(client, args.channelId, args.threadTs, args.messageTs, args.botUserId)
        : [];

    const prompt = args.viewingContext ? `${args.prompt}\n\n(${args.viewingContext})` : args.prompt;

    const answer = await runtime.ask({
      prompt,
      transcript,
      context: {
        surface: args.surface,
        channelId: args.channelId,
        threadTs: args.threadTs,
        userId: args.userId,
        teamId: args.teamId,
      },
      signal: controller.signal,
      onStatus: (s) => void setStatusSafe(s),
    });

    if (controller.signal.aborted) return;

    // Keep the thread engaged so plain follow-up replies reach us.
    markEngaged(args.channelId, args.threadTs);

    if (args.sayStream) {
      const streamer = args.sayStream({ thread_ts: args.threadTs });
      await streamer.append({ markdown_text: answer.markdown });
      await streamer.stop({ blocks: FOOTER_BLOCKS });
    } else {
      await client.chat.postMessage({ channel: args.channelId, text: answer.markdown, thread_ts: args.threadTs });
    }
  } catch (err) {
    if (isAbort(err) || controller.signal.aborted) {
      logger.info(`[respond] run for ${args.channelId}:${args.threadTs} stopped`);
      return;
    }
    logger.error(`[respond] failed for ${args.channelId}:${args.threadTs}: ${err}`);
    const text = `:warning: I couldn't answer that one. (${trimError(err)})`;
    try {
      if (args.say) await args.say({ text, thread_ts: args.threadTs });
      else await client.chat.postMessage({ channel: args.channelId, text, thread_ts: args.threadTs });
    } catch (sendErr) {
      logger.error(`[respond] could not deliver error message: ${sendErr}`);
    }
  } finally {
    endRun(args.channelId, args.threadTs, controller);
    await setStatusSafe(""); // clear "running" if the stream path didn't
  }
}

async function fetchTranscript(
  client: SlackClientLike,
  channelId: string,
  threadTs: string,
  currentTs: string,
  botUserId: string | undefined
): Promise<TranscriptTurn[]> {
  try {
    const res = await client.conversations.replies({ channel: channelId, ts: threadTs, limit: 30 });
    const turns: TranscriptTurn[] = [];
    for (const msg of res.messages ?? []) {
      if (msg.ts === currentTs) continue;
      if (msg.subtype) continue;
      const text = stripMentions(msg.text ?? "");
      if (!text) continue;
      const fromBot = Boolean(msg.bot_id) || (botUserId !== undefined && msg.user === botUserId);
      turns.push({ role: fromBot ? "assistant" : "user", text });
    }
    return turns;
  } catch {
    return []; // No history access (e.g. not in channel) — answer without it.
  }
}

export function stripMentions(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function trimError(err: unknown): string {
  return String(err instanceof Error ? err.message : err).slice(0, 200);
}
