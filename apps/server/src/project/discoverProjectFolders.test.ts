import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { discoverProjectFolders } from "./discoverProjectFolders.ts";

it.layer(NodeServices.layer)("discoverProjectFolders", (it) => {
  it.effect("finds nested repositories without registering their parent or dependencies", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const realRoot = yield* fs.realPath(root);
      yield* fs.makeDirectory(path.join(root, "team", "one", ".git"), { recursive: true });
      yield* fs.makeDirectory(path.join(root, "two", ".git"), { recursive: true });
      yield* fs.makeDirectory(path.join(root, "node_modules", "ignored", ".git"), {
        recursive: true,
      });
      const result = yield* discoverProjectFolders(root);
      expect(result.paths.map((p) => path.relative(realRoot, p)).sort()).toEqual([
        path.join("team", "one"),
        "two",
      ]);
      expect(result.truncated).toBe(false);
    }),
  );
  it.effect("accepts plain folders and worktree Git files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      expect((yield* discoverProjectFolders(root)).paths).toHaveLength(1);
      yield* fs.writeFileString(path.join(root, ".git"), "gitdir: /some/repo/.git/worktrees/test");
      expect((yield* discoverProjectFolders(root)).paths).toHaveLength(1);
    }),
  );
  it.effect("does not follow symlink cycles or repositories outside the selected tree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const other = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(path.join(other, ".git"));
      yield* fs.symlink(other, path.join(root, "outside"));
      yield* fs.symlink(root, path.join(root, "cycle"));
      expect((yield* discoverProjectFolders(root)).paths).toHaveLength(1);
    }),
  );
  it.effect("reports missing selected roots", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const result = yield* discoverProjectFolders(path.join(root, "missing")).pipe(Effect.exit);
      expect(result._tag).toBe("Failure");
    }),
  );
});
