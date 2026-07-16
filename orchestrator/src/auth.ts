// auth.ts — Bearer token middleware.
// Public: GET /health. Webhook receivers (/v1/webhooks/*) carry their own HMAC
// signature auth (validated inside each adapter) — external senders like Linear
// and GitHub cannot present the admin bearer, so they are exempted here and MUST
// be signature-checked downstream. Everything else requires the admin bearer.

import type { FastifyRequest, FastifyReply } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { createLogger } from "@flow/logger";

const log = createLogger("auth");
const TOKEN = process.env.FLOW_ADMIN_TOKEN ?? "dev-token";

if (!process.env.FLOW_ADMIN_TOKEN) {
  log.warn(
    "FLOW_ADMIN_TOKEN not set — using insecure default 'dev-token'; set this env var before exposing the service externally"
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

  const header = req.headers.authorization ?? "";
  const match = header.match(/^Bearer (.+)$/i);

  if (!match || !tokenMatches(match[1])) {
    reply.code(401).send({ error: "Unauthorized" });
    return;
  }

  done();
}
