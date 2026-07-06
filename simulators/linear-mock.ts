// linear-mock.ts — Standalone HTTP server (port 7509) implementing a
// Linear-API-shaped subset for orchestrator outbox drainer integration.
//
// Endpoints:
//   POST /issues             — create issue
//   GET  /issues/:id         — get issue
//   PATCH /issues/:id        — update issue
//   GET  /issues             — list issues
//   POST /issues/:id/comments   — add comment
//   PATCH /issues/:id/comments/:cid — update comment
//   GET  /_dump              — return full in-memory store (for assertions)
//   POST /_reset             — clear all data

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

const PORT = parseInt(process.env.LINEAR_MOCK_PORT ?? "7509", 10);

// ------------------------------------------------------------------
// In-memory store
// ------------------------------------------------------------------

interface Issue {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  state: string;
  team_id?: string;
  assignee_id?: string;
  created_at: string;
  updated_at: string;
}

interface Comment {
  id: string;
  issue_id: string;
  body: string;
  created_at: string;
  updated_at: string;
}

interface Store {
  issues: Map<string, Issue>;
  comments: Map<string, Comment>;      // keyed by comment id
  issueComments: Map<string, string[]>; // issue_id → comment ids
  issueCounter: number;
}

let store: Store = makeEmptyStore();

function makeEmptyStore(): Store {
  return {
    issues: new Map(),
    comments: new Map(),
    issueComments: new Map(),
    issueCounter: 0,
  };
}

function resetStore(): void {
  store = makeEmptyStore();
}

function dumpStore(): unknown {
  return {
    issues: Array.from(store.issues.values()),
    comments: Array.from(store.comments.values()),
  };
}

// ------------------------------------------------------------------
// HTTP helpers
// ------------------------------------------------------------------

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

function notFound(res: ServerResponse, msg = "Not found"): void {
  send(res, 404, { error: msg });
}

// ------------------------------------------------------------------
// Route handler
// ------------------------------------------------------------------

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;

  // Health
  if (method === "GET" && path === "/health") {
    send(res, 200, { status: "ok", service: "linear-mock" });
    return;
  }

  // Dump (for test assertions)
  if (method === "GET" && path === "/_dump") {
    send(res, 200, dumpStore());
    return;
  }

  // Reset (between test scenarios)
  if (method === "POST" && path === "/_reset") {
    resetStore();
    send(res, 200, { ok: true });
    return;
  }

  // POST /issues — create issue
  if (method === "POST" && path === "/issues") {
    const raw = await readBody(req);
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const title = (body.title as string | undefined) ?? "(untitled)";

    store.issueCounter += 1;
    const issue: Issue = {
      id: randomUUID(),
      identifier: `FLOW-${store.issueCounter}`,
      title,
      description: (body.description as string | undefined) ?? "",
      state: (body.state as string | undefined) ?? "todo",
      team_id: (body.team_id as string | undefined),
      assignee_id: (body.assignee_id as string | undefined),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    store.issues.set(issue.id, issue);
    store.issueComments.set(issue.id, []);
    send(res, 201, issue);
    return;
  }

  // GET /issues — list
  if (method === "GET" && path === "/issues") {
    send(res, 200, { nodes: Array.from(store.issues.values()) });
    return;
  }

  // /issues/:id and /issues/:id/comments/:cid
  const issueMatch = path.match(/^\/issues\/([^/]+)$/);
  const commentMatch = path.match(/^\/issues\/([^/]+)\/comments(?:\/([^/]+))?$/);

  if (issueMatch) {
    const issueId = issueMatch[1];

    if (method === "GET") {
      const issue = store.issues.get(issueId);
      if (!issue) { notFound(res); return; }
      const commentIds = store.issueComments.get(issueId) ?? [];
      const comments = commentIds.map((cid) => store.comments.get(cid)).filter(Boolean);
      send(res, 200, { ...issue, comments });
      return;
    }

    if (method === "PATCH") {
      const issue = store.issues.get(issueId);
      if (!issue) { notFound(res); return; }
      const raw = await readBody(req);
      const body = raw ? (JSON.parse(raw) as Partial<Issue>) : {};
      Object.assign(issue, body, { updated_at: new Date().toISOString() });
      send(res, 200, issue);
      return;
    }
  }

  if (commentMatch) {
    const issueId = commentMatch[1];
    const commentId = commentMatch[2]; // may be undefined for POST

    if (method === "POST") {
      // Add comment
      const issue = store.issues.get(issueId);
      if (!issue) { notFound(res, "Issue not found"); return; }
      const raw = await readBody(req);
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const comment: Comment = {
        id: randomUUID(),
        issue_id: issueId,
        body: (body.body as string | undefined) ?? "",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      store.comments.set(comment.id, comment);
      const list = store.issueComments.get(issueId) ?? [];
      list.push(comment.id);
      store.issueComments.set(issueId, list);
      send(res, 201, comment);
      return;
    }

    if (method === "PATCH" && commentId) {
      // Update comment
      const comment = store.comments.get(commentId);
      if (!comment) { notFound(res, "Comment not found"); return; }
      if (comment.issue_id !== issueId) { notFound(res, "Comment not on issue"); return; }
      const raw = await readBody(req);
      const body = raw ? (JSON.parse(raw) as Partial<Comment>) : {};
      Object.assign(comment, body, { updated_at: new Date().toISOString() });
      send(res, 200, comment);
      return;
    }
  }

  send(res, 404, { error: `No route: ${method} ${path}` });
}

// ------------------------------------------------------------------
// Boot
// ------------------------------------------------------------------

const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error("[linear-mock] error:", err);
    send(res, 500, { error: String(err) });
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[linear-mock] listening on port ${PORT}`);
});

export { server, dumpStore, resetStore };
