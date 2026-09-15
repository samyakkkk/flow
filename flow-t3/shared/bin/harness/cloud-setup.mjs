import { readFile } from 'node:fs/promises';
import { request } from './capture-replay.mjs';

/** Connect through the local runtime so capture and curation retain their normal owner. */
export async function connectCloud({ endpoint, tokenFile, enrollmentFile, stateDir, brainId }, rpc = request, fetcher = fetch) {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw Error('Cloud URL must be an HTTPS origin without credentials or a path.');
  const binding = { stateDir, instance: 'agent-setup' };
  const state = await rpc(binding, 'state', { metadataOnly: true });
  const existing = state.workspaces.find(w => w.remote?.endpoint === url.origin && (!brainId || w.remote.brainId === brainId));
  if (existing) {
    if (existing.remote.status !== 'ready') throw Error('The connected Cloud Brain is unavailable. Repair its connection in Flow.');
    return existing.id;
  }
  if (!tokenFile && !enrollmentFile) throw Error('Copy a setup prompt from your Cloud dashboard.');
  let token;
  if (enrollmentFile) {
    const response = await fetcher(new URL('/auth/enroll', url), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: (await readFile(enrollmentFile, 'utf8')).trim() }),
    });
    const grant = await response.json();
    if (!response.ok || (brainId && grant.brainId !== brainId) || typeof grant.token !== 'string')
      throw Error('Setup prompt expired, was already used, or belongs to another Brain. Copy a new prompt.');
    token = grant.token;
  } else token = (await readFile(tokenFile, 'utf8')).trim();
  if (!token) throw Error('The Cloud connection credential is empty.');
  // Verify the intended remote identity before persisting any local connection.
  const response = await fetcher(new URL('/v1/brain', url), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ version: 1, method: 'state', instance: 'agent-setup', metadataOnly: true }),
  });
  const remote = await response.json();
  if (!response.ok || remote.error) throw Error(`Cloud connection failed (${response.status}). Generate a new setup prompt in the dashboard.`);
  const remoteState = remote.result ?? remote;
  if (brainId && (remoteState.workspaces?.length !== 1 || remoteState.workspaces[0].id !== brainId))
    throw Error('The Cloud endpoint serves a different Brain. No connection was saved.');
  return rpc(binding, 'command', { command: { action: 'connectCloud', endpoint: url.origin, token } });
}
