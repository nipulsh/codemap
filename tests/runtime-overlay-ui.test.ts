import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { projectTraceToSnapshot } from '../shared/routeTrace.ts';
import type { StaticRouteTraceWire } from '../shared/routeTrace.ts';
import type { RuntimeTraceSummaryWire } from '../shared/runtimeTrace.ts';
import type { TraceOverlayWire } from '../shared/traceOverlay.ts';
import {
  formatOverlayMetrics,
  findOverlayNodeForGraphId,
  OVERLAY_OBSERVATION_LABELS,
  projectOverlaySnapshot,
  TraceOverlaySchema,
} from '../shared/traceOverlay.ts';
import {
  formatRuntimeTraceSummary,
  summariesForRoute,
  sortRuntimeTraceSummaries,
} from '../shared/runtimeTrace.ts';
import { createTraceOverlay } from '../src/runtime/TraceOverlay.ts';
import type { RuntimeTrace } from '../src/runtime/types.ts';
import {
  buildTraceOverlay,
  getRuntimeTraceCollector,
  listRuntimeTraceSummaries,
  resetRuntimeTraceCollector,
} from '../src/runtime/RuntimeTraceRegistry.ts';
import { ExtensionToWebviewSchema, WebviewToExtensionSchema } from '../shared/messages.ts';

function staticTrace(): StaticRouteTraceWire {
  const route = {
    id: 'route:get:/api/users/:id',
    method: 'GET' as const,
    path: '/api/users/:id',
    framework: 'express' as const,
    sourceFile: '/proj/routes.ts',
    line: 1,
    handlerSymbol: 'getUser',
    handlerResolved: true,
    confidence: 'high' as const,
  };
  const handler = {
    id: 'node-handler',
    symbolId: 'sym-handler',
    functionName: 'getUser',
    filePath: '/proj/controller.ts',
    line: 10,
    depth: 0,
    resolution: 'resolved' as const,
  };
  const service = {
    id: 'node-service',
    symbolId: 'sym-service',
    functionName: 'loadUser',
    filePath: '/proj/service.ts',
    line: 20,
    depth: 1,
    resolution: 'resolved' as const,
  };
  const audit = {
    id: 'node-audit',
    symbolId: 'sym-audit',
    functionName: 'audit',
    filePath: '/proj/audit.ts',
    line: 5,
    depth: 1,
    resolution: 'resolved' as const,
  };
  return {
    routeId: route.id,
    route,
    entryHandler: handler,
    nodes: [handler, service, audit],
    edges: [
      { from: 'node-handler', to: 'node-service', kind: 'calls', resolved: true },
      { from: 'node-handler', to: 'node-audit', kind: 'calls', resolved: true },
    ],
    maxDepth: 8,
    truncated: false,
    unresolved: [],
    limitations: [],
  };
}

function runtimeTrace(partial?: Partial<RuntimeTrace>): RuntimeTrace {
  return {
    traceId: 'rt-1',
    routeId: 'route:get:/api/users/:id',
    startedAt: 1000,
    completedAt: 1031,
    durationMs: 31,
    status: 'completed',
    attributes: {
      httpMethod: 'GET',
      routePattern: '/api/users/:id',
      statusCode: 200,
    },
    spans: [
      {
        spanId: 'span-handler',
        traceId: 'rt-1',
        symbolId: 'sym-handler',
        functionName: 'getUser',
        filePath: '/proj/controller.ts',
        line: 10,
        startedAt: 1000,
        completedAt: 1031,
        durationMs: 31,
        status: 'completed',
        resolution: 'resolved',
      },
      {
        spanId: 'span-service-1',
        traceId: 'rt-1',
        parentSpanId: 'span-handler',
        symbolId: 'sym-service',
        functionName: 'loadUser',
        filePath: '/proj/service.ts',
        line: 20,
        startedAt: 1005,
        completedAt: 1013,
        durationMs: 8,
        status: 'completed',
        resolution: 'resolved',
      },
      {
        spanId: 'span-service-2',
        traceId: 'rt-1',
        parentSpanId: 'span-handler',
        symbolId: 'sym-service',
        functionName: 'loadUser',
        filePath: '/proj/service.ts',
        line: 20,
        startedAt: 1015,
        completedAt: 1026,
        durationMs: 11,
        status: 'completed',
        resolution: 'resolved',
      },
      {
        spanId: 'span-runtime-only',
        traceId: 'rt-1',
        parentSpanId: 'span-handler',
        functionName: 'generatedHandler',
        startedAt: 1020,
        completedAt: 1025,
        durationMs: 5,
        status: 'completed',
        resolution: 'unresolved',
      },
    ],
    ...partial,
  };
}

describe('runtime overlay UI projection', () => {
  it('marks observed static nodes with overlay metadata', () => {
    const overlay = createTraceOverlay(staticTrace(), runtimeTrace());
    const snapshot = projectOverlaySnapshot(
      projectTraceToSnapshot(staticTrace()),
      overlay,
    );
    const service = snapshot.nodes.find((n) => n.id === 'node-service');
    assert.equal(service?.metadata?.overlayObservation, 'observed');
    assert.equal(service?.metadata?.overlayMetricsLabel, '2 calls · 19 ms total · 11 ms max');
  });

  it('marks unobserved static nodes distinctly', () => {
    const overlay = createTraceOverlay(staticTrace(), runtimeTrace());
    const snapshot = projectOverlaySnapshot(
      projectTraceToSnapshot(staticTrace()),
      overlay,
    );
    const audit = snapshot.nodes.find((n) => n.id === 'node-audit');
    assert.equal(audit?.metadata?.overlayObservation, 'unobserved');
  });

  it('adds runtime-only nodes without replacing static nodes', () => {
    const overlay = createTraceOverlay(staticTrace(), runtimeTrace());
    const snapshot = projectOverlaySnapshot(
      projectTraceToSnapshot(staticTrace()),
      overlay,
    );
    assert.ok(snapshot.nodes.some((n) => n.metadata?.runtimeOnly === true));
    assert.ok(snapshot.nodes.some((n) => n.id === 'node-service'));
  });

  it('marks observed and unobserved static edges separately from nodes', () => {
    const overlay = createTraceOverlay(staticTrace(), runtimeTrace());
    const snapshot = projectOverlaySnapshot(
      projectTraceToSnapshot(staticTrace()),
      overlay,
    );
    const serviceEdge = snapshot.edges.find(
      (e) => e.source === 'node-handler' && e.target === 'node-service',
    );
    const auditEdge = snapshot.edges.find(
      (e) => e.source === 'node-handler' && e.target === 'node-audit',
    );
    assert.equal(serviceEdge?.metadata?.overlayObservation, 'observed');
    assert.equal(auditEdge?.metadata?.overlayObservation, 'unobserved');
  });

  it('shows runtime-only edges without corrupting static edges', () => {
    const overlay = createTraceOverlay(staticTrace(), runtimeTrace());
    const snapshot = projectOverlaySnapshot(
      projectTraceToSnapshot(staticTrace()),
      overlay,
    );
    assert.ok(
      snapshot.edges.some(
        (e) =>
          e.metadata?.runtimeOnly === true ||
          e.metadata?.overlayObservation === 'runtime-only' ||
          e.metadata?.overlayObservation === 'unresolved',
      ),
    );
    assert.equal(
      snapshot.edges.filter((e) => e.kind === 'calls' && !e.metadata?.runtimeOnly).length >= 2,
      true,
    );
  });

  it('preserves runtime error metadata on overlay nodes', () => {
    const rt = runtimeTrace({
      spans: [
        {
          spanId: 'span-service',
          traceId: 'rt-1',
          parentSpanId: 'span-handler',
          symbolId: 'sym-service',
          functionName: 'loadUser',
          startedAt: 1,
          completedAt: 2,
          status: 'error',
          resolution: 'resolved',
          error: { name: 'DatabaseError', message: 'connection timeout' },
        },
        {
          spanId: 'span-handler',
          traceId: 'rt-1',
          functionName: 'express.handler',
          startedAt: 0,
          completedAt: 3,
          status: 'completed',
          resolution: 'resolved',
        },
      ],
    });
    const overlay = createTraceOverlay(staticTrace(), rt);
    const node = findOverlayNodeForGraphId(overlay, 'node-service');
    assert.equal(node?.error?.name, 'DatabaseError');
    assert.equal(node?.error?.message, 'connection timeout');
  });

  it('keeps static projection working when overlay enrichment is skipped', () => {
    const snapshot = projectTraceToSnapshot(staticTrace());
    assert.ok(snapshot.nodes.length > 0);
    assert.equal(snapshot.nodes[0]?.metadata?.overlayObservation, undefined);
  });

  it('isolates overlay projection failures from static snapshot', () => {
    const snapshot = projectTraceToSnapshot(staticTrace());
    const broken = null as unknown as TraceOverlayWire;
    assert.throws(() => projectOverlaySnapshot(snapshot, broken));
    assert.ok(snapshot.nodes.length > 0);
  });
});

describe('runtime overlay metrics formatting', () => {
  it('formats single invocation duration', () => {
    assert.equal(formatOverlayMetrics({ invocationCount: 1, totalDurationMs: 18 }), '18 ms');
  });

  it('formats aggregate multi-invocation metrics', () => {
    const label = formatOverlayMetrics({
      invocationCount: 3,
      totalDurationMs: 26,
      maxDurationMs: 11,
    });
    assert.match(label!, /3 calls/);
    assert.match(label!, /26 ms total/);
    assert.match(label!, /11 ms max/);
  });
});

describe('runtime trace summaries', () => {
  it('sorts runtime traces deterministically by timestamp', () => {
    const summaries: RuntimeTraceSummaryWire[] = [
      { traceId: 'b', startedAt: 100, status: 'completed' },
      { traceId: 'a', startedAt: 200, status: 'completed' },
    ];
    const sorted = sortRuntimeTraceSummaries(summaries);
    assert.equal(sorted[0]!.traceId, 'a');
  });

  it('filters summaries by routeId', () => {
    const summaries: RuntimeTraceSummaryWire[] = [
      { traceId: 't1', routeId: 'route-a', startedAt: 1, status: 'completed' },
      { traceId: 't2', routeId: 'route-b', startedAt: 2, status: 'completed' },
    ];
    assert.equal(summariesForRoute(summaries, 'route-a').length, 1);
  });

  it('formats runtime trace list labels', () => {
    const label = formatRuntimeTraceSummary({
      traceId: 't1',
      routeId: 'route:get:/users/:id',
      startedAt: Date.parse('2026-01-01T12:44:03Z'),
      durationMs: 31,
      status: 'completed',
      attributes: {
        httpMethod: 'GET',
        routePattern: '/users/:id',
        statusCode: 200,
      },
    });
    assert.match(label, /31ms/);
    assert.match(label, /200/);
    assert.match(label, /GET/);
  });
});

describe('runtime overlay message protocol', () => {
  it('validates runtimeTrace:overlay messages', () => {
    const overlay = createTraceOverlay(staticTrace(), runtimeTrace());
    assert.ok(
      ExtensionToWebviewSchema.safeParse({
        type: 'runtimeTrace:overlay',
        payload: overlay,
      }).success,
    );
  });

  it('validates runtimeTrace:list messages', () => {
    assert.ok(
      ExtensionToWebviewSchema.safeParse({
        type: 'runtimeTrace:list',
        payload: { runtimeTraces: [] },
      }).success,
    );
  });

  it('validates runtimeTrace:select from webview', () => {
    assert.ok(
      WebviewToExtensionSchema.safeParse({
        type: 'runtimeTrace:select',
        payload: { routeId: 'route-1', traceId: 'trace-1' },
      }).success,
    );
  });

  it('validates runtimeTrace:refresh from webview', () => {
    assert.ok(
      WebviewToExtensionSchema.safeParse({
        type: 'runtimeTrace:refresh',
      }).success,
    );
  });
});

describe('RuntimeTraceRegistry integration', () => {
  it('lists completed traces from the shared collector', () => {
    resetRuntimeTraceCollector();
    const collector = getRuntimeTraceCollector();
    collector.ingest({
      type: 'trace-started',
      traceId: 'rt-shared',
      routeId: 'route:get:/api/users/:id',
      startedAt: 1,
    });
    collector.ingest({
      type: 'trace-completed',
      traceId: 'rt-shared',
      completedAt: 2,
    });
    const summaries = listRuntimeTraceSummaries();
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]!.routeId, 'route:get:/api/users/:id');
    resetRuntimeTraceCollector();
  });

  it('builds overlay through registry helper', () => {
    const overlay = buildTraceOverlay(staticTrace(), runtimeTrace());
    assert.ok(TraceOverlaySchema.safeParse(overlay).success);
  });
});

describe('runtime-only trace rendering', () => {
  it('renders overlay when only runtime-only spans exist', () => {
    const rt = runtimeTrace({
      spans: [
        {
          spanId: 'only',
          traceId: 'rt-1',
          functionName: 'generatedHandler',
          startedAt: 1,
          completedAt: 2,
          status: 'completed',
          resolution: 'resolved',
        },
      ],
    });
    const overlay = createTraceOverlay({ ...staticTrace(), nodes: [], edges: [] }, rt);
    const snapshot = projectOverlaySnapshot(
      projectTraceToSnapshot({ ...staticTrace(), nodes: [], edges: [] }),
      overlay,
    );
    assert.ok(
      snapshot.nodes.some((n) => n.metadata?.overlayObservation === 'runtime-only'),
    );
  });
});

describe('overlay observation labels', () => {
  it('provides human-readable observation labels', () => {
    assert.equal(OVERLAY_OBSERVATION_LABELS.observed, '✓ observed');
    assert.equal(OVERLAY_OBSERVATION_LABELS.unobserved, '○ not observed');
    assert.equal(OVERLAY_OBSERVATION_LABELS['runtime-only'], '⚡ runtime-only');
  });
});
