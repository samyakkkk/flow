import * as NodeOS from "node:os";
import { assert } from "vite-plus/test";
import { it } from "@effect/vitest";
import { HostProcessExecutablePath } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { hydratePosixHome, preserveBundledRuntimePath } from "./os-jank.ts";

it.effect("keeps bundled tools ahead of system stubs after login-shell hydration", () =>
  Effect.gen(function* () {
    const env = { PATH: "/usr/bin:/bin:/app/runtime/bin:/app/runtime/git/bin" };
    yield* preserveBundledRuntimePath(env, "darwin").pipe(
      Effect.provideService(HostProcessExecutablePath, "/app/runtime/bin/node"),
      Effect.provide(
        FileSystem.layerNoop({
          exists: (file) => Effect.succeed(file === "/app/flow-bundle.json"),
        }),
      ),
      Effect.provide(Path.layer),
    );
    assert.equal(env.PATH, "/app/runtime/bin:/app/runtime/git/bin:/usr/bin:/bin");
  }),
);

it.effect("preserves normal shell precedence outside a marked runtime bundle", () =>
  Effect.gen(function* () {
    const env = { PATH: "/usr/bin:/bin:/app/runtime/bin" };
    yield* preserveBundledRuntimePath(env, "darwin").pipe(
      Effect.provideService(HostProcessExecutablePath, "/app/runtime/bin/node"),
      Effect.provide(FileSystem.layerNoop({ exists: () => Effect.succeed(false) })),
      Effect.provide(Path.layer),
    );
    assert.equal(env.PATH, "/usr/bin:/bin:/app/runtime/bin");
  }),
);

it("hydrates HOME for minimal service environments from the user account", () => {
  const env: NodeJS.ProcessEnv = {};

  hydratePosixHome(env);

  assert.equal(env.HOME, NodeOS.userInfo().homedir);
});

it("hydrates HOME independently of a blank process HOME", () => {
  const originalHome = process.env.HOME;
  const env: NodeJS.ProcessEnv = { HOME: " " };

  try {
    process.env.HOME = " ";
    hydratePosixHome(env);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }

  assert.equal(env.HOME, NodeOS.userInfo().homedir);
});

it("preserves an explicitly configured HOME", () => {
  const env: NodeJS.ProcessEnv = { HOME: "/custom/home" };

  hydratePosixHome(env, () => {
    throw new Error("HOME lookup should not run");
  });

  assert.equal(env.HOME, "/custom/home");
});
