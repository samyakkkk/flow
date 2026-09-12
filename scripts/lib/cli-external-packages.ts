/**
 * Packages that must load from disk: native addons, their loaders, and packages
 * whose runtime-relative imports cannot be bundled safely. The CLI bundler and
 * desktop packager share this list so each external root is staged on disk.
 *
 * The package manager installs each root's transitive dependencies. Ordinary JS
 * dependencies may also be bundled where the CLI imports them; marking the whole
 * closure external instead creates bare imports that pnpm cannot resolve from
 * the CLI workspace. Artifact checks verify native loaders stay external and
 * that both the server and Brain catalog load from the isolated packaged tree.
 *
 * Scoped families and node-gyp-build match prefixes; ordinary names match only
 * the package and its subpaths, not similarly named packages.
 */
export const CLI_RUNTIME_EXTERNAL_PREFIXES = [
  "better-sqlite3",
  "bindings",
  "file-uri-to-path",
  "@falkordblite/",
  "falkordb",
  "falkordblite",
  "@node-llama-cpp/",
  "node-llama-cpp",
  "node-pty",
  "ffi-rs",
  "@yuuang/",
  "@ff-labs/",
  "@clerk/electron-passkeys",
  "@msgpackr-extract/",
  // Its UMD entry keeps runtime-relative requires (e.g. ./impl/format) when
  // bundled by Rolldown. Keep the package intact alongside those modules.
  "jsonc-parser",
  "msgpackr-extract",
  "node-gyp-build",
  "node-addon-api",
  // Keep libc detection alongside the native loader that selects Linux builds.
  "detect-libc",
  // ws's optional accelerators. Nothing in this repo declares them, so they are
  // not in the staged production install and the packaged app does not ship
  // them either way -- ws wraps the require in try/catch and falls back to its
  // JS paths. They are listed because they were being inlined from the dev
  // store: both carry binding.gyp and prebuilds and load through
  // node-gyp-build, and a native loader inlined into a bundle chunk searches
  // for prebuilds that cannot be beside it. Listing them keeps that from
  // becoming real if either is ever declared as a dependency.
  "bufferutil",
  "utf-8-validate",
] as const;

/**
 * External only so the bundler never has to resolve them.
 *
 * These are reached through a runtime-conditional dynamic import that Node
 * never takes, and they resolve `bun:*` specifiers that do not exist when
 * bundling for Node. Because Node never loads them, their dependency closure
 * does not need to be external — only the entry point must stay unbundled.
 */
export const CLI_BUILD_ONLY_EXTERNAL_PREFIXES = [
  "@effect/platform-bun",
  "@effect/sql-sqlite-bun",
] as const;

export const CLI_EXTERNAL_PACKAGE_PREFIXES = [
  ...CLI_RUNTIME_EXTERNAL_PREFIXES,
  ...CLI_BUILD_ONLY_EXTERNAL_PREFIXES,
] as const;

export function isRuntimeExternalCliDependency(id: string): boolean {
  return CLI_RUNTIME_EXTERNAL_PREFIXES.some((prefix) =>
    prefix.endsWith("/") || prefix === "node-gyp-build" || prefix === "@clerk/electron-passkeys"
      ? id.startsWith(prefix)
      : id === prefix || id.startsWith(`${prefix}/`),
  );
}

/**
 * True when `id` must stay out of the bundle.
 *
 * This has to be wired to the bundler's `neverBundle`, not just to
 * `alwaysBundle`. `alwaysBundle` only forces packages IN — returning false from
 * it means "no opinion", and the default then applies: a declared dependency
 * stays external, but a transitive one gets bundled. That is how
 * msgpackr-extract, node-gyp-build-optional-packages and detect-libc ended up
 * inlined while node-pty (a declared dependency) stayed external.
 */
export function isExternalCliDependency(id: string): boolean {
  return (
    isRuntimeExternalCliDependency(id) ||
    CLI_BUILD_ONLY_EXTERNAL_PREFIXES.some((prefix) => id === prefix || id.startsWith(`${prefix}/`))
  );
}

/** True when the CLI bundle should inline `id` rather than leave it external. */
export function shouldBundleCliDependency(id: string): boolean {
  if (id.startsWith("node:")) return false;
  return !isExternalCliDependency(id);
}

/** Select direct dependency roots whose runtime closure belongs in the sidecar. */
export function selectCliRuntimeExternalDependencies(
  dependencies: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(dependencies).filter(([name]) => isRuntimeExternalCliDependency(name)),
  );
}

/**
 * Scan an emitted bundle chunk for runtime-external packages that were inlined.
 *
 * Configuring the bundler is not the same as checking what it produced. The
 * `alwaysBundle` predicate only forces packages IN; returning false from it
 * means "no opinion", so a transitive dependency still gets bundled by default.
 * msgpackr-extract, node-gyp-build-optional-packages and detect-libc were
 * inlined that way while every list-based test passed, which is why this reads
 * the artifact instead.
 *
 * `regionCount` is reported so the caller can tell "nothing was inlined" apart
 * from "the marker format changed and this scan no longer sees anything".
 *
 * `inlinedPackages` is every package seen in a region, which lets the caller
 * check the opposite direction too. Verifying only that externals are absent
 * would still pass if the bundler reverted to leaving everything external: the
 * scan would see source-file regions, report nothing inlined, and the packaged
 * backends would then fail with ERR_MODULE_NOT_FOUND because those packages
 * are not in the selected sidecar closure either.
 */
export function findInlinedExternalPackages(source: string): {
  readonly regionCount: number;
  readonly inlined: ReadonlyArray<string>;
  readonly inlinedPackages: ReadonlyArray<string>;
} {
  // Rolldown marks each inlined module with a `//#region <path>` comment.
  const regionPattern = /\/\/#region\s+(\S+)/g;
  const packagePattern = /node_modules\/((?:@[^/\s]+\/)?[^/\s]+)\//g;

  let regionCount = 0;
  const inlined = new Set<string>();
  const inlinedPackages = new Set<string>();
  for (const region of source.matchAll(regionPattern)) {
    regionCount += 1;
    const regionPath = region[1] ?? "";
    for (const candidate of regionPath.matchAll(packagePattern)) {
      const name = candidate[1];
      if (name === undefined || name === ".pnpm") continue;
      inlinedPackages.add(name);
      if (isExternalCliDependency(name)) inlined.add(name);
    }
  }

  return {
    regionCount,
    inlined: [...inlined].sort(),
    inlinedPackages: [...inlinedPackages].sort(),
  };
}
