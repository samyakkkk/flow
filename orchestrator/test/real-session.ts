// real-session.ts — Verify opencode session continuity end-to-end.
//
// 1. Run a trivial prompt with --format json; capture sessionID and answer text.
// 2. Follow up with --session <id> referencing the first answer.
// 3. Assert the model's follow-up response demonstrates memory of the first answer.
//
// Usage:
//   npm run verify:session
//
// Requires: opencode configured with a working model (openrouter/minimax/minimax-m3).
// This makes ~2 real LLM API calls (tiny prompts, ~$0.001 total).

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const MODEL = process.env.GRAPH_BUILDER_MODEL ?? "openrouter/minimax/minimax-m3";
const WORKSPACE =
  process.env.OPENCODE_WORKSPACE_DIR ??
  fileURLToPath(new URL("../../index-workspace", import.meta.url));

// Run opencode and return {stdout, stderr, exitCode} once the process finishes.
// Uses async spawn to avoid blocking the event loop (spawnSync hangs on opencode --session).
function runOpencode(args: string[], timeoutMs = 90_000): Promise<{ stdout: string; stderr: string; status: number | null }> {
  return new Promise((resolve) => {
    const proc = spawn("opencode", args, {
      cwd: WORKSPACE,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      resolve({ stdout, stderr: stderr + "\n[TIMEOUT]", status: 1 });
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, status: code });
    });
  });
}

function parseJsonlEvents(stdout: string): {
  sessionId: string;
  textParts: string[];
} {
  const lines = stdout.split("\n").filter((l) => l.trim());
  let sessionId = "";
  const textParts: string[] = [];

  for (const line of lines) {
    try {
      const evt = JSON.parse(line) as {
        type?: string;
        sessionID?: string;
        part?: { type?: string; text?: string };
      };
      if (!sessionId && evt.sessionID) sessionId = evt.sessionID;
      if (evt.type === "text" && evt.part?.text) textParts.push(evt.part.text);
    } catch {
      // skip malformed lines
    }
  }

  return { sessionId, textParts };
}

async function main(): Promise<void> {
  console.log("=== real-session.ts: opencode session continuity test ===\n");

  // Step 1: first prompt
  const q1 = "What is the capital of France? Reply with exactly one word.";
  console.log(`Step 1: asking "${q1}"`);

  // Note: cwd is set to WORKSPACE in runOpencode; no --dir needed (avoids server socket conflict)
  const run1 = await runOpencode([
    "run",
    "--format",
    "json",
    "-m",
    MODEL,
    q1,
  ]);

  if (run1.status !== 0) {
    console.error("Step 1 failed:\n", run1.stderr || run1.stdout);
    process.exit(1);
  }

  const { sessionId, textParts: parts1 } = parseJsonlEvents(run1.stdout);
  const answer1 = parts1.join("").trim();

  if (!sessionId) {
    console.error("Step 1: could not parse sessionID from output.");
    console.error("stdout:\n", run1.stdout.slice(0, 500));
    process.exit(1);
  }

  console.log(`  sessionID : ${sessionId}`);
  console.log(`  answer    : ${answer1}`);

  // Step 2: follow-up in the same session
  const q2 = "What word did you just reply with?";
  console.log(`\nStep 2: asking "${q2}" in session ${sessionId}`);

  const run2 = await runOpencode([
    "run",
    "--format",
    "json",
    "-m",
    MODEL,
    "--session",
    sessionId,
    q2,
  ]);

  if (run2.status !== 0) {
    console.error("Step 2 failed:\n", run2.stderr || run2.stdout);
    process.exit(1);
  }

  const { textParts: parts2 } = parseJsonlEvents(run2.stdout);
  const answer2 = parts2.join("").trim();

  console.log(`  answer    : ${answer2}`);

  // Assert the follow-up mentions the first answer (Paris or what was said)
  const a1lower = answer1.toLowerCase().replace(/[^a-z]/g, "");
  const a2lower = answer2.toLowerCase();
  const remembered = a1lower.length > 0 && a2lower.includes(a1lower.slice(0, 4));

  const transcriptSummary = [
    `Q1: ${q1}`,
    `A1: ${answer1}`,
    `Q2: ${q2}`,
    `A2: ${answer2}`,
    `Session: ${sessionId}`,
  ].join("\n  ");

  if (remembered || a2lower.includes("paris")) {
    console.log("\nPASS: model remembered the first answer in the continuation session.");
    console.log("\nTranscript summary:");
    console.log(`  ${transcriptSummary}`);
    process.exit(0);
  } else {
    console.error("\nFAIL: model did not appear to remember the first answer.");
    console.error(`  ${transcriptSummary}`);
    console.error("\nThis may indicate --session is not resuming correctly.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
