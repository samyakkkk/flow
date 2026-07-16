import assert from "node:assert/strict";
import test from "node:test";
import { createLogger } from "@flow/logger";

function capture(level: string, emit: (log: ReturnType<typeof createLogger>) => void): string[] {
  const previousLevel = process.env.LOG_LEVEL;
  const previousWrite = process.stdout.write;
  const lines: string[] = [];
  process.env.LOG_LEVEL = level;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    emit(createLogger("test"));
  } finally {
    process.stdout.write = previousWrite;
    if (previousLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previousLevel;
  }
  return lines;
}

test("silent suppresses all shared logs", () => {
  const lines = capture("silent", (log) => {
    log.trace("trace");
    log.debug("debug");
    log.info("info");
    log.warn("warn");
    log.error("error");
    log.fatal("fatal");
  });
  assert.deepEqual(lines, []);
});

test("trace and fatal follow Pino level ordering", () => {
  assert.equal(capture("trace", (log) => log.trace("visible")).length, 1);
  assert.equal(capture("fatal", (log) => log.error("hidden")).length, 0);
  assert.equal(capture("fatal", (log) => log.fatal("visible")).length, 1);
});
