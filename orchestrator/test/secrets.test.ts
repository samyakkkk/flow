import assert from "node:assert/strict";
import test from "node:test";
import { containsSecret, redactIfSecret } from "../src/secrets.js";

test("redacts tool text containing a supported credential", () => {
  const title = "curl -H 'Authorization: Bearer github_pat_abcdefghijklmnopqrstuvwxyz1234'";
  assert.equal(containsSecret(title), true);
  assert.equal(redactIfSecret(title), "[redacted: possible credential]");
});

test("keeps ordinary tool titles", () => {
  assert.equal(redactIfSecret("read src/auth.ts"), "read src/auth.ts");
});
