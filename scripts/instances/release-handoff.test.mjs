import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeHttp from "node:http";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeURL from "node:url";
import * as NodeEvents from "node:events";

const { test } = NodeTest;
const assert = NodeAssert;
const { join } = NodePath;
const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const repo = NodeURL.fileURLToPath(new URL("../../", import.meta.url));

test(
  "an explicit update hands off to a new release on the same browser origin with the same data",
  { timeout: 30000 },
  async (t) => {
    const root = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(join(NodeOS.tmpdir(), "flow-handoff-")),
    );
    const home = join(root, "install");
    const registry = join(root, "registry");
    const receipt = Promise.withResolvers();
    const receiver = NodeHttp.createServer(async (request, response) => {
      let body = "";
      for await (const part of request) body += part;
      const value = JSON.parse(body);
      if (value.version === "1.1.0") receipt.resolve(value);
      response.end();
    });
    receiver.listen(0, "127.0.0.1");
    await NodeEvents.once(receiver, "listening");
    const environment = {
      ...process.env,
      FLOW_RELEASE_HOME: home,
      FLOW_INSTANCE_HOME: registry,
      FLOW_AUTO_UPDATE: "0",
      TEST_RECEIPT_URL: `http://127.0.0.1:${receiver.address().port}`,
    };
    const command = (...args) =>
      exec(process.execPath, [join(home, "current/scripts/flow-release.mjs"), ...args], {
        env: environment,
        timeout: 20000,
      });
    t.after(async () => {
      await command("stop").catch(() => {});
      await new Promise((resolve) => receiver.close(resolve));
      await NodeFSP.rm(root, { recursive: true, force: true });
    });
    for (const version of ["1.0.0", "1.1.0"]) {
      const code = join(home, "releases", `flow-v${version}`);
      await NodeFSP.mkdir(join(code, "scripts/instances"), { recursive: true });
      for (const file of [
        "scripts/flow.mjs",
        "scripts/flow-release.mjs",
        ...(await NodeFSP.readdir(join(repo, "scripts/instances")))
          .filter((name) => name.endsWith(".mjs") && !name.includes(".test."))
          .map((name) => `scripts/instances/${name}`),
      ]) {
        await NodeFSP.copyFile(join(repo, file), join(code, file));
      }
      await NodeFSP.writeFile(
        join(code, "flow-release.json"),
        JSON.stringify({ tag: `flow-v${version}` }),
      );
      await NodeFSP.mkdir(join(code, "apps/server/src"), { recursive: true });
      // A disposable HTTP server models the launcher protocol without starting
      // Flow, providers, Brain services, or opening any real application database.
      await NodeFSP.writeFile(
        join(code, "apps/server/src/bin.ts"),
        `
import {createServer} from 'node:http';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
const args=process.argv.slice(2);
const home=args[args.indexOf('--base-dir')+1];
if(args[0]==='pair') {
 const runtime=JSON.parse(await readFile(join(home,'userdata/server-runtime.json'),'utf8'));
 console.log('Pairing URL: '+runtime.url+'/?token=fixture');
} else {
 const port=Number(args[args.indexOf('--port')+1]);
 const server=createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({environmentId:'test-environment'}));});
 await mkdir(join(home,'userdata'),{recursive:true});
 await writeFile(join(home,'userdata/server-runtime.json'),JSON.stringify({url:'http://127.0.0.1:'+port}));
 server.listen(port,'127.0.0.1',()=>void fetch(process.env.TEST_RECEIPT_URL,{method:'POST',body:JSON.stringify({version:${JSON.stringify(version)},port,home})}));
 process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
}
`,
      );
    }
    await NodeFSP.symlink("releases/flow-v1.0.0", join(home, "current"));
    await command("--no-open");
    const directory = join(registry, "instances/primary");
    const before = JSON.parse(await NodeFSP.readFile(join(directory, "config.json"), "utf8"));
    const port = JSON.parse(
      await NodeFSP.readFile(join(directory, "release-port.json"), "utf8"),
    ).port;
    await NodeFSP.symlink("releases/flow-v1.1.0", join(home, "next"));
    await NodeFSP.rename(join(home, "next"), join(home, "current"));
    const runtime = JSON.parse(await NodeFSP.readFile(join(directory, "runtime.json"), "utf8"));
    const apply = await fetch(runtime.controlUrl + "/apply-update", {
      method: "POST",
      headers: { authorization: `Bearer ${runtime.token}` },
    });
    assert.equal(apply.ok, true);
    assert.equal((await apply.json()).readyVersion, "1.1.0");
    const ready = await receipt.promise;
    assert.equal(ready.port, port);
    assert.equal(ready.home, before.home);
    const after = JSON.parse(await NodeFSP.readFile(join(directory, "config.json"), "utf8"));
    assert.equal(after.id, before.id);
    assert.equal(after.home, before.home);
    assert.equal(after.code, join(home, "releases/flow-v1.1.0"));
  },
);
