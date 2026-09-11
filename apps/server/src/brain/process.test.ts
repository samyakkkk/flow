// @effect-diagnostics nodeBuiltinImport:off - Isolated child-process lifecycle test.
import { afterEach, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import { runStreaming } from "./process.ts";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await NodeFSP.rm(root, { recursive: true, force: true });
});
it.effect("streams activity before completion and cancels the CLI's MCP process group", () =>
  Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    if (platform === "win32") return;
    yield* Effect.promise(async () => {
      const root = await NodeFSP.mkdtemp("/tmp/flow-stream-test-");
      roots.push(root);
      const ready = Promise.withResolvers<number>();
      const abort = new AbortController();
      const running = runStreaming(
        process.execPath,
        [
          "-e",
          "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'}); console.log(child.pid); setInterval(()=>{},1000);",
        ],
        {
          cwd: root,
          platform,
          env: {},
          signal: abort.signal,
          timeout: 5000,
          transcript: `${root}/transcript.jsonl`,
          onLine: (line) => ready.resolve(Number(line)),
        },
      );
      const pid = await ready.promise;
      expect(pid).toBeGreaterThan(0);
      abort.abort();
      await expect(running).rejects.toThrow("cancelled");
      expect(() => process.kill(pid, 0)).toThrow();
      expect(await NodeFSP.readFile(`${root}/transcript.jsonl`, "utf8")).toContain(String(pid));
    });
  }),
);
