import { assert, describe, it } from "@effect/vitest";

import serverPackageJson from "../../apps/server/package.json" with { type: "json" };

import {
  findInlinedExternalPackages,
  selectCliRuntimeExternalDependencies,
  shouldBundleCliDependency,
} from "./cli-external-packages.ts";

describe("shouldBundleCliDependency", () => {
  it("bundles ordinary runtime dependencies", () => {
    for (const id of [
      "effect",
      "@effect/platform",
      "hono",
      "@t3tools/shared/hostProcess",
      "ini",
      "cross-spawn",
      "chalk",
      "ms",
    ]) {
      assert.strictEqual(shouldBundleCliDependency(id), true, id);
    }
  });

  it("does not confuse a dependency with a similarly named package", () => {
    assert.strictEqual(shouldBundleCliDependency("better-sqlite3"), false);
    assert.strictEqual(shouldBundleCliDependency("better-sqlite3-helper"), true);
  });

  it("never bundles node: builtins", () => {
    assert.strictEqual(shouldBundleCliDependency("node:fs"), false);
  });

  it("leaves native addons and their dlopen wrappers external", () => {
    for (const id of [
      "node-pty",
      "ffi-rs",
      "@yuuang/ffi-rs-win32-x64-msvc",
      "@ff-labs/fff-node",
      "@clerk/electron-passkeys",
      "msgpackr-extract",
      "@msgpackr-extract/msgpackr-extract-win32-x64",
    ]) {
      assert.strictEqual(shouldBundleCliDependency(id), false, id);
    }
  });

  it("leaves bun-only entry points external", () => {
    assert.strictEqual(shouldBundleCliDependency("@effect/platform-bun"), false);
    assert.strictEqual(shouldBundleCliDependency("@effect/sql-sqlite-bun"), false);
  });

  // The real package is `node-gyp-build-optional-packages`, reached by prefix.
  // Its files are installed through the selected root's dependency manifest.
  it("treats prefix-matched siblings as external", () => {
    assert.strictEqual(shouldBundleCliDependency("node-gyp-build-optional-packages"), false);
  });
});

describe("selectCliRuntimeExternalDependencies", () => {
  it("keeps only runtime-external dependency roots for the Windows sidecar", () => {
    assert.deepStrictEqual(
      selectCliRuntimeExternalDependencies({
        "@effect/platform-bun": "1.0.0",
        "@ff-labs/fff-node": "2.0.0",
        effect: "3.0.0",
        "node-pty": "4.0.0",
      }),
      {
        "@ff-labs/fff-node": "2.0.0",
        "node-pty": "4.0.0",
      },
    );
  });

  it("selects every external root declared by the server", () => {
    assert.deepStrictEqual(
      Object.keys(selectCliRuntimeExternalDependencies(serverPackageJson.dependencies)).sort(),
      [
        "@ff-labs/fff-node",
        "better-sqlite3",
        "falkordb",
        "falkordblite",
        "jsonc-parser",
        "msgpackr-extract",
        "node-llama-cpp",
        "node-pty",
      ],
    );
  });
});

// Configuring the bundler is not the same as checking what it emitted. These
// exercise the scanner against the marker shape rolldown actually produces.
describe("findInlinedExternalPackages", () => {
  const region = (path: string) => `//#region ${path}
var x = 1;
//#endregion
`;

  it("flags an external package that was inlined", () => {
    const source =
      region("../../node_modules/.pnpm/detect-libc@2.1.2/node_modules/detect-libc/lib/process.js") +
      region(
        "../../node_modules/.pnpm/msgpackr-extract@3.0.4/node_modules/msgpackr-extract/index.js",
      );
    const result = findInlinedExternalPackages(source);

    assert.deepStrictEqual(result.inlined, ["detect-libc", "msgpackr-extract"]);
    assert.strictEqual(result.regionCount, 2);
  });

  it("flags scoped external packages", () => {
    const result = findInlinedExternalPackages(
      region("../../node_modules/@ff-labs/fff-node/dist/src/index.js"),
    );
    assert.deepStrictEqual(result.inlined, ["@ff-labs/fff-node"]);
  });

  it("ignores packages that are meant to be bundled", () => {
    const source =
      region("../../node_modules/.pnpm/effect@4.0.0/node_modules/effect/dist/index.js") +
      region("../../src/server/main.ts");
    const result = findInlinedExternalPackages(source);

    assert.deepStrictEqual(result.inlined, []);
    assert.strictEqual(result.regionCount, 2);
  });

  // regionCount is what separates "clean" from "this scan went blind because the
  // marker format changed". A caller that ignores it gets a vacuous pass.
  // The scan has to answer both directions. Checking only that externals are
  // absent still passes on a bundle that externalized everything, which is the
  // failure this whole change prevents.
  it("reports the packages that were inlined, not just the violations", () => {
    const source =
      region("../../node_modules/.pnpm/effect@4.0.0/node_modules/effect/dist/index.js") +
      region("../../node_modules/.pnpm/yaml@2.4.0/node_modules/yaml/dist/index.js") +
      region("../../src/server/main.ts");
    const result = findInlinedExternalPackages(source);

    assert.deepStrictEqual(result.inlinedPackages, ["effect", "yaml"]);
    assert.deepStrictEqual(result.inlined, []);
  });

  it("does not report the pnpm store directory as a package", () => {
    const result = findInlinedExternalPackages(
      region("../../node_modules/.pnpm/effect@4.0.0/node_modules/effect/dist/index.js"),
    );
    assert.deepStrictEqual(result.inlinedPackages, ["effect"]);
  });

  it("reports no regions when the marker format is absent", () => {
    const result = findInlinedExternalPackages("var x = 1; // node_modules/detect-libc/lib.js");
    assert.strictEqual(result.regionCount, 0);
    assert.deepStrictEqual(result.inlined, []);
  });
});
