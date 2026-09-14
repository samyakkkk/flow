import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectCloud } from '../harness/cloud-setup.mjs';

test('reuses the matching connected Cloud Brain without reading a credential', async () => {
  const result = await connectCloud({ endpoint: 'https://brain.example/', brainId: 'remote', stateDir: '/state' }, async () => ({ workspaces: [
    { id: 'other', remote: { endpoint: 'https://other.example', brainId: 'remote', status: 'ready' } },
    { id: 'local', remote: { endpoint: 'https://brain.example', brainId: 'remote', status: 'ready' } },
  ] }));
  assert.equal(result, 'local');
});

test('validates the remote identity before saving and never migrates an existing local Brain', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flow-cloud-setup-'));
  try {
    const tokenFile = join(dir, 'credential');
    await writeFile(tokenFile, 'synthetic-connection-credential', { mode: 0o600 });
    const commands = [];
    const rpc = async (_, method, fields) => {
      if (method === 'state') return { workspaces: [{ id: 'existing-local' }] };
      commands.push(fields.command);
      return 'new-remote-binding';
    };
    const options = { endpoint: 'https://brain.example', brainId: 'expected', stateDir: dir, tokenFile };
    await assert.rejects(connectCloud(options, rpc, async () => Response.json({ result: { workspaces: [{ id: 'wrong' }] } })), /different Brain/);
    assert.equal(commands.length, 0);
    const result = await connectCloud(options, rpc, async (url, init) => {
      assert.equal(url.href, 'https://brain.example/v1/brain');
      assert.equal(init.redirect, 'error');
      return Response.json({ result: { workspaces: [{ id: 'expected' }] } });
    });
    assert.equal(result, 'new-remote-binding');
    assert.deepEqual(commands, [{ action: 'connectCloud', endpoint: 'https://brain.example', token: 'synthetic-connection-credential' }]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('rejects insecure origins and unavailable existing connections', async () => {
  await assert.rejects(connectCloud({ endpoint: 'http://brain.example' }), /HTTPS/);
  await assert.rejects(connectCloud({ endpoint: 'https://brain.example', brainId: 'remote' }, async () => ({ workspaces: [
    { id: 'local', remote: { endpoint: 'https://brain.example', brainId: 'remote', status: 'error' } },
  ] })), /unavailable/);
});

test('redeems dashboard enrollment before connecting and does not send the enrollment to Brain RPC', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flow-enrollment-'));
  try {
    const enrollmentFile=join(dir,'grant');await writeFile(enrollmentFile,'one-use-fixture');
    const calls=[];
    const id=await connectCloud({endpoint:'https://brain.example',brainId:'expected',stateDir:dir,enrollmentFile},async(_,method,fields)=>{
      if(method==='state')return {workspaces:[]};
      assert.equal(fields.command.token,'connection-fixture');return 'bound';
    },async(url,init)=>{
      calls.push(url.pathname);
      if(url.pathname==='/auth/enroll'){
        assert.equal(JSON.parse(init.body).token,'one-use-fixture');
        return Response.json({token:'connection-fixture',brainId:'expected'});
      }
      assert.equal(init.headers.authorization,'Bearer connection-fixture');
      return Response.json({result:{workspaces:[{id:'expected'}]}});
    });
    assert.equal(id,'bound');assert.deepEqual(calls,['/auth/enroll','/v1/brain']);
  }finally{await rm(dir,{recursive:true,force:true});}
});
