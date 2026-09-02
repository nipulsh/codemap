import { z } from 'zod';
import type { GraphEdge, GraphNode, GraphSnapshot } from './graph';
import { StaticRouteTraceSchema } from './routeTrace';

const RuntimeErrorSchema = z.object({
  name: z.string().optional(),
  message: z.string(),
});

const RuntimeSpanSchema = z.object({
  spanId: z.string(),
  traceId: z.string(),
  parentSpanId: z.string().optional(),
  symbolId: z.string().optional(),
  functionName: z.string().optional(),
  filePath: z.string().optional(),
  line: z.number().optional(),
  startedAt: z.number(),
  completedAt: z.number().optional(),
  durationMs: z.number().optional(),
  status: z.enum(['active', 'completed', 'error']),
  resolution: z.enum(['resolved', 'unresolved']),
  error: RuntimeErrorSchema.optional(),
});

const RuntimeTraceSchema = z.object({
  traceId: z.string(),
  routeId: z.string().optional(),
  startedAt: z.number(),
  completedAt: z.number().optional(),
  durationMs: z.number().optional(),
  status: z.enum(['active', 'completed', 'error']),
  spans: z.array(RuntimeSpanSchema),
  attributes: z
    .object({
      httpMethod: z.string().optional(),
      routePattern: z.string().optional(),
      statusCode: z.number().optional(),
    })
    .optional(),
});

export const OverlayObservationSchema = z.enum([
  'observed',
  'unobserved',
  'runtime-only',
  'unresolved',
]);

export type OverlayObservationWire = z.infer<typeof OverlayObservationSchema>;

export const MatchMethodSchema = z.enum([
  'symbol-id',
  'file-line-name',
  'unique-file-name',
  'none',
]);

export const MatchConfidenceSchema = z.enum([
  'exact',
  'strong',
  'heuristic',
  'none',
]);

export const RuntimeNodeMetricsSchema = z.object({
  invocationCount: z.number(),
  totalDurationMs: z.number().optional(),
  maxDurationMs: z.number().optional(),
});

export const OverlayNodeSchema = z.object({
  id: z.string(),
  staticNodeId: z.string().optional(),
  runtimeSpanIds: z.array(z.string()),
  observation: OverlayObservationSchema,
  matchMethod: MatchMethodSchema.optional(),
  matchConfidence: MatchConfidenceSchema.optional(),
  metrics: RuntimeNodeMetricsSchema.optional(),
  error: RuntimeErrorSchema.optional(),
  errorSpanId: z.string().optional(),
});

export const OverlayEdgeSchema = z.object({
  id: z.string(),
  staticEdgeId: z.string().optional(),
  runtimeSpanRelation: z
    .object({
      parentSpanId: z.string(),
      childSpanId: z.string(),
    })
    .optional(),
  observation: OverlayObservationSchema,
});

export const TraceOverlaySchema = z.object({
  routeId: z.string().optional(),
  staticTrace: StaticRouteTraceSchema,
  runtimeTrace: RuntimeTraceSchema,
  nodes: z.array(OverlayNodeSchema),
  edges: z.array(OverlayEdgeSchema),
  unmatchedRuntimeSpans: z.array(RuntimeSpanSchema),
  unobservedStaticNodes: z.array(z.string()),
  unobservedStaticEdges: z.array(z.string()),
  warnings: z.array(z.string()),
});

export type TraceOverlayWire = z.infer<typeof TraceOverlaySchema>;
export type OverlayNodeWire = z.infer<typeof OverlayNodeSchema>;
export type OverlayEdgeWire = z.infer<typeof OverlayEdgeSchema>;
export type RuntimeNodeMetricsWire = z.infer<typeof RuntimeNodeMetricsSchema>;

export const OVERLAY_OBSERVATION_LABELS: Record<OverlayObservationWire, string> = {
  observed: '✓ observed',
  unobserved: '○ not observed',
  'runtime-only': '⚡ runtime-only',
  unresolved: '⚠ unresolved',
};

export function formatOverlayMetrics(
  metrics?: RuntimeNodeMetricsWire,
): string | undefined {
  if (!metrics) {
    return undefined;
  }
  if (metrics.invocationCount <= 1) {
    if (metrics.totalDurationMs !== undefined) {
      return `${metrics.totalDurationMs} ms`;
    }
    return undefined;
  }
  const parts = [`${metrics.invocationCount} calls`];
  if (metrics.totalDurationMs !== undefined) {
    parts.push(`${metrics.totalDurationMs} ms total`);
  }
  if (metrics.maxDurationMs !== undefined) {
    parts.push(`${metrics.maxDurationMs} ms max`);
  }
  return parts.join(' · ');
}

function graphNodeIdForOverlayNode(node: OverlayNodeWire): string {
  return node.staticNodeId ?? node.id;
}

type RuntimeSpanWire = TraceOverlayWire['runtimeTrace']['spans'][number];

/**
 * Lookup maps built once per projection. The previous `.find()` scans made the
 * runtime-only section O(runtimeSpans × overlayNodes), which is quadratic when
 * most spans are unmatched (e.g. an uninstrumented static trace against a
 * large runtime trace).
 */
function buildOverlayLookups(overlay: TraceOverlayWire): {
  spanById: Map<string, RuntimeSpanWire>;
  overlayNodeBySpanId: Map<string, OverlayNodeWire>;
} {
  const spanById = new Map<string, RuntimeSpanWire>();
  for (const span of overlay.runtimeTrace.spans) {
    spanById.set(span.spanId, span);
  }
  const overlayNodeBySpanId = new Map<string, OverlayNodeWire>();
  for (const node of overlay.nodes) {
    for (const spanId of node.runtimeSpanIds) {
      // First node wins, matching the previous `.find()` semantics.
      if (!overlayNodeBySpanId.has(spanId)) {
        overlayNodeBySpanId.set(spanId, node);
      }
    }
  }
  return { spanById, overlayNodeBySpanId };
}

function relativePath(filePath: string, workspaceRoot?: string): string {
  if (!workspaceRoot) {
    return filePath.split(/[/\\]/).pop() ?? filePath;
  }
  const norm = filePath.replace(/\\/g, '/');
  const root = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  if (norm.startsWith(root + '/')) {
    return norm.slice(root.length + 1);
  }
  return norm.split('/').pop() ?? norm;
}

/** Attach overlay observation metadata to an existing trace graph snapshot. */
export function enrichSnapshotWithOverlay(
  snapshot: GraphSnapshot,
  overlay: TraceOverlayWire,
  workspaceRoot?: string,
): GraphSnapshot {
  const nodeByStaticId = new Map<string, OverlayNodeWire>();
  for (const node of overlay.nodes) {
    if (node.staticNodeId) {
      nodeByStaticId.set(node.staticNodeId, node);
    }
  }

  const edgeByStaticKey = new Map<string, OverlayEdgeWire>();
  for (const edge of overlay.edges) {
    if (edge.staticEdgeId) {
      edgeByStaticKey.set(edge.staticEdgeId, edge);
    }
  }

  const nodes: GraphNode[] = snapshot.nodes.map((node) => {
    const overlayNode = nodeByStaticId.get(node.id);
    if (!overlayNode) {
      return {
        ...node,
        metadata: {
          ...node.metadata,
          overlayMode: true,
        },
      };
    }
    return {
      ...node,
      metadata: {
        ...node.metadata,
        overlayMode: true,
        overlayObservation: overlayNode.observation,
        overlayMetrics: overlayNode.metrics,
        overlayMetricsLabel: formatOverlayMetrics(overlayNode.metrics),
        runtimeSpanIds: overlayNode.runtimeSpanIds,
        overlayError: overlayNode.error,
        overlayErrorSpanId: overlayNode.errorSpanId,
        overlayMatchMethod: overlayNode.matchMethod,
        overlayMatchConfidence: overlayNode.matchConfidence,
      },
    };
  });

  const edges: GraphEdge[] = snapshot.edges.map((edge) => {
    if (edge.kind !== 'calls' && edge.kind !== 'handles') {
      return edge;
    }
    const key =
      edge.kind === 'calls' ? `${edge.source}->${edge.target}` : undefined;
    const overlayEdge = key ? edgeByStaticKey.get(key) : undefined;
    return {
      ...edge,
      metadata: {
        ...edge.metadata,
        overlayMode: true,
        overlayObservation: overlayEdge?.observation,
      },
    };
  });

  const { spanById, overlayNodeBySpanId } = buildOverlayLookups(overlay);

  for (const overlayNode of overlay.nodes) {
    if (overlayNode.staticNodeId) {
      continue;
    }
    const primarySpanId = overlayNode.runtimeSpanIds[0];
    const span = primarySpanId ? spanById.get(primarySpanId) : undefined;
    const label = span?.functionName ?? 'runtime span';
    const filePath = span?.filePath;
    nodes.push({
      id: overlayNode.id,
      kind: 'Function',
      label,
      filePath,
      line: span?.line,
      metadata: {
        staticTrace: true,
        runtimeOnly: true,
        overlayMode: true,
        overlayObservation: overlayNode.observation,
        overlayMetrics: overlayNode.metrics,
        overlayMetricsLabel: formatOverlayMetrics(overlayNode.metrics),
        runtimeSpanIds: overlayNode.runtimeSpanIds,
        overlayError: overlayNode.error,
        overlayErrorSpanId: overlayNode.errorSpanId,
        relativePath: filePath ? relativePath(filePath, workspaceRoot) : undefined,
        traceDepth: 99,
      },
    });
  }

  for (const overlayEdge of overlay.edges) {
    if (overlayEdge.staticEdgeId) {
      continue;
    }
    const rel = overlayEdge.runtimeSpanRelation;
    if (!rel) {
      continue;
    }
    const parentNode = overlayNodeBySpanId.get(rel.parentSpanId);
    const childNode = overlayNodeBySpanId.get(rel.childSpanId);
    if (!parentNode || !childNode) {
      continue;
    }
    const source = graphNodeIdForOverlayNode(parentNode);
    const target = graphNodeIdForOverlayNode(childNode);
    edges.push({
      id: `overlay-runtime:${rel.parentSpanId}->${rel.childSpanId}`,
      kind: 'calls',
      source,
      target,
      metadata: {
        staticTrace: true,
        overlayMode: true,
        overlayObservation: overlayEdge.observation,
        runtimeOnly: true,
      },
    });
  }

  nodes.sort((a, b) => a.id.localeCompare(b.id));
  edges.sort((a, b) => a.id.localeCompare(b.id));

  return {
    ...snapshot,
    nodes,
    edges,
  };
}

/** Project static snapshot + overlay without mutating source traces. */
export function projectOverlaySnapshot(
  snapshot: GraphSnapshot,
  overlay: TraceOverlayWire,
  workspaceRoot?: string,
): GraphSnapshot {
  return enrichSnapshotWithOverlay(snapshot, overlay, workspaceRoot);
}

export function findOverlayNodeForGraphId(
  overlay: TraceOverlayWire,
  graphNodeId: string,
): OverlayNodeWire | undefined {
  return overlay.nodes.find(
    (n) => n.staticNodeId === graphNodeId || n.id === graphNodeId,
  );
}
