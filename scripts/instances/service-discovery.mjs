import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// The state directory of a registry's `primary` instance. The home is recorded
// in `config.json` (an installer may point it at data that already exists, see
// the launcher's `--home`); `<instance>/data` is the layout when it does not.
export async function primaryStateDir(registryRoot) {
  const directory = join(resolve(registryRoot), "instances/primary");
  const config = await readJson(join(directory, "config.json")).catch(() => null);
  const home =
    typeof config?.home === "string" && config.home ? config.home : join(directory, "data");
  return join(home, "userdata");
}

// Discovery never starts, stops, migrates or repairs an installation. In
// particular, an unreachable owner is not permission to start another server.
export async function discoverService({
  registryRoot,
  name = "primary",
  channel = "cloud-cli",
  installationHome,
}) {
  const root = resolve(registryRoot);
  const directory = join(root, "instances", name);
  const base = { version: 1, installationHome: installationHome ?? root, channel };
  let config, runtime;
  try {
    config = await readJson(join(directory, "config.json"));
    runtime = await readJson(join(directory, "runtime.json"));
  } catch {
    return { ...base, status: "invalid", reason: "Unreadable service metadata." };
  }
  if (!config) return { ...base, status: runtime ? "invalid" : "not-configured" };
  if (config.version !== 1)
    return { ...base, status: "incompatible", reason: "Unsupported instance metadata version." };
  if (
    typeof config.id !== "string" ||
    !config.id ||
    config.name !== name ||
    config.dev ||
    config.mode !== "isolated" ||
    typeof config.home !== "string" ||
    !config.home ||
    typeof config.code !== "string"
  )
    return { ...base, status: "invalid", reason: "Not a standalone primary service." };
  // The recorded home is the identity: a service may legitimately own data
  // outside its instance directory. Only its absence disqualifies it, because
  // discovery must never invent a home it did not find.
  try {
    await realpath(config.home);
  } catch {
    return { ...base, status: "invalid", reason: "Service data directory is unavailable." };
  }
  const identity = {
    ...base,
    environmentId: config.id,
    dataHome: config.home,
    runningCode: config.code,
    ...(typeof config.node === "string" && config.node ? { nodePath: config.node } : {}),
  };
  if (!runtime) return { ...identity, status: "stopped" };
  let url;
  try {
    url = new URL(runtime.controlUrl);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      runtime.id !== config.id ||
      typeof runtime.generation !== "string" ||
      !runtime.generation ||
      typeof runtime.token !== "string" ||
      !runtime.token
    )
      throw Error();
  } catch {
    return { ...identity, status: "invalid", reason: "Invalid service control identity." };
  }
  try {
    const response = await fetch(new URL("/status", url), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(3000),
      headers: { authorization: `Bearer ${runtime.token}` },
    });
    if (!response.ok)
      return { ...identity, status: "unreachable", reason: "Service rejected the status request." };
    const live = await response.json();
    if (live.id !== config.id || live.generation !== runtime.generation)
      return {
        ...identity,
        status: "invalid",
        reason: "Live service identity does not match this installation.",
      };
    if (!["starting", "ready", "stopping", "failed"].includes(live.phase))
      return {
        ...identity,
        status: "incompatible",
        reason: "Unsupported service lifecycle state.",
      };
    // Do not forward arbitrary server fields: runtime tokens and control URLs
    // belong to the lifecycle owner, never to a renderer or CLI JSON response.
    return { ...identity, status: live.phase };
  } catch {
    return { ...identity, status: "unreachable", reason: "Service could not be reached." };
  }
}

// The cloud CLI's installation layout: one `primary` service under `instance-home`.
export const discoverCloudService = (home) =>
  discoverService({
    registryRoot: join(resolve(home), "instance-home"),
    installationHome: resolve(home),
  });
