import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { projectCpuLockfile } from "./prepare-browser-lockfile.mjs";

NodeTest.test(
  "CPU projection removes only optional GPU payloads without changing pinned runtime dependencies",
  () => {
    const cpu = "@node-llama-cpp/linux-x64";
    const gpu = `${cpu}-cuda`;
    const lockfile = {
      lockfileVersion: "9.0",
      importers: { ".": { dependencies: { llama: { specifier: "^1", version: "1.2.3" } } } },
      packages: {
        "llama@1.2.3": { resolution: { integrity: "llama-pin" } },
        [`${cpu}@1.2.3`]: { resolution: { integrity: "cpu-pin" } },
        [`${gpu}@1.2.3`]: { resolution: { integrity: "gpu-pin" } },
      },
      snapshots: {
        "llama@1.2.3": { optionalDependencies: { [cpu]: "1.2.3", [gpu]: "1.2.3" } },
        [`${cpu}@1.2.3`]: { optional: true },
        [`${gpu}@1.2.3`]: { optional: true },
      },
    };
    const original = structuredClone(lockfile);
    const projected = projectCpuLockfile(lockfile);
    NodeAssert.deepEqual(lockfile, original);
    NodeAssert.deepEqual(projected.importers, original.importers);
    NodeAssert.deepEqual(projected.packages[`${cpu}@1.2.3`], original.packages[`${cpu}@1.2.3`]);
    NodeAssert.deepEqual(projected.packages["llama@1.2.3"], original.packages["llama@1.2.3"]);
    NodeAssert.equal(projected.packages[`${gpu}@1.2.3`], undefined);
    NodeAssert.deepEqual(projected.snapshots["llama@1.2.3"].optionalDependencies, {
      [cpu]: "1.2.3",
    });
    NodeAssert.deepEqual(projectCpuLockfile(projected), projected);
  },
);

NodeTest.test("CPU projection refuses to remove a required GPU dependency", () => {
  NodeAssert.throws(
    () =>
      projectCpuLockfile({
        snapshots: { app: { dependencies: { "@node-llama-cpp/linux-x64-cuda": "1.2.3" } } },
      }),
    /required dependency/,
  );
});
