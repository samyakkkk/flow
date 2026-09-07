// run-scenarios.ts — Boot orchestrator + linear-mock, run all scenarios,
// print pass/fail table, exit nonzero on failure.
//
// Usage:
//   npm run verify
//   # or:
//   tsx run-scenarios.ts [--scenario 01-knowledge-claim]

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { runScenario, type Scenario, type ScenarioResult } from "./slack-sim.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ORCHESTRATOR_DIR = resolve(__dirname, "../orchestrator");
const SCENARIOS_DIR = resolve(__dirname, "scenarios");

const ORCH_PORT = 17510;
const LINEAR_MOCK_PORT = 17509;
const ADMIN_TOKEN = "test-token";
const BASE_URL = `http://127.0.0.1:${ORCH_PORT}`;

// ------------------------------------------------------------------
// Wait for HTTP service to become ready
// ------------------------------------------------------------------

async function waitForService(url: string, timeoutMs = 20000, label = url): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not ready
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Service "${label}" did not become ready in ${timeoutMs}ms`);
}

// ------------------------------------------------------------------
// Spawn orchestrator
// ------------------------------------------------------------------

function spawnOrchestrator(dbPath: string): ChildProcess {
  const proc = spawn(
    "npx",
    ["tsx", "src/index.ts"],
    {
      cwd: ORCHESTRATOR_DIR,
      env: {
        ...process.env,
        PORT: String(ORCH_PORT),
        ORCHESTRATOR_PORT: String(ORCH_PORT),
        ORCHESTRATOR_URL: BASE_URL,  // notify tool calls back to the orchestrator
        FLOW_ADMIN_TOKEN: ADMIN_TOKEN,
        FLOW_FAKE_OPENCODE: "1",
        DB_PATH: dbPath,
        GATEWAY_URL: `http://127.0.0.1:17433`,  // stub; graphwrite calls will fail but we tolerate
        LOG_LEVEL: "warn",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  proc.stdout?.on("data", (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line) process.stderr.write(`[orchestrator] ${line}\n`);
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line) process.stderr.write(`[orchestrator:err] ${line}\n`);
  });

  return proc;
}

// ------------------------------------------------------------------
// Spawn linear-mock
// ------------------------------------------------------------------

function spawnLinearMock(): ChildProcess {
  const proc = spawn(
    "npx",
    ["tsx", resolve(__dirname, "linear-mock.ts")],
    {
      cwd: __dirname,
      env: {
        ...process.env,
        LINEAR_MOCK_PORT: String(LINEAR_MOCK_PORT),
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  proc.stdout?.on("data", (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line) process.stderr.write(`[linear-mock] ${line}\n`);
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line) process.stderr.write(`[linear-mock:err] ${line}\n`);
  });

  return proc;
}

// ------------------------------------------------------------------
// Spawn gateway stub (tiny HTTP server that returns 200 for all POST)
// ------------------------------------------------------------------

async function startGatewayStub(port = 17433): Promise<() => void> {
  const { createServer } = await import("node:http");
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "created", id: `stub-${req.url}` })); // mirror real gateway shape
      });
    });
    server.listen(port, "127.0.0.1", () => {
      process.stderr.write(`[gateway-stub] listening on port ${port}\n`);
      resolve(() => server.close());
    });
    server.on("error", reject);
  });
}

// ------------------------------------------------------------------
// Print results table
// ------------------------------------------------------------------

function printTable(results: ScenarioResult[]): void {
  const maxName = Math.max(...results.map((r) => r.scenario.length), 10);
  const header = `${"SCENARIO".padEnd(maxName)}  STATUS  ASSERTIONS  DURATION`;
  console.log("\n" + "─".repeat(header.length));
  console.log(header);
  console.log("─".repeat(header.length));

  for (const r of results) {
    const status = r.passed ? "PASS  " : "FAIL  ";
    const passed = r.assertions.filter((a) => a.passed).length;
    const total = r.assertions.length;
    const dur = `${r.duration_ms}ms`;
    console.log(
      `${r.scenario.padEnd(maxName)}  ${status}  ${String(passed).padStart(3)}/${total}       ${dur}`
    );
  }

  console.log("─".repeat(header.length));

  const allPassed = results.every((r) => r.passed);
  const total = results.length;
  const passCount = results.filter((r) => r.passed).length;
  console.log(`\n${passCount}/${total} scenarios passed.`);

  if (!allPassed) {
    console.log("\nFailed assertion details:");
    for (const r of results) {
      if (!r.passed) {
        console.log(`\n  Scenario: ${r.scenario}`);
        for (const a of r.assertions) {
          if (!a.passed) {
            console.log(`    ✗ ${a.message}`);
            if (a.detail) {
              console.log(`      ${JSON.stringify(a.detail, null, 2).split("\n").join("\n      ")}`);
            }
          }
        }
      }
    }
  }
}

// ------------------------------------------------------------------
// Load scenarios from disk
// ------------------------------------------------------------------

function loadScenarios(filter?: string): Scenario[] {
  const files = readdirSync(SCENARIOS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();

  const scenarios: Scenario[] = [];
  for (const file of files) {
    if (filter && !file.includes(filter)) continue;
    const path = join(SCENARIOS_DIR, file);
    try {
      const s = JSON.parse(readFileSync(path, "utf8")) as Scenario;
      scenarios.push(s);
    } catch (err) {
      console.error(`Failed to load scenario ${file}:`, err);
    }
  }
  return scenarios;
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const scenarioFilter = args[args.indexOf("--scenario") + 1] ?? undefined;
  const verbose = args.includes("--verbose");

  // Load scenarios
  const scenarios = loadScenarios(scenarioFilter);
  if (scenarios.length === 0) {
    console.error("No scenarios found. Check scenarios/ directory.");
    process.exit(1);
  }

  console.log(`Loaded ${scenarios.length} scenario(s).`);

  // Create temp DB
  const tmpDir = mkdtempSync(join(tmpdir(), "flow-sim-"));
  const dbPath = join(tmpDir, "flow.db");
  console.log(`Using temp DB: ${dbPath}`);

  // Start gateway stub
  let stopGateway: (() => void) | null = null;
  try {
    stopGateway = await startGatewayStub(17433);
  } catch (err) {
    console.error("Failed to start gateway stub:", err);
    process.exit(1);
  }

  // Start linear mock
  const linearProc = spawnLinearMock();

  // Start orchestrator
  const orchProc = spawnOrchestrator(dbPath);

  // Graceful cleanup
  let exited = false;
  function cleanup(): void {
    if (exited) return;
    exited = true;
    try { orchProc.kill("SIGTERM"); } catch { /* ignore */ }
    try { linearProc.kill("SIGTERM"); } catch { /* ignore */ }
    if (stopGateway) stopGateway();
  }
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(143); });

  try {
    // Wait for services
    console.log("Waiting for orchestrator...");
    await waitForService(`${BASE_URL}/health`, 30000, "orchestrator");
    console.log("Orchestrator ready.");

    await waitForService(`http://127.0.0.1:${LINEAR_MOCK_PORT}/health`, 10000, "linear-mock");
    console.log("Linear mock ready.");

    // Run scenarios sequentially (each gets a fresh outbox/audit via isolated events)
    const results: ScenarioResult[] = [];
    for (const scenario of scenarios) {
      console.log(`\nRunning: ${scenario.name}...`);
      const result = await runScenario(scenario, BASE_URL, ADMIN_TOKEN, verbose);
      results.push(result);

      if (verbose) {
        for (const a of result.assertions) {
          const icon = a.passed ? "  ✓" : "  ✗";
          console.log(`${icon} ${a.message}`);
          if (!a.passed && a.detail) {
            console.log(`    ${JSON.stringify(a.detail)}`);
          }
        }
      }

      console.log(`  → ${result.passed ? "PASS" : "FAIL"} (${result.assertions.filter((a) => a.passed).length}/${result.assertions.length} assertions)`);
    }

    printTable(results);

    const allPassed = results.every((r) => r.passed);
    cleanup();
    process.exit(allPassed ? 0 : 1);
  } catch (err) {
    console.error("Run failed:", err);
    cleanup();
    process.exit(1);
  }
}

main();
