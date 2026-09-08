import * as NodeHttp from "node:http";
import * as NodeEvents from "node:events";
import { control } from "./launcher.mjs";
// Keep Vite's target stable while the source app changes ports on replacement.
export async function uiProxy(sourceDirectory) {
  const sockets = new Set();
  const target = async () => {
    const source = await control(sourceDirectory);
    if (source?.phase !== "ready") throw Error("Source instance is unavailable");
    return new URL(source.origin);
  };
  const server = NodeHttp.createServer(async (request, response) => {
    try {
      const origin = await target();
      const upstream = NodeHttp.request(
        new URL(origin.origin + (request.url.startsWith("/") ? request.url : "/")),
        { method: request.method, headers: { ...request.headers, host: origin.host } },
        (remote) => {
          response.writeHead(remote.statusCode, remote.headers);
          remote.pipe(response);
        },
      );
      upstream.on("error", () => {
        if (!response.headersSent) response.writeHead(502);
        response.end("Source instance is unavailable");
      });
      request.on("aborted", () => upstream.destroy());
      request.pipe(upstream);
    } catch {
      response.writeHead(503).end("Source instance is unavailable");
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", async (request, socket, head) => {
    try {
      const origin = await target();
      const upstream = NodeHttp.request(
        new URL(origin.origin + (request.url.startsWith("/") ? request.url : "/")),
        { headers: { ...request.headers, host: origin.host } },
      );
      upstream.on("upgrade", (response, remote, remoteHead) => {
        socket.write(
          `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n` +
            response.rawHeaders.reduce(
              (text, value, index, values) =>
                index % 2 ? text : text + value + ": " + values[index + 1] + "\r\n",
              "",
            ) +
            "\r\n",
        );
        if (remoteHead.length) socket.write(remoteHead);
        if (head.length) remote.write(head);
        socket.pipe(remote);
        remote.pipe(socket);
        socket.on("error", () => remote.destroy());
        remote.on("error", () => socket.destroy());
        socket.once("close", () => remote.destroy());
        remote.once("close", () => socket.destroy());
      });
      upstream.on("response", () => {
        socket.destroy();
        upstream.destroy();
      });
      upstream.on("error", () => socket.destroy());
      upstream.end();
    } catch {
      socket.destroy();
    }
  });
  server.listen(0, "127.0.0.1");
  await NodeEvents.once(server, "listening");
  return {
    port: server.address().port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
