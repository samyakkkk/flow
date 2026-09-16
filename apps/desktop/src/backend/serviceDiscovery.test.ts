// @effect-diagnostics nodeBuiltinImport:off - mirrors the fixture layout of scripts/instances/service-discovery.test.mjs against the real filesystem.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, assert, describe, expect, it } from "@effect/vitest";

import { defaultRegistryRoot, discoverService } from "./serviceDiscovery.ts";

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

// Same shape scripts/instances/service-discovery.test.mjs builds, so the port
// and the canonical module are exercised against identical on-disk input.
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "flow-desktop-discovery-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const registryRoot = join(home, "instance-home");
  const directory = join(registryRoot, "instances/primary");
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
  const save = (file: string, data: unknown) =>
    writeFile(join(directory, file), JSON.stringify(data));
  await save("config.json", config);
  return { home, registryRoot, directory, config, save };
}

async function live(
  f: Awaited<ReturnType<typeof fixture>>,
  handler: (request: IncomingMessage, response: ServerResponse) => void,
) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve(undefined))));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await f.save("runtime.json", {
    id: "environment",
    generation: "generation",
    token: "private-control-token",
    controlUrl: `http://127.0.0.1:${String(port)}`,
  });
}

describe("desktop service discovery", () => {
  it("reports an absent installation without creating it", async () => {
    const root = join(tmpdir(), `flow-desktop-missing-${String(process.pid)}`);
    const result = await discoverService({ registryRoot: root });
    expect(result.status).toBe("not-configured");
  });

  it("keeps identity for a stopped service and never starts it", async () => {
    const f = await fixture();
    const result = await discoverService({ registryRoot: f.registryRoot });
    assert.equal(result.status, "stopped");
    assert.equal(result.environmentId, f.config.id);
    assert.equal(result.runningCode, f.config.code);
    assert.equal(result.serverOrigin, undefined);
  });

  it("disqualifies corrupt, homeless and unsupported metadata", async () => {
    const f = await fixture();
    await writeFile(join(f.directory, "config.json"), "{");
    assert.equal((await discoverService({ registryRoot: f.registryRoot })).status, "invalid");
    await f.save("config.json", { ...f.config, home: join(f.home, "moved-away") });
    assert.equal((await discoverService({ registryRoot: f.registryRoot })).status, "invalid");
    await f.save("config.json", { ...f.config, version: 2 });
    assert.equal((await discoverService({ registryRoot: f.registryRoot })).status, "incompatible");
  });

  it("forwards the server origin of a ready service but never its control token", async () => {
    const f = await fixture();
    const seenAuthorization: string[] = [];
    await live(f, (request, response) => {
      seenAuthorization.push(request.headers.authorization ?? "");
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          id: "environment",
          generation: "generation",
          phase: "ready",
          origin: "http://127.0.0.1:41773",
          url: "http://localhost:41773",
        }),
      );
    });

    const result = await discoverService({ registryRoot: f.registryRoot });

    assert.equal(result.status, "ready");
    assert.equal(result.serverOrigin, "http://127.0.0.1:41773");
    assert.equal(result.dataHome, f.config.home);
    assert.deepEqual(seenAuthorization, ["Bearer private-control-token"]);
    assert.isUndefined((result as unknown as Record<string, unknown>).token);
  });

  it("reports a live service whose identity drifted as invalid", async () => {
    const f = await fixture();
    await live(f, (_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ id: "environment", generation: "other", phase: "ready" }));
    });

    assert.equal((await discoverService({ registryRoot: f.registryRoot })).status, "invalid");
  });

  it("reports a registered but silent service as unreachable", async () => {
    const f = await fixture();
    // Port 1 is in the reserved range with nothing listening: connect fails
    // fast rather than hanging on the discovery timeout.
    await f.save("runtime.json", {
      id: "environment",
      generation: "generation",
      token: "private-control-token",
      controlUrl: "http://127.0.0.1:1",
    });

    const result = await discoverService({ registryRoot: f.registryRoot, timeoutMs: 500 });

    assert.equal(result.status, "unreachable");
    assert.equal(result.environmentId, "environment");
  });

  it("follows FLOW_INSTANCE_HOME, else the launcher's default registry", () => {
    assert.equal(
      defaultRegistryRoot({ FLOW_INSTANCE_HOME: "/srv/flow-app" }, "/home/dev"),
      "/srv/flow-app",
    );
    assert.equal(defaultRegistryRoot({}, "/home/dev"), "/home/dev/.local/share/flow-app");
  });
});
