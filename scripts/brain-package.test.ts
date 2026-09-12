import { createPackage } from "@electron/asar";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  findPackagedAppArchives,
  verifyPackagedBundleIsSelfContained,
} from "./build-desktop-artifact.ts";

const packagedFixture = Effect.fn("packagedFixture")(function* (
  includeDependency: boolean,
  includeTransitiveDependency = true,
  serverSource = 'console.log("1.0.0");',
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "flow-brain-package-test-" });
  const app = path.join(root, "app");
  const dist = path.join(app, "apps/server/dist");
  yield* fs.makeDirectory(dist, { recursive: true });
  yield* fs.writeFileString(path.join(dist, "bin.mjs"), serverSource);
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
    yield* fs.writeFileString(
      path.join(dependency, "index.js"),
      'import "flow-test-transitive"; export const tools = [];',
    );
    if (includeTransitiveDependency) {
      const transitive = path.join(dependency, "node_modules/flow-test-transitive");
      yield* fs.makeDirectory(transitive, { recursive: true });
      yield* fs.writeFileString(
        path.join(transitive, "package.json"),
        '{"name":"flow-test-transitive","type":"module","exports":"./index.js"}',
      );
      yield* fs.writeFileString(path.join(transitive, "index.js"), "export const value = 1;");
    }
  }
  const archive = path.join(root, "app.asar");
  yield* Effect.promise(() => createPackage(app, archive));
  return archive;
});

it.layer(NodeServices.layer)("packaged Brain startup", (it) => {
  it.effect("runs the supplied Electron runtime in Node mode", () =>
    Effect.gen(function* () {
      const asarPath = yield* packagedFixture(
        true,
        true,
        'if (process.env.ELECTRON_RUN_AS_NODE !== "1") process.exit(9);',
      );
      yield* verifyPackagedBundleIsSelfContained({
        asarPath,
        verbose: false,
        electronExecutable: process.execPath,
      });
    }).pipe(Effect.scoped),
  );

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

  it.effect("rejects an external package whose transitive dependency was not shipped", () =>
    Effect.gen(function* () {
      const asarPath = yield* packagedFixture(true, false);
      const error = yield* verifyPackagedBundleIsSelfContained({ asarPath, verbose: false }).pipe(
        Effect.flip,
      );
      assert.equal(error._tag, "BundleNotSelfContainedError");
      assert.include(error.message, "flow-test-transitive");
    }).pipe(Effect.scoped),
  );
});

it.layer(NodeServices.layer)("packaged archive discovery", (it) => {
  for (const platform of ["mac", "linux"] as const) {
    it.effect(`finds the ${platform} archive beside installer files`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "flow-archive-discovery-" });
        for (const file of ["Flow.dmg", "Flow.zip", "Flow.AppImage", "latest.yml"]) {
          yield* fs.writeFileString(path.join(root, file), "installer");
        }
        const archive =
          platform === "mac"
            ? path.join(root, "mac-arm64/Flow.app/Contents/Resources/app.asar")
            : path.join(root, "linux-unpacked/resources/app.asar");
        yield* fs.makeDirectory(path.dirname(archive), { recursive: true });
        yield* fs.writeFileString(archive, "archive");
        assert.deepStrictEqual(
          yield* findPackagedAppArchives({ stageDistDir: root, platform, productName: "Flow" }),
          [archive],
        );
        yield* fs.remove(path.dirname(archive), { recursive: true });
        const error = yield* findPackagedAppArchives({
          stageDistDir: root,
          platform,
          productName: "Flow",
        }).pipe(Effect.flip);
        assert.equal(error._tag, "BundleNotSelfContainedError");
      }).pipe(Effect.scoped),
    );
  }
});
