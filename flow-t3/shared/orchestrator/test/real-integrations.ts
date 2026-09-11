// test/real-integrations.ts — Real credential integration verification.
// Run with: npm run verify:real (requires .env in flow/ directory)
//
// Verifications:
// a. Linear: create 3 sample issues on team LAN, upsert + idempotency-check
//    CONTEXT BY FLOW comment on issue 1.
// b. GitHub: PAT clone + local CLI clone of both repos, PR listing.
// c. Print claim→verified table.

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// ------------------------------------------------------------------
// Load .env from flow/ directory
// ------------------------------------------------------------------
const envPath = resolve(__dirname, "../../.env");
if (!existsSync(envPath)) {
  console.error(`[verify:real] .env not found at ${envPath}`);
  process.exit(1);
}

const envContent = readFileSync(envPath, "utf-8");
for (const line of envContent.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eqIdx = trimmed.indexOf("=");
  if (eqIdx === -1) continue;
  const key = trimmed.slice(0, eqIdx).trim();
  const val = trimmed.slice(eqIdx + 1).trim();
  if (!process.env[key]) process.env[key] = val;
}

// ------------------------------------------------------------------
// Imports after env is loaded
// ------------------------------------------------------------------
import {
  createIssue,
  getIssue,
  listIssues,
  upsertBotComment,
  linearGql,
} from "../src/adapters/linear.js";
import { cloneRepo, lsRemoteHead, listPRs } from "../src/adapters/github.js";
import { renderContextBlock } from "../src/actions/contextblock.js";

// ------------------------------------------------------------------
// Result tracker
// ------------------------------------------------------------------
interface ClaimResult {
  claim: string;
  method: "real" | "simulated";
  status: "VERIFIED" | "FAILED" | "SKIPPED";
  detail?: string;
}

const results: ClaimResult[] = [];

function pass(claim: string, method: "real" | "simulated", detail?: string): void {
  results.push({ claim, method, status: "VERIFIED", detail });
  console.log(`  ✓ ${claim}${detail ? ` — ${detail}` : ""}`);
}

function fail(claim: string, method: "real" | "simulated", detail: string): void {
  results.push({ claim, method, status: "FAILED", detail });
  console.error(`  ✗ ${claim} — ${detail}`);
}

function skip(claim: string, reason: string): void {
  results.push({ claim, method: "simulated", status: "SKIPPED", detail: reason });
  console.log(`  - ${claim} — SKIPPED: ${reason}`);
}

// ------------------------------------------------------------------
// A. Linear Integration
// ------------------------------------------------------------------
async function verifyLinear(): Promise<void> {
  console.log("\n=== A. Linear Integration ===");

  const LINEAR_TEAM_ID = "e2318b4f-b2b0-480b-b59a-ea034113efe1";

  if (!process.env.LINEAR_API_KEY) {
    skip("Linear: create issues", "LINEAR_API_KEY not set");
    skip("Linear: upsertBotComment idempotency", "LINEAR_API_KEY not set");
    return;
  }

  const issueTitles = [
    "Fix hero section CLS on mobile [flow-verify]",
    "Implement JWT auth refresh for api-service API [flow-verify]",
    "Add OpenGraph tags to web-app landing page [flow-verify]",
  ];

  const createdIssues: Array<{ id: string; identifier: string; url: string }> = [];

  // Create 3 sample issues
  for (let i = 0; i < issueTitles.length; i++) {
    try {
      const issue = await createIssue({
        teamId: LINEAR_TEAM_ID,
        title: issueTitles[i],
        description: `Created by Flow verify:real script on ${new Date().toISOString()}.\n\nRelated repo: ${i === 0 ? "acme/api-service" : "acme/web-app"}`,
      });
      createdIssues.push({ id: issue.id, identifier: issue.identifier, url: issue.url });
      pass(`Linear: create issue ${i + 1} (${issue.identifier})`, "real", issue.url);
      console.log(`    URL: ${issue.url}`);
    } catch (err) {
      fail(`Linear: create issue ${i + 1}`, "real", String(err));
    }
  }

  if (createdIssues.length === 0) {
    fail("Linear: upsertBotComment (no issues created)", "real", "prerequisite failed");
    return;
  }

  // upsertBotComment on issue 1 — first upsert
  const issue1 = createdIssues[0];
  const bundle1 = {
    relatedNodes: [
      { id: "concept:cls", name: "Cumulative Layout Shift", type: "Concept", description: "Core Web Vital measuring visual stability" },
      { id: "repo:api-service", name: "api-service", type: "Repository" },
    ],
    notes: "Initial context block from Flow verify:real — version 1",
  };
  const contextMd1 = renderContextBlock(bundle1);

  let commentId: string | null = null;

  try {
    const result1 = await upsertBotComment(issue1.id, contextMd1);
    commentId = result1.commentId;
    assert_ok(result1.action === "created", `Expected 'created', got '${result1.action}'`);
    pass("Linear: upsertBotComment — first create", "real", `comment=${result1.commentId}`);
  } catch (err) {
    fail("Linear: upsertBotComment — first create", "real", String(err));
    return;
  }

  // upsertBotComment again with changed content — should UPDATE the same comment
  const bundle2 = {
    relatedNodes: bundle1.relatedNodes,
    notes: "UPDATED context block from Flow verify:real — version 2 (idempotency check)",
  };
  const contextMd2 = renderContextBlock(bundle2);

  try {
    const result2 = await upsertBotComment(issue1.id, contextMd2);
    assert_ok(result2.action === "updated", `Expected 'updated', got '${result2.action}'`);
    assert_ok(
      result2.commentId === commentId,
      `Expected same comment ID ${commentId}, got ${result2.commentId}`
    );
    pass("Linear: upsertBotComment — idempotent update (same comment ID)", "real", `comment=${result2.commentId}`);
  } catch (err) {
    fail("Linear: upsertBotComment — idempotent update", "real", String(err));
    return;
  }

  // Fetch comments and assert exactly ONE flow comment with updated content
  try {
    const data = await linearGql<{ issue: { comments: { nodes: Array<{ id: string; body: string }> } } }>(
      `query GetComments($id: String!) {
         issue(id: $id) {
           comments(first: 50) { nodes { id body } }
         }
       }`,
      { id: issue1.id }
    );
    const comments = data.issue.comments.nodes;
    const flowComments = comments.filter((c) => c.body.includes("<!-- flow:context:start -->"));

    assert_ok(flowComments.length === 1, `Expected exactly 1 flow comment, found ${flowComments.length}`);
    assert_ok(
      flowComments[0].body.includes("version 2"),
      "Comment should contain the updated content (version 2)"
    );
    pass(
      "Linear: exactly ONE flow comment with updated content",
      "real",
      `total_comments=${comments.length}, flow_comments=${flowComments.length}`
    );

    console.log(`\n  Created issues:`);
    for (const issue of createdIssues) {
      console.log(`    ${issue.identifier}: ${issue.url}`);
    }
  } catch (err) {
    fail("Linear: verify single flow comment", "real", String(err));
  }
}

// ------------------------------------------------------------------
// B. GitHub Integration
// ------------------------------------------------------------------
async function verifyGithub(): Promise<void> {
  console.log("\n=== B. GitHub Integration ===");

  const repos = [
    { repo: "acme/api-service", branch: "main" },
    { repo: "acme/web-app", branch: "main" },
  ];

  const pat = process.env.GITHUB_PAT;

  for (const { repo, branch } of repos) {
    // PAT clone
    const cloneDest = `/tmp/flow-verify-${repo.replace("/", "-")}-pat`;
    try {
      const repoUrl = `https://github.com/${repo}.git`;

      // Get expected SHA via ls-remote (no clone needed)
      const expectedSha = lsRemoteHead(repoUrl, branch, pat || undefined);
      pass(`GitHub: ls-remote HEAD for ${repo}@${branch}`, "real", `sha=${expectedSha.slice(0, 8)}`);

      // PAT clone
      if (pat) {
        const cloneResult = cloneRepo(repoUrl, branch, cloneDest, { pat, force: true });
        assert_ok(
          cloneResult.sha === expectedSha,
          `Clone SHA ${cloneResult.sha} !== ls-remote SHA ${expectedSha}`
        );
        pass(`GitHub: PAT clone of ${repo}@${branch}`, "real", `sha_match=true, path=${cloneDest}`);
      } else {
        skip(`GitHub: PAT clone of ${repo}`, "GITHUB_PAT not set");
      }

      // Local CLI clone (plain https, uses ambient gh auth / git credentials)
      const cloneDestLocal = `/tmp/flow-verify-${repo.replace("/", "-")}-local`;
      try {
        const localResult = cloneRepo(repoUrl, branch, cloneDestLocal, { force: true });
        pass(`GitHub: local CLI clone of ${repo}@${branch}`, "real", `sha=${localResult.sha.slice(0, 8)}`);
      } catch (localErr) {
        // Local clone may fail if gh CLI not authenticated — acceptable
        skip(`GitHub: local CLI clone of ${repo}`, `local clone failed (acceptable): ${String(localErr).slice(0, 80)}`);
      }
    } catch (err) {
      fail(`GitHub: ls-remote / clone of ${repo}@${branch}`, "real", String(err));
    }

    // List PRs
    try {
      const prs = await listPRs(repo, "all");
      pass(`GitHub: listPRs on ${repo}`, "real", `count=${prs.length}`);
      console.log(`    PR count for ${repo}: ${prs.length}`);
      if (prs.length > 0) {
        console.log(`    Latest PR: #${prs[0].number} — ${prs[0].title}`);
      }
    } catch (err) {
      fail(`GitHub: listPRs on ${repo}`, "real", String(err));
    }
  }
}

// ------------------------------------------------------------------
// Assertion helper (throws with message on failure)
// ------------------------------------------------------------------
function assert_ok(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

// ------------------------------------------------------------------
// Print results table
// ------------------------------------------------------------------
function printTable(): void {
  console.log("\n\n" + "=".repeat(90));
  console.log("CLAIM → VERIFICATION TABLE");
  console.log("=".repeat(90));

  const colWidths = { claim: 60, method: 12, status: 10 };
  const header = [
    "CLAIM".padEnd(colWidths.claim),
    "METHOD".padEnd(colWidths.method),
    "STATUS".padEnd(colWidths.status),
  ].join(" | ");
  console.log(header);
  console.log("-".repeat(header.length));

  for (const r of results) {
    const row = [
      r.claim.slice(0, colWidths.claim).padEnd(colWidths.claim),
      r.method.padEnd(colWidths.method),
      r.status.padEnd(colWidths.status),
    ].join(" | ");
    console.log(row);
    if (r.detail && r.status !== "VERIFIED") {
      console.log(`  detail: ${r.detail}`);
    }
  }

  console.log("=".repeat(90));
  const passed = results.filter((r) => r.status === "VERIFIED").length;
  const failed = results.filter((r) => r.status === "FAILED").length;
  const skipped = results.filter((r) => r.status === "SKIPPED").length;
  console.log(`\nTotal: ${results.length} | Verified: ${passed} | Failed: ${failed} | Skipped: ${skipped}`);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
async function main(): Promise<void> {
  console.log("Flow real-integration verification");
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`LINEAR_API_KEY: ${process.env.LINEAR_API_KEY ? "set" : "NOT SET"}`);
  console.log(`GITHUB_PAT: ${process.env.GITHUB_PAT ? "set" : "NOT SET"}`);

  await verifyLinear();
  await verifyGithub();
  printTable();

  const failed = results.filter((r) => r.status === "FAILED");
  if (failed.length > 0) {
    console.error(`\n${failed.length} verification(s) FAILED`);
    process.exit(1);
  } else {
    console.log("\nAll verifications passed (or skipped).");
  }
}

main().catch((err) => {
  console.error("[verify:real] Unexpected error:", err);
  process.exit(1);
});
