import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalRemote, matchRepository } from "../src/repo-identity.ts";

test("remote URLs of every shape reduce to one identity", () => {
  for (const url of [
    "https://github.com/Mellowtel-Inc/Support-With-Mellowtel-Dskt-V2.git",
    "git@github.com:mellowtel-inc/support-with-mellowtel-dskt-v2.git",
    "ssh://git@github.com/mellowtel-inc/support-with-mellowtel-dskt-v2",
    "https://github.com/mellowtel-inc/support-with-mellowtel-dskt-v2/",
  ])
    assert.equal(canonicalRemote(url), "github.com/mellowtel-inc/support-with-mellowtel-dskt-v2");
  assert.equal(canonicalRemote(""), "");
  assert.equal(canonicalRemote(null), "");
});

const described = (id: string, extra: Record<string, string> = {}) => ({
  id,
  name: id.replace(/^repo:/, ""),
  description: `about ${id}`,
  ...extra,
});

test("an exact name still wins", () => {
  const rows = [described("repo:samyakkkk/flow"), described("repo:other/thing")];
  assert.equal(matchRepository("samyakkkk/flow", rows)?.id, "repo:samyakkkk/flow");
});

test("a session's owner/repo label finds the repository through its git remote", () => {
  // Registered from a local path, so the node carries a bare name; the remote
  // is what the session's label and the node actually share.
  const rows = [
    described("repo:support-with-mellowtel-dskt-v2", {
      remote: "github.com/mellowtel-inc/support-with-mellowtel-dskt-v2",
    }),
    described("repo:olostep-browser", { remote: "github.com/mellowtel-inc/olostep-browser" }),
  ];
  assert.equal(
    matchRepository("mellowtel-inc/support-with-mellowtel-dskt-v2", rows)?.id,
    "repo:support-with-mellowtel-dskt-v2",
  );
  assert.equal(
    matchRepository("https://github.com/mellowtel-inc/olostep-browser.git", rows)?.id,
    "repo:olostep-browser",
  );
});

test("graphs indexed before remotes were stamped still match by repository name", () => {
  const rows = [described("repo:support-with-mellowtel-dskt-v2"), described("repo:olostep-browser")];
  assert.equal(
    matchRepository("mellowtel-inc/support-with-mellowtel-dskt-v2", rows)?.id,
    "repo:support-with-mellowtel-dskt-v2",
  );
  // And the other way round: a bare label finds an owner-qualified node.
  assert.equal(
    matchRepository("flow", [described("repo:samyakkkk/flow"), described("repo:samyakkkk/web")])?.id,
    "repo:samyakkkk/flow",
  );
});

test("a session in a repository the graph does not hold gets no neighbour's overview", () => {
  // A Brain that has only indexed its docs repo, opened from a code repo, must
  // not describe itself as the docs repo.
  assert.equal(matchRepository("screenshot-headless", [described("repo:engineering-docs")]), undefined);
  // With no repository named at all, the graph's own is the best answer.
  assert.equal(matchRepository("", [described("repo:acme/api")])?.id, "repo:acme/api");
});

test("two repositories sharing a name are never guessed between", () => {
  const rows = [described("repo:alice/web"), described("repo:bob/web")];
  assert.equal(matchRepository("web", rows), undefined);
  // An owner-qualified label is still unambiguous.
  assert.equal(matchRepository("bob/web", rows)?.id, "repo:bob/web");
});

test("an unrelated repository in a multi-repository graph is not a match", () => {
  const rows = [described("repo:acme/api"), described("repo:acme/web")];
  assert.equal(matchRepository("elsewhere/billing", rows), undefined);
});
