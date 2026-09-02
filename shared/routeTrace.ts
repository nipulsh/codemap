import { z } from 'zod';

export const HttpMethodSchema = z.enum([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
  'HEAD',
]);

export const RouteDefinitionSchema = z.object({
  id: z.string(),
  method: HttpMethodSchema,
  path: z.string(),
  framework: z.literal('express'),
  sourceFile: z.string(),
  line: z.number(),
  handlerSymbol: z.string().optional(),
  handlerLine: z.number().optional(),
  routerVariable: z.string().optional(),
  mountPrefix: z.string().optional(),
  confidence: z.enum(['high', 'medium', 'low']),
  handlerResolved: z.boolean(),
  unresolvedMount: z.boolean().optional(),
});

export const TraceCallNodeSchema = z.object({
  id: z.string(),
  symbolId: z.string().optional(),
  functionName: z.string(),
  filePath: z.string(),
  line: z.number().optional(),
  depth: z.number(),
  resolution: z.enum(['resolved', 'unresolved', 'external']),
  cycleTargetId: z.string().optional(),
});

export const TraceCallEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  kind: z.literal('calls'),
  resolved: z.boolean(),
  isCycle: z.boolean().optional(),
});

export const TraceUnresolvedCallSchema = z.object({
  fromNodeId: z.string(),
  displayName: z.string(),
  reason: z.enum([
    'dynamic-dispatch',
    'external-module',
    'missing-symbol',
    'unsupported-pattern',
    'resolution-failed',
  ]),
  line: z.number().optional(),
});

export const StaticRouteTraceSchema = z.object({
  routeId: z.string(),
  route: RouteDefinitionSchema,
  entryHandler: TraceCallNodeSchema.optional(),
  nodes: z.array(TraceCallNodeSchema),
  edges: z.array(TraceCallEdgeSchema),
  maxDepth: z.number(),
  truncated: z.boolean(),
  unresolved: z.array(TraceUnresolvedCallSchema),
  limitations: z.array(z.string()),
});

export const RouteTraceDataSchema = z.object({
  routes: z.array(RouteDefinitionSchema),
  traces: z.array(StaticRouteTraceSchema),
  runtimeTraces: z
    .array(
      z.object({
        traceId: z.string(),
        routeId: z.string().optional(),
        startedAt: z.number(),
        completedAt: z.number().optional(),
        durationMs: z.number().optional(),
        status: z.enum(['active', 'completed', 'error']),
        attributes: z
          .object({
            httpMethod: z.string().optional(),
            routePattern: z.string().optional(),
            statusCode: z.number().optional(),
          })
          .optional(),
      }),
    )
    .optional(),
});

export type RouteDefinitionWire = z.infer<typeof RouteDefinitionSchema>;
export type StaticRouteTraceWire = z.infer<typeof StaticRouteTraceSchema>;
export type RouteTraceDataWire = z.infer<typeof RouteTraceDataSchema>;

export type ViewMode = 'architecture' | 'route-trace';

export const DEFAULT_CALL_CHAIN_MAX_DEPTH = 8;

/** Filter visible trace nodes/edges without recomputing analysis. */
export function filterTraceByDepth(
  trace: StaticRouteTraceWire,
  maxVisibleDepth: number,
): StaticRouteTraceWire {
  const visibleNodeIds = new Set(
    trace.nodes
      .filter((n) => n.depth <= maxVisibleDepth)
      .map((n) => n.id),
  );
  if (trace.entryHandler && trace.entryHandler.depth <= maxVisibleDepth) {
    visibleNodeIds.add(trace.entryHandler.id);
  }

  return {
    ...trace,
    nodes: trace.nodes.filter((n) => n.depth <= maxVisibleDepth),
    edges: trace.edges.filter(
      (e) => visibleNodeIds.has(e.from) && visibleNodeIds.has(e.to),
    ),
  };
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

/** Project StaticRouteTrace into a GraphSnapshot for React Flow rendering. */
export function projectTraceToSnapshot(
  trace: StaticRouteTraceWire,
  workspaceRoot?: string,
): import('./graph').GraphSnapshot {
  const nodes: import('./graph').GraphNode[] = [];
  const edges: import('./graph').GraphEdge[] = [];

  nodes.push({
    id: trace.route.id,
    kind: 'Route',
    label: `${trace.route.method} ${trace.route.path}`,
    filePath: trace.route.sourceFile,
    line: trace.route.line,
    metadata: {
      framework: trace.route.framework,
      confidence: trace.route.confidence,
      handlerSymbol: trace.route.handlerSymbol,
      handlerResolved: trace.route.handlerResolved,
      traceDepth: -1,
    },
  });

  const allTraceNodes = trace.entryHandler
    ? [
        trace.entryHandler,
        ...trace.nodes.filter((n) => n.id !== trace.entryHandler!.id),
      ]
    : trace.nodes;

  for (const tn of allTraceNodes) {
    const rel = relativePath(tn.filePath, workspaceRoot);
    nodes.push({
      id: tn.id,
      kind: 'Function',
      label: tn.functionName,
      filePath: tn.filePath,
      line: tn.line,
      metadata: {
        traceDepth: tn.depth,
        traceResolution: tn.resolution,
        symbolId: tn.symbolId,
        cycleTargetId: tn.cycleTargetId,
        relativePath: rel,
        staticTrace: true,
      },
    });
  }

  if (trace.entryHandler) {
    edges.push({
      id: `handles:${trace.route.id}->${trace.entryHandler.id}`,
      kind: 'handles',
      source: trace.route.id,
      target: trace.entryHandler.id,
      metadata: { staticTrace: true },
    });
  }

  for (const e of trace.edges) {
    edges.push({
      id: `trace-calls:${e.from}->${e.to}`,
      kind: 'calls',
      source: e.from,
      target: e.to,
      metadata: {
        staticTrace: true,
        isCycle: e.isCycle,
        resolved: e.resolved,
      },
    });
  }

  nodes.sort((a, b) => a.id.localeCompare(b.id));
  edges.sort((a, b) => a.id.localeCompare(b.id));

  return {
    nodes,
    edges,
    generatedAt: Date.now(),
    workspaceRoot,
  };
}

export function sortRoutes(routes: RouteDefinitionWire[]): RouteDefinitionWire[] {
  return [...routes].sort((a, b) => {
    const pathCmp = a.path.localeCompare(b.path);
    if (pathCmp !== 0) {
      return pathCmp;
    }
    const methodCmp = a.method.localeCompare(b.method);
    if (methodCmp !== 0) {
      return methodCmp;
    }
    const fileCmp = a.sourceFile.localeCompare(b.sourceFile);
    return fileCmp !== 0 ? fileCmp : a.line - b.line;
  });
}

export const UNRESOLVED_REASON_LABELS: Record<
  z.infer<typeof TraceUnresolvedCallSchema>['reason'],
  string
> = {
  'dynamic-dispatch': 'Dynamic dispatch',
  'external-module': 'External dependency',
  'missing-symbol': 'Missing symbol',
  'unsupported-pattern': 'Unsupported pattern',
  'resolution-failed': 'Resolution failed',
};
