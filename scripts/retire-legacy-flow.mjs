import * as NodeFSP from "node:fs/promises";
const fs = NodeFSP;
import * as NodePath from "node:path";
const { join, resolve, dirname, isAbsolute, relative } = NodePath;
import * as NodeOS from "node:os";
const { homedir } = NodeOS;
import * as NodeChildProcess from "node:child_process";
const { execFile } = NodeChildProcess;
import * as NodeUtil from "node:util";
const { promisify } = NodeUtil;
import * as NodeURL from "node:url";
const { pathToFileURL } = NodeURL;
const execute = promisify(execFile);
const read = async (path) =>
  fs.readFile(path, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
const list = async (path) =>
  fs.readdir(path).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
const within = (root, path) => path === root || path.startsWith(root + "/");
const legacyHook = (value) => JSON.stringify(value).includes(".flow/bin/flow-hook");
export function parseConfig(text) {
  // Accept editor JSONC while preserving comment-like text inside strings.
  // The original file, including comments, is backed up before any edit.
  let output = "",
    quoted = false,
    escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      output += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') {
      quoted = true;
      output += c;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      output += "\n";
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) throw Error("Unclosed comment");
      i = end + 1;
      output += " ";
      continue;
    }
    output += c;
  }
  let normalized = "";
  quoted = false;
  escaped = false;
  for (let i = 0; i < output.length; i++) {
    const c = output[i];
    if (!quoted && c === "," && /^\s*[}\]]/.test(output.slice(i + 1))) continue;
    normalized += c;
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
  }
  return JSON.parse(normalized);
}
export function cleanIntegration(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const result = structuredClone(value);
  for (const key of ["mcpServers", "servers", "mcp"]) {
    if (result[key] && typeof result[key] === "object") {
      for (const [name, server] of Object.entries(result[key])) {
        if (name === "flow-graph" || JSON.stringify(server).includes(".flow/bin/flow-mcp"))
          delete result[key][name];
      }
    }
  }
  if (result.hooks && typeof result.hooks === "object") {
    for (const [event, entries] of Object.entries(result.hooks)) {
      if (Array.isArray(entries))
        result.hooks[event] = entries.flatMap((entry) => {
          if (Array.isArray(entry?.hooks)) {
            const hooks = entry.hooks.filter((hook) => !legacyHook(hook));
            return hooks.length ? [{ ...entry, hooks }] : [];
          }
          return legacyHook(entry) ? [] : [entry];
        });
    }
  }
  if (result["flow-capture"] && legacyHook(result["flow-capture"])) delete result["flow-capture"];
  if (Array.isArray(result.permissions?.allow))
    result.permissions.allow = result.permissions.allow.filter(
      (x) => !String(x).startsWith("mcp__flow-graph__"),
    );
  if (result.projects && typeof result.projects === "object") {
    for (const key of Object.keys(result.projects))
      result.projects[key] = cleanIntegration(result.projects[key]);
  }
  return result;
}
export function cleanInstructions(text) {
  const unmarked = text
    .replace(/<!-- flow:begin[^]*?<!-- flow:end -->\s*/g, "")
    .replace(/^# >>> flow:begin[^]*?^# <<< flow:end[^\n]*(?:\n|$)/gm, "");
  let retired = false;
  return unmarked
    .split("\n")
    .filter((line) => {
      if (/^\s*\[/.test(line))
        retired = /^\s*\[mcp_servers\.(?:flow-graph|"flow-graph")(?:\.[^\]]+)?\]/.test(line);
      return !retired;
    })
    .join("\n");
}
export function cleanShell(text) {
  // Only the command named flow is retired; other aliases and functions survive.
  const withoutFunctions = text.replace(
    /^(?:function[ \t]+)?flow[ \t]*(?:\(\))?[ \t]*\{[^\n]*\n[^]*?^\}[^\n]*(?:\n|$)/gm,
    (block) =>
      /flow-release\.mjs|flow-browser/.test(block)
        ? block
        : block
            .split("\n")
            .map((line) => (line ? "# Retired legacy Flow: " + line : ""))
            .join("\n"),
  );
  return withoutFunctions.replace(
    /^([ \t]*(?:alias[ \t]+flow=|function[ \t]+flow[ \t]*\(\)[ \t]*\{[^\n]*\}|flow[ \t]*\(\)[ \t]*\{[^\n]*\})[^\n]*)$/gm,
    (line) =>
      /flow-release\.mjs|flow-browser/.test(line) ? line : "# Retired legacy Flow: " + line,
  );
}
const configFiles = [
  ".claude.json",
  ".claude/settings.json",
  ".mcp.json",
  ".codex/hooks.json",
  ".cursor/hooks.json",
  ".cursor/mcp.json",
  ".gemini/settings.json",
  ".agents/hooks.json",
  ".agents/mcp_config.json",
  "opencode.json",
  ".github/hooks/flow.json",
  ".vscode/mcp.json",
];
const textFiles = [
  "CLAUDE.md",
  "AGENTS.md",
  "GEMINI.md",
  ".codex/config.toml",
  ".github/copilot-instructions.md",
];
const ownedFiles = [
  ".claude/skills/flow/SKILL.md",
  ".agents/skills/flow/SKILL.md",
  ".opencode/plugins/flow.ts",
  ".cursor/rules/flow.mdc",
  ".github/skills/flow/SKILL.md",
];
export async function retireLegacyFlow({
  home = homedir(),
  path = process.env.PATH || "",
  run = (file, args) => execute(file, args, { timeout: 30_000 }),
  log = console.log,
  signal = (pid) => process.kill(pid, "SIGTERM"),
} = {}) {
  const changed = [],
    warnings = [],
    stopped = [];
  const backup = join(home, ".flow", "retired", new Date().toISOString().replaceAll(":", "-"));
  const saved = new Set();
  async function save(file) {
    if (saved.has(file)) return;
    const target = join(backup, "files", relative("/", resolve(file)));
    await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const info = await fs.lstat(file);
    if (info.isSymbolicLink()) await fs.symlink(await fs.readlink(file), target);
    else await fs.copyFile(file, target);
    if (!info.isSymbolicLink()) await fs.chmod(target, 0o600);
    saved.add(file);
  }
  async function edit(file, next) {
    const before = await read(file);
    if (before === next) return;
    await save(file);
    // Replace the named file, never write through a symlink into another config.
    const temp = file + ".flow-retire-" + process.pid;
    await fs.writeFile(temp, next, { mode: (await fs.stat(file)).mode & 0o777 });
    await fs.rename(temp, file);
    changed.push(file);
  }
  async function retire(file) {
    await save(file);
    await fs.unlink(file);
    changed.push(file);
  }
  const roots = new Set();
  const binDirs = new Set([
    join(home, ".local/bin"),
    join(home, "bin"),
    ...path.split(":").filter(isAbsolute),
  ]);
  const launchers = [];
  for (const bin of binDirs) {
    const file = join(bin, "flow");
    const info = await fs.lstat(file).catch(() => null);
    if (!info) continue;
    const text = await read(file);
    if (text.includes("# flow-managed-launcher")) continue;
    const target = info.isSymbolicLink() ? resolve(bin, await fs.readlink(file)) : "";
    if (
      text.includes("# Flow CLI — auto-generated by setup.sh") ||
      target.endsWith("/bin/flow.mjs")
    ) {
      const root =
        text.match(/^# Checkout: (.+)$/m)?.[1] || (target ? dirname(dirname(target)) : "");
      if (root) roots.add(resolve(root));
      launchers.push(file);
    } else warnings.push(`Unrecognized command retained: ${file}`);
  }
  for (const name of await list(join(home, ".flow/checkouts")))
    roots.add(join(home, ".flow/checkouts", name));
  const verifiedRoots = [];
  for (const root of roots) {
    try {
      const pkg = JSON.parse(await read(join(root, "package.json")));
      if (pkg.name === "flow" && pkg.bin?.flow === "bin/flow.mjs") {
        verifiedRoots.push(root);
        const canonical = await fs.realpath(root);
        if (canonical !== root) verifiedRoots.push(canonical);
      }
    } catch {
      /* A broken checkout still permits retiring its marked launcher. */
    }
  }
  // Retire login services before stopping listeners so launchd cannot restart them.
  for (const name of await list(join(home, "Library/LaunchAgents"))) {
    if (!name.endsWith(".plist")) continue;
    const file = join(home, "Library/LaunchAgents", name);
    const args = await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", file])
      .then((x) => JSON.parse(x.stdout))
      .catch(() => null);
    if (
      args &&
      (args.ProgramArguments || [args.Program]).some(
        (arg) => typeof arg === "string" && verifiedRoots.some((root) => within(root, arg)),
      )
    ) {
      try {
        await run("/bin/launchctl", ["bootout", `gui/${process.getuid()}`, file]);
      } catch {
        warnings.push(`Could not confirm that launch agent is unloaded: ${file}`);
      }
      await retire(file);
    }
  }
  const ports = new Set();
  for (const root of verifiedRoots) {
    const data = join(root, "data");
    const files = [
      join(data, "dashboard.json"),
      ...(await list(join(data, "projects"))).map((name) =>
        join(data, "projects", name, "project.json"),
      ),
    ];
    for (const file of files) {
      try {
        const value = JSON.parse(await read(file));
        for (const port of [value.port, ...Object.values(value.ports || {})])
          if (Number.isInteger(port) && port > 0 && port < 65536) ports.add(port);
      } catch {
        /* No reliable port record. */
      }
    }
  }
  for (const port of ports) {
    const listeners = await run("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"])
      .then((x) => x.stdout.trim().split(/\s+/).map(Number))
      .catch(() => []);
    for (const pid of listeners) {
      if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid || pid === process.ppid)
        continue;
      const cwd = await run("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"])
        .then((x) =>
          x.stdout
            .split("\n")
            .find((x) => x.startsWith("n"))
            ?.slice(1),
        )
        .catch(() => null);
      if (!cwd || !verifiedRoots.some((root) => within(root, cwd))) {
        warnings.push(`Port ${port} belongs to another process; left running.`);
        continue;
      }
      try {
        signal(pid);
        stopped.push(`legacy service on ${port}`);
      } catch (error) {
        if (error.code !== "ESRCH")
          warnings.push(`Could not stop legacy service on ${port}: ${error.message}`);
      }
    }
  }
  // Match the old Flow container name AND FalkorDB image, never a Redis port alone.
  const docker = await run("docker", ["ps", "-aq"])
    .then((x) => x.stdout.trim().split(/\s+/).filter(Boolean))
    .catch(() => []);
  for (const id of docker) {
    const item = await run("docker", ["inspect", id])
      .then((x) => JSON.parse(x.stdout)[0])
      .catch(() => null);
    if (!item) continue;
    const labels = item.Config?.Labels || {};
    const ownedDatabase =
      /^\/flow-falkordb(?:-[\w.-]+)?$/.test(item.Name || "") &&
      /^(?:docker\.io\/)?falkordb\/falkordb(?::|@|$)/.test(item.Config?.Image || "");
    const ownedCompose = verifiedRoots.includes(labels["com.docker.compose.project.working_dir"]);
    if (ownedDatabase || ownedCompose) {
      try {
        // Save only restoration metadata, never container environment secrets.
        await fs.mkdir(backup, { recursive: true, mode: 0o700 });
        await fs.appendFile(
          join(backup, "containers.jsonl"),
          JSON.stringify({
            id,
            name: item.Name,
            restartPolicy: item.HostConfig?.RestartPolicy,
            wasRunning: item.State?.Running,
          }) + "\n",
          { mode: 0o600 },
        );
        await run("docker", ["update", "--restart=no", id]);
        await run("docker", ["stop", id]);
        stopped.push(item.Name);
      } catch (error) {
        warnings.push(`Could not stop ${item.Name}: ${error.message}`);
      }
    }
  }
  let manifest = {};
  try {
    manifest = JSON.parse((await read(join(home, ".flow/integrations.json"))) || "{}");
  } catch {
    warnings.push(
      "Legacy integration registry is unreadable; scanning common repository folders instead.",
    );
  }
  const repos = new Set([home, ...Object.keys(manifest.repos || {}).filter(isAbsolute)]);
  // Broken installs may have lost their registry. Look for repositories in the
  // usual user code folders without following symlinks or walking dependencies.
  let visited = 0;
  async function discover(directory, depth) {
    if (depth > 5 || ++visited > 5000) return;
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    if (entries.some((entry) => entry.name === ".git")) repos.add(directory);
    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        !["node_modules", "vendor", "build", "dist", "target", "venv", "Library"].includes(
          entry.name,
        )
      )
        await discover(join(directory, entry.name), depth + 1);
    }
  }
  for (const name of [
    "Documents",
    "Desktop",
    "Developer",
    "Projects",
    "projects",
    "code",
    "dev",
    "src",
    "repos",
  ])
    await discover(join(home, name), 0);
  for (const repo of repos) {
    for (const rel of configFiles) {
      const file = join(repo, rel),
        text = await read(file);
      if (!text) continue;
      try {
        const before = parseConfig(text),
          after = cleanIntegration(before);
        if (JSON.stringify(before) !== JSON.stringify(after))
          await edit(file, JSON.stringify(after, null, 2) + "\n");
      } catch (error) {
        if (/flow-graph|\.flow\/bin\/flow-/.test(text))
          warnings.push(`Could not clean legacy config ${file}: ${error.message}`);
      }
    }
    for (const rel of textFiles) {
      const file = join(repo, rel),
        text = await read(file);
      if (text) await edit(file, cleanInstructions(text));
    }
    for (const rel of ownedFiles) {
      const file = join(repo, rel),
        text = await read(file);
      if (text && /flow-graph|\.flow\/bin\/flow-|managed by.*flow setup/.test(text))
        await retire(file);
    }
  }
  for (const name of [".zshrc", ".zprofile", ".bashrc", ".bash_profile", ".profile"]) {
    const file = join(home, name),
      text = await read(file);
    if (text) await edit(file, cleanShell(text));
  }
  for (const file of launchers) await retire(file);
  // Old hooks in unregistered repositories become harmless, including when the
  // old Node executable is unavailable and the hook shim is executed directly.
  const shim = join(home, ".flow/bin/flow-hook");
  if (await read(shim)) await edit(shim, "#!/bin/sh\n':' //; exit 0\n");
  if (changed.length || stopped.length || warnings.length) {
    await fs.mkdir(backup, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      join(backup, "report.json"),
      JSON.stringify({ changed, stopped, warnings }, null, 2),
      { mode: 0o600 },
    );
    log(
      `Retired ${changed.length} old Flow launchers/settings and ${stopped.length} services. Backup: ${backup}`,
    );
    for (const warning of warnings) log(`Note: ${warning}`);
    log("Restart existing terminals and coding-agent sessions to clear cached aliases and hooks.");
  }
  return { changed, stopped, warnings, backup };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await retireLegacyFlow();
