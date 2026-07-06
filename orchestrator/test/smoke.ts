// smoke.ts — Boot-and-health check: starts orchestrator on port 17501, hits /health, exits.
// Called by `npm run verify` after tests pass.

import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(__dirname, "..");

const SMOKE_PORT = 17501;

async function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollHealth(url: string, attempts = 15): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const body = await res.json() as Record<string, unknown>;
        if (body.status === "ok") return;
      }
    } catch {
      // not ready yet
    }
    await wait(500);
  }
  throw new Error(`Health check never succeeded at ${url}`);
}

async function run(): Promise<void> {
  console.log("[smoke] Starting orchestrator...");

  const proc = spawn(
    "node",
    ["--import", "tsx/esm", "src/index.ts"],
    {
      cwd: root,
      env: {
        ...process.env,
        ORCHESTRATOR_PORT: String(SMOKE_PORT),
        DB_PATH: ":memory:",
        FLOW_ADMIN_TOKEN: "smoke-token",
        FLOW_FAKE_OPENCODE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  proc.stdout?.on("data", (d: Buffer) => process.stdout.write(d));
  proc.stderr?.on("data", (d: Buffer) => process.stderr.write(d));

  try {
    await pollHealth(`http://127.0.0.1:${SMOKE_PORT}/health`);
    console.log("[smoke] Health check passed.");

    // Quick auth check
    const unauth = await fetch(`http://127.0.0.1:${SMOKE_PORT}/v1/audit`);
    if (unauth.status !== 401) {
      throw new Error(`Expected 401 on unauthenticated /v1/audit, got ${unauth.status}`);
    }
    console.log("[smoke] Auth enforcement verified.");

    console.log("[smoke] All checks passed.");
  } finally {
    proc.kill("SIGTERM");
  }
}

run().catch((err) => {
  console.error("[smoke] FAILED:", err);
  process.exit(1);
});
