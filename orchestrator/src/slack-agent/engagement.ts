// slack-agent/engagement.ts — which channel threads the agent is part of.
//
// The agent only participates where explicitly invoked: DMs and group DMs are
// always in-scope, but in channels (incl. Slack Connect) it answers only when
// mentioned — after which the thread is "engaged" and plain replies in that
// thread keep the conversation going. In-memory with TTL: losing it just means
// users mention the agent once more in an old thread.

const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 5000;

const engaged = new Map<string, number>();

function key(channelId: string, threadTs: string): string {
  return `${channelId}:${threadTs}`;
}

export function markEngaged(channelId: string, threadTs: string): void {
  if (engaged.size >= MAX_ENTRIES) {
    // Drop oldest entries (Map preserves insertion order).
    for (const k of engaged.keys()) {
      if (engaged.size < MAX_ENTRIES) break;
      engaged.delete(k);
    }
  }
  engaged.set(key(channelId, threadTs), Date.now());
}

export function isEngaged(channelId: string, threadTs: string): boolean {
  const at = engaged.get(key(channelId, threadTs));
  if (at === undefined) return false;
  if (Date.now() - at > TTL_MS) {
    engaged.delete(key(channelId, threadTs));
    return false;
  }
  return true;
}

export function engagedCount(): number {
  return engaged.size;
}
