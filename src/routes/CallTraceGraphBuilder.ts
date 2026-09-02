import type { GraphPatch } from '../../shared/graph';
import { makeEdge } from '../graph/incremental';
import { routeNodeId } from './RouteGraphBuilder';
import type { StaticRouteTrace } from './types';

/**
 * Converts StaticRouteTrace into graph patches reusing existing symbol node IDs.
 */
export class CallTraceGraphBuilder {
  build(traces: StaticRouteTrace[]): GraphPatch {
    const upsertEdges: GraphPatch['upsertEdges'] = [];
    const edgeSeen = new Set<string>();

    for (const trace of traces) {
      if (!trace.entryHandler) {
        continue;
      }

      const rid = routeNodeId(trace.route);
      const entryEdgeId = `handles:${rid}->${trace.entryHandler.id}`;
      if (!edgeSeen.has(entryEdgeId)) {
        edgeSeen.add(entryEdgeId);
        upsertEdges.push(
          makeEdge('handles', rid, trace.entryHandler.id, {
            staticTrace: true,
            handlerSymbol: trace.route.handlerSymbol,
          }),
        );
      }

      for (const edge of trace.edges) {
        if (!edge.resolved) {
          continue;
        }
        const id = `calls:${edge.from}->${edge.to}`;
        if (edgeSeen.has(id)) {
          continue;
        }
        edgeSeen.add(id);
        upsertEdges.push(
          makeEdge('calls', edge.from, edge.to, {
            staticTrace: true,
            isCycle: edge.isCycle,
          }),
        );
      }
    }

    upsertEdges.sort((a, b) => a.id.localeCompare(b.id));

    return {
      upsertNodes: [],
      removeNodeIds: [],
      upsertEdges,
      removeEdgeIds: [],
    };
  }
}
