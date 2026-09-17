#!/usr/bin/env node
import { main, registryRoot } from "./instances/launcher.mjs";
import { primaryStateDir } from "./instances/service-discovery.mjs";
const args = process.argv.slice(2);
if (args[0] === "setup" && !args.includes("--state-dir")) {
  await main(["--no-open"]);
  args.push("--state-dir", await primaryStateDir(registryRoot()));
}
const run =
  args[0] === "setup" || args[0] === "agents"
    ? (await import("../flow-t3/shared/bin/harness/agent-connector.mjs")).main
    : main;
run(args[0] === "agents" ? args.slice(1) : args).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
