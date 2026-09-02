import type { GraphEdge, GraphNode, GraphPatch } from '../../shared/graph';
import {
  fileNodeId,
  makeEdge,
  makeNode,
  symbolNodeId,
} from '../graph/incremental';
import { normalizePath } from '../utils/path';
import type { RouteDefinition } from './types';
import type { SourceFileInfo } from '../analysis/types';

export function routeNodeId(route: RouteDefinition): string {
  return route.id;
}

/**
 * Convert RouteDefinition[] into graph nodes and handles edges.
 * Does not mutate React Flow state — returns a GraphPatch for merging.
 */
export class RouteGraphBuilder {
  build(
    routes: RouteDefinition[],
    files: SourceFileInfo[],
  ): GraphPatch {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const fileByAbs = new Map(
      files.map((f) => [normalizePath(f.absolutePath), f]),
    );

    for (const route of routes) {
      const label = `${route.method} ${route.path}`;
      const rid = routeNodeId(route);

      nodes.push(
        makeNode(rid, 'Route', label, {
          filePath: route.sourceFile,
          line: route.line,
          metadata: {
            method: route.method,
            path: route.path,
            framework: route.framework,
            confidence: route.confidence,
            handlerSymbol: route.handlerSymbol,
            handlerResolved: route.handlerResolved,
            routerVariable: route.routerVariable,
            mountPrefix: route.mountPrefix,
            unresolvedMount: route.unresolvedMount,
          },
        }),
      );

      const fileInfo = fileByAbs.get(normalizePath(route.sourceFile));
      if (!fileInfo) {
        continue;
      }

      const fid = fileNodeId(route.sourceFile);
      edges.push(makeEdge('servedBy', rid, fid, { framework: route.framework }));

      if (route.handlerSymbol && route.handlerResolved) {
        const handlerName = route.handlerSymbol.includes('.')
          ? route.handlerSymbol.split('.').pop()!
          : route.handlerSymbol;

        if (!route.handlerSymbol.includes(':inline-handler')) {
          const sym = fileInfo.symbols.find((s) => s.name === handlerName);
          if (sym) {
            const sid = symbolNodeId(route.sourceFile, sym.name, sym.kind);
            edges.push(
              makeEdge('handles', rid, sid, {
                handlerSymbol: route.handlerSymbol,
              }),
            );
          }
        }
      }
    }

    const edgeMap = new Map<string, GraphEdge>();
    for (const e of edges) {
      edgeMap.set(e.id, e);
    }

    return {
      upsertNodes: nodes,
      removeNodeIds: [],
      upsertEdges: [...edgeMap.values()],
      removeEdgeIds: [],
    };
  }
}

export function mergeRouteGraphIntoSnapshot(
  snapshot: { nodes: GraphNode[]; edges: GraphEdge[] },
  patch: GraphPatch,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodeMap = new Map(snapshot.nodes.map((n) => [n.id, n]));
  const edgeMap = new Map(snapshot.edges.map((e) => [e.id, e]));

  for (const n of patch.upsertNodes ?? []) {
    nodeMap.set(n.id, n);
  }
  for (const e of patch.upsertEdges ?? []) {
    edgeMap.set(e.id, e);
  }

  return {
    nodes: [...nodeMap.values()],
    edges: [...edgeMap.values()],
  };
}
