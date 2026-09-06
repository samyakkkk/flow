// Deployment-level auth store — users, per-project grants, personal access
// tokens (PATs), and the session-cookie signing secret. One JSON file for the
// whole deployment (data/auth.json, created by `flow up`), shared read-only
// with the graph-gateway processes so a PAT gates MCP access with the same
// grants that gate the dashboard.
//
// Passwords: scrypt (random salt). PATs: "flowpat_<id>_<secret>" — only
// sha256(secret) is stored, the full token is shown once at mint time.
// Sessions: HMAC-SHA256-signed cookie payload {uid, exp}; grants are checked
// server-side on every request, so revocation is instant (no cookie dance).
import fs from "node:fs";
import {
  createHmac,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { FLOW_AUTH_PATH } from "./config";

export interface AuthUser {
  id: string;
  email: string;
  role: "owner" | "member";
  passwordHash: string; // scrypt:<saltB64>:<hashB64>
  createdAt: string;
}

export interface WorkspaceConnection { id?: string; machine: string; repo: string; harnesses: string[]; configuredAt: string | null }

export interface AuthToken {
  id: string;
  userId: string;
  label: string;
  projects?: string[]; // Absent only for legacy, user-wide PATs.
  workspace?: WorkspaceConnection;
  workspaces?: WorkspaceConnection[];
  hash: string; // sha256:<hex>
  createdAt: string;
}

export interface AuthStore {
  version: number;
  sessionSecret: string;
  setupToken?: string; // present until the first owner account exists
  users: AuthUser[];
  grants: Record<string, string[]>; // userId -> project names, or ["*"]
  tokens: AuthToken[];
  pairings?: import("./devicePairing").Pairing[];
}

const CACHE_TTL_MS = 2000;
let cache: { at: number; mtimeMs: number; store: AuthStore } | null = null;

export function loadAuthStore(): AuthStore | null {
  try {
    const stat = fs.statSync(FLOW_AUTH_PATH);
    const now = Date.now();
    if (cache && cache.mtimeMs === stat.mtimeMs && now - cache.at < CACHE_TTL_MS) {
      return cache.store;
    }
    const store = JSON.parse(fs.readFileSync(FLOW_AUTH_PATH, "utf-8")) as AuthStore;
    cache = { at: now, mtimeMs: stat.mtimeMs, store };
    return store;
  } catch {
    return null; // no auth store yet — flow up creates it; local mode never needs it
  }
}

export function saveAuthStore(store: AuthStore): void {
  fs.writeFileSync(FLOW_AUTH_PATH, JSON.stringify(store, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  cache = null;
}

// ── Passwords ────────────────────────────────────────────────────────────────

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `scrypt:${salt.toString("base64")}:${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(":");
  if (parts[0] !== "scrypt" || parts.length !== 3) return false;
  try {
    const salt = Buffer.from(parts[1], "base64");
    const expected = Buffer.from(parts[2], "base64");
    const actual = scryptSync(password, salt, expected.length);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// ── Sessions (signed cookie) ─────────────────────────────────────────────────

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function mintSession(userId: string, maxAgeSeconds: number, store: AuthStore): string {
  const payload = Buffer.from(
    JSON.stringify({ uid: userId, exp: Math.floor(Date.now() / 1000) + maxAgeSeconds })
  ).toString("base64url");
  return `${payload}.${sign(payload, store.sessionSecret)}`;
}

/** Verify a session cookie value → the live user, or null. */
export function verifySession(cookieValue: string | undefined | null): AuthUser | null {
  if (!cookieValue) return null;
  const store = loadAuthStore();
  if (!store) return null;
  const dot = cookieValue.lastIndexOf(".");
  if (dot < 1) return null;
  const payload = cookieValue.slice(0, dot);
  const sig = cookieValue.slice(dot + 1);
  const expected = sign(payload, store.sessionSecret);
  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  try {
    const { uid, exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as {
      uid: string;
      exp: number;
    };
    if (typeof exp !== "number" || exp * 1000 < Date.now()) return null;
    return store.users.find((u) => u.id === uid) ?? null;
  } catch {
    return null;
  }
}

// ── Grants ───────────────────────────────────────────────────────────────────

/** Can this user access this project? Owners always can. */
export function userCanAccess(user: AuthUser, project: string, store?: AuthStore | null): boolean {
  if (user.role === "owner") return true;
  const s = store ?? loadAuthStore();
  const grants = s?.grants?.[user.id] ?? [];
  return grants.includes("*") || grants.includes(project);
}

/** Project names this user may see (null = all). */
export function userProjectFilter(user: AuthUser, store?: AuthStore | null): string[] | null {
  if (user.role === "owner") return null;
  const s = store ?? loadAuthStore();
  const grants = s?.grants?.[user.id] ?? [];
  return grants.includes("*") ? null : grants;
}

// ── Personal access tokens ───────────────────────────────────────────────────

export function mintPat(userId: string, label: string): { token: string; record: AuthToken } {
  const id = randomBytes(4).toString("hex");
  const secret = randomBytes(16).toString("hex");
  const record: AuthToken = {
    id,
    userId,
    label,
    hash: `sha256:${createHash("sha256").update(secret).digest("hex")}`,
    createdAt: new Date().toISOString(),
  };
  return { token: `flowpat_${id}_${secret}`, record };
}

/** Verify a PAT string → its live user, or null. */
export function verifyPat(token: string): AuthUser | null {
  const m = token.match(/^flowpat_([0-9a-f]{8})_([0-9a-f]{32})$/);
  if (!m) return null;
  const store = loadAuthStore();
  if (!store) return null;
  const record = store.tokens.find((t) => t.id === m[1]);
  if (!record) return null;
  const expected = record.hash.replace(/^sha256:/, "");
  const actual = createHash("sha256").update(m[2]).digest("hex");
  try {
    if (!timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"))) return null;
  } catch {
    return null;
  }
  return store.users.find((u) => u.id === record.userId) ?? null;
}
