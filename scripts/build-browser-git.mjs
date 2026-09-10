/* oxlint-disable t3code/no-global-process-runtime -- Standalone native release builder. */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeOS from "node:os";

const execute = NodeUtil.promisify(NodeChildProcess.execFile);
export const gitVersion = "2.55.0";
const checksum = "0842dc384a23ac33ba3e570c4f3a8ded85963ee4713b1cd21153c3db41813d1e";

// Compile on the release builder only. Recipients get relocatable executables
// linked to macOS system libraries, with no Homebrew or developer-tools dependency.
export async function buildBrowserGit(runtime, temporary) {
  const name = `git-${gitVersion}.tar.gz`;
  const response = await fetch(`https://www.kernel.org/pub/software/scm/git/${name}`, {
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) throw Error(`Git source download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== checksum) {
    throw Error("Git source checksum mismatch.");
  }
  const archive = NodePath.join(temporary, name);
  await NodeFSP.writeFile(archive, bytes);
  await execute("/usr/bin/tar", ["-xzf", archive, "-C", temporary]);
  const source = NodePath.join(temporary, `git-${gitVersion}`);
  const staging = NodePath.join(temporary, "git-install");
  const flags = [
    "-j4",
    "prefix=/flow-private-git",
    `DESTDIR=${staging}`,
    "RUNTIME_PREFIX=YesPlease",
    "NO_GETTEXT=YesPlease",
    "NO_TCLTK=YesPlease",
    "NO_PERL=YesPlease",
    "NO_RUST=YesPlease",
    "NO_PYTHON=YesPlease",
    "CURL_CONFIG=/usr/bin/curl-config",
    "CFLAGS=-O2",
  ];
  const targets = [
    "install",
    ...(NodeOS.platform() === "darwin" ? ["install-git-credential-osxkeychain"] : []),
  ];
  const result = await execute("/usr/bin/make", [...flags, ...targets], {
    cwd: source,
    env: {
      ...process.env,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      MACOSX_DEPLOYMENT_TARGET: "15.0",
    },
    maxBuffer: 16 * 1024 * 1024,
  });
  console.log(result.stdout);
  // Build output may be a Docker bind mount on a different filesystem. Tar
  // preserves Git's hard-linked command aliases without a cross-device rename.
  const installed = NodePath.join(temporary, "git-installed.tar");
  await execute("/usr/bin/tar", ["-cf", installed, "-C", staging, "flow-private-git"]);
  await NodeFSP.mkdir(NodePath.join(runtime, "git"), { recursive: true });
  await execute("/usr/bin/tar", [
    "-xf",
    installed,
    "--strip-components=1",
    "-C",
    NodePath.join(runtime, "git"),
  ]);
  // Ship the corresponding source and build instructions with the GPL executable.
  const licenses = NodePath.join(runtime, "licenses/git");
  await NodeFSP.mkdir(licenses, { recursive: true });
  await NodeFSP.copyFile(archive, NodePath.join(licenses, name));
  await NodeFSP.copyFile(NodePath.join(source, "COPYING"), NodePath.join(licenses, "COPYING"));
  await NodeFSP.writeFile(
    NodePath.join(licenses, "BUILD.txt"),
    `Git ${gitVersion}\nSource SHA-256: ${checksum}\nBuilt with platform system libraries using:\n` +
      `PATH=/usr/bin:/bin:/usr/sbin:/sbin MACOSX_DEPLOYMENT_TARGET=15.0 make ${flags.filter((flag) => !flag.startsWith("DESTDIR=")).join(" ")} ${targets.join(" ")}\n`,
  );
  const version = await execute(NodePath.join(runtime, "git/bin/git"), ["--version"]);
  if (version.stdout.trim() !== `git version ${gitVersion}`)
    throw Error("Unexpected bundled Git version.");
}
