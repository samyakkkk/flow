import { test } from "node:test";
import assert from "node:assert/strict";
import { connectionUrl, discoverRemote, savedRemoteBinding } from "../../bin/lib/remote-setup.mjs";

test("remote setup requires HTTPS except for loopback and refuses URL credentials", () => {
  assert.equal(connectionUrl("https://flow.example/team/gateway/"), "https://flow.example/team/gateway");
  assert.equal(connectionUrl("http://127.0.0.1:7433"), "http://127.0.0.1:7433");
  for (const url of ["http://example.com", "file:///tmp/test", "https://user:secret@example.com", "https://example.com/?token=secret", "https://example.com/#fragment"]) {
    assert.throws(() => connectionUrl(url));
  }
});

test("remote setup rejects absent credentials before any network request", async () => {
  await assert.rejects(discoverRemote({ project: "test", gatewayUrl: "https://example.com", orchestratorUrl: "https://example.com" }), /token environment variable/);
});


test("saved remote lookup preserves only the requested project and repository binding", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "flow-reconnect-"));
  try {
    assert.equal(savedRemoteBinding(dir, "cloud", "/repo"), null);
    writeFileSync(join(dir, "config.json"), JSON.stringify({ projects: {
      cloud: { remote: "http", gatewayUrl: "https://example.com/gateway", orchestratorUrl: "https://example.com/orchestrator", token: "fixture-token" },
      local: { remote: "local" },
    } }));
    writeFileSync(join(dir, "integrations.json"), JSON.stringify({ repos: {
      "/repo": { project: "cloud", repo: "registered-name" },
      "/other": { project: "different", repo: "other-name" },
    } }));
    assert.equal(savedRemoteBinding(dir, "cloud", "/repo").repo, "registered-name");
    assert.equal(savedRemoteBinding(dir, "cloud", "/other").repo, undefined);
    assert.equal(savedRemoteBinding(dir, "missing", "/repo"), null);
    assert.equal(savedRemoteBinding(dir, "local", "/repo"), null);
    writeFileSync(join(dir, "config.json"), "malformed secret fixture");
    assert.throws(() => savedRemoteBinding(dir, "cloud", "/repo"), /Cannot read Flow config.json/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
