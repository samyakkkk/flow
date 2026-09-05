import { test } from "node:test";
import assert from "node:assert/strict";
import { connectionUrl, discoverRemote } from "../../bin/lib/remote-setup.mjs";

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
