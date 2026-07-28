import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraphFromFixture, hasEdge } from './helpers.ts';

describe('path-alias fixture', () => {
  it('resolves @/ path alias to the target file', () => {
    const graph = buildGraphFromFixture('path-alias');
    assert.ok(
      hasEdge(graph, 'imports', 'app.ts', 'Title.ts'),
      'expected app.ts imports Title.ts via @/ alias',
    );
  });
});
