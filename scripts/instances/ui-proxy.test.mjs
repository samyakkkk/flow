import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeHttp from "node:http";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { uiProxy } from "./ui-proxy.mjs";
NodeTest.test(
  "UI proxy follows verified source replacements without changing frontend port",
  async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "flow-ui-proxy-"));
    const servers = [];
    const listen = async (handler) => {
      const server = NodeHttp.createServer(handler);
      servers.push(server);
      server.listen(0, "127.0.0.1");
      await NodeEvents.once(server, "listening");
      return `http://127.0.0.1:${server.address().port}`;
    };
    let relay;
    try {
      const first = await listen((req, res) => res.end("first"));
      const second = await listen((req, res) => res.end("second"));
      let origin = first;
      const url = await listen((req, res) => {
        NodeAssert.equal(req.headers.authorization, "Bearer test");
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ id: "unit", generation: "generation", phase: "ready", origin }));
      });
      await NodeFSP.writeFile(
        NodePath.join(directory, "runtime.json"),
        JSON.stringify({ id: "unit", generation: "generation", token: "test", controlUrl: url }),
      );
      relay = await uiProxy(directory);
      const address = `http://127.0.0.1:${relay.port}/api/test`;
      NodeAssert.equal(await (await fetch(address)).text(), "first");
      origin = second;
      NodeAssert.equal(await (await fetch(address)).text(), "second");
    } finally {
      if (relay) await relay.close();
      await Promise.all(
        servers.map(
          (s) =>
            new Promise((r) => {
              s.closeAllConnections();
              s.close(r);
            }),
        ),
      );
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  },
);
