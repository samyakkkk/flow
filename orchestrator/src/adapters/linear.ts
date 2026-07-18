// adapters/linear.ts — Real Linear integration adapter.
//
// 1. LinearClient: plain fetch GraphQL (no SDK) — createIssue, updateIssue,
//    getIssue, listIssues, upsertBotComment.
// 2. Fastify route: POST /v1/webhooks/linear — validates LINEAR_WEBHOOK_SECRET
//    (HMAC-SHA256 of body), normalises ticket events, feeds processEvent directly.
//    Webhook accelerator: after handling the event it calls pollNow("linear", "_all")
//    to trigger an immediate corpus sync without waiting for the next poll interval.
// 3. Poller: startLinearPoller() — polls issues(filter:{updatedAt:{gt:cursor}})
//    on a configurable interval via the shared registerPoller() engine.
//    cursor = ISO timestamp. Mirrors rows into linear_tickets corpus, emits
//    normalized linear events into the pipeline.
//
// Drainer (see drainer.ts) uses LinearClient for linear_* outbox rows.

import type { FastifyInstance } from "fastify";
import { createHmac } from "node:crypto";
import { randomUUID } from "node:crypto";
import { processEvent } from "../events.js";
import type { NormalizedEvent } from "../events.js";
import { observeCorpus, repoForTicket } from "../memory/corpus-observe.js";
import db from "../db.js";
import { registerPoller, pollNow } from "../pollers/engine.js";
import { getSetting } from "../settings.js";

// ------------------------------------------------------------------
// Config
// ------------------------------------------------------------------

const LINEAR_API = "https://api.linear.app/graphql";
const FLOW_COMMENT_MARKER = "<!-- flow:context:start -->";

function apiKey(): string {
  return getSetting("LINEAR_API_KEY") ?? process.env.LINEAR_API_KEY ?? "";
}

// ------------------------------------------------------------------
// Low-level GraphQL fetch
// ------------------------------------------------------------------

export interface GqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

export async function linearGql<T>(
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const key = apiKey();
  if (!key) throw new Error("LINEAR_API_KEY not set");

  const res = await fetch(LINEAR_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: key,
    },
    body: JSON.stringify({ query, variables: variables ?? {} }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Linear API HTTP ${res.status}: ${text}`);
  }

  const json = (await res.json()) as GqlResponse<T>;
  if (json.errors && json.errors.length > 0) {
    throw new Error(`Linear GQL error: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  if (!json.data) throw new Error("Linear API returned no data");
  return json.data;
}

// ------------------------------------------------------------------
// LinearClient public interface
// ------------------------------------------------------------------

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  state?: { name: string };
  url: string;
  team: { id: string; key: string };
}

export interface LinearComment {
  id: string;
  body: string;
  createdAt: string;
  issue?: { id: string };
}

export async function createIssue(opts: {
  teamId: string;
  title: string;
  description?: string;
  assigneeId?: string;
  labelIds?: string[];
}): Promise<LinearIssue> {
  const data = await linearGql<{ issueCreate: { success: boolean; issue: LinearIssue } }>(
    `mutation CreateIssue($input: IssueCreateInput!) {
       issueCreate(input: $input) {
         success
         issue {
           id identifier title description url
           state { name }
           team { id key }
         }
       }
     }`,
    {
      input: {
        teamId: opts.teamId,
        title: opts.title,
        description: opts.description,
        assigneeId: opts.assigneeId,
        labelIds: opts.labelIds,
      },
    }
  );
  if (!data.issueCreate.success) throw new Error("Linear createIssue returned success=false");
  return data.issueCreate.issue;
}

export async function updateIssue(
  id: string,
  updates: { title?: string; description?: string; stateId?: string }
): Promise<LinearIssue> {
  const data = await linearGql<{ issueUpdate: { success: boolean; issue: LinearIssue } }>(
    `mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
       issueUpdate(id: $id, input: $input) {
         success
         issue {
           id identifier title description url
           state { name }
           team { id key }
         }
       }
     }`,
    { id, input: updates }
  );
  if (!data.issueUpdate.success) throw new Error("Linear updateIssue returned success=false");
  return data.issueUpdate.issue;
}

export async function getIssue(id: string): Promise<LinearIssue> {
  const data = await linearGql<{ issue: LinearIssue }>(
    `query GetIssue($id: String!) {
       issue(id: $id) {
         id identifier title description url
         state { name }
         team { id key }
       }
     }`,
    { id }
  );
  return data.issue;
}

export async function listIssues(teamId: string, first = 25): Promise<LinearIssue[]> {
  const data = await linearGql<{
    issues: { nodes: LinearIssue[] };
  }>(
    `query ListIssues($teamId: String!, $first: Int!) {
       issues(filter: { team: { id: { eq: $teamId } } }, first: $first, orderBy: updatedAt) {
         nodes {
           id identifier title description url
           state { name }
           team { id key }
         }
       }
     }`,
    { teamId, first }
  );
  return data.issues.nodes;
}

// ------------------------------------------------------------------
// Comments
// ------------------------------------------------------------------

async function getIssueComments(issueId: string): Promise<LinearComment[]> {
  const data = await linearGql<{
    issue: { comments: { nodes: LinearComment[] } };
  }>(
    `query GetComments($id: String!) {
       issue(id: $id) {
         comments(first: 50, orderBy: createdAt) {
           nodes { id body createdAt }
         }
       }
     }`,
    { id: issueId }
  );
  return data.issue.comments.nodes;
}

async function createComment(issueId: string, body: string): Promise<LinearComment> {
  const data = await linearGql<{ commentCreate: { success: boolean; comment: LinearComment } }>(
    `mutation CreateComment($input: CommentCreateInput!) {
       commentCreate(input: $input) {
         success
         comment { id body createdAt }
       }
     }`,
    { input: { issueId, body } }
  );
  if (!data.commentCreate.success) throw new Error("Linear commentCreate returned success=false");
  return data.commentCreate.comment;
}

async function updateComment(id: string, body: string): Promise<LinearComment> {
  const data = await linearGql<{ commentUpdate: { success: boolean; comment: LinearComment } }>(
    `mutation UpdateComment($id: String!, $input: CommentUpdateInput!) {
       commentUpdate(id: $id, input: $input) {
         success
         comment { id body createdAt }
       }
     }`,
    { id, input: { body } }
  );
  if (!data.commentUpdate.success) throw new Error("Linear commentUpdate returned success=false");
  return data.commentUpdate.comment;
}

/**
 * Find existing Flow comment on an issue and update it, or create a new one.
 * Exactly ONE flow comment per ticket (idempotent on the marker string).
 */
export async function upsertBotComment(
  issueId: string,
  markdown: string
): Promise<{ commentId: string; action: "created" | "updated" }> {
  const comments = await getIssueComments(issueId);
  const existing = comments.find((c) => c.body.includes(FLOW_COMMENT_MARKER));

  if (existing) {
    await updateComment(existing.id, markdown);
    return { commentId: existing.id, action: "updated" };
  }

  const created = await createComment(issueId, markdown);
  return { commentId: created.id, action: "created" };
}

// ------------------------------------------------------------------
// Corpus mirror: upsert a linear issue row into linear_tickets
// ------------------------------------------------------------------

const upsertLinearTicket = db.prepare(`
  INSERT INTO linear_tickets (id, identifier, title, description, state, assignee, labels, url, updated_at)
  VALUES (@id, @identifier, @title, @description, @state, @assignee, @labels, @url, @updated_at)
  ON CONFLICT(id) DO UPDATE SET
    identifier  = excluded.identifier,
    title       = excluded.title,
    description = excluded.description,
    state       = excluded.state,
    assignee    = excluded.assignee,
    labels      = excluded.labels,
    url         = excluded.url,
    updated_at  = excluded.updated_at
`);

/** Extended LinearIssue shape returned by the poll query. */
export interface LinearIssueForPoller extends LinearIssue {
  updatedAt?: string;
  assignee?: { displayName?: string } | null;
  labels?: { nodes: Array<{ name: string }> };
}

function mirrorTicket(issue: LinearIssueForPoller): void {
  upsertLinearTicket.run({
    id: issue.id,
    identifier: issue.identifier ?? null,
    title: issue.title,
    description: issue.description ?? null,
    state: issue.state?.name ?? null,
    assignee: issue.assignee?.displayName ?? null,
    labels: issue.labels ? JSON.stringify(issue.labels.nodes.map((l) => l.name)) : null,
    url: issue.url ?? null,
    updated_at: issue.updatedAt ? Math.floor(new Date(issue.updatedAt).getTime() / 1000) : null,
  });
  // Memory enrichment: mirror the ticket into the observations corpus so
  // search_knowledge can surface it. repo_family inferred from the team prefix.
  const text = [issue.title, issue.description].filter(Boolean).join(" — ");
  void observeCorpus({ source: "linear", text, repo: repoForTicket(issue.identifier ?? null) });
}

// ------------------------------------------------------------------
// Poller fetch function — returns engine FetchResult shape.
//
// GraphQL query: issues(filter: { updatedAt: { gt: $cursor } }, orderBy: updatedAt)
// cursor = ISO timestamp; advances to latest updatedAt seen each batch.
// ------------------------------------------------------------------

export async function linearFetchSince(cursor: string): Promise<{
  events: NormalizedEvent[];
  nextCursor: string;
}> {
  // On first boot (cursor === "") default to 7 days back
  const since: string = cursor || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const data = await linearGql<{
    issues: {
      nodes: LinearIssueForPoller[];
      pageInfo: { hasNextPage: boolean; endCursor: string };
    };
  }>(
    `query PollIssues($since: DateComparator!, $first: Int!) {
       issues(
         filter: { updatedAt: $since }
         first: $first
         orderBy: updatedAt
       ) {
         nodes {
           id
           identifier
           title
           description
           url
           updatedAt
           state { name }
           assignee { displayName }
           labels { nodes { name } }
           team { id key }
         }
         pageInfo { hasNextPage endCursor }
       }
     }`,
    { since: { gt: since }, first: 100 }
  );

  const issues = data.issues.nodes;

  // Mirror all fetched issues into corpus immediately
  for (const issue of issues) {
    mirrorTicket(issue);
  }

  // Map issues to normalized events
  const events: NormalizedEvent[] = issues.map((issue) => ({
    id: randomUUID(),
    source: "linear" as const,
    type: "ticket_updated",
    ts: issue.updatedAt ? new Date(issue.updatedAt).getTime() : Date.now(),
    payload: {
      ticket_id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      state: issue.state?.name,
      url: issue.url,
      team_id: issue.team?.id,
      polled: true,
    },
  }));

  // Advance cursor to the latest updatedAt seen
  let nextCursor = cursor || since;
  for (const issue of issues) {
    if (issue.updatedAt && issue.updatedAt > nextCursor) {
      nextCursor = issue.updatedAt;
    }
  }

  return { events, nextCursor };
}

const DEFAULT_LINEAR_INTERVAL_MS = 60_000; // 1 minute

/**
 * Register the Linear poller with the engine (engine starts on startAllPollers()).
 * Requires LINEAR_API_KEY. No-ops if FLOW_POLL_DISABLE=1 (test env).
 * Alias: startLinearPoller() for backwards compat.
 */
export function registerLinearPoller(
  intervalMs?: number
): void {
  // Read interval from settings at registration time; fall back to default
  const resolvedInterval =
    intervalMs ??
    parseInt(getSetting("FLOW_LINEAR_POLL_MS") ?? String(DEFAULT_LINEAR_INTERVAL_MS), 10);

  registerPoller({
    source: "linear",
    resource: "_all",
    intervalMs: resolvedInterval,
    fetchSince: linearFetchSince,
    enabled: () => Boolean(apiKey()) && process.env.FLOW_POLL_DISABLE !== "1",
  });
}

/** Alias for registerLinearPoller() — same function, preferred name in tests. */
export const startLinearPoller = registerLinearPoller;

// ------------------------------------------------------------------
// Webhook route registration
// ------------------------------------------------------------------

function verifyLinearSignature(
  secret: string,
  rawBody: Buffer,
  signature: string
): boolean {
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  // Linear sends "sha256=<hex>" or just "<hex>"
  const sig = signature.replace(/^sha256=/, "");
  return expected === sig;
}

export function registerLinearWebhook(app: FastifyInstance): void {
  // Raw body is pre-parsed by the global content-type parser in index.ts
  // and attached as req._rawBody (Buffer). req.body is already parsed JSON.
  app.post("/v1/webhooks/linear", async (req, reply) => {
    const secret = process.env.LINEAR_WEBHOOK_SECRET;
    const rawBody = (req as unknown as Record<string, Buffer>)._rawBody ?? Buffer.from(JSON.stringify(req.body));

    if (secret) {
      const sig =
        (req.headers["linear-signature"] as string | undefined) ??
        (req.headers["x-linear-signature"] as string | undefined) ??
        "";
      if (!verifyLinearSignature(secret, rawBody, sig)) {
        return reply.code(401).send({ error: "Invalid signature" });
      }
    }

    // Body is already parsed by the global content-type parser
    const payload = req.body as Record<string, unknown>;

    // Normalise Linear webhook event types
    const action = payload.action as string | undefined; // "create" | "update" | "remove"
    const data = payload.data as Record<string, unknown> | undefined;
    const type = payload.type as string | undefined; // "Issue" | "Comment" | etc.

    // Only handle ticket events
    if (type !== "Issue" || !data) {
      return reply.code(200).send({ ok: true, skipped: true });
    }

    const eventType =
      action === "create" ? "ticket_created"
      : action === "update" ? "ticket_updated"
      : "ticket_event";

    const event: NormalizedEvent = {
      id: randomUUID(),
      source: "linear",
      type: eventType,
      ts: Date.now(),
      payload: {
        ticket_id: data.id as string,
        identifier: data.identifier as string,
        title: data.title as string,
        description: data.description as string | undefined,
        state: (data.state as Record<string, unknown> | undefined)?.name as string | undefined,
        url: data.url as string | undefined,
        team_id: (data.team as Record<string, unknown> | undefined)?.id as string | undefined,
        raw: data,
      },
    };

    // Feed directly into event pipeline (same as POST /v1/events)
    await processEvent(event);

    // Webhook = poll-now accelerator: trigger immediate poll tick so corpus
    // (linear_tickets) mirrors any concurrent changes without waiting for the interval.
    pollNow("linear", "_all");

    return reply.code(200).send({ ok: true, event_id: event.id });
  });
}
