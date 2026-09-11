// One coding slot across projects run by this OS user. This is coordination,
// not a security sandbox. Never expire a live owner merely because it is slow.
import Database from "better-sqlite3";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

interface Request { id: string; owner: number; identity: string; child: number | null; child_identity: string | null; releasing: number }
let connection: Database.Database | undefined;
function state() {
  if (connection) return connection;
  const dir = process.env.FLOW_CODING_STATE_DIR ?? path.join(homedir(), ".flow", "coding");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  connection = new Database(path.join(dir, "queue.db"));
  connection.pragma("busy_timeout = 5000");
  connection.pragma("journal_mode = WAL");
  connection.exec(`CREATE TABLE IF NOT EXISTS requests (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
    owner INTEGER NOT NULL, identity TEXT NOT NULL, child INTEGER,
    child_identity TEXT, releasing INTEGER NOT NULL DEFAULT 0)`);
  return connection;
}

function proc(pid: number) {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    return { identity: fields[19], group: Number(fields[2]), session: Number(fields[3]), zombie: fields[0] === "Z" };
  } catch { return undefined; }
}
function identity(pid: number): string {
  if (process.platform === "linux") {
    const p = proc(pid);
    return p && !p.zombie ? p.identity : "gone";
  }
  try { process.kill(pid, 0); return "alive"; } catch { return "gone"; }
}
function groupAlive(pid: number): boolean {
  if (process.platform === "linux") {
    return readdirSync("/proc").some((name) => /^\d+$/.test(name) && (() => {
      const p = proc(Number(name)); return Boolean(p && (p.group === pid || p.session === pid) && !p.zombie);
    })());
  }
  try { process.kill(-pid, 0); return true; } catch { return false; }
}
function stopOrphan(row: Request): boolean {
  if (!row.child || !groupAlive(row.child)) return true;
  const now = identity(row.child);
  if (now !== "gone" && now !== row.child_identity) {
    throw new Error("Coding worker PID changed; inspect the machine before clearing its queue entry");
  }
  if (process.platform === "linux") {
    // Interactive terminals put foreground jobs into separate process groups
    // within the same session. Stop those too before admitting another writer.
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      const p = proc(Number(name));
      if (p?.session === row.child) { try { process.kill(-p.group, "SIGKILL"); } catch {} }
    }
  }
  try { process.kill(-row.child, "SIGKILL"); } catch { /* recheck below */ }
  return !groupAlive(row.child);
}

/** Nonblocking FIFO admission. Call again while waiting; reads never call it. */
export function requestCodingSlot(id: string, child?: number): { acquired: boolean; position: number } {
  const db = state();
  return db.transaction(() => {
    for (const row of db.prepare("SELECT * FROM requests ORDER BY seq").all() as Request[]) {
      if (row.releasing || identity(row.owner) !== row.identity) {
        if (stopOrphan(row)) db.prepare("DELETE FROM requests WHERE id = ?").run(row.id);
      }
    }
    db.prepare("INSERT OR IGNORE INTO requests (id, owner, identity, child, child_identity) VALUES (?, ?, ?, ?, ?)")
      .run(id, process.pid, identity(process.pid), child ?? null, child ? identity(child) : null);
    const rows = db.prepare("SELECT id FROM requests ORDER BY seq").all() as { id: string }[];
    const position = rows.findIndex((r) => r.id === id);
    return { acquired: position === 0, position };
  }).immediate();
}

export function codingSlotStatus(id: string): "waiting" | "coding" | undefined {
  if (!connection) return undefined;
  const rows = connection.prepare("SELECT id FROM requests ORDER BY seq").all() as { id: string }[];
  const pos = rows.findIndex((r) => r.id === id);
  return pos < 0 ? undefined : pos === 0 ? "coding" : "waiting";
}

export function releaseCodingSlot(id: string): void {
  if (!connection) return;
  connection.transaction(() => {
    const row = connection!.prepare("SELECT * FROM requests WHERE id = ? AND owner = ?").get(id, process.pid) as Request | undefined;
    if (!row) return;
    // Retain admission until the process group really stops, even on timeout.
    if (stopOrphan(row)) connection!.prepare("DELETE FROM requests WHERE id = ?").run(id);
    else connection!.prepare("UPDATE requests SET releasing = 1 WHERE id = ?").run(id);
  }).immediate();
}

export function attachCodingChild(id: string, child: number): void {
  const result = state().prepare("UPDATE requests SET child = ?, child_identity = ? WHERE id = ? AND owner = ? AND releasing = 0")
    .run(child, identity(child), id, process.pid);
  if (result.changes !== 1) throw new Error("Coding slot was released before command startup");
}
