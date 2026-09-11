import { createPackage } from "@electron/asar";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { verifyPackagedBundleIsSelfContained } from "./build-desktop-artifact.ts";

const packagedFixture = Effect.fn("packagedFixture")(function* (includeDependency: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "flow-brain-package-test-" });
  const app = path.join(root, "app");
  const dist = path.join(app, "apps/server/dist");
  yield* fs.makeDirectory(dist, { recursive: true });
  yield* fs.writeFileString(path.join(dist, "bin.mjs"), 'console.log("1.0.0");');
  yield* fs.writeFileString(
    path.join(dist, "brain-runtime.mjs"),
    'import "flow-test-catalog-dependency"; if (!process.argv.includes("--catalog")) process.exit(2);',
  );
  if (includeDependency) {
    const dependency = path.join(app, "node_modules/flow-test-catalog-dependency");
    yield* fs.makeDirectory(dependency, { recursive: true });
    yield* fs.writeFileString(
      path.join(dependency, "package.json"),
      '{"name":"flow-test-catalog-dependency","type":"module","exports":"./index.js"}',
    );
    yield* fs.writeFileString(path.join(dependency, "index.js"), "export const tools = [];");
  }
  const archive = path.join(root, "app.asar");
  yield* Effect.promise(() => createPackage(app, archive));
  return archive;
});

it.layer(NodeServices.layer)("packaged Brain startup", (it) => {
  it.effect("rejects a missing worker dependency even when the server version check passes", () =>
    Effect.gen(function* () {
      const asarPath = yield* packagedFixture(false);
      const error = yield* verifyPackagedBundleIsSelfContained({ asarPath, verbose: false }).pipe(
        Effect.flip,
      );
      assert.equal(error._tag, "BundleNotSelfContainedError");
      assert.include(error.message, "flow-test-catalog-dependency");
      assert.include(error.message, "brain-runtime.mjs --catalog");
    }).pipe(Effect.scoped),
  );

  it.effect("loads the catalog using only dependencies inside the packaged archive", () =>
    Effect.gen(function* () {
      const asarPath = yield* packagedFixture(true);
      yield* verifyPackagedBundleIsSelfContained({ asarPath, verbose: false });
    }).pipe(Effect.scoped),
  );
});
