#!/usr/bin/env node
// Publishing a Flow release uploads ~1 GB, and GitHub's upload service is not
// reliable at that size: single requests return HTTP 400/500, and a slow day
// can spend a job's whole time budget on one file. So every asset is uploaded
// on its own, an asset already stored with the right size is left alone (a
// rerun resumes instead of starting over), and a versioned release stays a
// draft until it holds exactly what was built.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeURL from "node:url";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const runGh = async (args) =>
  (await execFile("gh", args, { maxBuffer: 16 * 1024 * 1024 })).stdout;

/** What the release already holds, or null when it does not exist yet. */
export async function storedRelease(tag, gh) {
  try {
    const json = await gh(["release", "view", tag, "--json", "isDraft,assets"]);
    const release = JSON.parse(json);
    return {
      isDraft: release.isDraft === true,
      assets: new Map((release.assets ?? []).map((asset) => [asset.name, asset.size])),
    };
  } catch {
    return null;
  }
}

export async function publishReleaseAssets(input) {
  const {
    tag,
    files,
    title,
    notes,
    generateNotes = false,
    target,
    latest = false,
    prerelease = false,
    // A rolling feed is updated in place: installed apps read it, so new files
    // land before stale ones are removed and it is never empty mid-publish.
    rolling = false,
    gh = runGh,
    attempts = 5,
    sleep = delay,
    log = console.log,
  } = input;

  const stored = await storedRelease(tag, gh);
  if (stored && !rolling && !stored.isDraft) throw Error(`Release ${tag} is already published.`);
  if (!stored) {
    await gh([
      "release",
      "create",
      tag,
      ...(target ? ["--target", target] : []),
      ...(title ? ["--title", title] : []),
      ...(notes ? ["--notes", notes] : []),
      ...(generateNotes ? ["--generate-notes"] : []),
      ...(rolling ? ["--prerelease"] : ["--draft"]),
      ...(rolling ? [] : ["--latest=false"]),
    ]);
  }

  const held = stored?.assets ?? new Map();
  for (const file of files) {
    const name = NodePath.basename(file.path);
    if (held.get(name) === file.size) {
      log(`Already uploaded ${name}`);
      continue;
    }
    let failure;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await gh(["release", "upload", tag, file.path, "--clobber"]);
        failure = undefined;
        break;
      } catch (error) {
        failure = error;
        log(`Upload of ${name} failed (attempt ${attempt} of ${attempts}): ${error.message}`);
        if (attempt < attempts) await sleep(attempt * 20_000);
      }
    }
    if (failure) throw Error(`Could not upload ${name} to ${tag}: ${failure.message}`);
    log(`Uploaded ${name}`);
  }

  const after = await storedRelease(tag, gh);
  const expected = files.map((file) => NodePath.basename(file.path));
  const missing = expected.filter((name) => !after?.assets.has(name));
  if (missing.length) throw Error(`${tag} is missing ${missing.join(", ")} after uploading.`);

  if (rolling) {
    for (const name of after.assets.keys())
      if (!expected.includes(name)) {
        await gh(["release", "delete-asset", tag, name, "--yes"]);
        log(`Removed stale ${name}`);
      }
    return;
  }

  const extra = [...after.assets.keys()].filter((name) => !expected.includes(name));
  if (extra.length) throw Error(`${tag} holds unexpected assets: ${extra.join(", ")}.`);
  await gh(["release", "edit", tag, "--draft=false", `--latest=${latest}`]);
  log(`Published ${tag}`);
}

/** Updater manifests last: a manifest must never name a file that has not
    arrived yet. Everything else keeps the order the caller gave. */
export const orderForUpload = (files) => [
  ...files.filter((file) => !/^latest.*\.yml$/.test(NodePath.basename(file.path))),
  ...files.filter((file) => /^latest.*\.yml$/.test(NodePath.basename(file.path))),
];

export async function collect(directory) {
  const names = await NodeFSP.readdir(directory);
  const files = [];
  for (const name of names.sort()) {
    const path = NodePath.join(directory, name);
    const stat = await NodeFSP.stat(path);
    if (stat.isFile()) files.push({ path, size: stat.size });
  }
  return orderForUpload(files);
}

if (process.argv[1] && NodeURL.pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [tag, directory] = process.argv.slice(2);
  const flag = (name) => {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? undefined : process.argv[index + 1];
  };
  if (!tag || !directory) throw Error("Usage: publish-release-assets.mjs TAG DIRECTORY [options]");
  await publishReleaseAssets({
    tag,
    files: await collect(directory),
    title: flag("title"),
    notes: flag("notes"),
    generateNotes: process.argv.includes("--generate-notes"),
    target: flag("target"),
    latest: process.argv.includes("--latest"),
    rolling: process.argv.includes("--rolling"),
  });
}
