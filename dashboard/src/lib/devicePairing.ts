// Pairing tickets are signed, short-lived and stateless until browser approval.
// The browser never receives the CLI's redemption secret. All store mutations
// are synchronous so approval/redemption cannot interleave within this process.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { loadAuthStore, saveAuthStore, mintPat, userCanAccess, type AuthUser } from "./authStore";
export interface Ticket { id: string; project: string; machine: string; workspace: string; challenge: string; exp: number }
export interface Pairing { id: string; userId: string; exp: number; consumed?: boolean; denied?: boolean }
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function store() { const s = loadAuthStore(); if (!s) throw new Error("Authentication unavailable"); return s; }
export function startPairing(project: string, machine: string, workspace: string, challenge: string) {
  if (!/^[a-f0-9]{64}$/.test(challenge) || !machine || !workspace || machine.length > 100 || workspace.length > 100 || /[\x00-\x1f\x7f]/.test(machine + workspace)) throw new Error("Invalid setup request");
  const t: Ticket = { id: randomBytes(16).toString("hex"), project, machine, workspace, challenge, exp: Date.now() + 10 * 60_000 };
  const payload = Buffer.from(JSON.stringify(t)).toString("base64url");
  return { ticket: payload + "." + createHmac("sha256", store().sessionSecret).update(payload).digest("base64url"), code: t.id.slice(0, 8).toUpperCase() };
}
export function readTicket(ticket: string): Ticket {
  if (typeof ticket !== "string" || ticket.length > 2048) throw new Error("Invalid setup request");
  const [payload, sig, extra] = ticket.split(".");
  const expected = createHmac("sha256", store().sessionSecret).update(payload || "").digest("base64url");
  if (extra || !sig || sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) throw new Error("Invalid setup request");
  const t = JSON.parse(Buffer.from(payload, "base64url").toString()) as Ticket;
  if (t.exp <= Date.now()) throw new Error("Setup request expired; run setup again");
  return t;
}
export function approvePairing(ticket: string, user: AuthUser, denied = false) {
  const t = readTicket(ticket), s = store();
  if (!userCanAccess(user, t.project, s)) throw new Error("Project access denied");
  s.pairings = (s.pairings ?? []).filter(p => p.exp > Date.now());
  if (s.pairings.some(p => p.id === t.id)) throw new Error("Setup request already answered");
  if (s.pairings.length >= 1000) throw new Error("Too many setup requests; try later");
  s.pairings.push({ id: t.id, userId: user.id, exp: t.exp, denied });
  saveAuthStore(s);
}
export function redeemPairing(ticket: string, secret: string) {
  const t = readTicket(ticket), s = store();
  if (typeof secret !== "string" || secret.length > 128 || hash(secret) !== t.challenge) throw new Error("Invalid setup secret");
  const p = s.pairings?.find(p => p.id === t.id);
  if (!p) return { status: "pending" };
  if (p.denied || p.consumed) throw new Error("Setup request denied or already used");
  const user = s.users.find(u => u.id === p.userId);
  if (!user || !userCanAccess(user, t.project, s)) throw new Error("Project access revoked");
  const { token, record } = mintPat(user.id, `${t.workspace} on ${t.machine}`);
  record.projects = [t.project];
  record.workspace = { machine: t.machine, repo: t.workspace, harnesses: [], configuredAt: null };
  p.consumed = true;
  s.tokens.push(record);
  saveAuthStore(s);
  return { status: "approved", token, project: t.project, user: user.email };
}
