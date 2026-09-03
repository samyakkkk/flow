// slack-agent/cancel.ts — in-flight run registry so agent_session_stopped can abort work.
//
// One controller per thread: a new question in a thread supersedes (aborts)
// the previous in-flight run, and Slack's native stop button aborts via the
// agent_session_stopped event.

const inflight = new Map<string, AbortController>();

function key(channelId: string, threadTs: string): string {
  return `${channelId}:${threadTs}`;
}

/** Register a new run for the thread, aborting any previous one. Returns its controller. */
export function beginRun(channelId: string, threadTs: string): AbortController {
  const k = key(channelId, threadTs);
  inflight.get(k)?.abort();
  const controller = new AbortController();
  inflight.set(k, controller);
  return controller;
}

export function endRun(channelId: string, threadTs: string, controller: AbortController): void {
  const k = key(channelId, threadTs);
  if (inflight.get(k) === controller) inflight.delete(k);
}

/** Abort the in-flight run for a thread (stop button). Returns true if one existed. */
export function cancelRun(channelId: string, threadTs: string): boolean {
  const k = key(channelId, threadTs);
  const controller = inflight.get(k);
  if (!controller) return false;
  controller.abort();
  inflight.delete(k);
  return true;
}

export function inflightCount(): number {
  return inflight.size;
}
