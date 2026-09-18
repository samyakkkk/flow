import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { BrainRuntime } from "./BrainRuntime.ts";
import { nativeFalkorSupported } from "./native.ts";

const directories: string[] = [];
const scratch = async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "flow-hosting-"));
  directories.push(directory);
  return directory;
};
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => NodeFSP.rm(d, { recursive: true, force: true })),
  );
});

test("only hosts with a native graph database can host a Brain", () => {
  expect(nativeFalkorSupported("darwin", "arm64")).toBe(true);
  expect(nativeFalkorSupported("linux", "x64")).toBe(true);
  expect(nativeFalkorSupported("win32", "x64")).toBe(false);
  expect(nativeFalkorSupported("darwin", "x64")).toBe(false);
});

test("a Windows computer reports that it connects to a Cloud Brain, without an error", async () => {
  const runtime = new BrainRuntime(await scratch(), { platform: "win32", architecture: "x64" });
  await runtime.start();
  const state = await runtime.state();
  expect(state.localBrains).toBe(false);
  // Never having had a database to start is not a failure to show the user.
  expect(state.database.status).toBe("stopped");
  expect(state.database.message).toMatch(/Cloud Brain/);
});

test("a Windows computer refuses to create a local Brain, whoever asks", async () => {
  const runtime = new BrainRuntime(await scratch(), { platform: "win32", architecture: "x64" });
  await expect(
    runtime.command({ action: "create", name: "My Brain", cli: "claude" }),
  ).rejects.toThrow(/cannot host a Brain/);
  expect((await runtime.state()).workspaces).toEqual([]);
});

test("a supported host still says it can host a Brain", async () => {
  const runtime = new BrainRuntime(await scratch(), { platform: "linux", architecture: "x64" });
  expect((await runtime.state()).localBrains).toBe(true);
});

test("the server still starts on a computer that cannot host a Brain", async () => {
  // Flow on Windows exited at launch: startup ran the same availability check
  // a Brain host gets, and having no database failed it.
  const windows = new BrainRuntime(await scratch(), { platform: "win32", architecture: "x64" });
  await windows.initialize();
  expect(() => windows.assertAvailable()).not.toThrow();
  await windows.close();
  expect(() => windows.assertAvailable()).toThrow();
});
