#!/usr/bin/env node
// Opt-in model quality check; no Flow database or gateway writes.
// OPENROUTER_API_KEY=... node --import tsx/esm scripts/check-distiller-quality.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildDistillerPrompt } from '../orchestrator/src/memory/prompt.ts';
import { parseObservations } from '../orchestrator/src/memory/parse.ts';
const key = process.env.OPENROUTER_API_KEY;
assert.ok(key, 'OPENROUTER_API_KEY is required (paid, opt-in model calls)');
const cases = JSON.parse(readFileSync(new URL('../orchestrator/test/fixtures/distiller-quality.json', import.meta.url)));
let failures = 0;
for (const fixture of cases) {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.DISTILLER_EVAL_MODEL || 'anthropic/claude-sonnet-4.6', temperature: 0,
        messages: [{ role: 'user', content: buildDistillerPrompt(fixture.transcript) }] }),
      signal: AbortSignal.timeout(90000),
    });
    assert.ok(res.ok, `Model request returned HTTP ${res.status}`);
    const data = await res.json();
    const response = data.choices?.[0]?.message?.content;
    assert.equal(typeof response, 'string');
    const raw = JSON.parse(response.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''));
    assert.ok(Array.isArray(raw), 'Model returned no JSON array');
    const observations = parseObservations(response);
    assert.equal(observations.length, raw.length, 'Malformed observations were dropped');
    assert.ok(observations.length <= 5, 'Too many observations');
    if (fixture.empty) assert.equal(observations.length, 0, 'Retained routine/session-only content');
    else {
      assert.ok(observations.length > 0, 'Dropped a durable requirement');
      const claims = observations.map(o => o.claim).join('\n').toLowerCase();
      for (const term of fixture.expected) assert.ok(claims.includes(term.toLowerCase()), `Missing expected concept: ${term}`);
    }
    console.log(`PASS ${fixture.name} (${observations.length} observations)`);
  } catch (error) { failures++; console.error(`FAIL ${fixture.name}: ${error.message}`); }
}
console.log(`${cases.length - failures}/${cases.length} cases passed. Review claims as well as these coarse checks; this is a small regression set, not a precision benchmark.`);
process.exitCode = failures ? 1 : 0;
