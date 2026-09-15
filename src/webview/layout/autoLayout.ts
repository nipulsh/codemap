import type { GraphEdge, GraphNode, GraphSnapshot, NodeKind } from '../../../shared/graph';
import { getNodeDimensions, type NodeSize } from './nodeSizes';

export interface PositionedNode extends GraphNode {
  position: { x: number; y: number };
  width: number;
  height: number;
}

export interface LayoutResult {
  nodes: PositionedNode[];
  edges: GraphEdge[];
  engine: 'elk' | 'dagre' | 'incremental';
}

let currentNodeSize: NodeSize = 'medium';

export function setNodeSizePreference(size: NodeSize): void {
  currentNodeSize = size;
}

export function getNodeSizePreference(): NodeSize {
  return currentNodeSize;
}

export function nodeSize(kind: string, size?: NodeSize): { width: number; height: number } {
  const effectiveSize = size ?? currentNodeSize;
  return getNodeDimensions(kind as NodeKind, effectiveSize);
}

/** Edges that define the explorer tree; imports/calls are drawn but must not drive layout. */
const TREE_EDGE_KINDS = new Set<GraphEdge['kind']>(['hierarchy', 'contains']);

/** Above these counts ELK/Dagre become seconds-to-minutes on dense import graphs. */
const ELK_MAX_NODES = 400;
const ELK_MAX_TREE_EDGES = 600;

function hierarchyLayoutEdges(edges: GraphEdge[]): GraphEdge[] {
  return edges.filter((e) => TREE_EDGE_KINDS.has(e.kind));
}

function kindFromNodeId(nodeId: string): string {
  if (nodeId.startsWith('workspace:')) {
    return 'Workspace';
  }
  if (nodeId.startsWith('folder:')) {
    return 'Folder';
  }
  if (nodeId.startsWith('file:')) {
    return 'File';
  }
  return 'Function';
}

/**
 * Fast O(n) tree placement using hierarchy/contains edges only.
 * Used for large graphs and as the Dagre fallback when ELK fails.
 */
function layoutHierarchyTree(
  nodes: GraphNode[],
  edges: GraphEdge[],
  size?: NodeSize,
): LayoutResult {
  const effectiveSize = size ?? currentNodeSize;
  const treeEdges = hierarchyLayoutEdges(edges);
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const parentOf = new Map<string, string>();

  for (const e of treeEdges) {
    if (!nodeById.has(e.source) || !nodeById.has(e.target)) {
      continue;
    }
    parentOf.set(e.target, e.source);
  }

  const roots = nodes.filter((n) => !parentOf.has(n.id));
  const positions = layoutNewNodes(new Map(), nodes, treeEdges, undefined, effectiveSize);

  // Roots with no parent edge still need a seed position.
  let rootY = 0;
  for (const root of roots) {
    if (!positions.has(root.id)) {
      positions.set(root.id, { x: 0, y: rootY });
      rootY += 56;
    }
  }

  const positioned = nodes.map((n) => {
    const dim = nodeSize(n.kind ?? kindFromNodeId(n.id), effectiveSize);
    return {
      ...n,
      position: positions.get(n.id) ?? { x: 0, y: 0 },
      width: dim.width,
      height: dim.height,
    };
  });

  return { nodes: positioned, edges, engine: 'incremental' };
}

/**
 * Full layout for initial snapshot.
 *
 * Only hierarchy/contains edges influence placement — import/call edges are
 * visual only. Above {@link ELK_MAX_NODES} nodes or {@link ELK_MAX_TREE_EDGES}
 * tree edges, ELK is skipped in favour of the incremental tree layout.
 */
export async function layoutGraph(
  snapshot: GraphSnapshot,
  size?: NodeSize,
): Promise<LayoutResult> {
  const nodes = snapshot.nodes;
  const edges = snapshot.edges;
  const effectiveSize = size ?? currentNodeSize;

  if (nodes.length === 0) {
    return { nodes: [], edges: [], engine: 'elk' };
  }

  const treeEdges = hierarchyLayoutEdges(edges);
  if (nodes.length > ELK_MAX_NODES || treeEdges.length > ELK_MAX_TREE_EDGES) {
    return layoutHierarchyTree(nodes, edges, effectiveSize);
  }

  try {
    return await layoutWithElk(nodes, treeEdges, effectiveSize);
  } catch {
    try {
      return layoutWithDagre(nodes, treeEdges, effectiveSize);
    } catch {
      return layoutHierarchyTree(nodes, edges, effectiveSize);
    }
  }
}

/**
 * Place only newly added nodes near their parent without moving existing ones.
 */
export function layoutNewNodes(
  existingPositions: Map<string, { x: number; y: number }>,
  newNodes: GraphNode[],
  edges: GraphEdge[],
  parentHint?: string,
  size?: NodeSize,
): Map<string, { x: number; y: number }> {
  const effectiveSize = size ?? currentNodeSize;
  const positions = new Map(existingPositions);
  if (newNodes.length === 0) {
    return positions;
  }

  // Find parent from hierarchy/contains/calls edges
  const newNodeIds = new Set(newNodes.map((n) => n.id));
  const parentOf = new Map<string, string>();
  for (const e of edges) {
    if (
      e.kind === 'hierarchy' ||
      e.kind === 'contains' ||
      e.kind === 'calls' ||
      e.kind === 'imports' ||
      e.kind === 'dynamicImport'
    ) {
      if (newNodeIds.has(e.target)) {
        parentOf.set(e.target, e.source);
      }
    }
  }

  // Group new nodes by parent
  const byParent = new Map<string, GraphNode[]>();
  for (const n of newNodes) {
    const p = parentOf.get(n.id) ?? parentHint ?? '__root__';
    if (!byParent.has(p)) {
      byParent.set(p, []);
    }
    byParent.get(p)!.push(n);
  }

  const GAP_X = 220;
  const GAP_Y = 56;

  for (const [parentId, children] of byParent) {
    const parentPos = positions.get(parentId) ?? { x: 0, y: 0 };
    const parentDim = nodeSize(
      // approximate
      parentId.startsWith('workspace:')
        ? 'Workspace'
        : parentId.startsWith('folder:')
          ? 'Folder'
          : parentId.startsWith('file:')
            ? 'File'
            : 'Function',
      effectiveSize,
    );

    const startX = parentPos.x + parentDim.width + GAP_X * 0.6;
    let startY = parentPos.y;

    // Offset if siblings already occupy space
    const occupiedYs = [...positions.entries()]
      .filter(([id]) => id !== parentId)
      .map(([, p]) => p.y)
      .filter((y) => y >= parentPos.y - 20 && y <= parentPos.y + children.length * GAP_Y + 40);

    if (occupiedYs.length > 0) {
      startY = Math.max(...occupiedYs) + GAP_Y;
    }

    children.forEach((child, i) => {
      if (positions.has(child.id)) {
        return;
      }
      positions.set(child.id, {
        x: startX,
        y: startY + i * GAP_Y,
      });
    });
  }

  // Any new node still without position
  let orphanY = 0;
  for (const n of newNodes) {
    if (!positions.has(n.id)) {
      positions.set(n.id, { x: 40, y: orphanY });
      orphanY += GAP_Y;
    }
  }

  return positions;
}

async function layoutWithElk(
  nodes: GraphNode[],
  edges: GraphEdge[],
  size?: NodeSize,
): Promise<LayoutResult> {
  const effectiveSize = size ?? currentNodeSize;
  const ELK = (await import('elkjs/lib/elk.bundled.js')).default;
  const elk = new ELK();

  const graph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.spacing.nodeNode': '40',
      'elk.layered.spacing.nodeNodeBetweenLayers': '60',
    },
    children: nodes.map((n) => {
      const dim = nodeSize(n.kind, effectiveSize);
      return { id: n.id, width: dim.width, height: dim.height };
    }),
    edges: edges.map((e) => ({
      id: e.id,
      sources: [e.source],
      targets: [e.target],
    })),
  };

  // elkjs bundled runs synchronously on the main thread; Promise.race cannot
  // interrupt it, so size guards in layoutGraph() are the real safety net.
  const laid = await elk.layout(graph);

  const laidById = new Map<string, { x?: number; y?: number }>();
  for (const child of laid.children ?? []) {
    laidById.set(child.id, child);
  }

  const positioned = nodes.map((n) => {
    const child = laidById.get(n.id);
    const dim = nodeSize(n.kind, effectiveSize);
    return {
      ...n,
      position: { x: child?.x ?? 0, y: child?.y ?? 0 },
      width: dim.width,
      height: dim.height,
    };
  });

  return { nodes: positioned, edges, engine: 'elk' };
}

async function layoutWithDagre(
  nodes: GraphNode[],
  edges: GraphEdge[],
  size?: NodeSize,
): Promise<LayoutResult> {
  const effectiveSize = size ?? currentNodeSize;
  // @dagrejs/dagre is CommonJS. esbuild's __toESM interop exposes its members
  // directly on the namespace, but Node's native ESM loader only guarantees
  // them on `default`; accept both so the fallback works everywhere.
  const dagreModule: typeof import('@dagrejs/dagre') = await import('@dagrejs/dagre');
  const dagre =
    (dagreModule as unknown as { default?: typeof dagreModule }).default ??
    dagreModule;
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 60 });

  for (const n of nodes) {
    const dim = nodeSize(n.kind, effectiveSize);
    g.setNode(n.id, { width: dim.width, height: dim.height });
  }

  for (const e of edges) {
    g.setEdge(e.source, e.target);
  }

  dagre.layout(g);

  const positioned = nodes.map((n) => {
    const gn = g.node(n.id);
    const dim = nodeSize(n.kind, effectiveSize);
    return {
      ...n,
      position: {
        x: (gn?.x ?? 0) - (gn?.width ?? 0) / 2,
        y: (gn?.y ?? 0) - (gn?.height ?? 0) / 2,
      },
      width: dim.width,
      height: dim.height,
    };
  });

  return { nodes: positioned, edges, engine: 'dagre' };
}
