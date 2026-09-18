import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  collect,
  orderForUpload,
  publishReleaseAssets,
  sha256,
} from "./publish-release-assets.mjs";

const { test } = NodeTest;
const assert = NodeAssert;
const { join } = NodePath;

/** A GitHub that records what it was asked to do and can be told to fail. */
function fakeGitHub({ release = null, failUploads = {} } = {}) {
  const calls = [];
  const state = release && { ...release, assets: new Map(release.assets) };
  const gh = async (args) => {
    calls.push(args.join(" "));
    const [noun, verb, tag] = args;
    if (noun === "api") {
      if (!gh.release) throw Error("release not found");
      return JSON.stringify({
        draft: gh.release.isDraft,
        assets: [...gh.release.assets].map(([name, digest]) => ({
          name,
          ...(digest === null ? {} : { digest: `sha256:${digest}` }),
        })),
      });
    }
    if (noun !== "release") throw Error(`unexpected ${noun}`);
    if (verb === "create") {
      gh.release = { isDraft: !args.includes("--prerelease"), assets: new Map() };
      return "";
    }
    if (verb === "upload") {
      const name = NodePath.basename(args[3]);
      if (failUploads[name] > 0) {
        failUploads[name] -= 1;
        throw Error("HTTP 500: Error saving asset");
      }
      gh.release.assets.set(name, digests.get(name));
      return "";
    }
    if (verb === "delete-asset") {
      gh.release.assets.delete(args[3]);
      return "";
    }
    if (verb === "edit") {
      gh.release.isDraft = false;
      return "";
    }
    throw Error(`unexpected ${verb} ${tag}`);
  };
  gh.release = state;
  gh.calls = calls;
  return gh;
}

const sizes = new Map([
  ["Flow-arm64.dmg", 100],
  ["Flow-x64.dmg", 200],
  ["latest-mac.yml", 1],
]);
const digests = new Map([...sizes.keys()].map((name) => [name, `digest-of-${name}`]));
const files = [...sizes].map(([name, size]) => ({
  path: `/build/${name}`,
  size,
  digest: digests.get(name),
}));

test("a versioned release stays a draft until it holds exactly what was built", async () => {
  const gh = fakeGitHub();
  await publishReleaseAssets({
    tag: "flow-desktop-v1.0.0",
    files,
    gh,
    log: () => {},
    sleep: async () => {},
  });
  assert.equal(gh.release.isDraft, false);
  assert.deepEqual([...gh.release.assets.keys()].sort(), [...sizes.keys()].sort());
  assert.ok(gh.calls.some((call) => call.startsWith("release create") && call.includes("--draft")));
  assert.ok(gh.calls.at(-1).includes("--draft=false"));
});

test("a rerun uploads only what is missing or changed", async () => {
  const gh = fakeGitHub({
    release: {
      isDraft: true,
      assets: [
        ["Flow-arm64.dmg", digests.get("Flow-arm64.dmg")],
        ["Flow-x64.dmg", "digest-of-a-truncated-upload"],
      ],
    },
  });
  await publishReleaseAssets({
    tag: "flow-desktop-v1.0.0",
    files,
    gh,
    log: () => {},
    sleep: async () => {},
  });
  const uploaded = gh.calls.filter((call) => call.startsWith("release upload"));
  // The identical one is left alone; the one whose contents differ is replaced.
  assert.deepEqual(
    uploaded.map((call) => call.split(" ")[3]),
    ["/build/Flow-x64.dmg", "/build/latest-mac.yml"],
  );
});

test("an upload is retried, and a release that never completes is never published", async () => {
  const flaky = fakeGitHub({ failUploads: { "Flow-x64.dmg": 2 } });
  await publishReleaseAssets({ tag: "t", files, gh: flaky, log: () => {}, sleep: async () => {} });
  assert.equal(flaky.release.isDraft, false);

  const broken = fakeGitHub({ failUploads: { "Flow-x64.dmg": 99 } });
  await assert.rejects(
    publishReleaseAssets({
      tag: "t",
      files,
      gh: broken,
      log: () => {},
      sleep: async () => {},
      attempts: 2,
    }),
    /Could not upload Flow-x64.dmg/,
  );
  assert.equal(broken.release.isDraft, true, "a failed publish leaves a draft, not a release");
});

test("republishing an already published version is refused", async () => {
  const gh = fakeGitHub({ release: { isDraft: false, assets: [] } });
  await assert.rejects(
    publishReleaseAssets({ tag: "flow-desktop-v1.0.0", files, gh, log: () => {} }),
    /already published/,
  );
});

test("the rolling feed gains the new files before stale ones are removed", async () => {
  const gh = fakeGitHub({
    release: {
      isDraft: false,
      assets: [
        ["Flow-0.9-arm64.dmg", "old"],
        ["latest-mac.yml", "the-previous-release"],
      ],
    },
  });
  await publishReleaseAssets({
    tag: "flow-desktop-latest",
    files,
    gh,
    rolling: true,
    log: () => {},
    sleep: async () => {},
  });
  const order = gh.calls.filter(
    (c) => c.startsWith("release upload") || c.startsWith("release delete-asset"),
  );
  assert.ok(
    order.findIndex((c) => c.startsWith("release delete-asset")) >
      order.findLastIndex((c) => c.startsWith("release upload")),
    "every upload happens before the first delete",
  );
  assert.deepEqual([...gh.release.assets.keys()].sort(), [...sizes.keys()].sort());
});

test("updater manifests are uploaded last", async () => {
  const ordered = orderForUpload([
    { path: "/b/latest-mac.yml", size: 1 },
    { path: "/b/Flow.dmg", size: 2 },
    { path: "/b/latest-linux.yml", size: 1 },
    { path: "/b/Flow.AppImage", size: 3 },
  ]).map((file) => NodePath.basename(file.path));
  assert.deepEqual(ordered, ["Flow.dmg", "Flow.AppImage", "latest-mac.yml", "latest-linux.yml"]);
});

test("collect reads what is on disk and skips directories", async (t) => {
  const directory = await NodeFSP.mkdtemp(join(NodeOS.tmpdir(), "flow-assets-"));
  t.after(() => NodeFSP.rm(directory, { recursive: true, force: true }));
  await NodeFSP.writeFile(join(directory, "Flow.dmg"), "installer");
  await NodeFSP.writeFile(join(directory, "latest-mac.yml"), "y");
  await NodeFSP.mkdir(join(directory, "nested"));
  assert.deepEqual(
    (await collect(directory)).map((file) => [NodePath.basename(file.path), file.size]),
    [
      ["Flow.dmg", 9],
      ["latest-mac.yml", 1],
    ],
  );
});

test("a manifest of unchanged size is still uploaded, because its contents differ", async () => {
  // Every release's latest-mac.yml is the same number of bytes. Comparing size
  // left a rolling feed advertising the previous version while holding the new
  // installers, so nobody was ever offered the update.
  const gh = fakeGitHub({
    release: { isDraft: false, assets: [["latest-mac.yml", "the-previous-release"]] },
  });
  await publishReleaseAssets({
    tag: "flow-desktop-latest",
    files: files.filter((file) => file.path.endsWith("latest-mac.yml")),
    rolling: true,
    gh,
    log: () => {},
    sleep: async () => {},
  });
  assert.ok(gh.calls.some((call) => call.includes("release upload")));
  assert.equal(gh.release.assets.get("latest-mac.yml"), digests.get("latest-mac.yml"));
});

test("an asset GitHub stores no digest for is uploaded again", async () => {
  const gh = fakeGitHub({ release: { isDraft: true, assets: [["Flow-arm64.dmg", null]] } });
  await publishReleaseAssets({ tag: "t", files, gh, log: () => {}, sleep: async () => {} });
  assert.ok(gh.calls.some((call) => call.includes("/build/Flow-arm64.dmg")));
});

test("collect hashes what it finds", async (t) => {
  const directory = await NodeFSP.mkdtemp(join(NodeOS.tmpdir(), "flow-digest-"));
  t.after(() => NodeFSP.rm(directory, { recursive: true, force: true }));
  await NodeFSP.writeFile(join(directory, "Flow.dmg"), "installer");
  const [file] = await collect(directory);
  assert.equal(file.digest, await sha256(join(directory, "Flow.dmg")));
  assert.match(file.digest, /^[a-f0-9]{64}$/);
});
