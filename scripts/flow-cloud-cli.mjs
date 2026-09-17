#!/usr/bin/env node
// Launchers written by the earlier Cloud CLI still exec this path after they
// update. Repoint them at the one Flow CLI, then carry on as that CLI.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { installLauncher, main } from "./flow-release.mjs";

const { homedir } = NodeOS;
const { join } = NodePath;
const home =
  process.env.FLOW_CLI_HOME ||
  process.env.FLOW_CLOUD_CLI_HOME ||
  join(homedir(), ".local/share/flow-cloud-cli");
process.env.FLOW_RELEASE_HOME = home;
// A `flow` command that belongs to something else is left alone.
for (const prefix of [home, join(homedir(), ".local")])
  await installLauncher(home, prefix, false).catch(() => {});
main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
