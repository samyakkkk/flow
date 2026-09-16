import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manageBrains } from './cli-brains.mjs';

test('local Brain creation delegates to the service and invalid providers cannot create', async () => {
  const calls = [];
  await manageBrains(['create', '--state-dir', '/isolated', '--name', 'Test', '--cli', 'claude'], async (...args) => { calls.push(args); return 'brain-id'; });
  assert.deepEqual(calls, [[{stateDir:'/isolated', instance:'cli-brains'}, 'command', {command:{action:'create', name:'Test', cli:'claude'}}]]);
  await assert.rejects(manageBrains(['create', '--state-dir', '/isolated', '--name', 'Test', '--cli', 'unknown'], () => assert.fail()), /Usage/);
});

test('local creation propagates service failure instead of claiming success', async () => {
  await assert.rejects(manageBrains(['create', '--state-dir', '/isolated', '--name', 'Test', '--cli', 'claude'], async () => { throw Error('Local database unavailable'); }), /database unavailable/);
});
