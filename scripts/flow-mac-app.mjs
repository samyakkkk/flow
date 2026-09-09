import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";

const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

export async function installMacApp(
  home,
  directory = NodePath.join(NodeOS.homedir(), "Applications"),
) {
  const target = NodePath.join(directory, "Flow.app");
  const marker = NodePath.join(target, "Contents/flow-browser-launcher");
  try {
    const previous = await NodeFSP.readFile(marker, "utf8");
    if (previous.trim() !== home) throw new Error(`Another Flow installation owns ${target}.`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (await NodeFSP.stat(target).catch(() => null))
      throw new Error(`Refusing to replace ${target}.`, { cause: error });
  }
  await NodeFSP.mkdir(directory, { recursive: true });
  const staging = NodePath.join(directory, `.Flow-${NodeCrypto.randomUUID()}.app`);
  try {
    const contents = NodePath.join(staging, "Contents");
    await NodeFSP.mkdir(NodePath.join(contents, "MacOS"), { recursive: true });
    await NodeFSP.mkdir(NodePath.join(contents, "Resources"));
    await NodeFSP.writeFile(NodePath.join(contents, "flow-browser-launcher"), home + "\n");
    await NodeFSP.copyFile(
      NodePath.join(home, "current/runtime/Flow.icns"),
      NodePath.join(contents, "Resources/Flow.icns"),
    );
    await NodeFSP.writeFile(
      NodePath.join(contents, "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.flow.browser-launcher</string>
<key>CFBundleName</key><string>Flow</string>
<key>CFBundleDisplayName</key><string>Flow</string>
<key>CFBundleExecutable</key><string>Flow</string>
<key>CFBundleIconFile</key><string>Flow.icns</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>15.0</string>
<key>LSUIElement</key><true/>
</dict></plist>\n`,
    );
    await NodeFSP.writeFile(
      NodePath.join(contents, "MacOS/Flow"),
      `#!/bin/sh
# flow-managed-browser-app
export FLOW_RELEASE_HOME=${quote(home)}
export PATH="$FLOW_RELEASE_HOME/current/runtime/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
umask 077
exec "$FLOW_RELEASE_HOME/current/runtime/bin/node" "$FLOW_RELEASE_HOME/current/scripts/flow-release.mjs" "$@" >> "$FLOW_RELEASE_HOME/launcher.log" 2>&1
`,
      { mode: 0o755 },
    );
    // Only remove a launcher whose ownership marker was checked above.
    await NodeFSP.rm(target, { recursive: true, force: true });
    await NodeFSP.rename(staging, target);
  } finally {
    await NodeFSP.rm(staging, { recursive: true, force: true });
  }
  return target;
}
