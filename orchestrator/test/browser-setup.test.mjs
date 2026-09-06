import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupTarget, browserSetup } from '../../bin/lib/browser-setup.mjs';
test('setup URL only accepts HTTPS project locations, with loopback for development', async () => {
  assert.deepEqual(setupTarget('https://flow.example/engineering/'), { origin: 'https://flow.example', project: 'engineering' });
  assert.equal(setupTarget('http://localhost:7600/team').project, 'team');
  for (const url of ['http://flow.example/team', 'https://user:password@flow.example/team', 'https://flow.example/team?token=secret', 'https://flow.example/team/extra', 'https://flow.example/team#fragment', 'https://flow.example/']) assert.throws(() => setupTarget(url));
  await assert.rejects(browserSetup('https://flow.example/team', '/fixture', ['codex'], ['codex']), /interactive terminal/);
});
