// @effect-diagnostics nodeBuiltinImport:off - Discover the separately managed Flow installation.
// @effect-diagnostics globalProcess:off - Bootstrap runs before a backend exists.
import * as FS from "node:fs/promises";
import * as Path from "node:path";
import * as ChildProcess from "node:child_process";
import * as Util from "node:util";
const exec = Util.promisify(ChildProcess.execFile);

/** The desktop is a client of an installed Flow server; it never owns that process. */
export async function flowServerAttachment(
  home: string,
  development: boolean,
  serverEntry: string,
) {
  const explicitHome = process.env.FLOW_DESKTOP_SERVER_HOME;
  if (development && !explicitHome) return null;
  const release = Path.join(home, ".local/share/flow-browser/current");
  let baseDir: string;
  let node: string;
  let bin: string;
  if (explicitHome) {
    baseDir = explicitHome;
    node = process.execPath;
    bin = serverEntry;
  } else {
    try {
      await FS.access(Path.join(release, "scripts/flow-release.mjs"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    node = Path.join(release, "runtime/bin/node");
    bin = Path.join(release, "apps/server/src/bin.ts");
    // The launcher locks and reuses primary, including when it is already running.
    await exec(node, [Path.join(release, "scripts/flow-release.mjs"), "--no-open"], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      timeout: 150000,
    });
    baseDir = Path.join(home, ".local/share/flow-browser/instance-home/instances/primary/data");
  }
  const runtime = JSON.parse(
    await FS.readFile(Path.join(baseDir, "userdata/server-runtime.json"), "utf8"),
  );
  const url = new URL(runtime.origin);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    throw Error("Flow's local server must use a loopback address.");
  const mint = async () => {
    const { stdout } = await exec(node, [bin, "pair", "--base-dir", baseDir], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      timeout: 30000,
    });
    const token = /^Token: (\S+)$/m.exec(stdout)?.[1];
    if (!token) throw Error("Could not pair desktop with the existing Flow server.");
    return token;
  };
  return { url, baseDir, mint, rendererToken: await mint() };
}
