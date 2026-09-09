import { expect, it } from "vite-plus/test";
import { curatorSessionKey } from "./curator.ts";
import { CuratorSessions } from "./curator-sessions.ts";

it("keeps the same source chat isolated across brain workers while preserving each warm context", async () => {
  const closed: string[] = [];
  const sessions = new CuratorSessions<string>(async (value) => {
    closed.push(value);
  });
  const source = { sessionId: "t3-same-source-chat", token: "test-token" };
  const brainA = curatorSessionKey({
    ...source,
    endpoint: "http://localhost:8001/v1/curator/mcp/chat",
  });
  const brainB = curatorSessionKey({
    ...source,
    endpoint: "http://localhost:8002/v1/curator/mcp/chat",
  });
  try {
    expect(await sessions.acquire(brainA, true, async () => "brain A context")).toBe(
      "brain A context",
    );
    // A final checkpoint in the old brain can overlap the first one after rebinding.
    expect(await sessions.acquire(brainB, true, async () => "brain B context")).toBe(
      "brain B context",
    );
    sessions.release(brainA);
    sessions.release(brainB);
    expect(await sessions.acquire(brainA, false, async () => "wrong replacement")).toBe(
      "brain A context",
    );
    expect(await sessions.acquire(brainB, false, async () => "wrong replacement")).toBe(
      "brain B context",
    );
    expect(closed).toEqual([]);
  } finally {
    await sessions.dispose();
  }
  expect(closed.toSorted()).toEqual(["brain A context", "brain B context"]);
});

it("requests renewed source context if a restarted worker reuses an endpoint with new credentials", async () => {
  const sessions = new CuratorSessions<string>(async () => {});
  const source = { sessionId: "t3-chat", endpoint: "http://localhost:8001/v1/curator/mcp/chat" };
  const oldKey = curatorSessionKey({ ...source, token: "old-test-token" });
  const newKey = curatorSessionKey({ ...source, token: "new-test-token" });
  try {
    await sessions.acquire(oldKey, true, async () => "old tool connection");
    sessions.release(oldKey);
    expect(
      await sessions.acquire(newKey, false, async () => "must not create from a delta"),
    ).toBeUndefined();
    expect(await sessions.acquire(newKey, true, async () => "new tool connection")).toBe(
      "new tool connection",
    );
    expect(newKey).not.toContain("new-test-token");
  } finally {
    await sessions.dispose();
  }
});
