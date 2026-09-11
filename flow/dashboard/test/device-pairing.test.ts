import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

test("browser pairing: possession, grants, expiry, denial, one-time redemption and project scope", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flow-pairing-"));
  process.env.FLOW_AUTH_PATH = join(dir, "auth.json");
  process.env.FLOW_PROJECT_NAME = "other-team";
  const { startPairing, readTicket, approvePairing, redeemPairing } = await import("../src/lib/devicePairing.ts");
  const { loadAuthStore, saveAuthStore } = await import("../src/lib/authStore.ts");
  const member = { id: "employee", role: "member" as const, email: "employee@example.invalid", createdAt: "", passwordHash: "" };
  writeFileSync(process.env.FLOW_AUTH_PATH, JSON.stringify({ version: 1, sessionSecret: "test-only", users: [member], grants: { employee: ["engineering", "other-team"] }, tokens: [] }));
  const secret = "cli-private-secret", challenge = createHash("sha256").update(secret).digest("hex");
  const request = () => startPairing("engineering", "Test laptop", "payments", challenge);
  try {
    const { ticket } = request();
    assert.equal(redeemPairing(ticket, secret).status, "pending");
    assert.throws(() => redeemPairing(ticket, "browser-does-not-have-secret"));
    assert.throws(() => readTicket(ticket + "x"));
    assert.throws(() => approvePairing(ticket, { ...member, id: "outsider" }));
    approvePairing(ticket, member);
    approvePairing(ticket, member); // Same browser retry is idempotent.
    assert.equal(loadAuthStore()!.pairings!.length, 1);
    const redeemed = redeemPairing(ticket, secret);
    assert.equal(redeemed.status, "approved");
    assert.deepEqual(loadAuthStore()!.tokens[0].projects, ["engineering"]);
    assert.throws(() => redeemPairing(ticket, secret), /already/);
    const { verifyPatForProject } = await import("../../shared/pat-auth.ts");
    assert.equal(verifyPatForProject(redeemed.token!), null, "cannot use a scoped PAT in another granted project");
    const denied = request(); approvePairing(denied.ticket, member, true);
    assert.throws(() => redeemPairing(denied.ticket, secret), /denied/);
    const revoked = request(); approvePairing(revoked.ticket, member);
    const s = loadAuthStore()!; s.grants.employee = []; saveAuthStore(s);
    assert.throws(() => redeemPairing(revoked.ticket, secret), /revoked/);
    const now = Date.now; const exp = request();
    try { Date.now = () => now() + 11 * 60_000; assert.throws(() => readTicket(exp.ticket), /expired/); } finally { Date.now = now; }
    assert.throws(() => startPairing("engineering", "bad\nterminal", "payments", challenge));
    assert.throws(() => startPairing("engineering", {} as string, "payments", challenge));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
