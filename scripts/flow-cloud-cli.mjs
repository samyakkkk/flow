#!/usr/bin/env node
import * as fs from 'node:fs/promises';
import { homedir, platform, arch } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { adoptBundle, newerTag, stageRelease, main as runtimeMain } from './flow-release.mjs';
import { discoverCloudService } from './instances/service-discovery.mjs';
const self = fileURLToPath(import.meta.url);
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
const read = async p => JSON.parse(await fs.readFile(p, 'utf8'));
export function selectCloudRelease(releases, target = `${platform()}-${arch()}`) {
  if (!['darwin-arm64', 'linux-x64'].includes(target)) throw Error('Cloud CLI supports Apple Silicon macOS and Linux x64.');
  const eligible = releases.filter(r => /^flow-cloud-cli-v\d+\.\d+\.\d+$/.test(r.tag_name) && !r.draft && !r.prerelease);
  const selected = eligible.reduce((a, b) => !a || newerTag(b.tag_name.replace('flow-cloud-cli-', 'flow-'), a.tag_name.replace('flow-cloud-cli-', 'flow-')) ? b : a, null);
  if (!selected) throw Error('No Cloud CLI release is published yet.');
  const name = `flow-browser-${target}.tar.gz`;
  const archiveUrl = `https://github.com/samyakkkk/flow/releases/download/${selected.tag_name}/${name}`;
  for (const [asset, url] of [[name, archiveUrl], [name+'.sha256', archiveUrl+'.sha256']])
    if (!selected.assets?.some(a => a.name === asset && a.browser_download_url === url)) throw Error(`Cloud CLI release is missing ${asset}.`);
  return { tag: selected.tag_name.replace('flow-cloud-cli-', 'flow-'), archiveUrl, checksumUrl: archiveUrl+'.sha256', assetName: name };
}
export async function latestCloudRelease(fetcher = fetch) {
  const response = await fetcher('https://api.github.com/repos/samyakkkk/flow/releases?per_page=100', { signal: AbortSignal.timeout(2500), headers: { 'User-Agent': 'Flow-Cloud-CLI' } });
  if (!response.ok) throw Error(`Update check failed (${response.status}).`);
  return selectCloudRelease(await response.json());
}
async function prepare(home) {
  const lock = new DatabaseSync(join(home, 'update-lock.sqlite'));
  try {
    lock.exec('BEGIN EXCLUSIVE');
    await stageRelease(home, await latestCloudRelease());
  } finally { lock.close(); }
}
export const usage = `Flow — local and Cloud Brains, one browser app.
flow [--web|--no-open]       Start or reuse Flow and open its browser UI
flow setup --brain ID [--folder PATH] [--harness detected]
flow setup --cloud URL --cloud-brain ID --enrollment-file FILE [--folder PATH]
flow brains list
flow brains create --name NAME --cli claude|codex|opencode
flow agents status|doctor|flush|remove [--folder PATH]
flow status | flow service status | flow stop | flow restart | flow update
The packaged CLI includes Node. Desktop apps and their data are unchanged.`;

export async function dispatch(args, run = runtimeMain) {
  if (!args.length || (args.length === 1 && args[0] === '--web')) return run([]);
  if (args.length === 1 && args[0] === '--no-open') return run(args);
  if (args[0] === 'setup') {
    if (args.includes('--local') && args.includes('--cloud')) throw Error('Choose --local or --cloud, not both.');
    const setup = args.flatMap(arg => arg === '--local' ? ['--local', 'true'] : [arg]);
    if (!setup.includes('--brain') && !setup.includes('--cloud')) return run([]);
    if (!setup.includes('--harness')) setup.push('--harness', 'detected');
    return run(setup);
  }
  if (['agents', 'brains'].includes(args[0])) return run(args);
  if (args[0] === 'doctor') return run(['agents', ...args]);
  if (['status', 'stop', 'restart'].includes(args[0])) return run([...args, '--no-open']);
  throw Error(usage);
}

export async function main(args) {
  if (['--help', 'help'].includes(args[0])) { console.log(usage); return; }
  // Retain the shipped home/channel so existing Cloud installations adopt this CLI in place.
  const home = process.env.FLOW_CLI_HOME || process.env.FLOW_CLOUD_CLI_HOME || join(homedir(), '.local/share/flow-cloud-cli');
  if (args[0] === 'service' && args[1] === 'status' && args.length === 2) {
    console.log(JSON.stringify(await discoverCloudService(home), null, 2));
    return;
  }
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  // This distribution must never discover or update the Mac/browser installation.
  process.env.FLOW_AGENT_HOME = join(home, 'agents');
  process.env.FLOW_RELEASE_HOME = home;
  process.env.FLOW_INSTANCE_HOME = join(home, 'instance-home');
  process.env.FLOW_AUTO_UPDATE = '0';
  delete process.env.FLOW_SHARED_BRAIN_HOME;
  delete process.env.FLOW_MANAGED_INSTANCE_ID;
  const shims = join(home, 'agents/bin');
  if (await fs.stat(shims).catch(() => null)) {
    const source = join(dirname(self), '../flow-t3/shared/bin/harness');
    for (const [from, to] of [['flow-hook.mjs', 'flow-hook'], ...['agent-connector.mjs', 'capture-replay.mjs', 'agent-home.mjs', 'cloud-setup.mjs'].map(name => [name, name])]) {
      const temporary = join(shims, `.${to}-${randomUUID()}`);
      await fs.copyFile(join(source, from), temporary);
      await fs.rename(temporary, join(shims, to));
    }
  }
  if (args[0] === '--prepare-update') return prepare(home);
  if (args[0] === 'install-bundle') {
    await adoptBundle(home, args[1], args[2]);
    const bin = join(home, 'bin'); await fs.mkdir(bin, { recursive: true });
    const launcher = `#!/bin/sh\n# flow-cloud-cli-launcher\nexport FLOW_CLOUD_CLI_HOME=${quote(home)}\nexec ${quote(join(home,'current/runtime/bin/node'))} ${quote(join(home,'current/scripts/flow-cloud-cli.mjs'))} "$@"\n`;
    await fs.writeFile(join(bin, 'flow'), launcher, { mode: 0o755 });
    const publicBin = join(homedir(), '.local/bin'); await fs.mkdir(publicBin, { recursive: true });
    try { await fs.writeFile(join(publicBin, 'flow'), launcher, { mode: 0o755, flag: 'wx' }); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    console.log(`Flow CLI installed: ${join(bin, 'flow')}. Existing Flow commands and Mac apps are preserved.`);
    return;
  }
  if (args[0] === 'update') { await prepare(home); console.log('Flow CLI updated. Run flow restart to apply a prepared server update.'); return; }
  try {
    if (process.env.FLOW_CLI_AUTO_UPDATE === '0') throw Error('Automatic updates disabled');
    const latest = await latestCloudRelease();
    const installed = await read(join(home, 'current/flow-release.json'));
    if (newerTag(latest.tag, installed.tag)) {
      const log = await fs.open(join(home, 'update.log'), 'a', 0o600);
      const child = spawn(process.execPath, [self, '--prepare-update'], { detached: true, stdio: ['ignore', log.fd, log.fd], env: process.env });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref(); await log.close();
      console.error('Downloading a Flow CLI update in the background.');
    }
  } catch { /* Offline update checks must not block installed commands. */ }
  return dispatch(args);
}
if (process.argv[1] && pathToFileURL(await fs.realpath(process.argv[1])).href === import.meta.url)
  main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exitCode = 1; });
