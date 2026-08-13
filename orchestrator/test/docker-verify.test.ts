// docker-verify.test.ts — verifyFalkordb (bin/lib/docker.mjs) must refuse to
// adopt whatever answers on the FalkorDB port unless it really is a usable
// FalkorDB. A plain Redis, a password-protected Redis, or an HTTP server
// squatting the port previously got adopted silently — and every graph write
// then failed where users couldn't see it.

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
// Plain ESM module from the CLI — imported relatively; no orchestrator deps.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — untyped .mjs
import { verifyFalkordb } from "../../bin/lib/docker.mjs";

type Responder = (chunk: string, sock: Socket) => void;

const servers: Server[] = [];
after(() => {
  for (const s of servers) s.close();
});

function fakeServer(respond: Responder): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer((sock) => {
      sock.on("data", (d) => respond(d.toString("utf8"), sock));
    });
    servers.push(srv);
    srv.listen(0, "127.0.0.1", () => resolve((srv.address() as { port: number }).port));
  });
}

describe("verifyFalkordb", () => {
  test("real FalkorDB shape (PONG + GRAPH.LIST array) verifies", async () => {
    const port = await fakeServer((chunk, sock) => {
      if (chunk.includes("PING")) sock.write("+PONG\r\n");
      else if (chunk.includes("GRAPH.LIST")) sock.write("*0\r\n");
    });
    const v = await verifyFalkordb("127.0.0.1", port);
    assert.equal(v.ok, true);
  });

  test("plain Redis (no graph module) is rejected with a readable reason", async () => {
    const port = await fakeServer((chunk, sock) => {
      if (chunk.includes("PING")) sock.write("+PONG\r\n");
      else if (chunk.includes("GRAPH.LIST")) sock.write("-ERR unknown command 'GRAPH.LIST'\r\n");
    });
    const v = await verifyFalkordb("127.0.0.1", port);
    assert.equal(v.ok, false);
    assert.match(v.reason, /plain Redis/);
  });

  test("password-protected Redis is rejected", async () => {
    const port = await fakeServer((chunk, sock) => {
      if (chunk.includes("PING")) sock.write("-NOAUTH Authentication required.\r\n");
    });
    const v = await verifyFalkordb("127.0.0.1", port);
    assert.equal(v.ok, false);
    assert.match(v.reason, /password-protected/);
  });

  test("an HTTP server on the port is rejected", async () => {
    const port = await fakeServer((_chunk, sock) => {
      sock.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    });
    const v = await verifyFalkordb("127.0.0.1", port);
    assert.equal(v.ok, false);
  });

  test("a closed port does not verify", async () => {
    const v = await verifyFalkordb("127.0.0.1", 1); // nothing listens on port 1
    assert.equal(v.ok, false);
    assert.match(v.reason, /Redis protocol/);
  });
});
