import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const ignored = new Set(["node_modules", "vendor", "dist", "build", "target"]);

/** Discover repositories under a user-selected folder without traversing links or dependencies. */
export const discoverProjectFolders = Effect.fn("discoverProjectFolders")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolved = yield* fs.realPath(root);
  const queue = [{ directory: resolved, depth: 0 }];
  const repositories: string[] = [];
  let truncated = false;
  let visited = 0;
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (++visited > 5000) {
      truncated = true;
      break;
    }
    const entries = yield* fs.readDirectory(next.directory).pipe(
      Effect.catch((error) => {
        if (next.depth === 0) return Effect.fail(error);
        truncated = true;
        return Effect.succeed([] as string[]);
      }),
    );
    if (entries.includes(".git")) {
      repositories.push(next.directory);
      continue;
    }
    for (const name of entries.sort()) {
      if (name.startsWith(".") || ignored.has(name)) continue;
      const directory = path.join(next.directory, name);
      const isLink = yield* fs.readLink(directory).pipe(
        Effect.map(() => true),
        Effect.orElseSucceed(() => false),
      );
      if (isLink) continue;
      const isDirectory = yield* fs.stat(directory).pipe(
        Effect.map((info) => info.type === "Directory"),
        Effect.orElseSucceed(() => false),
      );
      if (!isDirectory) continue;
      if (next.depth >= 8) {
        truncated = true;
        continue;
      }
      queue.push({ directory, depth: next.depth + 1 });
    }
  }
  return { paths: repositories.length > 0 ? repositories : [resolved], truncated };
});
