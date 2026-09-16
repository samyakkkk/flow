// @effect-diagnostics nodeBuiltinImport:off - drives the real filesystem and a loopback control server, the two things this module reads.
import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  readFlowServiceStatus,
  restartFlowService,
  startFlowService,
  stopFlowService,
  unitLocation,
  type ServiceProcessLauncher,
  type ServiceProcessRunner,
} from "./flowService.ts";

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

interface RunnerCall {
  readonly command: string;
  readonly args: readonly string[];
}

const recordingRunner = (
  ok: boolean,
  stderr = "",
): { readonly run: ServiceProcessRunner; readonly calls: RunnerCall[] } => {
  const calls: RunnerCall[] = [];
  return {
    calls,
    run: (command, args) => {
      calls.push({ command, args });
      return Promise.resolve({ ok, stdout: "", stderr });
    },
  };
};

async function fixture() {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "flow-service-panel-"));
  cleanups.push(() => NodeFSP.rm(home, { recursive: true, force: true }));
  const registryRoot = NodePath.join(home, "instance-home");
  const directory = NodePath.join(registryRoot, "instances/primary");
  const dataHome = NodePath.join(directory, "data");
  const code = NodePath.join(home, "code");
  await NodeFSP.mkdir(dataHome, { recursive: true });
  await NodeFSP.mkdir(NodePath.join(code, "scripts"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(code, "scripts/flow.mjs"), "// entry point");
  const save = (file: string, data: unknown) =>
    NodeFSP.writeFile(NodePath.join(directory, file), JSON.stringify(data));
  await save("config.json", {
    version: 1,
    id: "environment",
    name: "primary",
    mode: "isolated",
    dev: false,
    home: dataHome,
    code,
  });
  return { home, registryRoot, directory, dataHome, code, save };
}

/** A stand-in supervisor: records every control request it answers. */
async function control(
  f: Awaited<ReturnType<typeof fixture>>,
  handler: (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => void,
) {
  const requests: Array<{ readonly url: string; readonly authorization: string | undefined }> = [];
  const server = NodeHttp.createServer((request, response) => {
    requests.push({ url: request.url ?? "", authorization: request.headers.authorization });
    handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve(undefined))));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await f.save("runtime.json", {
    id: "environment",
    generation: "generation",
    token: "private-control-token",
    controlUrl: `http://127.0.0.1:${String(port)}`,
  });
  return requests;
}

const plist = (nodePath: string, args: readonly string[]) =>
  [
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    "  <string>com.flow.service</string>",
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...[nodePath, ...args].map((value) => `    <string>${value}</string>`),
    "  </array>",
    "</dict>",
    "</plist>",
  ].join("\n");

const installUnit = async (
  f: Awaited<ReturnType<typeof fixture>>,
  contents: string,
): Promise<string> => {
  const path = unitLocation({ homeDirectory: f.home, host: "darwin" }).path;
  await NodeFSP.mkdir(NodePath.join(f.home, "Library/LaunchAgents"), { recursive: true });
  await NodeFSP.writeFile(path, contents);
  return path;
};

describe("flow service panel status", () => {
  it("reports a loaded unit and a ready service without running the launcher", async () => {
    const f = await fixture();
    await control(f, (_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          id: "environment",
          generation: "generation",
          phase: "ready",
          origin: "http://127.0.0.1:41234",
        }),
      );
    });
    const unitPath = await installUnit(
      f,
      plist("/usr/bin/node", [
        NodePath.join(f.code, "scripts/flow.mjs"),
        "--supervise",
        f.directory,
      ]),
    );
    const runner = recordingRunner(true);

    const status = await readFlowServiceStatus({
      registryRoot: f.registryRoot,
      homeDirectory: f.home,
      host: "darwin",
      uid: 501,
      run: runner.run,
    });

    expect(status).toEqual({
      installed: true,
      loaded: true,
      current: true,
      label: "com.flow.service",
      unitPath,
      instance: {
        phase: "ready",
        environmentId: "environment",
        dataHome: f.dataHome,
        serverOrigin: "http://127.0.0.1:41234",
        error: null,
      },
    });
    expect(runner.calls).toEqual([
      { command: "launchctl", args: ["print", "gui/501/com.flow.service"] },
    ]);
  });

  it("marks a unit that supervises another installation as not current", async () => {
    const f = await fixture();
    await installUnit(
      f,
      plist("/usr/bin/node", [
        NodePath.join(f.code, "scripts/flow.mjs"),
        "--supervise",
        NodePath.join(f.home, "someone-elses-registry/instances/primary"),
      ]),
    );
    const runner = recordingRunner(false);

    const status = await readFlowServiceStatus({
      registryRoot: f.registryRoot,
      homeDirectory: f.home,
      host: "darwin",
      uid: 501,
      run: runner.run,
    });

    expect(status.installed).toBe(true);
    expect(status.current).toBe(false);
    expect(status.loaded).toBe(false);
    // No runtime.json was written, so the instance is installed but stopped.
    expect(status.instance.phase).toBe("stopped");
  });

  it("reports an uninstalled service instead of failing", async () => {
    const f = await fixture();
    await NodeFSP.rm(NodePath.join(f.directory, "config.json"));
    const runner = recordingRunner(false);

    const status = await readFlowServiceStatus({
      registryRoot: f.registryRoot,
      homeDirectory: f.home,
      host: "linux",
      uid: 501,
      run: runner.run,
    });

    expect(status.installed).toBe(false);
    expect(status.instance.phase).toBe("not-configured");
    expect(status.instance.dataHome).toBe(null);
    expect(runner.calls).toEqual([
      { command: "systemctl", args: ["--user", "is-active", "flow.service"] },
    ]);
  });
});

describe("flow service panel actions", () => {
  it("stops the service with one authorized control request", async () => {
    const f = await fixture();
    const requests = await control(f, (_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ id: "environment", phase: "stopping" }));
    });

    const result = await stopFlowService({
      registryRoot: f.registryRoot,
      homeDirectory: f.home,
      host: "darwin",
      uid: 501,
    });

    expect(result).toEqual({ ok: true, reason: null, detail: null });
    expect(requests).toEqual([{ url: "/stop", authorization: "Bearer private-control-token" }]);
  });

  it("reports a service that was not running rather than failing", async () => {
    const f = await fixture();

    const result = await stopFlowService({
      registryRoot: f.registryRoot,
      homeDirectory: f.home,
      host: "darwin",
      uid: 501,
    });

    expect(result).toEqual({ ok: false, reason: "not-running", detail: null });
  });

  it("restarts through launchd when the unit is loaded", async () => {
    const f = await fixture();
    const runner = recordingRunner(true);

    const result = await restartFlowService({
      registryRoot: f.registryRoot,
      homeDirectory: f.home,
      host: "darwin",
      uid: 501,
      run: runner.run,
    });

    expect(result.ok).toBe(true);
    expect(runner.calls).toEqual([
      { command: "launchctl", args: ["print", "gui/501/com.flow.service"] },
      { command: "launchctl", args: ["kickstart", "-k", "gui/501/com.flow.service"] },
    ]);
  });

  it("restarts through systemd when the unit is loaded", async () => {
    const f = await fixture();
    const runner = recordingRunner(true);

    await restartFlowService({
      registryRoot: f.registryRoot,
      homeDirectory: f.home,
      host: "linux",
      uid: 501,
      run: runner.run,
    });

    expect(runner.calls).toEqual([
      { command: "systemctl", args: ["--user", "is-active", "flow.service"] },
      { command: "systemctl", args: ["--user", "restart", "flow.service"] },
    ]);
  });

  it("starts a stopped managed service through its service manager", async () => {
    const f = await fixture();
    const runner = recordingRunner(true);
    const launched: string[] = [];
    // The stand-in manager "starts" the service by publishing a control file.
    const run: ServiceProcessRunner = async (command, args) => {
      const result = await runner.run(command, args);
      if (args[0] === "kickstart")
        await f.save("runtime.json", {
          id: "environment",
          generation: "g",
          token: "t",
          controlUrl: "http://127.0.0.1:1",
          pid: 1,
        });
      return result;
    };

    const result = await startFlowService({
      registryRoot: f.registryRoot,
      homeDirectory: f.home,
      host: "darwin",
      uid: 501,
      run,
      launch: async (command) => {
        launched.push(command);
        return { ok: true, stdout: "", stderr: "" };
      },
    });

    expect(result.ok).toBe(true);
    expect(runner.calls).toEqual([
      { command: "launchctl", args: ["print", "gui/501/com.flow.service"] },
      { command: "launchctl", args: ["kickstart", "gui/501/com.flow.service"] },
    ]);
    expect(launched).toEqual([]);
  });

  it("starts a stopped unmanaged service by running its launcher with the recorded runtime", async () => {
    const f = await fixture();
    await f.save("config.json", {
      version: 1,
      id: "environment",
      name: "primary",
      mode: "isolated",
      dev: false,
      home: f.dataHome,
      code: f.code,
      node: "/opt/flow/runtime/bin/node",
    });
    const runner = recordingRunner(false);
    const launches: Array<{
      command: string;
      args: readonly string[];
      env: Record<string, string>;
    }> = [];
    const launch: ServiceProcessLauncher = async (command, args, env) => {
      launches.push({ command, args, env: { ...env } });
      await f.save("runtime.json", {
        id: "environment",
        generation: "g",
        token: "t",
        controlUrl: "http://127.0.0.1:1",
        pid: 1,
      });
      return { ok: true, stdout: "", stderr: "" };
    };

    const result = await startFlowService({
      registryRoot: f.registryRoot,
      homeDirectory: f.home,
      host: "darwin",
      uid: 501,
      run: runner.run,
      launch,
      fallbackNodePath: "/electron",
      fallbackNodeEnv: { ELECTRON_RUN_AS_NODE: "1" },
    });

    expect(result.ok).toBe(true);
    expect(launches).toEqual([
      {
        command: "/opt/flow/runtime/bin/node",
        args: [NodePath.join(f.code, "scripts/flow.mjs"), "--no-open"],
        env: { FLOW_INSTANCE_HOME: f.registryRoot },
      },
    ]);
  });

  it("falls back to the app's own runtime for a registry without a recorded one", async () => {
    const f = await fixture();
    const launches: Array<{ command: string; env: Record<string, string> }> = [];
    const launch: ServiceProcessLauncher = async (command, _args, env) => {
      launches.push({ command, env: { ...env } });
      await f.save("runtime.json", {
        id: "environment",
        generation: "g",
        token: "t",
        controlUrl: "http://127.0.0.1:1",
        pid: 1,
      });
      return { ok: true, stdout: "", stderr: "" };
    };

    const result = await startFlowService({
      registryRoot: f.registryRoot,
      homeDirectory: f.home,
      host: "linux",
      uid: 501,
      run: recordingRunner(false).run,
      launch,
      fallbackNodePath: "/electron",
      fallbackNodeEnv: { ELECTRON_RUN_AS_NODE: "1" },
    });

    expect(result.ok).toBe(true);
    expect(launches).toEqual([
      {
        command: "/electron",
        env: { FLOW_INSTANCE_HOME: f.registryRoot, ELECTRON_RUN_AS_NODE: "1" },
      },
    ]);
  });

  it("refuses to restart a service no service manager owns, and starts nothing", async () => {
    const f = await fixture();
    const runner = recordingRunner(false);

    const result = await restartFlowService({
      registryRoot: f.registryRoot,
      homeDirectory: f.home,
      host: "darwin",
      uid: 501,
      run: runner.run,
    });

    expect(result).toEqual({ ok: false, reason: "not-managed", detail: null });
    expect(runner.calls).toEqual([
      { command: "launchctl", args: ["print", "gui/501/com.flow.service"] },
    ]);
  });
});
