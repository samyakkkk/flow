import * as FS from "node:fs";
import * as Path from "node:path";
import Database from "better-sqlite3";
import { CurationStore } from "../src/curation/store.js";
import { memoryFingerprint } from "../src/curation/migration.js";
import { CURATOR_INSTRUCTIONS } from "../src/curation/prompt.js";

// Run with the orchestrator's TS loader, e.g. node --import tsx/esm scripts/prepare-curation-migration.ts SOURCE_DB NEW_DIRECTORY.
// This command only prepares isolated data. It never opens the source read-write,
// starts extraction, updates the running instance, or copies a DB back over it.
const [sourcePath, outputPath] = process.argv.slice(2);
if (!sourcePath || !outputPath || process.argv.length !== 4)
  throw new Error("Usage: prepare-curation-migration.ts SOURCE_DB NEW_DIRECTORY");
process.umask(0o077);
const source = FS.realpathSync(sourcePath);
const output = Path.resolve(outputPath);
FS.mkdirSync(output, { mode: 0o700 }); // Refuse an existing plan, including accidental retries.
const live = new Database(source, { readonly: true, fileMustExist: true });
try {
  await live.backup(Path.join(output, "original.sqlite"));
} finally {
  live.close();
}
const original = new Database(Path.join(output, "original.sqlite"), { readonly: true });
const before = memoryFingerprint(original);
await original.backup(Path.join(output, "baseline.sqlite"));
original.close();
const baseline = new Database(Path.join(output, "baseline.sqlite"));
try {
  baseline.pragma("foreign_keys = ON");
  const store = new CurationStore(baseline);
  if (memoryFingerprint(baseline) !== before) throw new Error("Schema upgrade changed existing memories.");
  if (baseline.pragma("integrity_check", { simple: true }) !== "ok" ||
      (baseline.pragma("foreign_key_check") as unknown[]).length)
    throw new Error("Snapshot integrity validation failed.");
  baseline.exec("INSERT INTO brain_documents_fts(brain_documents_fts,rank) VALUES('integrity-check',1)");
  const sessions = baseline.prepare(`SELECT c.session AS sessionId, MIN(c.seq) AS firstSeq,
    MAX(c.seq) AS through, COUNT(*) AS capturedEvents FROM t3_capture c
    WHERE EXISTS (SELECT 1 FROM t3_capture p WHERE p.session=c.session AND p.kind='user_prompt')
    GROUP BY c.session ORDER BY MIN(c.seq)`).all();
  await baseline.backup(Path.join(output, "staged.sqlite"));
  FS.writeFileSync(Path.join(output, "prompt.md"), CURATOR_INSTRUCTIONS);
  FS.writeFileSync(Path.join(output, "manifest.json"), JSON.stringify({
    version: 1, state: "prepared-not-generated", source, preparedAt: new Date().toISOString(),
    memoryFingerprint: before, sessions,
    documents: store.list({ includeInactive: true }).map(({ id, kind, revision, sessionId }) => ({ id, kind, revision, sessionId })),
  }, null, 2));
  console.log(JSON.stringify({ output, sessions: sessions.length, memoryPreserved: true,
    integrity: "ok", state: "prepared-not-generated" }));
} finally {
  baseline.close();
}
