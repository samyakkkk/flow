import * as NodeTest from "node:test";
const { test } = NodeTest;
import * as NodeAssert from "node:assert/strict";
const assert = NodeAssert;
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
const { join } = NodePath;
import * as NodeOS from "node:os";
const { tmpdir } = NodeOS;
import * as NodeHttp from "node:http";
import * as NodeChildProcess from "node:child_process";
const { spawn } = NodeChildProcess;
import * as NodeEvents from "node:events";
const { once } = NodeEvents;
import * as NodeCrypto from "node:crypto";
const { randomUUID } = NodeCrypto;
import * as NodeTimersPromises from "node:timers/promises";
const { setTimeout: delay } = NodeTimersPromises;
import * as NodeURL from "node:url";
const repo = NodeURL.fileURLToPath(new URL("../../", import.meta.url));

// A disposable HTTP server models the launcher protocol without starting Flow,
// providers, Brain services, or opening any real application database.
const fakeServer = `
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const args=process.argv.slice(2);
const home=args[args.indexOf('--base-dir')+1];
const port=Number(args[args.indexOf('--port')+1]);
const server=createServer((request,response)=>{response.setHeader('content-type','application/json');response.end(JSON.stringify({environmentId:'test-environment'}))});
await mkdir(join(home,'userdata'),{recursive:true});
await writeFile(join(home,'userdata/server-runtime.json'),JSON.stringify({url:'http://127.0.0.1:'+port}));
server.listen(port,'127.0.0.1',()=>void fetch(process.env.TEST_RECEIPT_URL,{method:'POST',body:JSON.stringify({pid:process.pid,entry:process.argv[1]})}));
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
`;

const entryOf = (code) => join(code, "apps/server/src/bin.ts");

async function fixture(
  t,
  { release = false, managed = false, current = "flow-v1.1.0", pinnedToSource = false } = {},
) {
  const root = await NodeFSP.realpath(await NodeFSP.mkdtemp(join(tmpdir(), "flow-supervisor-")));
  const registry = join(root, "registry");
  const directory = join(registry, "instances/primary");
  const releaseHome = join(root, "release");
  const code = release ? join(releaseHome, "releases/flow-v1.0.0") : join(root, "code");
  const plant = async (target) => {
    await NodeFSP.mkdir(join(target, "apps/server/src"), { recursive: true });
    await NodeFSP.writeFile(entryOf(target), fakeServer);
  };
  await plant(code);
  if (release) {
    for (const tag of ["flow-v1.0.0", "flow-v1.1.0"]) {
      const target = join(releaseHome, "releases", tag);
      await plant(target);
      await NodeFSP.writeFile(join(target, "flow-release.json"), JSON.stringify({ tag }));
    }
    await NodeFSP.symlink(`releases/${current}`, join(releaseHome, "current"));
  }
  await NodeFSP.mkdir(directory, { recursive: true });
  await NodeFSP.writeFile(
    join(directory, "config.json"),
    JSON.stringify({
      version: 1,
      id: randomUUID(),
      name: "primary",
      code: pinnedToSource ? join(root, "code") : code,
      mode: "isolated",
      dev: false,
      home: join(root, "home"),
    }),
  );
  const started = Promise.withResolvers();
  const receiver = NodeHttp.createServer(async (request, response) => {
    let body = "";
    for await (const part of request) body += part;
    started.resolve(JSON.parse(body));
    response.end();
  });
  receiver.listen(0, "127.0.0.1");
  await once(receiver, "listening");
  t.after(async () => {
    await new Promise((resolve) => receiver.close(resolve));
    await NodeFSP.rm(root, { recursive: true, force: true });
  });
  const supervise = () => {
    const child = spawn(
      process.execPath,
      [join(repo, "scripts/flow.mjs"), "--supervise", directory],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH,
          HOME: root,
          FLOW_INSTANCE_HOME: registry,
          FLOW_AUTO_UPDATE: "0",
          TEST_RECEIPT_URL: `http://127.0.0.1:${receiver.address().port}`,
          ...(release ? { FLOW_RELEASE_HOME: releaseHome } : {}),
          ...(managed ? { FLOW_SERVICE_MANAGED: "1" } : {}),
        },
      },
    );
    // Only ever signalled by the pid captured here.
    t.after(() => {
      try {
        if (child.exitCode === null) process.kill(child.pid, "SIGKILL");
      } catch {
        /* Already gone. */
      }
    });
    return child;
  };
  const runtime = async () => {
    for (let attempt = 0; attempt < 300; attempt++) {
      const saved = await NodeFSP.readFile(join(directory, "runtime.json"), "utf8").catch(
        () => null,
      );
      if (saved) {
        const state = JSON.parse(saved);
        const status = await fetch(`${state.controlUrl}/status`, {
          method: "POST",
          headers: { authorization: `Bearer ${state.token}` },
        }).then((response) => response.json());
        if (status.phase === "ready") return state;
      }
      await delay(100);
    }
    throw Error("The supervisor never became ready.");
  };
  // Preparing an update is a symlink swap, exactly as adoptBundle does it.
  const prepare = async (tag) => {
    await NodeFSP.symlink(`releases/${tag}`, join(releaseHome, "next"));
    await NodeFSP.rename(join(releaseHome, "next"), join(releaseHome, "current"));
  };
  const config = async () =>
    JSON.parse(await NodeFSP.readFile(join(directory, "config.json"), "utf8"));
  return {
    root,
    home: join(root, "home"),
    sourceCode: join(root, "code"),
    directory,
    releaseHome,
    supervise,
    runtime,
    prepare,
    config,
    started: started.promise,
  };
}

const command = (state, action) =>
  fetch(`${state.controlUrl}/${action}`, {
    method: "POST",
    headers: { authorization: `Bearer ${state.token}` },
  });

test("a supervisor whose instance already has an owner exits 0", { timeout: 30000 }, async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const { directory } = await fixture(t);
  const owner = new DatabaseSync(join(directory, "supervisor-lock.sqlite"));
  owner.exec("BEGIN EXCLUSIVE");
  try {
    const second = spawn(
      process.execPath,
      [join(repo, "scripts/flow.mjs"), "--supervise", directory],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: process.env.PATH, HOME: directory },
      },
    );
    const [code] = await once(second, "exit");
    // An owner exists, so a service manager must not respawn this one.
    assert.equal(code, 0);
  } finally {
    owner.close();
  }
});

test("an intentional stop exits 0 so the service stays stopped", { timeout: 60000 }, async (t) => {
  const { supervise, runtime, directory } = await fixture(t);
  const supervisor = supervise();
  const state = await runtime();
  assert.equal((await command(state, "stop")).ok, true);
  const [code] = await once(supervisor, "exit");
  assert.equal(code, 0);
  await assert.rejects(NodeFSP.stat(join(directory, "runtime.json")), { code: "ENOENT" });
});

test(
  "an owned process dying exits 1 so the service is restarted",
  { timeout: 60000 },
  async (t) => {
    const { supervise, runtime, started } = await fixture(t);
    const supervisor = supervise();
    await runtime();
    // Only the pid the fake server reported is signalled.
    process.kill((await started).pid, "SIGKILL");
    const [code] = await once(supervisor, "exit");
    assert.equal(code, 1);
  },
);

test(
  "a managed update restart exits 1 instead of spawning a replacement",
  { timeout: 60000 },
  async (t) => {
    const { supervise, runtime, prepare, releaseHome } = await fixture(t, {
      release: true,
      managed: true,
      current: "flow-v1.0.0",
    });
    const supervisor = supervise();
    const state = await runtime();
    await prepare("flow-v1.1.0");
    const applied = await command(state, "apply-update");
    assert.equal(applied.ok, true);
    assert.equal((await applied.json()).readyVersion, "1.1.0");
    const [code] = await once(supervisor, "exit");
    assert.equal(code, 1);
    // spawnReleaseCommand would have opened this log; the manager restarts instead.
    await assert.rejects(NodeFSP.stat(join(releaseHome, "update.log")), { code: "ENOENT" });
  },
);

test(
  "a managed supervisor serves the release the manager restarted it into",
  { timeout: 60000 },
  async (t) => {
    const { supervise, runtime, started, config, releaseHome } = await fixture(t, {
      release: true,
      managed: true,
    });
    supervise();
    await runtime();
    // Nothing runs `flow restart` between the update and this process, so the
    // supervisor itself must re-point the instance at `current`.
    const selected = join(releaseHome, "releases/flow-v1.1.0");
    assert.equal((await started).entry, entryOf(selected));
    assert.equal((await config()).code, selected);
  },
);

test(
  "an unmanaged release instance keeps the release it was started with",
  { timeout: 60000 },
  async (t) => {
    const { supervise, runtime, started, config, releaseHome } = await fixture(t, {
      release: true,
    });
    supervise();
    await runtime();
    // `flow restart` owns release selection here, and it did not run.
    const pinned = join(releaseHome, "releases/flow-v1.0.0");
    assert.equal((await started).entry, entryOf(pinned));
    assert.equal((await config()).code, pinned);
  },
);

test(
  "a managed instance pinned outside the release tree stays stopped and says why",
  { timeout: 60000 },
  async (t) => {
    const { supervise, home } = await fixture(t, {
      release: true,
      managed: true,
      pinnedToSource: true,
    });
    const supervisor = supervise();
    let stderr = "";
    supervisor.stderr.on("data", (part) => (stderr += part));
    const [code] = await once(supervisor, "exit");
    // Staying stopped is the loud outcome: KeepAlive={SuccessfulExit:false} does
    // not respawn, and the code the containment check rejected never ran.
    assert.equal(code, 0);
    assert.match(stderr, /Flow service will not start: .*Run `flow service install`/s);
    await assert.rejects(NodeFSP.stat(join(home, "userdata/server-runtime.json")), {
      code: "ENOENT",
    });
  },
);
