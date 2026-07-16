// Thread-title generation stays a separate indexer-CLI turn. These tests
// cover the pure prompt/output boundary without making a live model call.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.FLOW_ADMIN_TOKEN = "test-admin-token-thread-title";
process.env.FLOW_FAKE_OPENCODE = "1";
process.env.FLOW_DRAIN_DISABLE = "1";
process.env.FLOW_POLL_DISABLE = "1";

const { normalizeThreadTitle, threadTitlePrompt } = await import("../src/opencode.js");

describe("thread title", () => {
  test("normalizes the small agent's plain-text response", () => {
    assert.equal(normalizeThreadTitle('Title: "Fix login redirect."'), "Fix login redirect");
    assert.equal(normalizeThreadTitle("`Add billing audit`\nExtra explanation"), "Add billing audit");
  });

  test("rejects empty responses and bounds unexpectedly long titles", () => {
    assert.equal(normalizeThreadTitle("(no title)"), null);
    assert.equal(normalizeThreadTitle("   "), null);
    const bounded = normalizeThreadTitle("x".repeat(100));
    assert.ok(bounded);
    assert.equal(bounded.length, 78);
  });

  test("builds from the user's prompt without Flow's injected preamble", () => {
    const prompt = threadTitlePrompt("Repair the flaky checkout test");
    assert.match(prompt, /User request: "Repair the flaky checkout test"/);
    assert.doesNotMatch(prompt, /flow-graph|knowledge graph|branch notes/i);
  });
});
