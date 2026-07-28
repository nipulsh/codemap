import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraphFromFixture, hasEdge } from './helpers.ts';

describe('barrel-reexport fixture', () => {
  it('links consumer through barrel to underlying module', () => {
    const graph = buildGraphFromFixture('barrel-reexport');

    assert.ok(
      hasEdge(graph, 'imports', 'app.ts', 'greet.ts'),
      'expected app.ts -> greet.ts after barrel hop',
    );
  });
});
