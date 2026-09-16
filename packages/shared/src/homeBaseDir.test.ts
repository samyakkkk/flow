import { describe, expect, it } from "vite-plus/test";

import { legacyBaseDirProbePath, resolveHomeBaseDir } from "./homeBaseDir.ts";

const joinPath = (first: string, ...segments: string[]) =>
  [first, ...segments].join("/").replaceAll(/\/+/g, "/");

describe("resolveHomeBaseDir", () => {
  it("prefers an explicit selection over either default", () => {
    for (const legacyHomeExists of [true, false]) {
      expect(
        resolveHomeBaseDir({
          explicit: "  /tmp/chosen  ",
          homeDirectory: "/Users/alice",
          joinPath,
          legacyHomeExists,
        }),
      ).toBe("/tmp/chosen");
    }
  });

  it("adopts an existing install in place rather than moving it", () => {
    expect(
      resolveHomeBaseDir({
        explicit: undefined,
        homeDirectory: "/Users/alice",
        joinPath,
        legacyHomeExists: true,
      }),
    ).toBe("/Users/alice/.t3");
  });

  it("gives a fresh install the Flow home", () => {
    // A blank selection is not a selection: it must not skip the rule.
    expect(
      resolveHomeBaseDir({
        explicit: "   ",
        homeDirectory: "/Users/alice",
        joinPath,
        legacyHomeExists: false,
      }),
    ).toBe("/Users/alice/.flow");
  });

  it("probes the state directory, not the bare legacy home", () => {
    expect(legacyBaseDirProbePath("/Users/alice", joinPath)).toBe("/Users/alice/.t3/userdata");
  });
});
