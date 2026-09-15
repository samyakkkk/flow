import { readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Discovery never starts, stops, migrates or repairs an installation. In
// particular, an unreachable owner is not permission to start another server.
export async function discoverCloudService(home) {
  const installationHome = resolve(home);
  const directory = join(installationHome, 'instance-home/instances/primary');
  const base = { version: 1, installationHome, channel: 'cloud-cli' };
  let config, runtime;
  try {
    config = await readJson(join(directory, 'config.json'));
    runtime = await readJson(join(directory, 'runtime.json'));
  } catch { return { ...base, status: 'invalid', reason: 'Unreadable service metadata.' }; }
  if (!config) return { ...base, status: runtime ? 'invalid' : 'not-configured' };
  if (config.version !== 1) return { ...base, status: 'incompatible', reason: 'Unsupported instance metadata version.' };
  if (typeof config.id !== 'string' || !config.id || config.name !== 'primary' || config.dev || config.mode !== 'isolated' ||
      typeof config.home !== 'string' || typeof config.code !== 'string')
    return { ...base, status: 'invalid', reason: 'Not a standalone primary service.' };
  try {
    if (await realpath(config.home) !== await realpath(join(directory, 'data')))
      return { ...base, status: 'invalid', reason: 'Service data belongs to another installation.' };
  } catch { return { ...base, status: 'invalid', reason: 'Service data directory is unavailable.' }; }
  const identity = { ...base, environmentId: config.id, dataHome: config.home, runningCode: config.code };
  if (!runtime) return { ...identity, status: 'stopped' };
  let url;
  try {
    url = new URL(runtime.controlUrl);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash || runtime.id !== config.id ||
        typeof runtime.generation !== 'string' || !runtime.generation ||
        typeof runtime.token !== 'string' || !runtime.token) throw Error();
  } catch { return { ...identity, status: 'invalid', reason: 'Invalid service control identity.' }; }
  try {
    const response = await fetch(new URL('/status', url), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3000),
      headers: { authorization: `Bearer ${runtime.token}` },
    });
    if (!response.ok) return { ...identity, status: 'unreachable', reason: 'Service rejected the status request.' };
    const live = await response.json();
    if (live.id !== config.id || live.generation !== runtime.generation)
      return { ...identity, status: 'invalid', reason: 'Live service identity does not match this installation.' };
    if (!['starting', 'ready', 'stopping', 'failed'].includes(live.phase))
      return { ...identity, status: 'incompatible', reason: 'Unsupported service lifecycle state.' };
    // Do not forward arbitrary server fields: runtime tokens and control URLs
    // belong to the lifecycle owner, never to a renderer or CLI JSON response.
    return { ...identity, status: live.phase };
  } catch { return { ...identity, status: 'unreachable', reason: 'Service could not be reached.' }; }
}
