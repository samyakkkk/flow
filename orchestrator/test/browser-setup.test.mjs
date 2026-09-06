import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupTarget, browserSetup } from '../../bin/lib/browser-setup.mjs';
test('setup URL only accepts HTTPS project locations, with loopback for development', async () => {
  assert.deepEqual(setupTarget('https://flow.example/engineering/'), { origin: 'https://flow.example', project: 'engineering' });
  assert.equal(setupTarget('http://localhost:7600/team').project, 'team');
  for (const url of ['http://flow.example/team', 'https://user:password@flow.example/team', 'https://flow.example/team?token=secret', 'https://flow.example/team/extra', 'https://flow.example/team#fragment', 'https://flow.example/']) assert.throws(() => setupTarget(url));
  await assert.rejects(browserSetup('https://flow.example/team', '/fixture', ['codex'], ['codex']), /interactive terminal/);
});

test('URL setup reuses verified credentials; only auth rejection requires browser approval', async () => {
  const { reuseBrowserConnection } = await import('../../bin/lib/browser-setup.mjs');
  const url = 'https://flow.example/team';
  const saved = { gatewayUrl:'https://flow.example/api/connect/team/gateway', orchestratorUrl:'https://flow.example/api/connect/team/orchestrator', token:'private', repo:undefined };
  let calls = 0;
  const result = await reuseBrowserConnection(url, saved, async args => { calls++; assert.equal(args.project,'team'); });
  assert.equal(result.token, saved.token); assert.equal(calls, 1);
  for (const status of [401,403]) assert.equal(await reuseBrowserConnection(url,saved,async()=>{throw Object.assign(new Error('auth'),{status});}),null);
  for (const status of [500,502]) await assert.rejects(reuseBrowserConnection(url,saved,async()=>{throw Object.assign(new Error('outage'),{status});}),/outage/);
  await assert.rejects(reuseBrowserConnection(url,saved,async()=>{throw new Error('project mismatch');}),/mismatch/);
  await assert.rejects(reuseBrowserConnection('https://other.example/team',saved,async()=>assert.fail('must not send credentials')),/different deployment/);
  assert.equal(await reuseBrowserConnection(url,null),null);
});
