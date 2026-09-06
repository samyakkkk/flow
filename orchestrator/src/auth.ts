// auth.ts — Bearer token middleware.
// Public: GET /health. Webhook receivers (/v1/webhooks/*) carry their own HMAC
// signature auth (validated inside each adapter) — external senders like Linear
// and GitHub cannot present the admin bearer, so they are exempted here and MUST
// be signature-checked downstream. Everything else requires the admin bearer.

import type { FastifyRequest, FastifyReply } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { isPat, verifyPatForProject } from "../../shared/pat-auth.js";

const TOKEN = process.env.FLOW_ADMIN_TOKEN ?? "dev-token";

if (!process.env.FLOW_ADMIN_TOKEN) {
  console.warn(
    "[auth] FLOW_ADMIN_TOKEN not set — using insecure default 'dev-token'. " +
    "Set this env var before exposing the service externally."
  );
}

function tokenMatches(candidate: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(TOKEN);
  // timingSafeEqual throws on length mismatch — guard so length isn't a signal.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function requireAuth(
  req: FastifyRequest,
  reply: FastifyReply,
  done: () => void
): void {
  const url = req.url.split("?")[0];

  // Public: health check.
  if (req.method === "GET" && url === "/health") {
    done();
    return;
  }

  // Webhook receivers authenticate by HMAC signature inside the adapter.
  if (url.startsWith("/v1/webhooks/")) {
    done();
    return;
  }

  // /v1/notify accepts EITHER the admin bearer OR a per-job scoped token
  // (validated inside the route). Exempt here so the scoped token isn't 401'd.
  if (url === "/v1/notify") {
    done();
    return;
  }

  if (req.method === "POST" && /^\/v1\/agents\/tasks\/[^/]+\/workspace$/.test(url)) {
    done(); // Exact job-scoped authentication is enforced inside cloud-routes.
    return;
  }

  const header = req.headers.authorization ?? "";
  const match = header.match(/^Bearer (.+)$/i);

  // Machine credentials grant knowledge/capture access, never process control
  // or administrative access. Revocation is checked against the shared store.
  if (match && isPat(match[1])) {
    if (!verifyPatForProject(match[1])) {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    const allowed = req.method === "GET" && url === "/v1/connection" ||
      req.method === "POST" && new Set([
        "/v1/ingest/hook", "/v1/ingest/opencode", "/v1/memory/search",
        "/v1/memory/remember", "/v1/telemetry/track",
      ]).has(url);
    if (!allowed) {
      reply.code(403).send({ error: "This credential cannot access that operation" });
      return;
    }
    done();
    return;
  }

  if (!match || !tokenMatches(match[1])) {
    reply.code(401).send({ error: "Unauthorized" });
    return;
  }

  done();
}
