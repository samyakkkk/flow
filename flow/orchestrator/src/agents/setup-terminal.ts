import { chmodSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { IPty } from "node-pty";
import { requestCodingSlot, attachCodingChild, releaseCodingSlot, codingSlotStatus } from "./coding-slot.js";
import { getSetupRequest, saveSetupRequest } from "./setup-requests.js";
import { conversationRepos } from "./cloud-workspaces.js";
import { getJob, codingChildPid } from "../opencode.js";

interface Terminal { pty: IPty; output: string; offset: number; touched: number; started: number; exited: boolean }
const terminals = new Map<string, Terminal>();
const lease = (id: string) => `setup-terminal:${id}`;
const waiting = new Map<string, number>();
const opening = new Map<string, Promise<{ queued: boolean }>>();
export async function openSetupTerminal(id: string): Promise<{ queued: boolean }> {
  const existing = opening.get(id);
  if (existing) return existing;
  const promise = openTerminal(id); opening.set(id, promise);
  try { return await promise; } finally { opening.delete(id); }
}
async function openTerminal(id: string): Promise<{ queued: boolean }> {
  const request = getSetupRequest(id);
  if (!request || request.kind !== "terminal" || request.state !== "waiting") throw new Error("This setup terminal is no longer waiting");
  const existing = terminals.get(id);
  if (existing && !existing.exited) { existing.touched = Date.now(); return { queued: false }; }
  if (["queued", "running"].includes(getJob(request.job)?.status ?? "") || codingChildPid(request.job)) return { queued: true };
  waiting.set(id, Date.now());
  if (!requestCodingSlot(lease(id)).acquired) return { queued: true };
  let spawned: IPty | undefined;
  try {
    const repo = conversationRepos(request.conversation).find(r => r.name === request.repo);
    if (!repo) throw new Error("Repository is no longer registered");
    // node-pty 1.1.0 ships its macOS spawn helper without executable mode.
    if (process.platform === "darwin") {
      const packageDir = path.dirname(createRequire(import.meta.url).resolve("node-pty/package.json"));
      const helper = path.join(packageDir, "prebuilds", `darwin-${process.arch}`, "spawn-helper");
      if (existsSync(helper)) chmodSync(helper, 0o755);
    }
    const { spawn } = await import("node-pty");
    if (codingSlotStatus(lease(id)) !== "coding" || getSetupRequest(id)?.state !== "waiting") throw new Error("Terminal opening was cancelled");
    // No admin/job tokens in the terminal environment. Login shells read the same user's CLI setup.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !/TOKEN|SECRET|PASSWORD|API_KEY/.test(key))) as Record<string, string>;
    const pty = spawn(process.env.SHELL || "/bin/bash", ["-l"], { name: "xterm-256color", cols: 100, rows: 28, cwd: repo.source, env: { ...env, HISTFILE: "/dev/null", TERM: "xterm-256color" } });
    spawned = pty;
    attachCodingChild(lease(id), pty.pid);
    const terminal: Terminal = { pty, output: "", offset: 0, touched: Date.now(), started: Date.now(), exited: false };
    terminals.set(id, terminal); waiting.delete(id);
    pty.onData(data => {
      terminal.output += data;
      if (terminal.output.length > 256_000) { const drop = terminal.output.length - 256_000; terminal.output = terminal.output.slice(drop); terminal.offset += drop; }
    });
    pty.onExit(() => { terminal.exited = true; releaseCodingSlot(lease(id)); });
    return { queued: false };
  } catch { if (spawned) { try { spawned.kill("SIGKILL"); } catch {} } waiting.delete(id); releaseCodingSlot(lease(id)); throw new Error("Could not start a setup terminal on this host"); }
}
export function readSetupTerminal(id: string, cursor = 0) {
  const terminal = terminals.get(id);
  if (!terminal) return { output: "", cursor: 0, active: false };
  terminal.touched = Date.now();
  const reset = cursor < terminal.offset || cursor > terminal.offset + terminal.output.length;
  return { output: terminal.output.slice(reset ? 0 : Math.max(0, cursor - terminal.offset)), cursor: terminal.offset + terminal.output.length, active: !terminal.exited, reset };
}
export function writeSetupTerminal(id: string, data: string, cols?: number, rows?: number): void {
  const terminal = terminals.get(id);
  if (!terminal || terminal.exited || getSetupRequest(id)?.state !== "waiting") throw new Error("Open the setup terminal first");
  if (typeof data !== "string" || data.length > 16_384) throw new Error("Terminal input is too large");
  terminal.touched = Date.now();
  if (cols !== undefined && rows !== undefined && Number.isInteger(cols) && Number.isInteger(rows) && cols >= 20 && cols <= 300 && rows >= 5 && rows <= 100) terminal.pty.resize(cols, rows);
  terminal.pty.write(data);
}
export function closeSetupTerminal(id: string, complete = false): void {
  const terminal = terminals.get(id);
  if (terminal) { try { terminal.pty.kill("SIGKILL"); } catch {} terminals.delete(id); }
  waiting.delete(id); releaseCodingSlot(lease(id));
  if (complete) {
    const request = getSetupRequest(id);
    if (!request || request.kind !== "terminal" || request.state !== "waiting") throw new Error("Setup request is not waiting");
    request.state = "ready"; saveSetupRequest(request);
  }
}
export function sweepSetupTerminals(): void {
  const cutoff = Date.now() - 5 * 60_000;
  for (const [id, terminal] of terminals) if (terminal.touched < cutoff || terminal.started < Date.now() - 60 * 60_000 || getSetupRequest(id)?.state !== "waiting") closeSetupTerminal(id);
  for (const [id, touched] of waiting) if (touched < Date.now() - 30_000) closeSetupTerminal(id);
}
export function stopSetupTerminals(): void {
  for (const id of new Set([...terminals.keys(), ...waiting.keys()])) closeSetupTerminal(id);
}
