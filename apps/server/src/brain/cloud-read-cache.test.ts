// @effect-diagnostics nodeBuiltinImport:off - Native cloud cache adapter owns its filesystem paths.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { CloudClient } from "./cloud-client.ts";
import type { BrainState } from "@t3tools/contracts";
import { CloudReadCache } from "../../../../flow-t3/shared/runtime/src/cloud-read-cache.ts";

type Doc = { id: string; revision: number; updatedAt: number; text: string };
type Snapshot = { entities: string[]; documents: Doc[] };
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    directories.splice(0).map((path) => NodeFSP.rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "flow-cloud-cache-"));
  directories.push(directory);
  let now = 0;
  let snapshot: Snapshot = {
    entities: ["service"],
    documents: [{ id: "skill", revision: 1, updatedAt: 1, text: "first" }],
  };
  const state = vi.fn(async () => snapshot);
  const document = vi.fn(
    async (id: string) => snapshot.documents.find((doc) => doc.id === id) ?? null,
  );
  const options = {
    file: NodePath.join(directory, "cache.json"),
    state,
    document,
    summaries: (value: Snapshot) => value.documents,
    decodeState: (value: unknown) => value as Snapshot,
    decodeDocument: (value: unknown) => value as Doc,
    now: () => now,
  };
  return {
    options,
    state,
    document,
    cache: new CloudReadCache(options),
    advance: () => {
      now += 10_000;
    },
    change: (next: Snapshot) => {
      snapshot = next;
    },
  };
}

describe("persistent cloud reads", () => {
  it("deduplicates cold reads, warms documents, and reuses unchanged revisions", async () => {
    const f = await fixture();
    await Promise.all([f.cache.state(), f.cache.state()]);
    await f.cache.drain();
    expect(f.state).toHaveBeenCalledTimes(1);
    expect((await f.cache.document("skill"))?.text).toBe("first");
    await f.cache.refresh();
    await f.cache.drain();
    expect(f.document).toHaveBeenCalledTimes(1);
    const persisted = JSON.parse(await NodeFSP.readFile(f.options.file, "utf8"));
    expect(persisted.documents[0].hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("serves a persisted graph and skill while a remote refresh is still pending", async () => {
    const f = await fixture();
    await f.cache.state();
    await f.cache.drain();
    let resolve!: (value: Snapshot) => void;
    f.state.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const reopened = new CloudReadCache(f.options);
    expect((await reopened.state()).entities).toEqual(["service"]);
    expect((await reopened.document("skill"))?.text).toBe("first");
    resolve({ entities: ["updated"], documents: [] });
    await reopened.drain();
    expect((await reopened.state()).entities).toEqual(["updated"]);
    expect(await reopened.document("deleted")).toBeNull();
    await reopened.drain();
  });

  it("refreshes changed revisions and evicts deleted documents", async () => {
    const f = await fixture();
    await f.cache.state();
    await f.cache.drain();
    f.change({
      entities: ["new"],
      documents: [{ id: "skill", revision: 2, updatedAt: 2, text: "second" }],
    });
    f.advance();
    expect((await f.cache.state()).entities).toEqual(["service"]);
    await f.cache.drain();
    expect((await f.cache.document("skill"))?.text).toBe("second");
    expect(f.document).toHaveBeenCalledTimes(2);
    f.change({ entities: [], documents: [] });
    await f.cache.refresh();
    await f.cache.drain();
    expect(await f.cache.document("skill")).toBeNull();
    await f.cache.drain();
  });

  it("keeps cached data on failure, reports the error, and recovers", async () => {
    const f = await fixture();
    await f.cache.state();
    await f.cache.drain();
    f.state.mockRejectedValueOnce(new Error("offline"));
    f.advance();
    expect((await f.cache.state()).entities).toEqual(["service"]);
    await f.cache.drain();
    expect(f.cache.error).toBe("offline");
    expect((await f.cache.document("skill"))?.text).toBe("first");
    await f.cache.refresh();
    await f.cache.drain();
    expect(f.cache.error).toBeUndefined();
  });

  it("invalidates after mutations without letting an older fetch repopulate documents", async () => {
    const f = await fixture();
    await f.cache.state();
    await f.cache.drain();
    let resolve!: (value: Doc) => void;
    f.document.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = f.cache.document("other");
    await Promise.resolve();
    f.cache.invalidate();
    resolve({ id: "other", revision: 1, updatedAt: 1, text: "old" });
    await pending;
    expect(await f.cache.document("other")).toBeNull();
    await f.cache.state();
    await f.cache.drain();
    expect(f.state).toHaveBeenCalledTimes(2);
  });

  it("rejects a modified document body whose saved hash no longer matches", async () => {
    const f = await fixture();
    await f.cache.state();
    await f.cache.drain();
    const saved = JSON.parse(await NodeFSP.readFile(f.options.file, "utf8"));
    saved.documents[0].value.text = "corrupt";
    await NodeFSP.writeFile(f.options.file, JSON.stringify(saved));
    const reopened = new CloudReadCache(f.options);
    expect((await reopened.document("skill"))?.text).toBe("first");
    expect(f.document).toHaveBeenCalledTimes(2);
    await reopened.drain();
  });

  it("limits prefetch concurrency and stops the remaining queue on shutdown", async () => {
    const f = await fixture();
    f.change({
      entities: [],
      documents: Array.from({ length: 10 }, (_, id) => ({
        id: String(id),
        revision: 1,
        updatedAt: 1,
        text: "body",
      })),
    });
    const resolvers: (() => void)[] = [];
    f.document.mockImplementation(
      (id) =>
        new Promise((resolve) =>
          resolvers.push(() => resolve({ id, revision: 1, updatedAt: 1, text: "body" })),
        ),
    );
    await f.cache.state();
    expect(f.document).toHaveBeenCalledTimes(3);
    const closing = f.cache.close();
    for (const resolve of resolvers) resolve();
    await closing;
    expect(f.document).toHaveBeenCalledTimes(3);
    await expect(f.cache.document("9")).rejects.toThrow("closed");
  });

  it("recovers from corrupt disk data", async () => {
    const f = await fixture();
    await NodeFSP.writeFile(f.options.file, "broken");
    const reopened = new CloudReadCache(f.options);
    expect((await reopened.state()).entities).toEqual(["service"]);
    await reopened.drain();
  });
});

describe("cloud cache adapter", () => {
  async function setup() {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "flow-cloud-adapter-"));
    directories.push(directory);
    const snapshot: BrainState = {
      database: { status: "ready", message: "ready" },
      embeddings: { status: "ready", message: "ready" },
      github: { connected: false, login: "", message: "" },
      clis: [],
      workspaces: [
        {
          id: "brain",
          name: "Remote",
          cli: "codex",
          sources: [],
          knowledge: { entities: [], edges: [], memories: [] },
        },
      ],
    };
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ result: snapshot })));
    vi.stubGlobal("fetch", fetcher);
    const client = new CloudClient(
      "https://brain.example",
      "fixture-one",
      "instance",
      "brain",
      directory,
    );
    return { directory, snapshot, fetcher, client };
  }

  it("removes the replica and denies cached reads when authentication is revoked", async () => {
    const f = await setup();
    await f.client.state();
    await f.client.cache?.drain();
    f.fetcher.mockImplementation(async () => new Response("Unauthorized", { status: 401 }));
    await expect(f.client.state(true)).rejects.toThrow("Sign in again");
    await expect(f.client.state()).rejects.toThrow("Sign in again");
    await expect(f.client.cache?.document("secret")).rejects.toThrow("closed");
    const reopened = new CloudClient(
      "https://brain.example",
      "fixture-one",
      "instance",
      "brain",
      f.directory,
    );
    await expect(reopened.state()).rejects.toThrow("Sign in again");
  });

  it("caches full state but keeps metadata checks live and invalidates commands", async () => {
    const f = await setup();
    await f.client.state();
    await f.client.cache?.drain();
    await f.client.state();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    await f.client.state(true);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    await f.client.command({ action: "refreshGithub" });
    await f.client.state();
    await f.client.cache?.drain();
    expect(f.fetcher).toHaveBeenCalledTimes(4);
  });

  it("isolates persisted replicas by credentials, endpoint, instance, and brain", async () => {
    const f = await setup();
    await f.client.state();
    await f.client.cache?.drain();
    f.fetcher.mockRejectedValue(new Error("offline"));
    for (const [endpoint, token, instance, brain] of [
      ["https://brain.example", "fixture-two", "instance", "brain"],
      ["https://other.example", "fixture-one", "instance", "brain"],
      ["https://brain.example", "fixture-one", "other", "brain"],
      ["https://brain.example", "fixture-one", "instance", "other"],
    ] as const) {
      const client = new CloudClient(endpoint, token, instance, brain, f.directory);
      await expect(client.state()).rejects.toThrow("offline");
      await client.cache?.drain();
    }
    const reopened = new CloudClient(
      "https://brain.example",
      "fixture-one",
      "instance",
      "brain",
      f.directory,
    );
    expect((await reopened.state()).workspaces[0]?.name).toBe("Remote");
    await reopened.cache?.drain();
    expect(reopened.cache?.error).toBe("offline");
  });

  it("does not replace a healthy replica with an unavailable or missing remote brain", async () => {
    const f = await setup();
    await f.client.state();
    await f.client.cache?.drain();
    f.fetcher.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          result: { ...f.snapshot, database: { status: "error", message: "database offline" } },
        }),
      ),
    );
    await expect(f.client.cache?.refresh()).rejects.toThrow("database offline");
    expect((await f.client.state()).database.status).toBe("ready");
    f.fetcher.mockResolvedValueOnce(
      new Response(JSON.stringify({ result: { ...f.snapshot, workspaces: [] } })),
    );
    await expect(f.client.cache?.refresh()).rejects.toThrow("no longer exists");
    expect((await f.client.state()).workspaces).toHaveLength(1);
    await f.client.cache?.drain();
  });
});
