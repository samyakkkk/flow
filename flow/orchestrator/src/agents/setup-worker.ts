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
        // Legacy rows stayed "resumed" after successful delivery. Retire them
        // before any Slack lookup, including when recovering from a restart.
        if (request.delivered && request.state !== "completed") {
          request.state = "completed"; delete request.retryAt; saveSetupRequest(request);
        }
        if (request.state === "completed" || request.state === "cancelled") { releaseCodingSlot(lease); continue; }
        if ((request.retryAt ?? 0) > Date.now()) continue;
        if (request.state === "requesting") { await deliverSetupRequest(request); pauseCloudJobForSetup(request.job, request.id); continue; }
        if (request.state === "waiting") { pauseCloudJobForSetup(request.job, request.id); continue; }
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
          const finalDelivery = job?.status === "done" && !request.delivered;
          // An unchanged phase needs no notification or network request.
          if (!phase || (!finalDelivery && phase === request.notice)) continue;
          const url = cloudRunUrl(request.resumeJob);
          // Re-check the channel before delayed delivery: setup may finish long
          // after the original response, and shared channels need private output.
          const info = await slackCall("conversations.info", { channel: request.channel });
          if (!info.channel) throw new Error("Reply destination unavailable");
          const shared = !!info.channel.is_ext_shared;
          if (shared && !request.dm) throw new Error("Private reply destination unavailable");
          const destination = { channel: shared ? request.dm! : request.channel, thread_ts: shared ? request.dmThread : request.thread };
          const link = url ? `\n<${url}|View agent run>` : "";
          if (finalDelivery) {
            const result = job?.result_json ? JSON.parse(job.result_json) : {};
            await slackCall("chat.postMessage", { ...destination, client_msg_id: request.resumeJob, text: redactCloudText(renderAnswer(result)) + link });
            request.delivered = true; request.state = "completed"; request.notice = "done";
            delete request.retryAt; request.errorAttempts = 0; saveSetupRequest(request);
            continue;
          }
          if (!phase || phase === request.notice) continue;
          const text = phase === "failed" ? "The resumed task stopped with an error. Its saved work is available in the agent run." : phase === "done" ? undefined : phase === "waiting" ? "Setup is ready. This task is queued behind another coding task." : phase === "coding" ? "Setup is ready. Your coding task has resumed." : request.notice ? undefined : "Setup is ready. I’m resuming the original task.";
          if (text) await slackCall("chat.postMessage", { ...destination, text: text + link });
          request.notice = phase;
          if (phase === "failed") request.state = "completed";
          delete request.retryAt; request.errorAttempts = 0; saveSetupRequest(request);
        }
      } catch (err) {
        // Retry independently of the last delivered phase. An intermittent API
        // failure must never reset notice and create an error/success spam loop.
        const failure = err as { code?: string; retryAfter?: number };
        const code = typeof failure?.code === "string" && /^slack_[a-z0-9_:-]+$/i.test(failure.code)
          ? failure.code : request.state === "ready" ? "setup_apply_failed" : "notification_failed";
        request.errorAttempts = (request.errorAttempts ?? 0) + 1;
        const delay = Math.min(900_000, 30_000 * 2 ** Math.min(request.errorAttempts - 1, 5));
        request.retryAt = Date.now() + Math.max(delay, Math.max(0, Number(failure?.retryAfter) || 0) * 1000);
        request.lastError = { stage: request.state, code, at: Date.now() };
        const notify = !request.errorNotified && !!request.dm && code !== "slack_ratelimited" && code !== "slack_429";
        // Persist before sending, so failed/uncertain notification delivery and
        // process restarts cannot emit the same error repeatedly.
        if (notify) request.errorNotified = true;
        saveSetupRequest(request);
        if (notify) {
          const text = request.state === "ready"
            ? "I couldn’t apply this setup yet. I’ve retained your supplied file and will retry."
            : request.state === "resumed"
              ? "The setup step is finished, but I couldn’t deliver the task update. I’ll retry delivery."
              : "I couldn’t finish sending the setup request. I’ll retry.";
          try { await slackCall("chat.postMessage", { channel: request.dm, thread_ts: request.dmThread, text }); } catch { /* Retry the underlying operation, not this notification. */ }
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
