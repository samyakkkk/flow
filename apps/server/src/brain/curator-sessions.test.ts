import { afterEach, expect, it, vi } from "vite-plus/test";
import { CuratorSessions } from "./curator-sessions.ts";

afterEach(() => vi.useRealTimers());

it("reuses warm segments, closes idle ones, and requests full context instead of accepting a delta", async () => {
  vi.useFakeTimers();
  const closed: number[] = [];
  const sessions = new CuratorSessions<number>(async (value) => {
    closed.push(value);
  }, 1000);
  let created = 0;
  const create = async () => ++created;
  expect(await sessions.acquire("chat", true, create)).toBe(1);
  await expect(sessions.acquire("chat", false, create)).rejects.toThrow("in progress");
  sessions.release("chat");
  await vi.advanceTimersByTimeAsync(500);
  expect(await sessions.acquire("chat", false, create)).toBe(1);
  await vi.advanceTimersByTimeAsync(1500);
  expect(closed).toEqual([]); // An in-flight turn never expires.
  sessions.release("chat");
  await vi.advanceTimersByTimeAsync(1000);
  expect(closed).toEqual([1]);
  expect(await sessions.acquire("chat", false, create)).toBeUndefined();
  expect(created).toBe(1);
  expect(await sessions.acquire("chat", true, create)).toBe(2);
  await sessions.dispose();
  expect(closed).toEqual([1, 2]);
});

it("bounds idle processes and closes pending creations during shutdown", async () => {
  const closed: string[] = [];
  const sessions = new CuratorSessions<string>(
    async (value) => {
      closed.push(value);
    },
    1000,
    1,
  );
  await sessions.acquire("a", true, async () => "a");
  sessions.release("a");
  await sessions.acquire("b", true, async () => "b");
  sessions.release("b");
  expect(closed).toEqual(["a"]);
  let finish!: (value: string) => void;
  const pending = sessions.acquire(
    "c",
    true,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await sessions.dispose();
  finish("c");
  await expect(pending).rejects.toThrow("shutting down");
  expect(closed).toEqual(["a", "b", "c"]);
});
