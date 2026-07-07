#!/usr/bin/env node
// Preinstall guard: Flow needs Node 22+.
//
// Two independent reasons, both of which otherwise fail CONFUSINGLY (halfway
// through install, or at runtime) instead of up front:
//   1. The Claude Code ACP adapter (@agentclientprotocol/claude-agent-acp)
//      declares engines.node ">=22".
//   2. better-sqlite3's prebuilt binaries cover Node 20/22/24 — on an
//      unsupported Node it compiles from source and needs a full C/C++
//      toolchain, which most machines don't have. Node 22 LTS is the sweet spot.
//
// Fail loud and early with the exact fix.

const major = Number(process.versions.node.split(".")[0]);
const MIN = 22;

if (Number.isFinite(major) && major < MIN) {
  const R = "\x1b[31m", B = "\x1b[1m", D = "\x1b[2m", X = "\x1b[0m";
  process.stderr.write(`
${R}${B}✗ Flow needs Node ${MIN}+ — you have Node ${process.versions.node}.${X}

  The coding-agent adapters require Node ${MIN}, and on this version Flow would
  try to compile SQLite from source (and fail without build tools).

  ${B}Fix with nvm:${X}
    nvm install ${MIN} && nvm use ${MIN}
  ${D}…or install Node ${MIN} LTS from https://nodejs.org${X}

  Then re-run  ${B}npm install${X}.

`);
  process.exit(1);
}
