import { existsSync } from "node:fs";
import path from "node:path";
import db from "../db.js";
import { getJob, enqueueJob, codingChildPid, pauseCloudJobForSetup } from "../opencode.js";
import { codingSlotStatus, requestCodingSlot, releaseCodingSlot } from "./coding-slot.js";
import { cloudMode, conversationRepos, ensureConversationWorktree } from "./cloud-workspaces.js";
import { registerSetupFile, setupEnvironment, mergeSetupValue, rememberExistingSetup } from "./setup-files.js";
import { requests, saveSetupRequest, setupData, slackCall, deliverSetupRequest } from "./setup-requests.js";
import { redactCloudText } from "./repo-env.js";
import { cloudRunUrl, renderAnswer } from "../slack-agent/runtime.js";
import { sweepSetupTerminals, stopSetupTerminals } from "./setup-terminal.js";

let sweeping = false;
export async function sweepSetupRequests(): Promise<void> {
  if (!cloudMode() || sweeping) return;
  sweeping = true;
  try {
    sweepSetupTerminals();
    for (const request of requests()) {
      const lease = `setup-apply:${request.id}`;
      try {
        if (request.state === "requesting") { await deliverSetupRequest(request); pauseCloudJobForSetup(request.job, request.id); continue; }
        if (request.state === "waiting") { pauseCloudJobForSetup(request.job, request.id); continue; }
        if (request.state === "cancelled") { releaseCodingSlot(lease); continue; }
        if (request.state === "ready") {
          if (["running", "queued"].includes(getJob(request.job)?.status ?? "") || codingChildPid(request.job)) continue;
          if (!requestCodingSlot(lease).acquired) continue;
          const previousResume = db.prepare("SELECT id FROM jobs WHERE json_extract(input,'$.setup_request') = ? ORDER BY rowid LIMIT 1").get(request.id) as { id: string } | undefined;
          if (!previousResume) {
            const repo = conversationRepos(request.conversation).find(r => r.name === request.repo);
            if (!repo) throw new Error("Repository is no longer registered");
            setupEnvironment(request.conversation, request.repo, request.environment);
            const owned = await ensureConversationWorktree(request.conversation, request.repo);
            if (request.kind !== "terminal") {
              let data = setupData(request);
              if (request.kind === "value") {
                data = mergeSetupValue(repo.source, request.destination!, request.variable!, data);
                if (existsSync(path.join(repo.source, request.destination!))) rememberExistingSetup({ repo: request.repo, environment: request.environment, destination: request.destination!, source: repo.source, worktree: owned.worktree!.path, conversation: request.conversation, from: "source" });
              }
              registerSetupFile({ repo: request.repo, environment: request.environment, destination: request.destination!, data, source: repo.source, worktree: owned.worktree!.path, conversation: request.conversation });
            }
          }
          // Leave no gap for another setup application, but release before the resumed turn wants the slot.
          releaseCodingSlot(lease);
          const [source, workspace, id] = JSON.parse(request.conversation);
          const original = getJob(request.job);
          const description = request.kind === "terminal" ? "The requester completed the setup terminal. Verify the required CLI/login now." : `The requested setup file is installed at ${request.destination} for ${request.repo} (${request.environment}). Do not read or print its credential values. Verify the application can use it.`;
          const resumed = previousResume ?? await enqueueJob({ type: "answer", input: {
            conversation: { source, workspace, id }, setup_request: request.id, slack_requester: request.requester,
            question: `${description}\nResume the original task and finish its requested delivery. Original request:\n${String(original?.input.question ?? original?.input.message ?? "Continue the task in this conversation")}`,
            display_message: `Setup ready: ${request.repo} (${request.environment}). Resume the original task.`,
            workspace,
          } });
          request.state = "resumed"; request.resumeJob = resumed.id; delete request.encrypted; delete request.notice; saveSetupRequest(request);
        }
        if (request.state === "resumed" && request.resumeJob) {
          const job = getJob(request.resumeJob);
          const phase = codingSlotStatus(request.resumeJob) ?? job?.status;
          const url = cloudRunUrl(request.resumeJob);
          const link = url ? `\n<${url}|View agent run>` : "";
          if (job?.status === "done" && !request.delivered) {
            const result = job.result_json ? JSON.parse(job.result_json) : {};
            await slackCall("chat.postMessage", { channel: request.channel, thread_ts: request.thread, client_msg_id: request.resumeJob, text: redactCloudText(renderAnswer(result)) + link });
            request.delivered = true; saveSetupRequest(request);
          }
          if (!phase || phase === request.notice) continue;
          const text = phase === "failed" ? "The resumed task stopped with an error. Its saved work is available in the agent run." : phase === "done" ? undefined : phase === "waiting" ? "Setup is ready. This task is queued behind another coding task." : phase === "coding" ? "Setup is ready. Your coding task has resumed." : request.notice ? undefined : "Setup is ready. I’m resuming the original task.";
          if (text) await slackCall("chat.postMessage", { channel: request.channel, thread_ts: request.thread, text: text + link });
          request.notice = phase; saveSetupRequest(request);
        }
      } catch {
        // A conflict never retries destructive writes or exposes file contents. Keep encrypted input for retry.
        if (request.notice !== "setup-error") {
          try { await slackCall("chat.postMessage", { channel: request.dm, thread_ts: request.dmThread, text: "I couldn’t apply the setup yet. An existing file may conflict or the repository may be unavailable. Your supplied file is retained; resolve the setup conflict and I’ll retry." }); request.notice = "setup-error"; saveSetupRequest(request); } catch { /* Slack may be unavailable; retry later */ }
        }
      } finally {
        // Retain a waiting lease's FIFO position; release only acquired/failed operations.
        if (codingSlotStatus(lease) === "coding") releaseCodingSlot(lease);
      }
    }
  } finally { sweeping = false; }
}
export function startSetupWorker(): () => void {
  const timer = setInterval(() => { void sweepSetupRequests(); }, 1500); timer.unref();
  return () => { clearInterval(timer); stopSetupTerminals(); };
}
