import type { StaticRouteTrace } from '../routes/types';
import type { RuntimeError, RuntimeSpan, RuntimeTrace } from './types';
import {
  buildStaticTraceNodeIndex,
  collectStaticTraceNodes,
  correlateSpanToStaticNode,
  staticEdgeKey,
  type MatchConfidence,
  type MatchMethod,
} from './TraceCorrelation';

export type OverlayObservation =
  | 'observed'
  | 'unobserved'
  | 'runtime-only'
  | 'unresolved';

export interface RuntimeNodeMetrics {
  invocationCount: number;
  totalDurationMs?: number;
  maxDurationMs?: number;
}

export interface OverlayNode {
  id: string;
  staticNodeId?: string;
  runtimeSpanIds: string[];
  observation: OverlayObservation;
  matchMethod?: MatchMethod;
  matchConfidence?: MatchConfidence;
  metrics?: RuntimeNodeMetrics;
  error?: RuntimeError;
  errorSpanId?: string;
}

export interface OverlayEdge {
  id: string;
  staticEdgeId?: string;
  runtimeSpanRelation?: {
    parentSpanId: string;
    childSpanId: string;
  };
  observation: OverlayObservation;
}

/**
 * Derived comparison between static structure and one runtime execution.
 * Does not mutate StaticRouteTrace or RuntimeTrace.
 */
export interface TraceOverlay {
  routeId?: string;
  staticTrace: StaticRouteTrace;
  runtimeTrace: RuntimeTrace;
  nodes: OverlayNode[];
  edges: OverlayEdge[];
  unmatchedRuntimeSpans: RuntimeSpan[];
  unobservedStaticNodes: string[];
  unobservedStaticEdges: string[];
  warnings: string[];
}

export interface TraceOverlayOptions {
  includeRuntimeOnly?: boolean;
  includeUnobserved?: boolean;
}

function computeMetrics(spans: RuntimeSpan[]): RuntimeNodeMetrics {
  const metrics: RuntimeNodeMetrics = {
    invocationCount: spans.length,
  };

  let total = 0;
  let hasTotal = false;
  let max: number | undefined;

  for (const span of spans) {
    if (span.durationMs !== undefined) {
      total += span.durationMs;
      hasTotal = true;
      max =
        max === undefined ? span.durationMs : Math.max(max, span.durationMs);
    }
  }

  if (hasTotal) {
    metrics.totalDurationMs = total;
  }
  if (max !== undefined) {
    metrics.maxDurationMs = max;
  }

  return metrics;
}

function pickError(spans: RuntimeSpan[]): {
  error?: RuntimeError;
  errorSpanId?: string;
} {
  for (const span of spans) {
    if (span.status === 'error' && span.error) {
      return { error: { ...span.error }, errorSpanId: span.spanId };
    }
  }
  return {};
}

function overlayNodeIdForStatic(staticNodeId: string): string {
  return `overlay:static:${staticNodeId}`;
}

function overlayNodeIdForRuntime(spanId: string): string {
  return `overlay:runtime:${spanId}`;
}

function overlayEdgeIdForStatic(from: string, to: string): string {
  return `overlay:edge:static:${from}->${to}`;
}

function overlayEdgeIdForRuntime(parentSpanId: string, childSpanId: string): string {
  return `overlay:edge:runtime:${parentSpanId}->${childSpanId}`;
}

export function createTraceOverlay(
  staticTrace: StaticRouteTrace,
  runtimeTrace: RuntimeTrace,
  options: TraceOverlayOptions = {},
): TraceOverlay {
  const includeRuntimeOnly = options.includeRuntimeOnly ?? true;
  const includeUnobserved = options.includeUnobserved ?? true;

  const index = buildStaticTraceNodeIndex(staticTrace);
  const staticNodes = collectStaticTraceNodes(staticTrace);
  const staticEdgeIds = new Set(
    staticTrace.edges.map((e) => staticEdgeKey(e.from, e.to)),
  );

  const spanMatches = new Map(
    runtimeTrace.spans.map((span) => [
      span.spanId,
      correlateSpanToStaticNode(span, index),
    ]),
  );

  const spansByStaticNode = new Map<string, RuntimeSpan[]>();
  const unmatchedRuntimeSpans: RuntimeSpan[] = [];

  for (const span of [...runtimeTrace.spans].sort((a, b) =>
    a.spanId.localeCompare(b.spanId),
  )) {
    const match = spanMatches.get(span.spanId)!;
    if (match.staticNodeId) {
      const list = spansByStaticNode.get(match.staticNodeId) ?? [];
      list.push(span);
      spansByStaticNode.set(match.staticNodeId, list);
    } else {
      unmatchedRuntimeSpans.push(span);
    }
  }

  const warnings: string[] = [];
  if (
    staticTrace.routeId &&
    runtimeTrace.routeId &&
    staticTrace.routeId !== runtimeTrace.routeId
  ) {
    warnings.push(
      `Route ID mismatch: static=${staticTrace.routeId}, runtime=${runtimeTrace.routeId}`,
    );
  }
  if (unmatchedRuntimeSpans.length > 0) {
    warnings.push(
      `${unmatchedRuntimeSpans.length} runtime span(s) could not be matched to static nodes`,
    );
  }

  const nodes: OverlayNode[] = [];
  const unobservedStaticNodes: string[] = [];

  for (const staticNode of staticNodes) {
    const matchedSpans = spansByStaticNode.get(staticNode.id) ?? [];
    const observation: OverlayObservation =
      matchedSpans.length > 0 ? 'observed' : 'unobserved';

    if (observation === 'unobserved') {
      unobservedStaticNodes.push(staticNode.id);
      if (!includeUnobserved) {
        continue;
      }
    }

    const primaryMatch = matchedSpans[0]
      ? spanMatches.get(matchedSpans[0]!.spanId)
      : undefined;
    const { error, errorSpanId } = pickError(matchedSpans);

    nodes.push({
      id: overlayNodeIdForStatic(staticNode.id),
      staticNodeId: staticNode.id,
      runtimeSpanIds: matchedSpans.map((s) => s.spanId).sort(),
      observation,
      matchMethod: primaryMatch?.method !== 'none' ? primaryMatch?.method : undefined,
      matchConfidence:
        primaryMatch?.confidence !== 'none' ? primaryMatch?.confidence : undefined,
      metrics:
        matchedSpans.length > 0 ? computeMetrics(matchedSpans) : undefined,
      error,
      errorSpanId,
    });
  }

  if (includeRuntimeOnly) {
    for (const span of unmatchedRuntimeSpans) {
      const observation: OverlayObservation =
        span.resolution === 'unresolved' ? 'unresolved' : 'runtime-only';
      nodes.push({
        id: overlayNodeIdForRuntime(span.spanId),
        runtimeSpanIds: [span.spanId],
        observation,
        matchMethod: 'none',
        matchConfidence: 'none',
        metrics: computeMetrics([span]),
        error: span.error ? { ...span.error } : undefined,
        errorSpanId: span.status === 'error' ? span.spanId : undefined,
      });
    }
  }

  const observedStaticEdges = new Set<string>();
  const runtimeOnlyEdges: OverlayEdge[] = [];

  for (const span of runtimeTrace.spans) {
    if (!span.parentSpanId) {
      continue;
    }

    const parentMatch = spanMatches.get(span.parentSpanId);
    const childMatch = spanMatches.get(span.spanId);
    if (!parentMatch?.staticNodeId || !childMatch?.staticNodeId) {
      if (includeRuntimeOnly) {
        runtimeOnlyEdges.push({
          id: overlayEdgeIdForRuntime(span.parentSpanId, span.spanId),
          runtimeSpanRelation: {
            parentSpanId: span.parentSpanId,
            childSpanId: span.spanId,
          },
          observation:
            parentMatch?.staticNodeId || childMatch?.staticNodeId
              ? 'unresolved'
              : 'runtime-only',
        });
      }
      continue;
    }

    const key = staticEdgeKey(parentMatch.staticNodeId, childMatch.staticNodeId);
    if (staticEdgeIds.has(key)) {
      observedStaticEdges.add(key);
    } else if (includeRuntimeOnly) {
      runtimeOnlyEdges.push({
        id: overlayEdgeIdForRuntime(span.parentSpanId, span.spanId),
        runtimeSpanRelation: {
          parentSpanId: span.parentSpanId,
          childSpanId: span.spanId,
        },
        observation: 'runtime-only',
      });
    }
  }

  const edges: OverlayEdge[] = [];
  const unobservedStaticEdges: string[] = [];

  for (const edge of staticTrace.edges) {
    const key = staticEdgeKey(edge.from, edge.to);
    const observation: OverlayObservation = observedStaticEdges.has(key)
      ? 'observed'
      : 'unobserved';

    if (observation === 'unobserved') {
      unobservedStaticEdges.push(key);
      if (!includeUnobserved) {
        continue;
      }
    }

    edges.push({
      id: overlayEdgeIdForStatic(edge.from, edge.to),
      staticEdgeId: key,
      observation,
    });
  }

  edges.push(...runtimeOnlyEdges);

  nodes.sort((a, b) => a.id.localeCompare(b.id));
  edges.sort((a, b) => a.id.localeCompare(b.id));
  unmatchedRuntimeSpans.sort((a, b) => a.spanId.localeCompare(b.spanId));
  unobservedStaticNodes.sort();
  unobservedStaticEdges.sort();
  warnings.sort();

  const routeId =
    staticTrace.routeId === runtimeTrace.routeId
      ? staticTrace.routeId
      : staticTrace.routeId ?? runtimeTrace.routeId;

  return {
    routeId,
    staticTrace,
    runtimeTrace,
    nodes,
    edges,
    unmatchedRuntimeSpans,
    unobservedStaticNodes,
    unobservedStaticEdges,
    warnings,
  };
}

/** Deterministic serialized overlay for tests and wire transport. */
export function serializeTraceOverlay(overlay: TraceOverlay): TraceOverlay {
  return {
    ...overlay,
    nodes: [...overlay.nodes].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...overlay.edges].sort((a, b) => a.id.localeCompare(b.id)),
    unmatchedRuntimeSpans: [...overlay.unmatchedRuntimeSpans].sort((a, b) =>
      a.spanId.localeCompare(b.spanId),
    ),
    unobservedStaticNodes: [...overlay.unobservedStaticNodes].sort(),
    unobservedStaticEdges: [...overlay.unobservedStaticEdges].sort(),
    warnings: [...overlay.warnings].sort(),
  };
}

export const TRACE_OVERLAY_LIMITATIONS = [
  'TraceOverlay compares one StaticRouteTrace with one RuntimeTrace without modifying either source.',
  'Unobserved static nodes and edges remain possible according to source analysis.',
  'Runtime-only observations may indicate dynamic dispatch, instrumentation gaps, or incomplete static analysis.',
] as const;
