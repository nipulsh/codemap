import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { StaticRouteTrace } from '../src/routes/types.ts';
import type { RuntimeSpan, RuntimeTrace } from '../src/runtime/types.ts';
import {
  buildStaticTraceNodeIndex,
  correlateSpanToStaticNode,
} from '../src/runtime/TraceCorrelation.ts';
import {
  createTraceOverlay,
  serializeTraceOverlay,
  TRACE_OVERLAY_LIMITATIONS,
} from '../src/runtime/TraceOverlay.ts';
import { TraceOverlaySchema, enrichSnapshotWithOverlay } from '../shared/traceOverlay.ts';
import { projectTraceToSnapshot } from '../shared/routeTrace.ts';

const ROUTE = {
  id: 'route:get:/api/test',
  method: 'GET' as const,
  path: '/api/test',
  framework: 'express' as const,
  sourceFile: '/proj/routes.ts',
  line: 1,
  handlerSymbol: 'handlerA',
  handlerResolved: true,
  confidence: 'high' as const,
};

function node(
  id: string,
  functionName: string,
  filePath: string,
  line: number,
  depth: number,
  symbolId?: string,
): StaticRouteTrace['nodes'][number] {
  return {
    id,
    symbolId,
    functionName,
    filePath,
    line,
    depth,
    resolution: 'resolved',
  };
}

function span(
  spanId: string,
  opts: Partial<RuntimeSpan> & { startedAt: number },
): RuntimeSpan {
  return {
    spanId,
    traceId: 'rt1',
    status: 'completed',
    resolution: 'resolved',
    ...opts,
  };
}

function minimalStaticTrace(
  nodes: StaticRouteTrace['nodes'],
  edges: StaticRouteTrace['edges'],
  entryHandler?: StaticRouteTrace['entryHandler'],
): StaticRouteTrace {
  return {
    routeId: ROUTE.id,
    route: ROUTE,
    entryHandler,
    nodes,
    edges,
    maxDepth: 8,
    truncated: false,
    unresolved: [],
    limitations: [],
  };
}

function minimalRuntimeTrace(spans: RuntimeSpan[]): RuntimeTrace {
  return {
    traceId: 'rt1',
    routeId: ROUTE.id,
    startedAt: 0,
    completedAt: 100,
    durationMs: 100,
    status: 'completed',
    spans,
  };
}

describe('correlateSpanToStaticNode precedence', () => {
  const staticTrace = minimalStaticTrace(
    [
      node('node-a', 'funcA', '/proj/a.ts', 10, 0, 'sym-a'),
      node('node-b', 'funcB', '/proj/b.ts', 20, 1, 'sym-b'),
      node('node-c', 'funcC', '/proj/c.ts', 30, 2),
    ],
    [],
  );
  const index = buildStaticTraceNodeIndex(staticTrace);

  it('matches exact symbol ID with exact / symbol-id', () => {
    const match = correlateSpanToStaticNode(
      span('s1', { startedAt: 0, symbolId: 'sym-a' }),
      index,
    );
    assert.equal(match.staticNodeId, 'node-a');
    assert.equal(match.method, 'symbol-id');
    assert.equal(match.confidence, 'exact');
  });

  it('matches file + line + name with strong / file-line-name', () => {
    const match = correlateSpanToStaticNode(
      span('s1', {
        startedAt: 0,
        filePath: '/proj/b.ts',
        line: 20,
        functionName: 'funcB',
      }),
      index,
    );
    assert.equal(match.staticNodeId, 'node-b');
    assert.equal(match.method, 'file-line-name');
    assert.equal(match.confidence, 'strong');
  });

  it('matches unique file + name with heuristic / unique-file-name', () => {
    const match = correlateSpanToStaticNode(
      span('s1', {
        startedAt: 0,
        filePath: '/proj/c.ts',
        functionName: 'funcC',
      }),
      index,
    );
    assert.equal(match.staticNodeId, 'node-c');
    assert.equal(match.method, 'unique-file-name');
    assert.equal(match.confidence, 'heuristic');
  });

  it('remains unmatched when file + name is ambiguous', () => {
    const ambiguous = minimalStaticTrace(
      [
        node('n1', 'dup', '/proj/x.ts', 1, 0),
        node('n2', 'dup', '/proj/x.ts', 2, 1),
      ],
      [],
    );
    const ambIndex = buildStaticTraceNodeIndex(ambiguous);
    const match = correlateSpanToStaticNode(
      span('s1', {
        startedAt: 0,
        filePath: '/proj/x.ts',
        functionName: 'dup',
      }),
      ambIndex,
    );
    assert.equal(match.staticNodeId, undefined);
    assert.equal(match.method, 'none');
    assert.equal(match.confidence, 'none');
  });
});

describe('createTraceOverlay semantic comparison', () => {
  it('marks observed/unobserved nodes and edges for A→B→C static vs A→B runtime', () => {
    const nodeA = node('node-a', 'A', '/proj/a.ts', 1, 0, 'sym-a');
    const nodeB = node('node-b', 'B', '/proj/b.ts', 2, 1, 'sym-b');
    const nodeC = node('node-c', 'C', '/proj/c.ts', 3, 2, 'sym-c');

    const staticTrace = minimalStaticTrace(
      [nodeA, nodeB, nodeC],
      [
        { from: 'node-a', to: 'node-b', kind: 'calls', resolved: true },
        { from: 'node-b', to: 'node-c', kind: 'calls', resolved: true },
      ],
      nodeA,
    );

    const runtimeTrace = minimalRuntimeTrace([
      span('span-a', { startedAt: 0, symbolId: 'sym-a', durationMs: 10 }),
      span('span-b', {
        startedAt: 5,
        parentSpanId: 'span-a',
        symbolId: 'sym-b',
        durationMs: 5,
      }),
    ]);

    const overlay = createTraceOverlay(staticTrace, runtimeTrace);

    const obs = (id: string) =>
      overlay.nodes.find((n) => n.staticNodeId === id)?.observation;

    assert.equal(obs('node-a'), 'observed');
    assert.equal(obs('node-b'), 'observed');
    assert.equal(obs('node-c'), 'unobserved');

    const edgeObs = (from: string, to: string) =>
      overlay.edges.find((e) => e.staticEdgeId === `${from}->${to}`)
        ?.observation;

    assert.equal(edgeObs('node-a', 'node-b'), 'observed');
    assert.equal(edgeObs('node-b', 'node-c'), 'unobserved');

    assert.deepEqual(overlay.unobservedStaticNodes, ['node-c']);
    assert.deepEqual(overlay.unobservedStaticEdges, ['node-b->node-c']);
    assert.equal(overlay.staticTrace, staticTrace);
    assert.equal(overlay.runtimeTrace, runtimeTrace);
  });
});

describe('createTraceOverlay observations', () => {
  it('marks static node observed when runtime span maps to it', () => {
    const n = node('n1', 'fn', '/p/f.ts', 1, 0, 'sym-1');
    const overlay = createTraceOverlay(
      minimalStaticTrace([n], [], n),
      minimalRuntimeTrace([
        span('s1', { startedAt: 0, symbolId: 'sym-1' }),
      ]),
    );
    assert.equal(overlay.nodes[0]!.observation, 'observed');
  });

  it('marks static node unobserved when no runtime span maps', () => {
    const n = node('n1', 'fn', '/p/f.ts', 1, 0, 'sym-1');
    const overlay = createTraceOverlay(
      minimalStaticTrace([n], [], n),
      minimalRuntimeTrace([]),
    );
    assert.equal(overlay.nodes[0]!.observation, 'unobserved');
  });

  it('preserves runtime-only span without static counterpart', () => {
    const overlay = createTraceOverlay(
      minimalStaticTrace([], []),
      minimalRuntimeTrace([
        span('s1', {
          startedAt: 0,
          functionName: 'dynamicHandler',
        }),
      ]),
    );
    assert.equal(overlay.nodes[0]!.observation, 'runtime-only');
    assert.equal(overlay.unmatchedRuntimeSpans.length, 1);
  });

  it('creatates runtime-only edge when runtime parent-child has no static edge', () => {
    const a = node('na', 'A', '/p/a.ts', 1, 0, 'sa');
    const b = node('nb', 'B', '/p/b.ts', 2, 1, 'sb');
    const overlay = createTraceOverlay(
      minimalStaticTrace([a, b], [], a),
      minimalRuntimeTrace([
        span('s1', { startedAt: 0, symbolId: 'sa' }),
        span('s2', {
          startedAt: 1,
          parentSpanId: 's1',
          symbolId: 'sb',
        }),
      ]),
    );
    const runtimeOnlyEdge = overlay.edges.find(
      (e) => e.observation === 'runtime-only' && e.runtimeSpanRelation,
    );
    assert.ok(runtimeOnlyEdge);
  });
});

describe('createTraceOverlay multi-invocation metrics', () => {
  it('preserves all span IDs and aggregate metrics for one static node', () => {
    const n = node('n1', 'findUser', '/p/repo.ts', 10, 0, 'sym-find');
    const overlay = createTraceOverlay(
      minimalStaticTrace([n], [], n),
      minimalRuntimeTrace([
        span('s10', { startedAt: 0, symbolId: 'sym-find', durationMs: 5 }),
        span('s17', { startedAt: 1, symbolId: 'sym-find', durationMs: 12 }),
        span('s29', { startedAt: 2, symbolId: 'sym-find', durationMs: 8 }),
      ]),
    );

    const on = overlay.nodes.find((n) => n.staticNodeId === 'n1')!;
    assert.deepEqual(on.runtimeSpanIds, ['s10', 's17', 's29']);
    assert.equal(on.metrics?.invocationCount, 3);
    assert.equal(on.metrics?.totalDurationMs, 25);
    assert.equal(on.metrics?.maxDurationMs, 12);
  });
});

describe('createTraceOverlay errors', () => {
  it('preserves runtime error metadata on matched overlay node', () => {
    const n = node('n1', 'fn', '/p/f.ts', 1, 0, 'sym-1');
    const overlay = createTraceOverlay(
      minimalStaticTrace([n], [], n),
      minimalRuntimeTrace([
        span('s1', {
          startedAt: 0,
          symbolId: 'sym-1',
          status: 'error',
          error: { name: 'TypeError', message: 'boom' },
        }),
      ]),
    );
    const on = overlay.nodes.find((n) => n.staticNodeId === 'n1')!;
    assert.equal(on.error?.message, 'boom');
    assert.equal(on.errorSpanId, 's1');
  });

  it('marks trace overlay with error span while static structure unchanged', () => {
    const n = node('n1', 'fn', '/p/f.ts', 1, 0, 'sym-1');
    const staticTrace = minimalStaticTrace([n], [], n);
    const overlay = createTraceOverlay(
      staticTrace,
      minimalRuntimeTrace([
        span('s1', {
          startedAt: 0,
          symbolId: 'sym-1',
          status: 'error',
          error: { message: 'fail' },
        }),
      ]),
    );
    assert.equal(staticTrace.nodes[0]!.resolution, 'resolved');
    assert.equal(overlay.nodes[0]!.error?.message, 'fail');
  });
});

describe('createTraceOverlay edge cases', () => {
  it('marks all static nodes and edges unobserved for empty runtime trace', () => {
    const a = node('na', 'A', '/p/a.ts', 1, 0, 'sa');
    const b = node('nb', 'B', '/p/b.ts', 2, 1, 'sb');
    const overlay = createTraceOverlay(
      minimalStaticTrace(
        [a, b],
        [{ from: 'na', to: 'nb', kind: 'calls', resolved: true }],
        a,
      ),
      minimalRuntimeTrace([]),
    );
    assert.deepEqual(overlay.unobservedStaticNodes.sort(), ['na', 'nb']);
    assert.deepEqual(overlay.unobservedStaticEdges, ['na->nb']);
  });

  it('marks all runtime spans runtime-only for empty static trace', () => {
    const overlay = createTraceOverlay(
      minimalStaticTrace([], []),
      minimalRuntimeTrace([
        span('s1', { startedAt: 0, functionName: 'onlyRuntime' }),
      ]),
    );
    assert.equal(overlay.nodes[0]!.observation, 'runtime-only');
    assert.equal(overlay.unobservedStaticNodes.length, 0);
  });

  it('warns on route ID mismatch without guessing', () => {
    const overlay = createTraceOverlay(
      minimalStaticTrace([], []),
      {
        ...minimalRuntimeTrace([]),
        routeId: 'other-route',
      },
    );
    assert.ok(overlay.warnings.some((w) => w.includes('Route ID mismatch')));
  });

  it('produces deterministic serialized output', () => {
    const a = node('na', 'A', '/p/a.ts', 1, 0, 'sa');
    const b = node('nb', 'B', '/p/b.ts', 2, 1, 'sb');
    const staticTrace = minimalStaticTrace(
      [a, b],
      [{ from: 'na', to: 'nb', kind: 'calls', resolved: true }],
      a,
    );
    const runtimeTrace = minimalRuntimeTrace([
      span('s1', { startedAt: 0, symbolId: 'sa' }),
      span('s2', { startedAt: 1, symbolId: 'sb', parentSpanId: 's1' }),
    ]);

    const o1 = serializeTraceOverlay(createTraceOverlay(staticTrace, runtimeTrace));
    const o2 = serializeTraceOverlay(createTraceOverlay(staticTrace, runtimeTrace));
    assert.equal(JSON.stringify(o1), JSON.stringify(o2));
  });

  it('respects includeRuntimeOnly=false', () => {
    const overlay = createTraceOverlay(
      minimalStaticTrace([], []),
      minimalRuntimeTrace([
        span('s1', { startedAt: 0, functionName: 'x' }),
      ]),
      { includeRuntimeOnly: false },
    );
    assert.equal(overlay.nodes.length, 0);
  });

  it('respects includeUnobserved=false', () => {
    const n = node('n1', 'fn', '/p/f.ts', 1, 0, 'sym');
    const overlay = createTraceOverlay(
      minimalStaticTrace([n], [], n),
      minimalRuntimeTrace([]),
      { includeUnobserved: false },
    );
    assert.equal(overlay.nodes.length, 0);
  });
});

describe('createTraceOverlay mixed trace', () => {
  it('includes observed, unobserved, and runtime-only nodes together', () => {
    const observed = node('no', 'Observed', '/p/o.ts', 1, 0, 'sym-o');
    const unobserved = node('nu', 'Unobserved', '/p/u.ts', 2, 1, 'sym-u');
    const overlay = createTraceOverlay(
      minimalStaticTrace([observed, unobserved], [], observed),
      minimalRuntimeTrace([
        span('s1', { startedAt: 0, symbolId: 'sym-o' }),
        span('s2', { startedAt: 1, functionName: 'runtimeOnlyFn' }),
      ]),
    );

    const observations = overlay.nodes.map((n) => n.observation).sort();
    assert.deepEqual(observations, ['observed', 'runtime-only', 'unobserved']);
  });
});

describe('trace overlay wire format', () => {
  it('validates TraceOverlay schema', () => {
    const a = node('na', 'A', '/p/a.ts', 1, 0, 'sa');
    const overlay = createTraceOverlay(
      minimalStaticTrace([a], [], a),
      minimalRuntimeTrace([span('s1', { startedAt: 0, symbolId: 'sa' })]),
    );
    assert.ok(TraceOverlaySchema.safeParse(overlay).success);
  });

  it('enriches graph snapshot with overlay metadata', () => {
    const a = node('na', 'A', '/p/a.ts', 1, 0, 'sa');
    const b = node('nb', 'B', '/p/b.ts', 2, 1, 'sb');
    const staticTrace = minimalStaticTrace(
      [a, b],
      [{ from: 'na', to: 'nb', kind: 'calls', resolved: true }],
      a,
    );
    const overlay = createTraceOverlay(
      staticTrace,
      minimalRuntimeTrace([
        span('s1', { startedAt: 0, symbolId: 'sa' }),
      ]),
    );
    const snapshot = projectTraceToSnapshot(staticTrace);
    const enriched = enrichSnapshotWithOverlay(snapshot, overlay);
    const nodeA = enriched.nodes.find((n) => n.id === 'na');
    assert.equal(nodeA?.metadata?.overlayObservation, 'observed');
    const nodeB = enriched.nodes.find((n) => n.id === 'nb');
    assert.equal(nodeB?.metadata?.overlayObservation, 'unobserved');
  });
});

describe('trace overlay semantics documentation', () => {
  it('documents static vs runtime vs overlay roles', () => {
    assert.ok(
      TRACE_OVERLAY_LIMITATIONS.some((l) =>
        l.includes('without modifying either source'),
      ),
    );
  });
});
