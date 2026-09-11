import { test } from "node:test";
import assert from "node:assert/strict";
import { LiveMemoryScheduler } from "../src/memory/live-scheduler.js";

test("first completion debounces, long responses require meaningful content, and work coalesces", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  let release!: (value: boolean) => void;
  const scheduler = new LiveMemoryScheduler(async () => { calls++; return new Promise<boolean>(r => { release = r; }); });
  scheduler.capture("chat", 20, true);
  assert.equal(scheduler.pending("chat"), true);
  t.mock.timers.tick(1999); assert.equal(calls, 0);
  t.mock.timers.tick(1); assert.equal(calls, 1);
  scheduler.capture("chat", 1000, true);
  scheduler.capture("chat", 1000, true);
  t.mock.timers.tick(30_000); assert.equal(calls, 1);
  release(true); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(2000); assert.equal(calls, 2);
  release(true); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  scheduler.capture("long", 399, false);
  t.mock.timers.tick(30_000); assert.equal(calls, 2);
  scheduler.capture("long", 1, false);
  t.mock.timers.tick(29_999); assert.equal(calls, 2);
  t.mock.timers.tick(1); assert.equal(calls, 3);
  scheduler.close(); release(true);
});

test("failed extraction does not immediately retry in a hot loop", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const scheduler = new LiveMemoryScheduler(async () => { calls++; return false; });
  scheduler.capture("chat", 800, true);
  t.mock.timers.tick(2000);
  await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(60_000);
  assert.equal(calls, 1); assert.equal(scheduler.pending("chat"), false);
  scheduler.close();
});
