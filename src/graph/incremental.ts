import type {
  EdgeKind,
  GraphEdge,
  GraphNode,
  GraphPatch,
  NodeKind,
} from '../../shared/graph';
import { basename } from 'node:path';
import { normalizePath } from '../utils/path';

export function workspaceNodeId(workspaceRoot: string): string {
  return `workspace:${normalizePath(workspaceRoot)}`;
}

export function folderNodeId(absolutePath: string): string {
  return `folder:${normalizePath(absolutePath)}`;
}

export function fileNodeId(absolutePath: string): string {
  return `file:${normalizePath(absolutePath)}`;
}

export function symbolNodeId(
  absolutePath: string,
  name: string,
  kind: NodeKind,
): string {
  return `symbol:${normalizePath(absolutePath)}:${kind}:${name}`;
}

export function edgeId(kind: string, source: string, target: string): string {
  return `${kind}:${source}->${target}`;
}

export function makeNode(
  id: string,
  kind: NodeKind,
  label: string,
  extras?: Partial<GraphNode>,
): GraphNode {
  return {
    id,
    kind,
    label,
    filePath: extras?.filePath,
    line: extras?.line,
    metadata: extras?.metadata ?? {},
  };
}

export function makeEdge(
  kind: EdgeKind,
  source: string,
  target: string,
  metadata?: Record<string, unknown>,
): GraphEdge {
  return {
    id: edgeId(kind, source, target),
    kind,
    source,
    target,
    metadata,
  };
}

export function emptyPatch(): GraphPatch {
  return {
    upsertNodes: [],
    removeNodeIds: [],
    upsertEdges: [],
    removeEdgeIds: [],
  };
}

export function mergePatches(...patches: GraphPatch[]): GraphPatch {
  const result = emptyPatch();
  for (const p of patches) {
    result.upsertNodes.push(...(p.upsertNodes ?? []));
    result.removeNodeIds.push(...(p.removeNodeIds ?? []));
    result.upsertEdges.push(...(p.upsertEdges ?? []));
    result.removeEdgeIds.push(...(p.removeEdgeIds ?? []));
  }
  return result;
}

export function applyPatchToMaps(
  nodeMap: Map<string, GraphNode>,
  edgeMap: Map<string, GraphEdge>,
  patch: GraphPatch,
): void {
  for (const id of patch.removeNodeIds ?? []) {
    nodeMap.delete(id);
  }
  for (const id of patch.removeEdgeIds ?? []) {
    edgeMap.delete(id);
  }
  for (const n of patch.upsertNodes ?? []) {
    nodeMap.set(n.id, n);
  }
  for (const e of patch.upsertEdges ?? []) {
    edgeMap.set(e.id, e);
  }
}

export { applyGraphPatch } from '../../shared/graph';

export function parentIdForPath(
  workspaceRoot: string,
  absolutePath: string,
): string {
  const root = normalizePath(workspaceRoot);
  const path = normalizePath(absolutePath);
  if (path === root) {
    return workspaceNodeId(root);
  }
  const idx = path.lastIndexOf('/');
  const parent = idx <= 0 ? root : path.slice(0, idx);

  if (parent === root || parent === '') {
    return workspaceNodeId(root);
  }
  return folderNodeId(parent);
}

export function labelFromPath(absolutePath: string): string {
  return basename(absolutePath) || absolutePath;
}

/**
 * Rewire call edges that pointed at a file stub to a concrete symbol node.
 */
export function rewireFileStubToSymbol(
  edges: GraphEdge[],
  fileStubId: string,
  symbolNodeIdTarget: string,
  calleeName: string,
): { removeEdgeIds: string[]; upsertEdges: GraphEdge[] } {
  const removeEdgeIds: string[] = [];
  const upsertEdges: GraphEdge[] = [];

  for (const e of edges) {
    if (
      e.kind === 'calls' &&
      e.target === fileStubId &&
      (e.metadata?.calleeName === calleeName || !e.metadata?.calleeName)
    ) {
      removeEdgeIds.push(e.id);
      upsertEdges.push(
        makeEdge('calls', e.source, symbolNodeIdTarget, {
          ...e.metadata,
          calleeName,
          rewired: true,
        }),
      );
    }
  }

  return { removeEdgeIds, upsertEdges };
}
