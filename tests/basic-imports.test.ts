import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraphFromFixture, findFileNode, hasEdge } from './helpers.ts';

describe('basic-imports fixture', () => {
  it('creates an imports edge from main.ts to utils.ts', () => {
    const graph = buildGraphFromFixture('basic-imports');
    assert.ok(findFileNode(graph, 'main.ts'), 'main.ts node');
    assert.ok(findFileNode(graph, 'utils.ts'), 'utils.ts node');
    assert.ok(
      hasEdge(graph, 'imports', 'main.ts', 'utils.ts'),
      'expected imports edge main -> utils',
    );
  });

  it('creates folder contains edges', () => {
    const graph = buildGraphFromFixture('basic-imports');
    const folders = graph.nodes.filter((n) => n.kind === 'Folder');
    assert.ok(folders.length >= 1);
    const contains = graph.edges.filter((e) => e.kind === 'contains');
    assert.ok(contains.length >= 1);
  });
});
