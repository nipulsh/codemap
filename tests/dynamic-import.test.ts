import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraphFromFixture, hasEdge } from './helpers.ts';

describe('dynamic-import fixture', () => {
  it('creates a dynamicImport edge, not a static imports edge', () => {
    const graph = buildGraphFromFixture('dynamic-import');
    assert.ok(
      hasEdge(graph, 'dynamicImport', 'entry.ts', 'lazy.ts'),
      'expected dynamicImport edge',
    );
    assert.equal(
      hasEdge(graph, 'imports', 'entry.ts', 'lazy.ts'),
      false,
      'should not use static imports kind for dynamic import()',
    );
  });
});
