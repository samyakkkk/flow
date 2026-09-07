export interface CloudRepo { name: string; baseBranch?: string; worktree?: { path: string; branch: string; archived_at?: number; cleanup_error?: string } }
export interface CloudTurn { id: string; status: string; phase: string; message: string; created_at?: number; updated_at?: number; repos?: CloudRepo[]; result?: { answer_md?: string; output?: string }; events?: { kind: string; time: number; title: string; output?: string; status?: string }[] }
export interface CloudRun { turns: CloudTurn[]; repos: CloudRepo[]; slackUrl?: string }
export const cloudStatus = (turn: CloudTurn) => turn.phase === "waiting" || turn.status === "queued" ? "queued" : turn.status === "done" ? "idle" : turn.status === "failed" ? "error" : "running";
export function cloudSessionRow(turn: CloudTurn) {
  return { id: `cloud-${turn.id}`, backend: "opencode", repo: turn.repos?.map(r => r.name).join(", ") || "server", title: turn.message, status: cloudStatus(turn), live: ["running", "queued"].includes(turn.status), worktree_id: turn.repos?.find(r => r.worktree)?.worktree?.path ?? null, created_at: (turn.created_at ?? 0) * 1000, updated_at: (turn.updated_at ?? 0) * 1000 };
}
export function cloudTranscript(run: CloudRun) {
  const events: { seq: number; ts: number; kind: string; data: Record<string, unknown> }[] = [];
  const add = (kind: string, data: Record<string, unknown>, ts: number) => events.push({ seq: events.length + 1, ts, kind, data });
  for (const turn of run.turns) {
    const ts = (turn.created_at ?? 0) * 1000;
    add("user_prompt", { text: turn.message }, ts);
    for (const [i, event] of (turn.events ?? []).entries()) {
      if (event.kind === "tool") add("update", { sessionUpdate: "tool_call", toolCallId: `${turn.id}-${i}`, title: event.title, status: event.status === "error" ? "failed" : event.status || "completed" }, event.time);
      else if (!turn.result) add("update", { sessionUpdate: "agent_message_chunk", content: { text: event.title + "\n\n" } }, event.time);
    }
    if (turn.result?.answer_md) add("update", { sessionUpdate: "agent_message_chunk", content: { text: turn.result.answer_md } }, ts);
    if (turn.result?.output) add("update", { sessionUpdate: "agent_message_chunk", content: { text: "\n\n```text\n" + turn.result.output + "\n```" } }, ts);
    add("status", { status: cloudStatus(turn) }, (turn.updated_at ?? 0) * 1000);
  }
  return events;
}
