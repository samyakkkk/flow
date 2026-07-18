// actions/index.ts — THE ONLY SIDE-EFFECT LAYER.
// Receives (event, classification, policy) and dispatches to specific action handlers.
// Every path writes an audit_log row. External targets write to outbox.

import db from "../db.js";
import type { NormalizedEvent } from "../events.js";
import type { ClassificationResult } from "../classify.js";
import type { PolicyDecision } from "../policy.js";
import { getSetting } from "../settings.js";
import { upsertNode, relateNodes } from "./graphwrite.js";
import { postSlackMessage, dmController } from "./slack.js";
import { addLinearComment, updateLinearTicketContext, createLinearTicket } from "./linear.js";
import { proposeAction } from "./dm.js";
import { upsertContextBlock, renderContextBlock } from "./contextblock.js";
import { enqueueJob } from "../opencode.js";
import { observeCorpus, repoForChannel } from "../memory/corpus-observe.js";

const insertAudit = db.prepare(`
  INSERT INTO audit_log (event_id, classification, confidence, action, target, status, detail)
  VALUES (@event_id, @classification, @confidence, @action, @target, @status, @detail)
`);

function audit(
  event_id: string,
  classification: string,
  confidence: number,
  action: string,
  target: string,
  status: "ok" | "error" | "suppressed" | "proposed",
  detail?: unknown
): void {
  insertAudit.run({
    event_id,
    classification,
    confidence,
    action,
    target,
    status,
    detail: detail !== undefined ? JSON.stringify(detail) : null,
  });
}

// Insert into corpus (slack)
const insertSlackMsg = db.prepare(`
  INSERT OR IGNORE INTO slack_messages (id, workspace, channel, user_id, text, ts, thread_ts, permalink)
  VALUES (@id, @workspace, @channel, @user_id, @text, @ts, @thread_ts, @permalink)
`);

export interface ActionContext {
  event: NormalizedEvent;
  classification: ClassificationResult;
  policy: PolicyDecision;
}

export async function executeAction(ctx: ActionContext): Promise<void> {
  const { event, classification, policy } = ctx;

  // Sensitive: always hard-drop — nothing stored anywhere, no audit either.
  // (system.md: "sensitive-drop is hardcoded non-configurable")
  if (classification.classification === "sensitive") {
    // Per spec: sensitive → nothing stored anywhere. We write NO corpus row and NO audit row.
    return;
  }

  // Off policy: suppress entirely
  if (policy === "off") {
    audit(event.id, classification.classification, classification.confidence, "suppressed", "-", "suppressed");
    return;
  }

  // Confidence floor (scenario S029): a low-confidence classification must not
  // auto-execute — one sarcastic message should never poison the graph. Below
  // the floor, auto downgrades to propose so a human sees it first.
  // Exception: github.index_worthy is a safe, deterministic reindex trigger;
  // requiring human approval for every push to main creates too much friction
  // and lets the graph fall behind.
  const floor = Number(getSetting("FLOW_CONFIDENCE_FLOOR") ?? process.env.FLOW_CONFIDENCE_FLOOR ?? "0.75");
  const isSafeAuto = event.source === "github" && classification.classification === "index_worthy";
  const effectivePolicy =
    policy === "auto" && !isSafeAuto && classification.confidence < floor ? "propose" : policy;

  // Propose mode: write to outbox (DM the controller), no direct action
  if (effectivePolicy === "propose") {
    const proposedDesc = describeProposedAction(event, classification);
    await proposeAction(event, classification, proposedDesc);
    audit(event.id, classification.classification, classification.confidence, "propose", "outbox", "proposed", { proposed: proposedDesc });
    return;
  }

  // Auto mode: execute based on source + classification
  await executeAuto(ctx);
}

function describeProposedAction(event: NormalizedEvent, classification: ClassificationResult): string {
  const c = classification.classification;
  if (c === "task_discussion") return "create or update Linear ticket from discussion";
  if (c === "ticket_status_signal") return "update Linear ticket status";
  if (c === "action_item") return "create Linear ticket from meeting action item";
  if (c === "duplicate_candidate") return "flag ticket as potential duplicate";
  if (c === "unresolvable") return "escalate unresolvable ticket";
  return `handle ${event.source}.${c}`;
}

// Exported so outbox approval can replay a proposed event with policy forced to auto.
export async function executeAuto(ctx: ActionContext): Promise<void> {
  const { event, classification } = ctx;
  const { source } = event;
  const c = classification.classification;

  try {
    if (source === "slack") {
      await handleSlackAuto(event, classification);
    } else if (source === "github") {
      await handleGithubAuto(event, classification);
    } else if (source === "linear") {
      await handleLinearAuto(event, classification);
    } else if (source === "meeting") {
      await handleMeetingAuto(event, classification);
    } else if (source === "dashboard") {
      // Dashboard events (ask) are handled via /v1/ask job queue, not auto-action
      audit(event.id, c, classification.confidence, "noop", "dashboard", "ok");
    }
  } catch (err) {
    audit(event.id, c, classification.confidence, "error", source, "error", { error: String(err) });
    throw err;
  }
}

// ------------------------------------------------------------------
// Per-source handlers
// ------------------------------------------------------------------

async function handleSlackAuto(event: NormalizedEvent, cls: ClassificationResult): Promise<void> {
  const p = event.payload as Record<string, string | undefined>;
  const c = cls.classification;

  // Store in corpus for all non-sensitive, non-noise slack messages
  if (c !== "noise") {
    insertSlackMsg.run({
      id: event.id,
      workspace: event.workspace ?? null,
      channel: p.channel ?? null,
      user_id: p.user_id ?? null,
      text: p.text ?? "",
      ts: p.ts ?? String(event.ts),
      thread_ts: p.thread_ts ?? null,
      permalink: p.permalink ?? null,
    });
    // Memory enrichment: mirror the message into the observations corpus so
    // search_knowledge can surface it (embedded + FTS). Non-blocking, best-effort.
    void observeCorpus({ source: "slack", text: p.text ?? "", repo: repoForChannel(p.channel) });
  }

  if (c === "knowledge_claim" || c === "correction") {
    // Write claim to knowledge graph. Conversational actor prefix ("slack:")
    // marks the low-trust lane — the gateway can refuse code-derived overwrites
    // from these actors (biz-vs-code trust rule, S072).
    const claimText = (p.text ?? "").slice(0, 500);
    await upsertNode(
      "Concept",
      `slack:${event.id}`,
      claimText.slice(0, 80) || `slack claim ${event.id}`,
      { source_text: claimText, source: "slack" },
      { actor: `slack:${p.user_id ?? "unknown"}`, evidence: p.permalink ?? `slack:${event.id}`, confidence: confidenceLabel(cls.confidence) }
    );
    audit(event.id, c, cls.confidence, "graphwrite", "Concept", "ok");
  } else if (c === "question") {
    // @mention/DM: answer and reply in the thread when the job completes.
    // workspace is passed through so the session binder in opencode.ts can
    // compute the correct thread_key for session-per-chat continuity (G10).
    // simulate_notify is a test hook: if present in payload, forwarded to the
    // job so fake-opencode can fire N notify calls to exercise the budget.
    const extra: Record<string, unknown> = {};
    if (p.simulate_notify !== undefined) {
      extra.simulate_notify = Number(p.simulate_notify);
    }
    const job = await enqueueJob({
      type: "answer",
      input: {
        question: p.text ?? "",
        event_id: event.id,
        workspace: event.workspace ?? "",
        reply_to: {
          channel: p.channel ?? "",
          thread_ts: p.thread_ts ?? p.ts ?? "",
        },
        ...extra,
      },
    });
    audit(event.id, c, cls.confidence, "answer_job", job.id, "ok");
  } else if (c === "question_about_system") {
    // Ambient peer question: stay silent by default; log as a demand signal
    // (repeated unanswered topics feed the enrichment queue).
    audit(event.id, c, cls.confidence, "demand_signal", "slack", "ok");
  } else if (c === "task_discussion") {
    const ex = cls.extracted as { title?: string; task?: string };
    const { outbox_id } = await createLinearTicket({
      title: (ex.title ?? ex.task ?? (p.text ?? "task from Slack")).slice(0, 120),
      description: `${p.text ?? ""}\n\n_From Slack${p.permalink ? `: ${p.permalink}` : ""} — created by Flow_`,
      event_id: event.id,
    });
    audit(event.id, c, cls.confidence, "linear_ticket_create", `outbox:${outbox_id}`, "ok");
  } else if (c === "ticket_status_signal") {
    const ex = cls.extracted as { ticket_id?: string; ticket?: string; status?: string };
    const ticketRef = ex.ticket_id ?? ex.ticket ?? "";
    const { outbox_id } = await addLinearComment({
      ticket_id: ticketRef,
      body: `Status signal from Slack${p.permalink ? ` (${p.permalink})` : ""}: ${p.text ?? ""}${ex.status ? `\n\nSuggested status: ${ex.status}` : ""}`,
      event_id: event.id,
    });
    audit(event.id, c, cls.confidence, "linear_comment", `outbox:${outbox_id}`, "ok");
  } else if (c === "noise") {
    audit(event.id, c, cls.confidence, "suppressed", "noise", "suppressed");
  } else {
    audit(event.id, c, cls.confidence, "corpus_insert", "slack_messages", "ok");
  }
}

async function handleGithubAuto(event: NormalizedEvent, cls: ClassificationResult): Promise<void> {
  const c = cls.classification;
  if (c === "skip") {
    audit(event.id, c, cls.confidence, "suppressed", "github", "suppressed");
    return;
  }

  // index_worthy: enqueue index job. The poller names repos as "owner/repo"
  // but the job runner and workspace registry address checkouts by short name
  // (repos/<name>), so resolve through the registry by URL — otherwise
  // ensureRepoClone throws "no checkout and no url" and the job dies.
  const p = event.payload as Record<string, string | undefined>;
  const { listWorkspaceRepos } = await import("../opencode.js");
  const { ownerRepoFromUrl } = await import("../adapters/github.js");
  const entry = listWorkspaceRepos().find(
    (r) => r.url && ownerRepoFromUrl(r.url) === p.repo
  );
  const repoName = entry?.name ?? p.repo ?? "";
  const job = await enqueueJob({
    type: "index_repo",
    // trigger:"push" opts the run into the incremental (diff-only) path when
    // the last indexed commit is an ancestor of the new HEAD.
    input: { repo: repoName, url: entry?.url, branch: p.branch ?? entry?.branch, commit: p.commit, trigger: "push" },
    repo: repoName,
  });
  audit(event.id, c, cls.confidence, "index_job", job.id, "ok");
}

async function handleLinearAuto(event: NormalizedEvent, cls: ClassificationResult): Promise<void> {
  const c = cls.classification;
  const p = event.payload as Record<string, string | undefined>;

  if (c === "needs_context") {
    // Render a context block and queue linear write
    const bundle = {
      notes: `Flow auto-context for ticket ${p.ticket_id ?? event.id} — enrich with graph lookup.`,
    };
    const contextMd = renderContextBlock(bundle);
    await updateLinearTicketContext(p.ticket_id ?? event.id, contextMd, event.id);
    audit(event.id, c, cls.confidence, "contextblock", p.ticket_id ?? "-", "ok");
  } else if (c === "not_applicable") {
    audit(event.id, c, cls.confidence, "suppressed", "linear", "suppressed");
  } else {
    audit(event.id, c, cls.confidence, "noop", "linear", "ok");
  }
}

async function handleMeetingAuto(event: NormalizedEvent, cls: ClassificationResult): Promise<void> {
  const c = cls.classification;
  const p = event.payload as Record<string, string | undefined>;

  if (c === "decision" || c === "knowledge_claim") {
    // Write to graph — meeting-derived, conversational trust lane.
    const mText = (p.text ?? "").slice(0, 500);
    await upsertNode(
      "Concept",
      `meeting:${event.id}`,
      mText.slice(0, 80) || `meeting claim ${event.id}`,
      { source_text: mText, source: "meeting" },
      { actor: `meeting:${p.meeting_id ?? event.id}`, evidence: `meeting:${p.meeting_id ?? event.id}`, confidence: confidenceLabel(cls.confidence) }
    );
    audit(event.id, c, cls.confidence, "graphwrite", "Concept", "ok");
  } else if (c === "open_question") {
    audit(event.id, c, cls.confidence, "corpus_insert", "meeting_segments", "ok");
  } else if (c === "noise") {
    audit(event.id, c, cls.confidence, "suppressed", "noise", "suppressed");
  } else {
    audit(event.id, c, cls.confidence, "noop", "meeting", "ok");
  }
}

function confidenceLabel(conf: number): "high" | "medium" | "low" {
  if (conf >= 0.8) return "high";
  if (conf >= 0.5) return "medium";
  return "low";
}
