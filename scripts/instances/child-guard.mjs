/* eslint-disable t3code/no-global-process-runtime -- Process guardian uses its own OS process group. */
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
// The supervisor owns this process group. If it crashes, IPC disconnects and
// this guardian shuts down its children instead of leaving a second app behind.
const [command, ...args] = process.argv.slice(2);
const child = NodeChildProcess.spawn(command, args, {
  stdio: ["ignore", "inherit", "inherit"],
  detached: false,
  env: process.env,
});
let stopping = false;
let orphaned = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  if (NodeOS.platform() === "win32") child.kill("SIGTERM");
  else {
    const force = setTimeout(() => {
      try {
        process.kill(-process.pid, "SIGKILL");
      } catch {}
    }, 20000);
    if (!orphaned) force.unref();
    process.kill(-process.pid, "SIGTERM");
  }
};
process.on("SIGTERM", stop);
process.once("disconnect", () => {
  orphaned = true;
  stop();
});
child.once("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
child.once("exit", (code, signal) => {
  if (!stopping) process.exit(code ?? (signal ? 1 : 0));
  else if (!orphaned) process.exit(0);
});
