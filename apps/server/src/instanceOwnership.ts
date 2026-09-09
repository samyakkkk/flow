// @effect-diagnostics nodeBuiltinImport:off - Process-lifetime ownership of a local data directory.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { PersistedServerRuntimeState, isProcessAlive } from "./serverRuntimeState.ts";

export class InstanceOwnershipError extends Schema.TaggedError<InstanceOwnershipError>()(
  "InstanceOwnershipError",
  { message: Schema.String },
) {}

const isOwnershipError = Schema.is(InstanceOwnershipError);
const decodeRuntime = Schema.decodeUnknownSync(Schema.fromJsonString(PersistedServerRuntimeState));

/** SQLite's OS lock is released even after a crash. Never delete this file:
 * unlinking a locked inode would allow two owners of the same data directory.
 * This database contains no application data and is independent of chat writes.
 */
export async function acquireInstanceOwnership(stateDir: string) {
  await NodeFSP.mkdir(stateDir, { recursive: true });
  const filename = NodePath.join(stateDir, "instance-lock.sqlite");
  const db = process.versions.bun
    ? new (await import("bun:sqlite")).Database(filename)
    : new (await import("node:sqlite")).DatabaseSync(filename);
  try {
    db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
  } catch (cause) {
    db.close();
    throw new InstanceOwnershipError({
      message: `This app's data directory is already in use (${stateDir}). Open the running app; chat and brain must run together in one server. ${cause instanceof Error ? cause.message : ""}`,
    });
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    db.close();
  };
  try {
    // Also protect upgrades from a server launched before ownership locking.
    const saved = await NodeFSP.readFile(
      NodePath.join(stateDir, "server-runtime.json"),
      "utf8",
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (saved) {
      const owner = decodeRuntime(saved);
      if (owner.pid !== process.pid && isProcessAlive(owner.pid)) {
        throw new InstanceOwnershipError({
          message: `This app is already running at ${owner.devUrl ?? owner.origin} (process ${owner.pid}). Open that app instead. Chat and brain share one server.`,
        });
      }
    }
    return release;
  } catch (error) {
    release();
    throw error;
  }
}

export const ownInstance = (stateDir: string) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () => acquireInstanceOwnership(stateDir),
      catch: (cause) =>
        isOwnershipError(cause)
          ? cause
          : new InstanceOwnershipError({
              message: `Could not acquire ownership of ${stateDir}: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
    }),
    (release) => Effect.sync(release),
  );
