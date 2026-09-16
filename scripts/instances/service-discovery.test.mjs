import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { discoverCloudService } from "./service-discovery.mjs";

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "flow-discovery-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, "instance-home/instances/primary");
  await mkdir(join(directory, "data"), { recursive: true });
  const config = {
    version: 1,
    id: "environment",
    name: "primary",
    mode: "isolated",
    dev: false,
    home: join(directory, "data"),
    code: join(home, "releases/old-running-version"),
  };
  const save = (file, data) => writeFile(join(directory, file), JSON.stringify(data));
  await save("config.json", config);
  return { home, directory, config, save };
}
async function live(t, f, handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await f.save("runtime.json", {
    id: "environment",
    generation: "generation",
    token: "private-control-token",
    controlUrl: `http://127.0.0.1:${server.address().port}`,
  });
}
test("absent installation is reported without creating it", async () => {
  const home = join(tmpdir(), `flow-missing-${crypto.randomUUID()}`);
  assert.equal((await discoverCloudService(home)).status, "not-configured");
  await assert.rejects(stat(home), { code: "ENOENT" });
});
test("stopped service retains identity and pinned code without starting it", async (t) => {
  const f = await fixture(t);
  const result = await discoverCloudService(f.home);
  assert.equal(result.status, "stopped");
  assert.equal(result.environmentId, f.config.id);
  assert.equal(result.runningCode, f.config.code);
});
test("corrupt, foreign and unsupported metadata cannot look like a fresh install", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.directory, "config.json"), "{");
  assert.equal((await discoverCloudService(f.home)).status, "invalid");
  await f.save("config.json", { ...f.config, home: f.home });
  assert.equal((await discoverCloudService(f.home)).status, "invalid");
  await f.save("config.json", { ...f.config, version: 2 });
  assert.equal((await discoverCloudService(f.home)).status, "incompatible");
});
test("authenticates live identity without exposing credentials or trusting response fields", async (t) => {
  const f = await fixture(t);
  await live(t, f, (req, res) => {
    assert.equal(req.headers.authorization, "Bearer private-control-token");
    res.end(
      JSON.stringify({
        id: "environment",
        generation: "generation",
        phase: "ready",
        token: "leak",
        arbitrary: true,
      }),
    );
  });
  const result = await discoverCloudService(f.home);
  assert.equal(result.status, "ready");
  assert.equal(result.environmentId, "environment");
  assert.equal(result.token, undefined);
  assert.equal(result.arbitrary, undefined);
  assert.equal(JSON.stringify(result).includes("private-control-token"), false);
});
test("rejects a reused port with a different service identity", async (t) => {
  const f = await fixture(t);
  await live(t, f, (_req, res) =>
    res.end(JSON.stringify({ id: "other", generation: "generation", phase: "ready" })),
  );
  assert.equal((await discoverCloudService(f.home)).status, "invalid");
});
test("does not follow redirects or treat authentication failure as stopped", async (t) => {
  const f = await fixture(t);
  let status = 302;
  await live(t, f, (_req, res) => {
    res.writeHead(status, { location: "http://127.0.0.1:1/" });
    res.end();
  });
  assert.equal((await discoverCloudService(f.home)).status, "unreachable");
  status = 401;
  assert.equal((await discoverCloudService(f.home)).status, "unreachable");
});
