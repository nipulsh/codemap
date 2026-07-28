import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraphFromFixture, hasEdge } from './helpers.ts';

describe('monorepo-two-tsconfig fixture', () => {
  it('resolves each package alias via its own tsconfig', () => {
    const graph = buildGraphFromFixture('monorepo-two-tsconfig');

    assert.ok(
      hasEdge(graph, 'imports', 'consumer.ts', 'index.ts'),
      'package a: @a/index should resolve',
    );
    assert.ok(
      hasEdge(graph, 'imports', 'main.ts', 'util.ts'),
      'package b: @b/util should resolve',
    );
  });
});
