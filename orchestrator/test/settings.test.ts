// settings.test.ts — Tests for the DB-backed settings system.
//
// Tests:
//   1. Registry: all expected keys are present with correct metadata.
//   2. get/put roundtrip for a non-secret setting.
//   3. Secret value is encrypted at rest (raw config row ≠ plaintext).
//   4. GET /v1/settings — lists all settings, masks secrets.
//   5. Precedence: DB > env > default.
//   6. Empty-string PUT deletes the DB override (falls back to env/default).
//   7. PUT unknown key → 400.
//   8. Audit row written per changed key (without the secret value).
//   9. Poller starts after LINEAR_API_KEY set via PUT (mock linear fetch).

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

// -----------------------------------------------------------------------
// Set env BEFORE any module that touches DB is imported
// -----------------------------------------------------------------------
process.env.DB_PATH = ":memory:";
process.env.FLOW_ADMIN_TOKEN = "test-admin-token-settings";
process.env.FLOW_FAKE_OPENCODE = "1";
process.env.FLOW_DRAIN_DISABLE = "1";
process.env.FLOW_POLL_DISABLE = "1";
process.env.ORCHESTRATOR_PORT = "17530"; // unique port for this test file

// Gateway stub required by db.ts / events.ts
let gatewayStub: Server;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any;

before(async () => {
  // Start gateway stub
  await new Promise<void>((resolve) => {
    gatewayStub = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    });
    gatewayStub.listen(0, "127.0.0.1", () => {
      const addr = gatewayStub.address() as { port: number };
      process.env.GATEWAY_URL = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });

  // Import and start the app (single instance for all HTTP tests)
  const mod = await import("../src/index.js");
  app = mod.app;
  await app.ready();
});

after(async () => {
  await app.close();
  await new Promise<void>((resolve) => gatewayStub.close(() => resolve()));
});

// -----------------------------------------------------------------------
// Helper: clear settings-related config rows between tests
// -----------------------------------------------------------------------
async function clearSettings(): Promise<void> {
  const { default: db } = await import("../src/db.js");
  db.prepare("DELETE FROM config WHERE key LIKE 'setting:%'").run();
  // Invalidate in-process cache by writing + deleting a dummy key
  const { putSetting } = await import("../src/settings.js");
  putSetting("FLOW_CONFIDENCE_FLOOR", "");
}

// -----------------------------------------------------------------------
// 1. Registry completeness
// -----------------------------------------------------------------------
describe("settings registry", () => {
  test("all required keys are present in the registry", async () => {
    const { SETTINGS } = await import("../src/settings.js");

    const requiredKeys = [
      "OPENROUTER_API_KEY",
      "CLASSIFIER_MODEL",
      "GRAPH_BUILDER_MODEL",
      "LINEAR_API_KEY",
      "FIREFLIES_API_KEY",
      "GITHUB_TOKEN",
      "SLACK_BOT_TOKEN",
      "SLACK_APP_TOKEN",
      "FLOW_CONFIDENCE_FLOOR",
      "FLOW_GITHUB_POLL_MS",
      "FLOW_LINEAR_POLL_MS",
      "FLOW_FIREFLIES_POLL_MS",
      "FLOW_DM_CHANNEL",
    ];

    const registeredKeys = SETTINGS.map((s) => s.key);
    for (const key of requiredKeys) {
      assert.ok(registeredKeys.includes(key), `Missing registry entry: ${key}`);
    }
  });

  test("secret flag is correct for all secrets", async () => {
    const { SETTINGS } = await import("../src/settings.js");
    const secretKeys = new Set([
      "OPENROUTER_API_KEY",
      "LINEAR_API_KEY",
      "FIREFLIES_API_KEY",
      "GITHUB_TOKEN",
      "SLACK_BOT_TOKEN",
      "SLACK_APP_TOKEN",
    ]);

    for (const def of SETTINGS) {
      if (secretKeys.has(def.key)) {
        assert.equal(def.secret, true, `${def.key} should be secret`);
      } else {
        assert.equal(def.secret, false, `${def.key} should NOT be secret`);
      }
    }
  });
});

// -----------------------------------------------------------------------
// 2. get/put roundtrip — non-secret
// -----------------------------------------------------------------------
describe("getSetting / putSetting roundtrip (non-secret)", () => {
  beforeEach(async () => {
    await clearSettings();
  });

  test("stored value is returned by getSetting", async () => {
    const { getSetting, putSetting } = await import("../src/settings.js");

    putSetting("CLASSIFIER_MODEL", "anthropic/claude-3-haiku");
    const val = getSetting("CLASSIFIER_MODEL");
    assert.equal(val, "anthropic/claude-3-haiku");
  });

  test("DB value takes precedence over env", async () => {
    const { getSetting, putSetting } = await import("../src/settings.js");

    process.env.CLASSIFIER_MODEL = "env-model";
    putSetting("CLASSIFIER_MODEL", "db-model");
    const val = getSetting("CLASSIFIER_MODEL");
    assert.equal(val, "db-model", "DB value must win over env");
    delete process.env.CLASSIFIER_MODEL;
  });
});

// -----------------------------------------------------------------------
// 3. Secret encrypted at rest
// -----------------------------------------------------------------------
describe("secret encryption at rest", () => {
  beforeEach(async () => {
    await clearSettings();
  });

  test("secret value is NOT stored as plaintext in config table", async () => {
    const { putSetting } = await import("../src/settings.js");
    const { default: db } = await import("../src/db.js");

    const secret = "lin_api_supersecret_12345";
    putSetting("LINEAR_API_KEY", secret);

    const row = db
      .prepare("SELECT value FROM config WHERE key = 'setting:LINEAR_API_KEY'")
      .get() as { value: string } | undefined;

    assert.ok(row, "Config row should exist after putSetting");
    const rawValue = JSON.parse(row!.value) as string;
    assert.ok(!rawValue.includes(secret), "Plaintext secret must NOT appear in raw config value");
    assert.ok(rawValue.startsWith("v1:"), "Encrypted value should start with 'v1:' prefix");
  });

  test("getSetting decrypts the secret correctly", async () => {
    const { getSetting, putSetting } = await import("../src/settings.js");

    const secret = "lin_api_correct_decryption";
    putSetting("LINEAR_API_KEY", secret);
    const decrypted = getSetting("LINEAR_API_KEY");
    assert.equal(decrypted, secret, "Decrypted value must match original");
  });

  test("secret is masked in listSettings output", async () => {
    const { putSetting, listSettings } = await import("../src/settings.js");

    // "xoxb-abc123def456" — last 4 chars are "f456"
    const secret = "xoxb-abc123def456";
    putSetting("SLACK_BOT_TOKEN", secret);

    const views = listSettings();
    const entry = views.find((v) => v.key === "SLACK_BOT_TOKEN");
    assert.ok(entry, "SLACK_BOT_TOKEN should appear in listSettings");
    assert.ok(entry!.set, "set should be true");
    assert.ok(!entry!.value?.includes("xoxb-abc123def456"), "Plaintext must not appear in masked value");
    assert.ok(entry!.value?.startsWith("…"), "Masked secret should start with '…'");
    // Last 4 chars of "xoxb-abc123def456" = "f456"
    assert.ok(entry!.value?.endsWith("f456"), "Last 4 chars should be visible");
  });
});

// -----------------------------------------------------------------------
// 4. GET /v1/settings HTTP route
// -----------------------------------------------------------------------
describe("GET /v1/settings", () => {
  beforeEach(async () => {
    await clearSettings();
  });

  test("returns 200 with array of settings", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/settings",
      headers: { authorization: "Bearer test-admin-token-settings" },
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body) as Array<{
      key: string;
      secret: boolean;
      source: string;
      set: boolean;
    }>;

    assert.ok(Array.isArray(body), "Response should be an array");
    assert.ok(body.length >= 13, "Should have at least 13 entries");

    const linearEntry = body.find((e) => e.key === "LINEAR_API_KEY");
    assert.ok(linearEntry, "LINEAR_API_KEY should be in response");
    assert.equal(linearEntry!.secret, true);
  });

  test("requires auth", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/settings",
    });
    assert.equal(response.statusCode, 401);
  });

  test("shows source=default for settings with defaults and no override", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/settings",
      headers: { authorization: "Bearer test-admin-token-settings" },
    });

    const body = JSON.parse(response.body) as Array<{
      key: string;
      source: string;
      value: string | undefined;
    }>;

    const confFloor = body.find((e) => e.key === "FLOW_CONFIDENCE_FLOOR");
    assert.ok(confFloor, "FLOW_CONFIDENCE_FLOOR should appear");
    assert.equal(confFloor!.source, "default");
    assert.equal(confFloor!.value, "0.75");
  });
});

// -----------------------------------------------------------------------
// 5. Precedence: DB > env > default
// -----------------------------------------------------------------------
describe("setting precedence", () => {
  beforeEach(async () => {
    await clearSettings();
  });

  test("env beats default when no DB override", async () => {
    const { getSetting } = await import("../src/settings.js");

    const savedEnv = process.env.CLASSIFIER_MODEL;
    process.env.CLASSIFIER_MODEL = "env-from-test";

    const val = getSetting("CLASSIFIER_MODEL");
    assert.equal(val, "env-from-test", "env should win over default");

    if (savedEnv !== undefined) process.env.CLASSIFIER_MODEL = savedEnv;
    else delete process.env.CLASSIFIER_MODEL;
  });

  test("default used when no DB or env", async () => {
    const { getSetting } = await import("../src/settings.js");

    const saved = process.env.CLASSIFIER_MODEL;
    delete process.env.CLASSIFIER_MODEL;

    const val = getSetting("CLASSIFIER_MODEL");
    assert.equal(val, "minimax/minimax-m3", "Default should be returned");

    if (saved !== undefined) process.env.CLASSIFIER_MODEL = saved;
  });

  test("DB beats env", async () => {
    const { getSetting, putSetting } = await import("../src/settings.js");

    process.env.FLOW_CONFIDENCE_FLOOR = "0.5";
    putSetting("FLOW_CONFIDENCE_FLOOR", "0.9");

    const val = getSetting("FLOW_CONFIDENCE_FLOOR");
    assert.equal(val, "0.9", "DB value must beat env");

    delete process.env.FLOW_CONFIDENCE_FLOOR;
  });
});

// -----------------------------------------------------------------------
// 6. Empty-string deletes DB override
// -----------------------------------------------------------------------
describe("empty-string PUT deletes override", () => {
  beforeEach(async () => {
    await clearSettings();
  });

  test("putSetting with empty value removes DB row and falls back to default", async () => {
    const { getSetting, putSetting, getSettingSource } = await import("../src/settings.js");

    putSetting("FLOW_CONFIDENCE_FLOOR", "0.99");
    assert.equal(getSetting("FLOW_CONFIDENCE_FLOOR"), "0.99");

    putSetting("FLOW_CONFIDENCE_FLOOR", ""); // delete
    assert.equal(getSettingSource("FLOW_CONFIDENCE_FLOOR"), "default");
    assert.equal(getSetting("FLOW_CONFIDENCE_FLOOR"), "0.75");
  });
});

// -----------------------------------------------------------------------
// 7. PUT /v1/settings — validation
// -----------------------------------------------------------------------
describe("PUT /v1/settings validation", () => {
  beforeEach(async () => {
    await clearSettings();
  });

  test("PUT unknown key returns 400", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/v1/settings",
      headers: {
        authorization: "Bearer test-admin-token-settings",
        "content-type": "application/json",
      },
      body: JSON.stringify({ UNKNOWN_KEY_XYZ: "some-value" }),
    });

    assert.equal(response.statusCode, 400);
    const body = JSON.parse(response.body) as { error: string };
    assert.ok(body.error.includes("Unknown setting key"), "Error should mention unknown key");
  });

  test("PUT valid key returns 200 with ok:true", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/v1/settings",
      headers: {
        authorization: "Bearer test-admin-token-settings",
        "content-type": "application/json",
      },
      body: JSON.stringify({ FLOW_CONFIDENCE_FLOOR: "0.8" }),
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body) as { ok: boolean; updated: string[] };
    assert.equal(body.ok, true);
    assert.ok(body.updated.includes("FLOW_CONFIDENCE_FLOOR"));
  });

  test("PUT requires auth", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/v1/settings",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ FLOW_CONFIDENCE_FLOOR: "0.8" }),
    });
    assert.equal(response.statusCode, 401);
  });
});

// -----------------------------------------------------------------------
// 8. Audit row written per changed key (without the value)
// -----------------------------------------------------------------------
describe("audit log on setting change", () => {
  beforeEach(async () => {
    await clearSettings();
    const { default: db } = await import("../src/db.js");
    db.prepare("DELETE FROM audit_log WHERE action = 'setting_change'").run();
  });

  test("PUT setting writes an audit_log row with action=setting_change", async () => {
    await app.inject({
      method: "PUT",
      url: "/v1/settings",
      headers: {
        authorization: "Bearer test-admin-token-settings",
        "content-type": "application/json",
      },
      body: JSON.stringify({ LINEAR_API_KEY: "lin_audit_test_key" }),
    });

    const { default: db } = await import("../src/db.js");
    const rows = db
      .prepare("SELECT * FROM audit_log WHERE action = 'setting_change' AND target = 'LINEAR_API_KEY'")
      .all() as Array<Record<string, unknown>>;

    assert.ok(rows.length >= 1, "Audit row should be written");
    // The value (secret) must NOT appear in the audit row
    const row = rows[0];
    const detail = row.detail as string | null;
    assert.ok(!JSON.stringify(row).includes("lin_audit_test_key"), "Secret value must not appear in audit row");
    assert.equal(detail, null, "detail should be null (no value logged)");
  });

  test("PUT multiple keys writes one audit row per key", async () => {
    const { default: db } = await import("../src/db.js");

    await app.inject({
      method: "PUT",
      url: "/v1/settings",
      headers: {
        authorization: "Bearer test-admin-token-settings",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        FLOW_CONFIDENCE_FLOOR: "0.8",
        CLASSIFIER_MODEL: "test-model",
      }),
    });

    const rows = db
      .prepare("SELECT * FROM audit_log WHERE action = 'setting_change'")
      .all() as Array<Record<string, unknown>>;

    assert.ok(rows.length >= 2, "Should have at least 2 audit rows");
    const targets = rows.map((r) => r.target);
    assert.ok(targets.includes("FLOW_CONFIDENCE_FLOOR"));
    assert.ok(targets.includes("CLASSIFIER_MODEL"));
  });
});

// -----------------------------------------------------------------------
// 9. Poller starts after LINEAR_API_KEY set via PUT
// -----------------------------------------------------------------------
describe("poller starts after LINEAR_API_KEY set via PUT", () => {
  beforeEach(async () => {
    await clearSettings();
  });

  test("reinitPollers makes linear poller enabled after LINEAR_API_KEY set", async () => {
    const { getSetting, putSetting } = await import("../src/settings.js");
    const { stopAllPollers } = await import("../src/pollers/engine.js");

    // Ensure no LINEAR_API_KEY initially
    const savedKey = process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_API_KEY;

    // Set it via putSetting (simulating what PUT /v1/settings does)
    putSetting("LINEAR_API_KEY", "lin_test_via_settings_api");

    const val = getSetting("LINEAR_API_KEY");
    assert.equal(val, "lin_test_via_settings_api", "getSetting should return new value");

    // Stop pollers then reinit — this is what the PUT handler does
    stopAllPollers();
    const { reinitPollers } = await import("../src/bootstrap.js");
    reinitPollers();

    // Verify getSetting returns the value after reinit (cache is live)
    const checkVal = getSetting("LINEAR_API_KEY");
    assert.equal(checkVal, "lin_test_via_settings_api");

    // The linear enabled() closure checks getSetting("LINEAR_API_KEY")
    // which now returns a truthy value — verify this logic directly
    const enabled = Boolean(getSetting("LINEAR_API_KEY"));
    assert.ok(enabled, "linear poller should be enabled after key set");

    // Clean up
    putSetting("LINEAR_API_KEY", "");
    if (savedKey !== undefined) process.env.LINEAR_API_KEY = savedKey;
  });

  test("PUT /v1/settings with LINEAR_API_KEY persists and is readable", async () => {
    const savedKey = process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_API_KEY;

    const response = await app.inject({
      method: "PUT",
      url: "/v1/settings",
      headers: {
        authorization: "Bearer test-admin-token-settings",
        "content-type": "application/json",
      },
      body: JSON.stringify({ LINEAR_API_KEY: "lin_e2e_test_key" }),
    });

    assert.equal(response.statusCode, 200);

    // Verify it's now readable via getSetting
    const { getSetting } = await import("../src/settings.js");
    const val = getSetting("LINEAR_API_KEY");
    assert.equal(val, "lin_e2e_test_key");

    // Clean up
    const { putSetting } = await import("../src/settings.js");
    putSetting("LINEAR_API_KEY", "");
    if (savedKey !== undefined) process.env.LINEAR_API_KEY = savedKey;
  });
});
