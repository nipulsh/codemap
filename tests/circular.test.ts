import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraphFromFixture, findFileNode } from './helpers.ts';

describe('circular fixture', () => {
  it('marks nodes/edges participating in a cycle', () => {
    const graph = buildGraphFromFixture('circular');
    const a = findFileNode(graph, 'a.ts');
    const b = findFileNode(graph, 'b.ts');
    assert.ok(a && b);

    const cycleNodes = graph.nodes.filter((n) => n.metadata?.cycle === true);
    assert.ok(
      cycleNodes.length >= 2,
      `expected cycle metadata on nodes, got ${cycleNodes.length}`,
    );

    const cycleEdges = graph.edges.filter((e) => e.metadata?.cycle === true);
    assert.ok(
      cycleEdges.length >= 1,
      'expected at least one cycle-marked edge',
    );
  });
});
