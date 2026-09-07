import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { discoverExecutable, executableCandidates } from '../../bin/lib/executables.mjs';
test('service restart discovers standard installs and remembers custom locations without shell startup files', () => {
 const home = mkdtempSync(path.join(tmpdir(),'flow-discovery-'));
 const make = file => { mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,'#!/bin/sh\nexit 0\n',{mode:0o755});return file; };
 const options = {home,env:{PATH:''},accept:file=>file.startsWith(home+path.sep)};
 try {
  const installed=make(path.join(home,'.opencode/bin/opencode'));
  assert.equal(discoverExecutable('opencode',options),installed);
  const custom=make(path.join(home,'custom/opencode'));
  assert.equal(discoverExecutable('opencode',{...options,env:{PATH:path.dirname(custom)}}),custom);
  assert.equal(discoverExecutable('opencode',options),custom,'saved selection survives minimal PATH');
  rmSync(custom);assert.equal(discoverExecutable('opencode',options),installed,'removed selection is rediscovered');
  chmodSync(installed,0o644);assert.equal(discoverExecutable('opencode',options),null,'non-executable is rejected');
  const codex=make(path.join(home,'.nvm/versions/node/v22.22.3/bin/codex'));
  assert.equal(discoverExecutable('codex',options),codex);
  const claude=make(path.join(home,'.local/bin/claude'));
  assert.equal(discoverExecutable('claude',options),claude);
  assert.deepEqual(executableCandidates('claude',{...options,accept:()=>false}),[],'managed executable exclusion survives fallback');
  assert.deepEqual(executableCandidates('../unsafe',options),[]);
  assert.equal(JSON.parse(readFileSync(path.join(home,'.flow/executables/codex.json'),'utf8')).path,codex);
 } finally {rmSync(home,{recursive:true,force:true});}
});
