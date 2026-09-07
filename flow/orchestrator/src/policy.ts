// policy.ts — Toggle matrix: "<source>.<classification>" → auto|propose|off.
// Stored in config table under key "policies". Dashboard can PATCH to change.
// Sensitive drop is hardcoded (non-configurable).

import type { FastifyInstance } from "fastify";
import db from "./db.js";

export type PolicyDecision = "auto" | "propose" | "off";

// Sensible defaults per system.md spec
const DEFAULTS: Record<string, PolicyDecision> = {
  "slack_ambient.noise": "off",
  "slack_ambient.knowledge_claim": "auto",
  "slack_ambient.correction": "auto",
  "slack_ambient.task_discussion": "propose",
  "slack_ambient.ticket_status_signal": "propose",
  "slack_ambient.question_about_system": "auto",
  "slack_ambient.sensitive": "off",   // also hardcoded drop — see policyFor()

  "slack_mention.question": "auto",
  "slack_mention.command": "auto",
  "slack_mention.feedback": "auto",

  "github_merge.skip": "off",
  "github_merge.index_worthy": "auto",

  "linear_ticket.needs_context": "auto",
  "linear_ticket.duplicate_candidate": "propose",
  "linear_ticket.unresolvable": "propose",
  "linear_ticket.not_applicable": "off",

  "meeting_segment.decision": "auto",
  "meeting_segment.action_item": "propose",
  "meeting_segment.knowledge_claim": "auto",
  "meeting_segment.open_question": "auto",
  "meeting_segment.noise": "off",
};

function loadPolicies(): Record<string, PolicyDecision> {
  const row = db.prepare("SELECT value FROM config WHERE key = 'policies'").get() as
    | { value: string }
    | undefined;
  if (!row) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...(JSON.parse(row.value) as Record<string, PolicyDecision>) };
  } catch {
    return { ...DEFAULTS };
  }
}

function savePolicies(overrides: Record<string, PolicyDecision>): void {
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('policies', ?)")
    .run(JSON.stringify(overrides));
}

export function policyFor(source: string, classification: string): PolicyDecision {
  // Sensitive is always dropped — hardcoded, never configurable
  if (classification === "sensitive") return "off";

  const key = `${source}.${classification}`;
  const policies = loadPolicies();
  return policies[key] ?? "auto";
}

export function registerPolicyRoutes(app: FastifyInstance): void {
  // GET /v1/config/policies — full matrix with effective values
  app.get("/v1/config/policies", async (_req, reply) => {
    const overrides = (() => {
      const row = db.prepare("SELECT value FROM config WHERE key = 'policies'").get() as
        | { value: string }
        | undefined;
      if (!row) return {};
      try { return JSON.parse(row.value) as Record<string, PolicyDecision>; } catch { return {}; }
    })();

    return reply.send({
      effective: loadPolicies(),
      overrides,
      defaults: DEFAULTS,
    });
  });

  // PATCH /v1/config/policies — merge overrides into stored config
  app.patch<{ Body: Record<string, PolicyDecision> }>(
    "/v1/config/policies",
    async (req, reply) => {
      const body = req.body as Record<string, string>;

      // Validate values
      const valid = new Set(["auto", "propose", "off"]);
      for (const [k, v] of Object.entries(body)) {
        if (!valid.has(v)) {
          return reply.code(400).send({ error: `Invalid policy value "${v}" for key "${k}"` });
        }
      }

      // Load current overrides, merge, save
      const row = db.prepare("SELECT value FROM config WHERE key = 'policies'").get() as
        | { value: string }
        | undefined;
      const current: Record<string, PolicyDecision> = row
        ? (JSON.parse(row.value) as Record<string, PolicyDecision>)
        : {};

      const next = { ...current, ...(body as Record<string, PolicyDecision>) };
      savePolicies(next);

      return reply.send({ effective: loadPolicies(), overrides: next });
    }
  );
}
