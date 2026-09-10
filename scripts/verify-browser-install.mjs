/* oxlint-disable t3code/no-global-process-runtime -- Standalone installation tooling reads the host before the app runtime exists. */
// Run after installing into a fresh release archive, never a developer checkout.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeModule from "node:module";

const root = NodePath.resolve(process.argv[2] || ".");
const store = NodePath.join(root, "node_modules/.pnpm");
let count = 0;
for (const entry of NodeFS.readdirSync(store, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === "node_modules") continue;
  count++;
  NodeAssert.doesNotMatch(
    entry.name,
    /^(?:expo(?:-|@)|@expo\+|alchemy@|workerd@|@cloudflare\+)/,
    `Unrelated mobile/cloud package installed: ${entry.name}`,
  );
  // Native package manifests describe which platform the payload supports.
  const modules = NodePath.join(store, entry.name, "node_modules");
  for (const name of NodeFS.readdirSync(modules)) {
    const base = NodePath.join(modules, name);
    if (NodeFS.lstatSync(base).isSymbolicLink()) continue;
    const paths = name.startsWith("@")
      ? NodeFS.readdirSync(base).map((child) => NodePath.join(base, child))
      : [base];
    for (const path of paths) {
      if (NodeFS.lstatSync(path).isSymbolicLink()) continue;
      const manifest = NodePath.join(path, "package.json");
      if (!NodeFS.existsSync(manifest)) continue;
      const pkg = JSON.parse(NodeFS.readFileSync(manifest, "utf8"));
      for (const [field, current] of [
        ["os", NodeOS.platform()],
        ["cpu", NodeOS.arch()],
      ]) {
        const values = pkg[field];
        if (!Array.isArray(values)) continue;
        const positive = values.filter((value) => !value.startsWith("!"));
        NodeAssert.ok(
          !values.includes(`!${current}`) &&
            (!positive.length || positive.includes(current) || positive.includes("any")),
          `${pkg.name} targets ${field}=${values}, not ${current}`,
        );
      }
      if (pkg.name === "electron") {
        NodeAssert.ok(
          !NodeFS.existsSync(NodePath.join(path, "dist")),
          "Browser installs must not download the Electron executable",
        );
      }
    }
  }
}
for (const workspace of [
  "apps/mobile",
  "apps/desktop",
  "apps/marketing",
  "infra/relay",
  "flow-t3/cloud",
]) {
  NodeAssert.ok(
    !NodeFS.existsSync(NodePath.join(root, workspace, "node_modules")),
    `Unrelated workspace installed: ${workspace}`,
  );
}
for (const [workspace, dependencies] of [
  [
    "apps/server",
    ["better-sqlite3", "node-pty", "node-llama-cpp", "falkordblite", "@flow/brain-runtime"],
  ],
  ["apps/web", ["react", "vite-plus", "@t3tools/client-runtime/load-balancing"]],
  ["flow-t3/shared/graph-gateway", ["tsx", "falkordb"]],
  ["flow-t3/shared/orchestrator", ["@modelcontextprotocol/sdk/client/index.js", "fastify"]],
]) {
  const require = NodeModule.createRequire(NodePath.join(root, workspace, "package.json"));
  for (const dependency of dependencies) require.resolve(dependency);
}
const serverRequire = NodeModule.createRequire(NodePath.join(root, "apps/server/package.json"));
const Database = serverRequire("better-sqlite3");
const database = new Database(":memory:");
try {
  NodeAssert.equal(database.prepare("select 42 as answer").get().answer, 42);
} finally {
  database.close();
}
await new Promise((resolve, reject) => {
  const terminal = serverRequire("node-pty").spawn("/bin/sh", ["-c", "printf FLOW_TERMINAL_OK"], {
    name: "xterm",
    cols: 80,
    rows: 24,
    cwd: root,
  });
  const timer = setTimeout(() => {
    terminal.kill();
    reject(new Error("Native terminal smoke test timed out"));
  }, 10_000);
  let output = "";
  terminal.onData((data) => {
    output += data;
  });
  terminal.onExit(({ exitCode }) => {
    clearTimeout(timer);
    try {
      NodeAssert.equal(exitCode, 0);
      NodeAssert.match(output, /FLOW_TERMINAL_OK/);
      resolve();
    } catch (error) {
      reject(error);
    }
  });
});
console.log(
  `Browser installation verified: ${count} packages, ${NodeOS.platform()}/${NodeOS.arch()}, no unrelated workspace or platform payloads.`,
);
