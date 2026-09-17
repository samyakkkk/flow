import { test } from "node:test";
import assert from "node:assert/strict";
import { selectCloudRelease, latestCloudRelease } from "./flow-cloud-cli.mjs";
const release = (tag) => ({
  tag_name: tag,
  assets: ["flow-browser-darwin-arm64.tar.gz", "flow-browser-darwin-arm64.tar.gz.sha256"].map(
    (name) => ({
      name,
      browser_download_url: `https://github.com/samyakkkk/flow/releases/download/${tag}/${name}`,
    }),
  ),
});
test("Cloud CLI update selection never consumes desktop or browser releases", () => {
  const selected = selectCloudRelease(
    [
      release("flow-v999.0.0"),
      release("flow-desktop-v999.0.0"),
      release("flow-cloud-cli-v0.1.0"),
      release("flow-cloud-cli-v0.2.0"),
      { ...release("flow-cloud-cli-v0.3.0"), prerelease: true },
    ],
    "darwin-arm64",
  );
  assert.equal(selected.tag, "flow-v0.2.0");
  assert.match(selected.archiveUrl, /flow-cloud-cli-v0.2.0/);
});
test("rejects missing or substituted platform assets", () => {
  assert.throws(
    () => selectCloudRelease([release("flow-cloud-cli-v0.1.0")], "linux-x64"),
    /missing/,
  );
  const r = release("flow-cloud-cli-v0.1.0");
  r.assets[0].browser_download_url = "https://example.com/bundle";
  assert.throws(() => selectCloudRelease([r], "darwin-arm64"), /missing/);
});
test("update feed failures fail explicitly and have a bounded request", async () => {
  await assert.rejects(
    latestCloudRelease(async (url, options) => {
      assert.ok(options.signal);
      return new Response("", { status: 503 });
    }),
    /503/,
  );
});

test("unified entry opens browser and accepts local and Cloud setup", async () => {
  const { dispatch } = await import("./flow-cloud-cli.mjs");
  const calls = [];
  const run = async (args) => calls.push(args);
  await dispatch([], run);
  await dispatch(["--web"], run);
  await dispatch(["setup", "--local", "--brain", "local-id", "--folder", "/project"], run);
  await dispatch(["setup", "--cloud", "https://brain.example", "--cloud-brain", "remote-id"], run);
  await dispatch(["setup"], run);
  assert.deepEqual(calls.slice(0, 2), [[], []]);
  // Binding a folder reuses the machine's installed tools; a bare setup installs them.
  assert.deepEqual(calls[2], [
    "setup",
    "--local",
    "true",
    "--brain",
    "local-id",
    "--folder",
    "/project",
  ]);
  assert.ok(calls[3].includes("--cloud"));
  assert.deepEqual(calls[4], ["setup", "--harness", "detected"]);
  await assert.rejects(
    dispatch(["setup", "--local", "--cloud", "https://brain.example"], run),
    /Choose/,
  );
});

test("lifecycle and diagnostic commands never open the UI", async () => {
  const { dispatch } = await import("./flow-cloud-cli.mjs");
  const calls = [];
  for (const args of [
    ["status"],
    ["stop"],
    ["restart"],
    ["doctor", "--folder", "/project"],
    ["brains", "list"],
  ])
    await dispatch(args, async (args) => calls.push(args));
  assert.deepEqual(calls, [
    ["status", "--no-open"],
    ["stop", "--no-open"],
    ["restart", "--no-open"],
    ["agents", "doctor", "--folder", "/project"],
    ["brains", "list"],
  ]);
});
