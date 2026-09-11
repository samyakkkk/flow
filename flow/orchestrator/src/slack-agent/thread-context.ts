// slack-agent/thread-context.ts — Slack's "what is the user viewing" context.
//
// assistant_thread_started / assistant_thread_context_changed deliver a
// context object ({channel_id, team_id, ...}) describing where the user is
// looking while they talk to the agent. We keep the latest per thread and fold
// it into the runtime query so "summarize this channel" style questions work.

const contexts = new Map<string, string>();

function key(channelId: string, threadTs: string): string {
  return `${channelId}:${threadTs}`;
}

export function setThreadContext(channelId: string, threadTs: string, context: Record<string, unknown> | undefined): void {
  const viewed = context?.channel_id;
  if (typeof viewed === "string" && viewed.length > 0) {
    contexts.set(key(channelId, threadTs), `User is currently viewing Slack channel <#${viewed}>`);
  }
}

export function getThreadContext(channelId: string, threadTs: string): string | undefined {
  return contexts.get(key(channelId, threadTs));
}
