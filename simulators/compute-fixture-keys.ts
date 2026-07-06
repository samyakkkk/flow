// compute-fixture-keys.ts — Helper to compute fixture keys for scenario events.
// Run this to see the key for any event payload.
// Usage: tsx compute-fixture-keys.ts

import { createHash } from "node:crypto";

export function fixtureKey(source: string, type: string, payload: Record<string, unknown>): string {
  const text = JSON.stringify({ source, type, payload });
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// If run directly, compute keys for all scenario events
if (import.meta.url === `file://${process.argv[1]}`) {
  const events = [
    // Scenario 1: knowledge_claim
    { source: "slack", type: "ambient", payload: { text: "We use Redis for all session caching in production.", channel: "#engineering", user_id: "U001", ts: "1700000001000" } },
    // Scenario 2: correction (higher confidence)
    { source: "slack", type: "ambient", payload: { text: "Actually, we switched from Redis to Memcached last quarter for session caching.", channel: "#engineering", user_id: "U002", ts: "1700000002000" } },
    // Scenario 3: task_discussion
    { source: "slack", type: "ambient", payload: { text: "We need to build a new auth service with OAuth2 support next sprint.", channel: "#product", user_id: "U003", ts: "1700000003000" } },
    // Scenario 4: question_about_system in silent channel
    { source: "slack", type: "ambient", payload: { text: "How does the deployment pipeline work for the mobile app?", channel: "#silent-channel", user_id: "U004", ts: "1700000004000" } },
    // Scenario 5: sensitive
    { source: "slack", type: "ambient", payload: { text: "My API key is sk-1234567890abcdef and the DB password is supersecret!", channel: "#dev", user_id: "U005", ts: "1700000005000" } },
    // Scenario 6: @mention question
    { source: "slack", type: "mention", payload: { text: "How is authentication handled in the system?", channel: "#engineering", user_id: "U006", ts: "1700000006000" } },
    // Scenario 7: ticket_status_signal
    { source: "slack", type: "ambient", payload: { text: "AUTH-123 is now deployed to staging, waiting for QA sign-off.", channel: "#releases", user_id: "U007", ts: "1700000007000" } },
    // Scenario 8: policy toggled off (knowledge_claim but policy set to off)
    { source: "slack", type: "ambient", payload: { text: "Our microservices communicate via gRPC for internal calls.", channel: "#engineering", user_id: "U008", ts: "1700000008000" } },
  ];

  for (const ev of events) {
    console.log(`${ev.payload.text?.toString().slice(0, 50).padEnd(50)} → ${fixtureKey(ev.source, ev.type, ev.payload)}`);
  }
}
