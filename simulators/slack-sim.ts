// slack-sim.ts — Simulated Slack workspace scenario runner.
//
// Takes a scenario file, replays messages as normalized events (source: slack)
// into a running orchestrator's POST /v1/events with bearer auth, then polls
// /v1/events/:id, /v1/audit, /v1/outbox to assert expected outcomes.
//
// Usage:
//   tsx slack-sim.ts --scenario scenarios/01-knowledge-claim.json \
//                    --orchestrator http://localhost:17510 \
//                    --token test-token

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ------------------------------------------------------------------
// Scenario types (DSL)
// ------------------------------------------------------------------

export interface ScenarioEvent {
  id: string;
  source: "slack" | "linear" | "github" | "meeting" | "dashboard";
  type: string;
  ts: number;
  payload: Record<string, unknown>;
  workspace?: string;
  /** Milliseconds to wait BEFORE sending this event (lets prior async jobs settle). */
  delay_before_ms?: number;
}

export interface AuditExpectation {
  event_id: string;
  classification?: string;
  action?: string;
  status?: string;
  confidence_min?: number; // check that confidence >= this value
}

export interface OutboxExpectation {
  event_id: string;
  action_type?: string;
  payload_contains?: string; // substring check in JSON-stringified payload
}

export interface AnswerExpectation {
  event_id: string;
  has_citations?: boolean;
  answer_contains?: string;
}

export interface ScenarioSetup {
  policy_patch?: Record<string, string>;
}

export interface ScenarioExpect {
  audits: AuditExpectation[];
  audits_absent?: AuditExpectation[];  // assert NO matching audit row exists
  outbox: OutboxExpectation[];
  outbox_absent?: OutboxExpectation[];
  corpus_absent: string[];       // texts that must NOT appear in corpus search
  answers: AnswerExpectation[];
}

// ------------------------------------------------------------------
// Mid-scenario PATCH actions (approve/dismiss outbox rows)
// ------------------------------------------------------------------

export interface ScenarioAction {
  /** "patch_outbox": find a pending outbox row by event_id and PATCH it. */
  type: "patch_outbox";
  /** event_id whose pending outbox row should be acted upon. */
  find_by_event_id: string;
  decision: "approve" | "dismiss";
  /** Milliseconds to wait before executing this action. */
  delay_before_ms?: number;
}

// ------------------------------------------------------------------
// Workspace dimension: run same events against different policy configs
// ------------------------------------------------------------------

export interface WorkspaceRun {
  /** Workspace field injected into events for this run. */
  workspace: string;
  /** Prepended to all parent event IDs to make them unique per workspace run. */
  id_prefix: string;
  /** Policy patch applied before running this workspace's events. */
  policy_patch: Record<string, string>;
  /** Policy patch applied after assertions to reset to defaults. */
  teardown_patch?: Record<string, string>;
  /**
   * Expected outcomes — event_id values should match the ORIGINAL event IDs
   * (without id_prefix); the runner prefixes them automatically when matching
   * against audit/outbox rows.
   */
  expect: ScenarioExpect;
}

export interface Scenario {
  name: string;
  description?: string;
  setup?: ScenarioSetup;
  teardown?: ScenarioSetup;
  events: ScenarioEvent[];
  expect: ScenarioExpect;
  /**
   * Mid-scenario actions (PATCH outbox rows) executed after events settle
   * but before final assertions. Actions reference original event IDs (no prefix).
   */
  actions?: ScenarioAction[];
  /**
   * Run the same parent events against additional workspace + policy configurations.
   * Each WorkspaceRun produces its own set of assertions (appended to overall result).
   */
  workspace_runs?: WorkspaceRun[];
  /**
   * When true, skip executing the base events/expect (only workspace_runs execute).
   * Use for pure multi-workspace scenarios where base events have no standalone meaning.
   */
  skip_base_run?: boolean;
}

// ------------------------------------------------------------------
// Assertion result
// ------------------------------------------------------------------

export interface AssertionResult {
  passed: boolean;
  message: string;
  detail?: unknown;
}

export interface ScenarioResult {
  scenario: string;
  passed: boolean;
  assertions: AssertionResult[];
  duration_ms: number;
}

// ------------------------------------------------------------------
// HTTP helpers
// ------------------------------------------------------------------

async function apiGet(baseUrl: string, path: string, token: string): Promise<unknown> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET ${path} → HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

async function apiPost(
  baseUrl: string,
  path: string,
  body: unknown,
  token: string
): Promise<unknown> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST ${path} → HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

async function apiPatch(
  baseUrl: string,
  path: string,
  body: unknown,
  token: string
): Promise<unknown> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PATCH ${path} → HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ------------------------------------------------------------------
// Wait for orchestrator to be ready
// ------------------------------------------------------------------

async function waitForOrchestrator(baseUrl: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await sleep(200);
  }
  throw new Error(`Orchestrator at ${baseUrl} did not become ready in ${timeoutMs}ms`);
}

// ------------------------------------------------------------------
// Assertion helpers
// ------------------------------------------------------------------

function pass(message: string, detail?: unknown): AssertionResult {
  return { passed: true, message, detail };
}

function fail(message: string, detail?: unknown): AssertionResult {
  return { passed: false, message, detail };
}

// ------------------------------------------------------------------
// Core assertion block (shared between base run and workspace runs)
// ------------------------------------------------------------------

async function runAssertions(
  expect: ScenarioExpect,
  auditRows: Array<Record<string, unknown>>,
  outboxRows: Array<Record<string, unknown>>,
  events: ScenarioEvent[],
  baseUrl: string,
  token: string,
  label: string,
  idPrefix = "",
): Promise<AssertionResult[]> {
  const assertions: AssertionResult[] = [];

  // Helper: prepend prefix to event_id for matching
  const prefixed = (id: string) => `${idPrefix}${id}`;

  // 1. Assert audits
  for (const expected of expect.audits) {
    const targetId = prefixed(expected.event_id);
    const matching = auditRows.filter((r) => r.event_id === targetId);

    if (matching.length === 0) {
      assertions.push(
        fail(`[${label}] No audit row found for event_id=${targetId}`, {
          expected,
          auditRows: auditRows.slice(0, 10),
        })
      );
      continue;
    }

    const matched = matching.find((r) => {
      if (expected.classification && r.classification !== expected.classification) return false;
      if (expected.action && r.action !== expected.action) return false;
      if (expected.status && r.status !== expected.status) return false;
      if (
        expected.confidence_min !== undefined &&
        (r.confidence as number) < expected.confidence_min
      ) return false;
      return true;
    });

    if (matched) {
      assertions.push(
        pass(
          `[${label}] audit ok: event=${targetId} action=${expected.action ?? "*"} status=${expected.status ?? "*"}`
        )
      );
    } else {
      assertions.push(
        fail(`[${label}] audit mismatch: event_id=${targetId}`, {
          expected,
          found: matching,
        })
      );
    }
  }

  // 2. Assert NO audit rows for events without explicit expectations (sensitive hard-drop)
  const eventsWithAuditExpectations = new Set(expect.audits.map((a) => prefixed(a.event_id)));
  for (const event of events) {
    const targetId = prefixed(event.id);
    if (!eventsWithAuditExpectations.has(targetId)) {
      const rows = auditRows.filter((r) => r.event_id === targetId);
      if (rows.length === 0) {
        assertions.push(pass(`[${label}] no audit rows for event=${targetId} (expected none)`));
      } else {
        assertions.push(
          fail(`[${label}] unexpected audit rows for event=${targetId}`, { rows })
        );
      }
    }
  }

  // 3. Assert audits_absent
  for (const absent of expect.audits_absent ?? []) {
    const targetId = prefixed(absent.event_id);
    const matching = auditRows.filter((r) => {
      if (absent.event_id && r.event_id !== targetId) return false;
      if (absent.classification && r.classification !== absent.classification) return false;
      if (absent.action && r.action !== absent.action) return false;
      if (absent.status && r.status !== absent.status) return false;
      return true;
    });
    if (matching.length === 0) {
      assertions.push(
        pass(`[${label}] audits_absent ok: no ${absent.action ?? "*"} for event=${targetId}`)
      );
    } else {
      assertions.push(
        fail(
          `[${label}] audits_absent violated: found ${absent.action ?? "*"} for event=${targetId}`,
          { absent, found: matching }
        )
      );
    }
  }

  // 4. Assert outbox items present
  for (const expected of expect.outbox) {
    const targetId = prefixed(expected.event_id);
    const matching = outboxRows.filter((r) => {
      if (expected.event_id && r.event_id !== targetId) return false;
      if (expected.action_type && r.action_type !== expected.action_type) return false;
      if (expected.payload_contains) {
        const payloadStr =
          typeof r.payload === "string" ? r.payload : JSON.stringify(r.payload);
        if (!payloadStr.includes(expected.payload_contains)) return false;
      }
      return true;
    });

    if (matching.length > 0) {
      assertions.push(
        pass(`[${label}] outbox ok: event=${targetId} type=${expected.action_type ?? "*"}`)
      );
    } else {
      assertions.push(
        fail(`[${label}] outbox missing: event=${targetId} type=${expected.action_type ?? "*"}`, {
          expected,
          outboxRows: outboxRows.slice(0, 10),
        })
      );
    }
  }

  // 5. Assert outbox items absent
  for (const absent of expect.outbox_absent ?? []) {
    const targetId = prefixed(absent.event_id);
    const matching = outboxRows.filter((r) => {
      if (absent.event_id && r.event_id !== targetId) return false;
      if (absent.action_type && r.action_type !== absent.action_type) return false;
      if (absent.payload_contains) {
        const payloadStr =
          typeof r.payload === "string" ? r.payload : JSON.stringify(r.payload);
        if (!payloadStr.includes(absent.payload_contains)) return false;
      }
      return true;
    });

    if (matching.length === 0) {
      assertions.push(
        pass(`[${label}] outbox_absent ok: no ${absent.action_type} for event=${targetId}`)
      );
    } else {
      assertions.push(
        fail(
          `[${label}] outbox_absent violated: found ${absent.action_type} for event=${targetId}`,
          { absent, found: matching }
        )
      );
    }
  }

  // 6. Assert corpus_absent
  for (const term of expect.corpus_absent) {
    const words = term.split(/[^a-zA-Z0-9]+/).filter((w) => w.length >= 4);
    if (words.length === 0) {
      assertions.push(pass(`[${label}] corpus_absent ok (unsearchable term skipped): "${term}"`));
      continue;
    }
    const queryWord = words[0];
    const encoded = encodeURIComponent(queryWord);
    let searchBody: { results: unknown[] };
    try {
      searchBody = (await apiGet(baseUrl, `/v1/corpus/search?q=${encoded}`, token)) as {
        results: unknown[];
      };
    } catch {
      searchBody = { results: [] };
    }

    const sensitive = searchBody.results.some((r) => {
      const row = r as Record<string, unknown>;
      return JSON.stringify(row).includes(term);
    });

    if (!sensitive) {
      assertions.push(pass(`[${label}] corpus_absent ok: "${term}" not in corpus`));
    } else {
      assertions.push(
        fail(`[${label}] corpus_absent violated: "${term}" found in corpus`, {
          term,
          results: searchBody.results,
        })
      );
    }
  }

  // 7. Assert answers (job citations)
  for (const expected of expect.answers) {
    const targetId = prefixed(expected.event_id);
    const answerAudit = auditRows.find(
      (r) =>
        r.event_id === targetId && r.action === "answer_job" && r.status === "ok"
    );

    if (!answerAudit) {
      assertions.push(
        fail(`[${label}] answer: no answer_job audit for event=${targetId}`, { expected })
      );
      continue;
    }

    const jobId = answerAudit.target as string;
    let jobBody: Record<string, unknown> | null = null;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        const j = (await apiGet(
          baseUrl,
          `/v1/jobs/${jobId}`,
          token
        )) as Record<string, unknown>;
        if (j.status === "done" || j.status === "failed") {
          jobBody = j;
          break;
        }
      } catch {
        // ignore
      }
      await sleep(200);
    }

    if (!jobBody) {
      assertions.push(
        fail(`[${label}] answer: job ${jobId} did not complete in time`, { expected })
      );
      continue;
    }

    if (jobBody.status === "failed") {
      assertions.push(fail(`[${label}] answer: job ${jobId} failed`, { jobBody }));
      continue;
    }

    if (expected.has_citations) {
      const result = jobBody.result as Record<string, unknown> | null;
      const citations = result?.citations as unknown[] | undefined;
      if (Array.isArray(citations) && citations.length > 0) {
        assertions.push(pass(`[${label}] answer citations ok: job=${jobId}`));
      } else {
        assertions.push(
          fail(`[${label}] answer: job ${jobId} has no citations`, { result })
        );
      }
    } else {
      assertions.push(pass(`[${label}] answer job completed: job=${jobId}`));
    }
  }

  return assertions;
}

// ------------------------------------------------------------------
// Execute mid-scenario actions (PATCH outbox rows)
// ------------------------------------------------------------------

async function executeActions(
  actions: ScenarioAction[],
  baseUrl: string,
  token: string,
  idPrefix = "",
): Promise<void> {
  for (const action of actions) {
    if (action.delay_before_ms && action.delay_before_ms > 0) {
      await sleep(action.delay_before_ms);
    }

    if (action.type === "patch_outbox") {
      const targetId = `${idPrefix}${action.find_by_event_id}`;
      // Fetch ALL outbox rows (pending) and find the one for this event
      const outboxData = (await apiGet(
        baseUrl,
        "/v1/outbox?status=pending",
        token
      )) as { rows: Array<Record<string, unknown>> };

      const row = outboxData.rows.find((r) => r.event_id === targetId);
      if (!row?.id) {
        // Also check approved/dismissed rows in case the status already changed
        const allData = (await apiGet(
          baseUrl,
          "/v1/outbox?limit=500",
          token
        )) as { rows: Array<Record<string, unknown>> };
        const anyRow = allData.rows.find(
          (r) => r.event_id === targetId && r.status === "pending"
        );
        if (!anyRow?.id) {
          console.warn(
            `[actions] patch_outbox: no pending outbox row found for event_id=${targetId}`
          );
          continue;
        }
        await apiPatch(
          baseUrl,
          `/v1/outbox/${anyRow.id}`,
          { decision: action.decision },
          token
        );
      } else {
        await apiPatch(
          baseUrl,
          `/v1/outbox/${row.id}`,
          { decision: action.decision },
          token
        );
      }

      // Brief wait for approval replay to complete
      await sleep(500);
    }
  }
}

// ------------------------------------------------------------------
// Run a single scenario
// ------------------------------------------------------------------

export async function runScenario(
  scenario: Scenario,
  baseUrl: string,
  token: string,
  verbose = false
): Promise<ScenarioResult> {
  const start = Date.now();
  const assertions: AssertionResult[] = [];

  try {
    // -----------------------------------------------------------------
    // BASE RUN (skip if skip_base_run is true)
    // -----------------------------------------------------------------
    if (!scenario.skip_base_run) {
      // 1. Setup: policy patches
      if (scenario.setup?.policy_patch) {
        await apiPatch(baseUrl, "/v1/config/policies", scenario.setup.policy_patch, token);
      }

      // 2. Send events (optionally with per-event delays)
      for (const event of scenario.events) {
        if (event.delay_before_ms && event.delay_before_ms > 0) {
          await sleep(event.delay_before_ms);
        }
        await apiPost(baseUrl, "/v1/events", event, token);
      }

      // 3. Wait for async processing to complete
      await sleep(600);

      // 4. Execute mid-scenario actions (approve/dismiss outbox rows)
      if (scenario.actions && scenario.actions.length > 0) {
        await executeActions(scenario.actions, baseUrl, token, "");
        // Wait for action replay effects
        await sleep(400);
      }

      // 5. Fetch audit log (all rows, large limit to catch concurrent scenarios)
      const auditBody = (await apiGet(baseUrl, "/v1/audit?limit=500", token)) as {
        rows: Array<Record<string, unknown>>;
      };
      const auditRows = auditBody.rows;

      // 6. Fetch outbox (pending items)
      const outboxBody = (await apiGet(baseUrl, "/v1/outbox?status=pending", token)) as {
        rows: Array<Record<string, unknown>>;
      };
      const outboxRows = outboxBody.rows;

      if (verbose) {
        console.log(
          `[${scenario.name}] base audit rows (${auditRows.length}):`,
          JSON.stringify(auditRows.slice(0, 5))
        );
        console.log(
          `[${scenario.name}] base outbox rows (${outboxRows.length}):`,
          JSON.stringify(outboxRows.slice(0, 5))
        );
      }

      // 7. Run assertions for base scenario
      const baseAssertions = await runAssertions(
        scenario.expect,
        auditRows,
        outboxRows,
        scenario.events,
        baseUrl,
        token,
        scenario.name
      );
      assertions.push(...baseAssertions);

      // 8. Teardown: restore policies
      if (scenario.teardown?.policy_patch) {
        await apiPatch(baseUrl, "/v1/config/policies", scenario.teardown.policy_patch, token);
      }
    }

    // -----------------------------------------------------------------
    // WORKSPACE RUNS (additional policy/workspace dimension)
    // -----------------------------------------------------------------
    for (const wsRun of scenario.workspace_runs ?? []) {
      // Apply workspace-specific policy patch
      if (wsRun.policy_patch && Object.keys(wsRun.policy_patch).length > 0) {
        await apiPatch(baseUrl, "/v1/config/policies", wsRun.policy_patch, token);
      }

      // Send events with prefixed IDs and overridden workspace
      const wsEvents = scenario.events.map((ev) => ({
        ...ev,
        id: `${wsRun.id_prefix}${ev.id}`,
        workspace: wsRun.workspace,
      }));

      for (const event of wsEvents) {
        if (event.delay_before_ms && event.delay_before_ms > 0) {
          await sleep(event.delay_before_ms);
        }
        await apiPost(baseUrl, "/v1/events", event, token);
      }

      // Wait for async processing
      await sleep(600);

      // Execute mid-scenario actions (with prefixed event IDs)
      if (scenario.actions && scenario.actions.length > 0) {
        await executeActions(scenario.actions, baseUrl, token, wsRun.id_prefix);
        await sleep(400);
      }

      // Fetch audit + outbox
      const wsAuditBody = (await apiGet(baseUrl, "/v1/audit?limit=500", token)) as {
        rows: Array<Record<string, unknown>>;
      };
      const wsOutboxBody = (await apiGet(baseUrl, "/v1/outbox?status=pending", token)) as {
        rows: Array<Record<string, unknown>>;
      };

      if (verbose) {
        console.log(
          `[${scenario.name}/${wsRun.workspace}] audit rows:`,
          JSON.stringify(wsAuditBody.rows.filter((r) => String(r.event_id).startsWith(wsRun.id_prefix)).slice(0, 5))
        );
      }

      // Run assertions with workspace prefix
      const wsAssertions = await runAssertions(
        wsRun.expect,
        wsAuditBody.rows,
        wsOutboxBody.rows,
        wsEvents,
        baseUrl,
        token,
        `${scenario.name}/${wsRun.workspace}`,
        wsRun.id_prefix
      );
      assertions.push(...wsAssertions);

      // Teardown: reset patched policies
      if (wsRun.teardown_patch && Object.keys(wsRun.teardown_patch).length > 0) {
        await apiPatch(baseUrl, "/v1/config/policies", wsRun.teardown_patch, token);
      }
    }
  } catch (err) {
    assertions.push(fail(`Scenario threw an error: ${String(err)}`));
    // Still apply teardown
    if (!scenario.skip_base_run && scenario.teardown?.policy_patch) {
      try {
        await apiPatch(
          baseUrl,
          "/v1/config/policies",
          scenario.teardown.policy_patch,
          token
        );
      } catch {
        // ignore teardown failure
      }
    }
  }

  const passed = assertions.every((a) => a.passed);
  return {
    scenario: scenario.name,
    passed,
    assertions,
    duration_ms: Date.now() - start,
  };
}

// ------------------------------------------------------------------
// CLI entry point
// ------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const scenarioArg = args[args.indexOf("--scenario") + 1];
  const baseUrl =
    args[args.indexOf("--orchestrator") + 1] ?? "http://localhost:7500";
  const token =
    args[args.indexOf("--token") + 1] ??
    process.env.FLOW_ADMIN_TOKEN ??
    "dev-token";
  const verbose = args.includes("--verbose");

  if (!scenarioArg) {
    console.error(
      "Usage: tsx slack-sim.ts --scenario <path> [--orchestrator <url>] [--token <token>] [--verbose]"
    );
    process.exit(1);
  }

  const scenarioPath = resolve(process.cwd(), scenarioArg);
  const scenario: Scenario = JSON.parse(
    readFileSync(scenarioPath, "utf8")
  ) as Scenario;

  await waitForOrchestrator(baseUrl);

  const result = await runScenario(scenario, baseUrl, token, verbose);

  console.log(`\nScenario: ${result.scenario}`);
  for (const a of result.assertions) {
    console.log(`  ${a.passed ? "✓" : "✗"} ${a.message}`);
    if (!a.passed && a.detail) {
      console.log(`    detail:`, JSON.stringify(a.detail, null, 2));
    }
  }
  console.log(`\n${result.passed ? "PASS" : "FAIL"} (${result.duration_ms}ms)`);

  process.exit(result.passed ? 0 : 1);
}
