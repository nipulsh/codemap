import type { GraphEdge, GraphNode, GraphSnapshot } from '../../../shared/graph';

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

const NODE_SIZES: Record<string, { width: number; height: number }> = {
  Workspace: { width: 200, height: 52 },
  Folder: { width: 180, height: 48 },
  File: { width: 160, height: 40 },
  Function: { width: 150, height: 36 },
  Class: { width: 150, height: 36 },
  Interface: { width: 150, height: 36 },
  Enum: { width: 140, height: 36 },
  Component: { width: 160, height: 36 },
};

export function nodeSize(kind: string): { width: number; height: number } {
  return NODE_SIZES[kind] ?? { width: 150, height: 36 };
}

/**
 * Full layout for initial snapshot (ELK with Dagre fallback).
 */
export async function layoutGraph(
  snapshot: GraphSnapshot,
): Promise<LayoutResult> {
  const nodes = snapshot.nodes;
  const edges = snapshot.edges;

  if (nodes.length === 0) {
    return { nodes: [], edges: [], engine: 'elk' };
  }

  try {
    return await layoutWithElk(nodes, edges);
  } catch {
    return layoutWithDagre(nodes, edges);
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
): Map<string, { x: number; y: number }> {
  const positions = new Map(existingPositions);
  if (newNodes.length === 0) {
    return positions;
  }

  // Find parent from hierarchy/contains/calls edges
  const parentOf = new Map<string, string>();
  for (const e of edges) {
    if (
      e.kind === 'hierarchy' ||
      e.kind === 'contains' ||
      e.kind === 'calls' ||
      e.kind === 'imports' ||
      e.kind === 'dynamicImport'
    ) {
      if (newNodes.some((n) => n.id === e.target)) {
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
    const parentSize = nodeSize(
      // approximate
      parentId.startsWith('workspace:')
        ? 'Workspace'
        : parentId.startsWith('folder:')
          ? 'Folder'
          : parentId.startsWith('file:')
            ? 'File'
            : 'Function',
    );

    const startX = parentPos.x + parentSize.width + GAP_X * 0.6;
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
): Promise<LayoutResult> {
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
      const size = nodeSize(n.kind);
      return { id: n.id, width: size.width, height: size.height };
    }),
    edges: edges.map((e) => ({
      id: e.id,
      sources: [e.source],
      targets: [e.target],
    })),
  };

  const ELK_TIMEOUT_MS = 2000;
  const layoutPromise = elk.layout(graph);
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('ELK timeout')), ELK_TIMEOUT_MS);
  });

  const laid = await Promise.race([layoutPromise, timeoutPromise]);

  const positioned = nodes.map((n) => {
    const child = laid.children?.find((c: { id: string }) => c.id === n.id);
    const size = nodeSize(n.kind);
    return {
      ...n,
      position: { x: child?.x ?? 0, y: child?.y ?? 0 },
      width: size.width,
      height: size.height,
    };
  });

  return { nodes: positioned, edges, engine: 'elk' };
}

async function layoutWithDagre(
  nodes: GraphNode[],
  edges: GraphEdge[],
): Promise<LayoutResult> {
  const dagre = await import('@dagrejs/dagre');
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 60 });

  for (const n of nodes) {
    const size = nodeSize(n.kind);
    g.setNode(n.id, { width: size.width, height: size.height });
  }

  for (const e of edges) {
    g.setEdge(e.source, e.target);
  }

  dagre.layout(g);

  const positioned = nodes.map((n) => {
    const gn = g.node(n.id);
    const size = nodeSize(n.kind);
    return {
      ...n,
      position: {
        x: (gn?.x ?? 0) - (gn?.width ?? 0) / 2,
        y: (gn?.y ?? 0) - (gn?.height ?? 0) / 2,
      },
      width: size.width,
      height: size.height,
    };
  });

  return { nodes: positioned, edges, engine: 'dagre' };
}
