import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const compare = (a, b) => {
  const left = a.split(".").map(BigInt);
  const right = b.split(".").map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
};

export function selectVersion(tags, requested = "") {
  const versions = tags
    .filter((tag) => tag.startsWith("flow-v"))
    .map((tag) => tag.slice(6))
    .filter((version) => stable.test(version))
    .sort(compare);
  const latest = versions.at(-1);
  const version =
    requested ||
    (latest
      ? latest
          .split(".")
          .slice(0, 2)
          .concat(String(BigInt(latest.split(".")[2]) + 1n))
          .join(".")
      : "0.1.0");
  if (!stable.test(version)) throw new Error("Use a stable X.Y.Z version.");
  if (latest && compare(version, latest) <= 0) {
    throw new Error(`Version ${version} must be newer than ${latest}.`);
  }
  return { version, latest };
}

export function validateEvent(event, ref) {
  if (event === "pull_request") return;
  if (!["push", "workflow_dispatch"].includes(event) || ref !== "refs/heads/release") {
    throw new Error("Browser publication requires the release branch.");
  }
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  validateEvent(process.env.GITHUB_EVENT_NAME, process.env.GITHUB_REF);
  const git = (...args) => NodeChildProcess.execFileSync("git", args, { encoding: "utf8" }).trim();
  const commit = git("rev-parse", "HEAD");
  if (commit !== process.env.GITHUB_SHA)
    throw new Error("Checkout must match the triggering commit.");
  let version = "0.0.0";
  if (process.env.GITHUB_EVENT_NAME !== "pull_request") {
    const selected = selectVersion(
      git("tag", "--list", "flow-v*").split("\n"),
      process.env.FLOW_VERSION,
    );
    // Queued runs must never publish older source over a newer release.
    if (selected.latest) git("merge-base", "--is-ancestor", `flow-v${selected.latest}`, commit);
    version = selected.version;
  }
  NodeFS.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `tag=flow-v${version}\nversion=${version}\ncommit=${commit}\n`,
  );
}
