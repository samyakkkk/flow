#!/usr/bin/env node
// Synthetic fixture on the Flow host only. Never copies a remote checkout locally.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const project = JSON.parse(readFileSync(join(homedir(), '.flow/config.json'), 'utf8')).projects[process.argv[2]];
assert.ok(project?.mcpUrl && project.token);
const client = new Client({ name: 'flow-source-validation', version: '1' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(project.mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${project.token}` } },
  }));
  const read = await client.callTool({ name: 'source_read', arguments: { repo: 'remote-only-fixture', path: 'refunds.ts' } });
  assert.ok(!read.isError, JSON.stringify(read.content));
  const result = JSON.parse(read.content[0].text);
  assert.match(result.content, /refundWindowDays = 17/);
  assert.ok(!result.content.includes('99'));
  assert.equal(result.revision, result.indexed_revision);
  const search = await client.callTool({ name: 'source_search', arguments: { repo: 'remote-only-fixture', query: 'refundWindowDays' } });
  assert.ok(!search.isError);
  const found = JSON.parse(search.content[0].text);
  assert.equal(found.matches[0].path, 'refunds.ts');
  assert.equal(found.matches[0].line, 2);
  assert.match(found.matches[0].text, /17/);
  for (const args of [{ repo: 'unknown', path: 'refunds.ts' }, { repo: 'remote-only-fixture', path: '../../auth.json' }]) {
    assert.equal((await client.callTool({ name: 'source_read', arguments: args })).isError, true);
  }
  console.log(`PASS: HTTPS source read/search at ${result.revision}; indexed content returned over dirty working copy; unknown repo and traversal denied.`);
} finally { await client.close(); }
