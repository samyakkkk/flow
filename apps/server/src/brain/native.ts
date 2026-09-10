// @effect-diagnostics globalFetch:off - Pinned binary downloader inside the Promise-based native adapter.
// @effect-diagnostics nodeBuiltinImport:off - Verified native executable installation boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as yauzl from "yauzl";

// Upstream's macOS npm package links Homebrew dylibs. The official Python wheel
// contains standalone ARM64 executables plus loader-relative OpenSSL libraries.
// We extract only native assets and license notices; Python is never executed.
const MAC_BINARY_URL =
  "https://files.pythonhosted.org/packages/0e/43/39d8cf13964784447676d24f0cefa3bdc99c10e647c71e6a4172d302dcac/falkordblite-0.10.0-cp312-cp312-macosx_10_13_x86_64.macosx_15_0_arm64.whl";
export const MAC_BINARY_SHA256 = "741fda166170513db1815d5369870e47d44da2e9b85320fddbc50c88a7338d51";
const ASSETS = new Map([
  ["redislite/bin/redis-server", "bin/redis-server"],
  ["redislite/bin/falkordb.so", "bin/falkordb.so"],
  ["redislite/.dylibs/libssl.3.dylib", ".dylibs/libssl.3.dylib"],
  ["redislite/.dylibs/libcrypto.3.dylib", ".dylibs/libcrypto.3.dylib"],
  ["falkordblite-0.10.0.dist-info/licenses/LICENSE.txt", "LICENSE.txt"],
]);
export function verifyNativeArchive(buffer: Buffer) {
  if (NodeCrypto.createHash("sha256").update(buffer).digest("hex") !== MAC_BINARY_SHA256)
    throw new Error("FalkorDB binary checksum mismatch. No executable was installed.");
}
async function extractNativeArchive(buffer: Buffer, directory: string) {
  verifyNativeArchive(buffer);
  await new Promise<void>((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        reject(error ?? new Error("Invalid native binary archive."));
        return;
      }
      const extracted = new Set<string>();
      const fail = (cause: unknown) => {
        zip.close();
        reject(cause);
      };
      zip.on("error", fail);
      zip.on("end", () => {
        if (extracted.size === ASSETS.size) resolve();
        else reject(new Error("FalkorDB binary archive is incomplete."));
      });
      zip.on("entry", (entry: yauzl.Entry) => {
        const relative = ASSETS.get(entry.fileName);
        if (!relative) {
          zip.readEntry();
          return;
        }
        if (entry.uncompressedSize > 64 * 1024 * 1024 || extracted.has(relative)) {
          fail(new Error("Invalid native asset."));
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            fail(streamError);
            return;
          }
          const target = NodePath.join(directory, relative);
          void NodeFSP.mkdir(NodePath.dirname(target), { recursive: true, mode: 0o700 })
            .then(() =>
              NodeStreamPromises.pipeline(
                stream,
                NodeFS.createWriteStream(target, { mode: 0o600 }),
              ),
            )
            .then(() => {
              extracted.add(relative);
              zip.readEntry();
            })
            .catch(fail);
        });
      });
      zip.readEntry();
    });
  });
}
export async function prepareNativeFalkor(
  directory: string,
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
): Promise<{ redisServerPath: string; modulePath: string }> {
  if (platform === "darwin" && architecture === "arm64") {
    if (Number(NodeOS.release().split(".")[0]) < 24)
      throw new Error("This native FalkorDB bundle requires macOS 15 or newer.");
    // Ready-built browser releases carry the verified native runtime alongside
    // the app. Source checkouts retain the on-demand download below.
    const bundled = NodePath.resolve(
      NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
      "../../../../runtime/brain/falkordb-macos-0.10.0",
    );
    if (
      (await NodeFSP.readFile(NodePath.join(bundled, "verified.sha256"), "utf8").catch(
        () => "",
      )) === MAC_BINARY_SHA256
    ) {
      const paths = {
        redisServerPath: NodePath.join(bundled, "bin/redis-server"),
        modulePath: NodePath.join(bundled, "bin/falkordb.so"),
      };
      await Promise.all([NodeFSP.access(paths.redisServerPath), NodeFSP.access(paths.modulePath)]);
      return paths;
    }
    const target = NodePath.join(directory, "falkordb-macos-0.10.0");
    const marker = NodePath.join(target, "verified.sha256");
    const ready = await NodeFSP.readFile(marker, "utf8").catch(() => "");
    if (ready !== MAC_BINARY_SHA256) {
      const temp = `${target}.${NodeCrypto.randomUUID()}.tmp`;
      await NodeFSP.mkdir(temp, { recursive: true, mode: 0o700 });
      try {
        const response = await fetch(MAC_BINARY_URL, { signal: AbortSignal.timeout(120_000) });
        if (!response.ok || Number(response.headers.get("content-length")) > 32 * 1024 * 1024)
          throw new Error("Could not download the native FalkorDB runtime.");
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > 32 * 1024 * 1024)
          throw new Error("Native binary download exceeded the size limit.");
        await extractNativeArchive(buffer, temp);
        await NodeFSP.chmod(NodePath.join(temp, "bin/redis-server"), 0o700);
        await NodeFSP.chmod(NodePath.join(temp, "bin/falkordb.so"), 0o700);
        await NodeFSP.writeFile(NodePath.join(temp, "verified.sha256"), MAC_BINARY_SHA256, {
          mode: 0o600,
        });
        await NodeFSP.rename(temp, target);
      } catch (error) {
        await NodeFSP.rm(temp, { recursive: true, force: true });
        throw error;
      }
    }
    const paths = {
      redisServerPath: NodePath.join(target, "bin/redis-server"),
      modulePath: NodePath.join(target, "bin/falkordb.so"),
    };
    await Promise.all([NodeFSP.access(paths.redisServerPath), NodeFSP.access(paths.modulePath)]);
    return paths;
  }
  if (platform === "linux" && architecture === "x64") {
    const require = NodeModule.createRequire(import.meta.url);
    const ownerRequire = NodeModule.createRequire(require.resolve("falkordblite"));
    const packageDirectory = NodePath.dirname(
      ownerRequire.resolve("@falkordblite/linux-x64/package.json"),
    );
    // Copy executables out of Electron ASAR archives into app-owned storage.
    const target = NodePath.join(directory, "falkordb-linux-4.16.3");
    await NodeFSP.mkdir(target, { recursive: true, mode: 0o700 });
    const paths = {
      redisServerPath: NodePath.join(target, "redis-server"),
      modulePath: NodePath.join(target, "falkordb.so"),
    };
    for (const [name, path] of [
      ["redis-server", paths.redisServerPath],
      ["falkordb.so", paths.modulePath],
    ]) {
      await NodeFSP.copyFile(NodePath.join(packageDirectory, "bin", name!), path!);
      await NodeFSP.chmod(path!, 0o700);
    }
    return paths;
  }
  throw new Error(
    "Native FalkorDB currently supports Apple Silicon macOS 15+ and Linux x64. Docker fallback is disabled.",
  );
}
