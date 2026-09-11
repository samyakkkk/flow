import { describe, expect, it } from "vite-plus/test";
import { verifyNativeArchive } from "./native.ts";
describe("native binary integrity", () => {
  it("refuses corrupt or substituted downloads before extracting executables", () => {
    expect(() => verifyNativeArchive(Buffer.from("not-the-pinned-archive"))).toThrow(
      "checksum mismatch",
    );
  });
});
