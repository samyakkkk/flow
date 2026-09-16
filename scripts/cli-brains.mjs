import { request } from '../flow-t3/shared/bin/harness/capture-replay.mjs';

export async function manageBrains(args, rpc = request) {
  const [action, ...rest] = args;
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i].startsWith('--') || !rest[i + 1]) throw Error('Expected --option value');
    const key = rest[i].slice(2);
    if (!['state-dir', 'name', 'cli'].includes(key) || key in options) throw Error(`Unexpected option: ${rest[i]}`);
    options[key] = rest[i + 1];
  }
  if (!options['state-dir']) throw Error('Flow service state directory is required.');
  const binding = { stateDir: options['state-dir'], instance: 'cli-brains' };
  if (action === 'list') {
    const state = await rpc(binding, 'state', { metadataOnly: true });
    // Never forward remote connection credentials or internal runtime descriptors.
    console.log(JSON.stringify(state.workspaces.map(w => ({ id: w.id, name: w.name, location: w.remote ? 'cloud' : 'local' })), null, 2));
    return;
  }
  if (action !== 'create' || !options.name?.trim() || !['claude', 'codex', 'opencode'].includes(options.cli))
    throw Error('Usage: flow brains list | flow brains create --name NAME --cli claude|codex|opencode');
  const id = await rpc(binding, 'command', { command: { action: 'create', name: options.name, cli: options.cli } });
  console.log(JSON.stringify({ id, name: options.name.trim(), location: 'local' }));
}
