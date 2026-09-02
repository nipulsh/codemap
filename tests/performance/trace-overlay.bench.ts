/**
 * Benchmark: createTraceOverlay() + projectOverlaySnapshot() + JSON serialization
 * for runtime traces of 100 → 50,000 spans against static traces of varying size.
 *
 * Two shapes per size:
 *  - matched: most spans correlate to static nodes by symbolId (typical instrumented app)
 *  - unmatched: spans carry no static identity (worst case for runtime-only handling)
 *
 * Run: npx tsx --expose-gc tests/performance/trace-overlay.bench.ts
 */
import { createTraceOverlay } from '../../src/runtime/TraceOverlay.ts';
import type { RuntimeSpan, RuntimeTrace } from '../../src/runtime/types.ts';
import type {
  RouteDefinition,
  StaticRouteTrace,
  TraceCallEdge,
  TraceCallNode,
} from '../../src/routes/types.ts';
import { projectTraceToSnapshot } from '../../shared/routeTrace.ts';
import {
  projectOverlaySnapshot,
  type TraceOverlayWire,
} from '../../shared/traceOverlay.ts';
import {
  createSuite,
  isDirectRun,
  measureSync,
  round,
  runSuiteMain,
  toMb,
  type BenchmarkSuiteResult,
} from './benchmark-utils.ts';
import { createRng } from './synthetic-workspace.ts';

export const SPAN_COUNTS = [100, 1_000, 10_000, 50_000];

const ROUTE: RouteDefinition = {
  id: 'route:express:GET:/api/items/:id:/ws/src/routes.ts:10',
  method: 'GET',
  path: '/api/items/:id',
  framework: 'express',
  sourceFile: '/ws/src/routes.ts',
  line: 10,
  handlerSymbol: 'entry',
  handlerResolved: true,
  confidence: 'high',
};

/** Static trace with `staticNodeCount` functions in a tree of fan-out 3. */
export function buildStaticTrace(staticNodeCount: number): StaticRouteTrace {
  const nodes: TraceCallNode[] = [];
  const edges: TraceCallEdge[] = [];
  const entry: TraceCallNode = {
    id: 'symbol:/ws/src/handler.ts:entry:Function',
    symbolId: 'symbol:/ws/src/handler.ts:entry:Function',
    functionName: 'entry',
    filePath: '/ws/src/handler.ts',
    line: 5,
    depth: 0,
    resolution: 'resolved',
  };
  for (let i = 0; i < staticNodeCount; i++) {
    const file = `/ws/src/svc/svc${Math.floor(i / 20)}.ts`;
    const node: TraceCallNode = {
      id: `symbol:${file}:fn${i}:Function`,
      symbolId: `symbol:${file}:fn${i}:Function`,
      functionName: `fn${i}`,
      filePath: file,
      line: (i % 20) * 8 + 1,
      depth: 1 + Math.floor(Math.log(i + 1) / Math.log(3)),
      resolution: 'resolved',
    };
    nodes.push(node);
    const parent = i < 3 ? entry : nodes[Math.floor((i - 3) / 3)]!;
    edges.push({ from: parent.id, to: node.id, kind: 'calls', resolved: true });
  }
  return {
    routeId: ROUTE.id,
    route: ROUTE,
    entryHandler: entry,
    nodes,
    edges,
    maxDepth: 8,
    truncated: false,
    unresolved: [],
    limitations: [],
  };
}

/** Runtime trace with `spanCount` spans; matched spans reuse static symbolIds. */
export function buildRuntimeTrace(
  staticTrace: StaticRouteTrace,
  spanCount: number,
  matched: boolean,
  seed = 1,
): RuntimeTrace {
  const rng = createRng(seed);
  const spans: RuntimeSpan[] = [];
  const staticNodes = [staticTrace.entryHandler!, ...staticTrace.nodes];
  const base = 1_700_000_000_000;
  const root: RuntimeSpan = {
    spanId: 'span:000000',
    traceId: 'trace:bench',
    symbolId: matched ? staticTrace.entryHandler!.symbolId : undefined,
    functionName: 'entry',
    filePath: matched ? '/ws/src/handler.ts' : undefined,
    startedAt: base,
    completedAt: base + 50,
    durationMs: 50,
    status: 'completed',
    resolution: matched ? 'resolved' : 'unresolved',
  };
  spans.push(root);
  for (let i = 1; i < spanCount; i++) {
    const parent = spans[Math.floor(rng() * i)]!;
    const staticNode = staticNodes[1 + ((i - 1) % (staticNodes.length - 1))]!;
    const startedAt = parent.startedAt + Math.floor(rng() * 20);
    const duration = Math.floor(rng() * 10);
    const isError = i % 997 === 0;
    spans.push({
      spanId: `span:${String(i).padStart(6, '0')}`,
      traceId: 'trace:bench',
      parentSpanId: parent.spanId,
      symbolId: matched ? staticNode.symbolId : undefined,
      functionName: matched ? staticNode.functionName : `dyn${i}`,
      filePath: matched ? staticNode.filePath : undefined,
      line: matched ? staticNode.line : undefined,
      startedAt,
      completedAt: startedAt + duration,
      durationMs: duration,
      status: isError ? 'error' : 'completed',
      resolution: matched ? 'resolved' : 'unresolved',
      error: isError ? { name: 'Error', message: `failure ${i}` } : undefined,
    });
  }
  return {
    traceId: 'trace:bench',
    routeId: ROUTE.id,
    startedAt: base,
    completedAt: base + 60,
    durationMs: 60,
    status: 'error',
    spans,
  };
}

export async function runTraceOverlayBenchmark(): Promise<BenchmarkSuiteResult> {
  const suite = createSuite(
    'trace-overlay',
    'createTraceOverlay / projectOverlaySnapshot / JSON serialization by span count',
  );

  for (const spanCount of SPAN_COUNTS) {
    const staticNodeCount = Math.min(2000, Math.max(30, Math.floor(spanCount / 5)));
    const staticTrace = buildStaticTrace(staticNodeCount);
    const staticSnapshot = projectTraceToSnapshot(staticTrace, '/ws');

    for (const matched of [true, false]) {
      const label = matched ? 'matched' : 'unmatched';
      const runtimeTrace = buildRuntimeTrace(staticTrace, spanCount, matched);

      const overlayRun = measureSync(
        `${spanCount} spans / ${label} / createTraceOverlay`,
        () => createTraceOverlay(staticTrace, runtimeTrace),
        (overlay, ms) => ({
          spans: spanCount,
          staticNodes: staticNodeCount + 1,
          overlayNodes: overlay.nodes.length,
          overlayEdges: overlay.edges.length,
          unmatched: overlay.unmatchedRuntimeSpans.length,
          usPerSpan: round((ms * 1000) / spanCount, 1),
        }),
      );
      suite.measurements.push(overlayRun.measurement);
      const overlay = overlayRun.result as unknown as TraceOverlayWire;

      const projectRun = measureSync(
        `${spanCount} spans / ${label} / projectOverlaySnapshot`,
        () => projectOverlaySnapshot(staticSnapshot, overlay, '/ws'),
        (snapshot, ms) => ({
          spans: spanCount,
          graphNodes: snapshot.nodes.length,
          graphEdges: snapshot.edges.length,
          usPerSpan: round((ms * 1000) / spanCount, 1),
        }),
      );
      suite.measurements.push(projectRun.measurement);

      const serializeRun = measureSync(
        `${spanCount} spans / ${label} / JSON.stringify(overlay)`,
        () => JSON.stringify(overlay),
        (json) => ({
          spans: spanCount,
          jsonMb: toMb(Buffer.byteLength(json, 'utf8')),
        }),
      );
      suite.measurements.push(serializeRun.measurement);
    }
  }

  suite.notes.push(
    'Overlay construction and projection use Map lookups (no staticNodes × runtimeSpans scans); usPerSpan should stay roughly flat as span count grows.',
    'The overlay embeds both source traces, so its JSON size scales linearly with span count; the webview receives that payload on each overlay switch.',
  );
  return suite;
}

if (isDirectRun(import.meta.url)) {
  void runSuiteMain(runTraceOverlayBenchmark);
}
