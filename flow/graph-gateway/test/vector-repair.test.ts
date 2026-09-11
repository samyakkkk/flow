import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

test('merge preserves embedding ownership, reconciliation repairs lists, and missing repos stay missing', async () => {
  const queries: Array<{ q: string; p: any }> = [];
  let vectorFailure = false;
  mock.module('../src/graph.js', { namedExports: {
    DEFAULT_GRAPH: 'test', deletedGraphError: async () => null, raw: async () => ({}),
    run: async (_g: string, q: string, p: any = {}) => {
      queries.push({ q, p });
      if (q.includes('keepProps')) return [{ keepProps: { id: 'svc:a', name: 'Alpha' }, removeProps: { id: 'svc:b', embedding: [1, 0], description: 'merged description' } }];
      if (q.includes('MATCH (r:Repository)')) return [{ id: 'repo:engineering-docs', name: 'engineering-docs', description: 'Wrong repository' }];
      if (q.includes('vec.cosineDistance')) {
        assert.match(q, /typeOf\(n.embedding\) = 'Vectorf32'/);
        if (vectorFailure) throw new Error('vector service failed');
        return [];
      }
      if (q.includes('RETURN n.id AS id, labels(n)')) return [{ id: 'svc:a', type: 'Service', name: 'Alpha' }];
      if (q.includes('RETURN labels(n)[0] AS type, n.name')) return [{ type: 'Service', name: 'Alpha', description: 'merged description' }];
      return [];
    },
  }});
  mock.module('../src/journal.js', { namedExports: { record: async () => {}, tail: async () => [] } });
  mock.module('../src/embed.js', { namedExports: {
    embeddingsEnabled: () => true, entityText: () => 'merged content',
    embedText: async () => [1, 0], embedQuery: async () => ({ vec: [1, 0] }), embedBatch: async () => [[1, 0]],
  }});
  const { callVerb } = await import('../src/verbs.js');
  await callVerb('merge_entities', { keep: 'svc:a', remove: 'svc:b', provenance: { actor: 'test', source: 'test' } });
  const fill = queries.find(x => x.q.includes('SET n += $fill'));
  assert.ok(fill);
  assert.equal(fill.p.fill.embedding, undefined);
  assert.equal(fill.p.fill.description, 'merged description');
  assert.match(fill.q, /n.embedding = NULL/);
  assert.ok(queries.some(x => x.q.includes('SET n.embedding = vecf32($vec)')));
  const { reconcileEmbeddings } = await import('../src/reconcile.js');
  const result = await reconcileEmbeddings('test', { log: () => {} });
  assert.equal(result.embedded, 1);
  assert.ok(queries.some(x => x.q.includes("typeOf(n.embedding) <> 'Vectorf32'")));
  const orient = await callVerb('orient', { repo: 'screenshot-headless' });
  assert.match(JSON.stringify(orient), /not indexed/);
  assert.doesNotMatch(JSON.stringify(orient), /Wrong repository/);
  vectorFailure = true;
  const search = await callVerb('find_entity', { q: 'some service' });
  assert.match(JSON.stringify(search), /vector search failed/);
  assert.notEqual(search.status, 'error');
});
