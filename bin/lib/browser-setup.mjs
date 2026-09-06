import { randomBytes, createHash } from "node:crypto";
import { hostname } from "node:os";
import { basename } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { connectionUrl, discoverRemote } from "./remote-setup.mjs";
export function setupTarget(value) {
  const url = new URL(connectionUrl(value));
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 1 || !/^[a-zA-Z0-9_-]+$/.test(parts[0])) throw new Error("Use the dashboard project URL, e.g. https://flow.company.com/engineering");
  return { project: parts[0], origin: url.origin };
}
async function post(origin, body, token) {
  const res = await fetch(origin + "/api/auth/device", { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(15_000) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Setup failed (${res.status})`);
  return data;
}
export async function reuseBrowserConnection(value, saved, discover = discoverRemote) {
  const { project, origin } = setupTarget(value);
  if (!saved) return null;
  if (new URL(saved.gatewayUrl).origin !== origin || new URL(saved.orchestratorUrl).origin !== origin) throw new Error("A different deployment is already saved under this project name.");
  try {
    await discover({ ...saved, project });
    return { ...saved, project, origin };
  } catch (error) {
    if (error.status === 401 || error.status === 403) return null;
    throw error; // Outages/identity mismatches are not a reason to mint credentials.
  }
}
export async function browserSetup(value, repoDir, defaults, all, saved = null) {
  const { project, origin } = setupTarget(value);
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Browser setup requires an interactive terminal for local workspace approval.");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let harnesses;
  try {
    console.log(`\nConnect ${repoDir} to ${origin}/${project}\nDetected/selected tools: ${defaults.join(", ") || "none"}\nAvailable: ${all.join(", ")}\nThis installs project knowledge access and workspace session capture. It does not enable remote execution.`);
    const answer = await rl.question("Tools to connect (comma-separated; Enter keeps selection): ");
    harnesses = answer.trim() ? answer.split(",").map(s => s.trim()) : defaults;
    if (!harnesses.length || harnesses.some(h => !all.includes(h))) throw new Error("Select at least one supported tool.");
    if ((await rl.question(`Install Flow for ${harnesses.join(", ")} in this repository? [y/N] `)).trim().toLowerCase() !== "y") throw new Error("Setup canceled; no integration installed.");
  } finally { rl.close(); }
  const reused = await reuseBrowserConnection(value, saved);
  if (reused) {
    console.log("Reusing the saved authorized connection; browser approval is not needed.");
    return { ...reused, harnesses, repoDir };
  }
  const secret = randomBytes(32).toString("hex");
  const { ticket, code } = await post(origin, { action: "start", project, machine: hostname(), workspace: basename(repoDir), challenge: createHash("sha256").update(secret).digest("hex") });
  const url = `${origin}/connect?ticket=${encodeURIComponent(ticket)}`;
  console.log(`\nConfirm code ${code} in your browser. Approve only if it matches.\n${url}\nWaiting for browser approval…`);
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
  const child = spawn(command, [url], { stdio: "ignore", detached: true });
  child.on("error", () => console.log("Open the URL above in your browser.")); child.unref();
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    const result = await post(origin, { action: "poll", ticket, secret });
    if (result.status === "approved") {
      console.log(`Approved by ${result.user}. Verifying project knowledge and capture endpoints…`);
      return { project, origin, token: result.token, harnesses, repoDir, gatewayUrl: `${origin}/api/connect/${project}/gateway`, orchestratorUrl: `${origin}/api/connect/${project}/orchestrator` };
    }
  }
  throw new Error("Setup expired; run the command again.");
}
export async function completeBrowserSetup(connection, harnesses) {
  await post(connection.origin, { action: "complete", harnesses, workspace: basename(connection.repoDir), machine: hostname(), workspaceId: createHash("sha256").update(connection.token + connection.repoDir).digest("hex") }, connection.token);
}
