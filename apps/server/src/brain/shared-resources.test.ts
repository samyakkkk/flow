import { expect, it } from "vite-plus/test";
import { brainResourceEnvironment } from "@flow/brain-runtime";
import { startSessionWorker } from "./session-worker.ts";

it("refuses to launch a worker without the shared host resources", async () => {
  await expect(startSessionWorker({ GRAPH_NAME: "brain_a" })).rejects.toThrow("shared database");
});
it("keeps graph isolation while borrowing the same host resources", () => {
  const host = {
    databaseSocket: "/tmp/host.sock",
    embeddingUrl: "http://127.0.0.1:1234/embed",
    embeddingToken: "test",
  };
  const first = brainResourceEnvironment({ ...host, graphName: "brain_a" });
  const second = brainResourceEnvironment({ ...host, graphName: "brain_b" });
  expect(first.GRAPH_NAME).not.toBe(second.GRAPH_NAME);
  expect(first.FALKOR_SOCKET).toBe(second.FALKOR_SOCKET);
  expect(first.FLOW_EMBED_URL).toBe(second.FLOW_EMBED_URL);
});
