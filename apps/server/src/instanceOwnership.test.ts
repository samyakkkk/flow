// @effect-diagnostics nodeBuiltinImport:off - Exercise OS ownership across real processes.
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
const { mkdtemp, rm, symlink, writeFile } = NodeFSP;
import * as NodeOS from "node:os";
const { tmpdir } = NodeOS;
import * as NodePath from "node:path";
const { join } = NodePath;
import * as NodeChildProcess from "node:child_process";
const { spawn } = NodeChildProcess;
const once = (emitter: NodeJS.EventEmitter, event: string) =>
  new Promise<void>((resolve) => {
    emitter.once(event, () => resolve());
  });
import { acquireInstanceOwnership } from "./instanceOwnership.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const release of cleanup.splice(0).toReversed()) await release();
});
async function home() {
  const dir = await mkdtemp(join(tmpdir(), "flow-instance-test-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function own(dir: string) {
  const release = await acquireInstanceOwnership(dir);
  cleanup.push(release);
  return release;
}
describe("instance ownership", () => {
  it("allows separate units but rejects another owner of the same unit", async () => {
    const daily = await home();
    const test = await home();
    const release = await own(daily);
    await own(test);
    await expect(acquireInstanceOwnership(daily)).rejects.toThrow("already in use");
    release();
    await own(daily);
  });
  it("treats a symlink to the same home as the same unit", async () => {
    const dir = await home();
    const aliases = await home();
    await symlink(dir, join(aliases, "alias"), "dir");
    await own(dir);
    await expect(acquireInstanceOwnership(join(aliases, "alias"))).rejects.toThrow(
      "already in use",
    );
  });
  it("recovers ownership after a crashed process without removing data", async () => {
    const dir = await home();
    await writeFile(join(dir, "keep.txt"), "preserved");
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import * as NodeSqlite from "node:sqlite";
const { DatabaseSync } = NodeSqlite;
      const db = new DatabaseSync(process.argv[1]);
      db.exec('BEGIN EXCLUSIVE');
      process.stdout.write('ready');
      process.stdin.resume();
    `,
        join(dir, "instance-lock.sqlite"),
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    cleanup.push(() => {
      if (child.exitCode === null) child.kill();
    });
    await once(child.stdout!, "data");
    await expect(acquireInstanceOwnership(dir)).rejects.toThrow("already in use");
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    await own(dir);
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(join(dir, "keep.txt"), "utf8")).toBe("preserved");
  });
  it("does not take over a live older server that lacks the new lock", async () => {
    const dir = await home();
    const child = spawn(
      process.execPath,
      ["-e", "process.stdout.write('ready'); process.stdin.resume()"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    cleanup.push(() => {
      child.kill();
    });
    await once(child.stdout!, "data");
    await writeFile(
      join(dir, "server-runtime.json"),
      JSON.stringify({
        version: 1,
        pid: child.pid,
        port: 12345,
        origin: "http://localhost:12345",
        startedAt: "2026-09-08T00:00:00.000Z",
      }),
    );
    await expect(acquireInstanceOwnership(dir)).rejects.toThrow("http://localhost:12345");
    const exited = once(child, "exit");
    child.kill();
    await exited;
    await own(dir);
  });
});
