import type { GraphEdge, GraphNode, GraphSnapshot } from '../../../shared/graph';
import { getNodeDimensions, type NodeSize } from './nodeSizes';

export interface LayoutResult {
  nodes: Array<GraphNode & { position: { x: number; y: number }; width: number; height: number }>;
  edges: GraphEdge[];
  engine: 'elk' | 'dagre';
}

const ELK_TIMEOUT_MS = 2000;

function visibleGraph(
  snapshot: GraphSnapshot,
  collapsedFolders: Set<string>,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const hidden = new Set<string>();

  // Build parent map from contains edges
  const childrenOf = new Map<string, string[]>();
  for (const e of snapshot.edges) {
    if (e.kind === 'contains') {
      if (!childrenOf.has(e.source)) {
        childrenOf.set(e.source, []);
      }
      childrenOf.get(e.source)!.push(e.target);
    }
  }

  function hideDescendants(folderId: string): void {
    for (const child of childrenOf.get(folderId) ?? []) {
      hidden.add(child);
      hideDescendants(child);
    }
  }

  for (const folderId of collapsedFolders) {
    hideDescendants(folderId);
  }

  const nodes = snapshot.nodes.filter((n) => !hidden.has(n.id));
  const visibleIds = new Set(nodes.map((n) => n.id));
  const edges = snapshot.edges.filter(
    (e) => visibleIds.has(e.source) && visibleIds.has(e.target),
  );

  return { nodes, edges };
}

async function layoutWithElk(
  nodes: GraphNode[],
  edges: GraphEdge[],
  nodeSize: NodeSize,
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
      const { width, height } = getNodeDimensions(
        n.kind === 'Folder' ? 'Folder' : 'File',
        nodeSize,
      );
      return { id: n.id, width, height };
    }),
    edges: edges
      .filter((e) => e.kind !== 'contains')
      .map((e) => ({
        id: e.id,
        sources: [e.source],
        targets: [e.target],
      })),
  };

  // Also include contains edges lightly for structure — ELK layered works better
  // with dependency edges only; place contains as hierarchy via positions later.
  const layoutPromise = elk.layout(graph);
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('ELK timeout')), ELK_TIMEOUT_MS);
  });

  const laid = await Promise.race([layoutPromise, timeoutPromise]);

  const positioned = nodes.map((n) => {
    const child = laid.children?.find((c: { id: string }) => c.id === n.id);
    const { width, height } = getNodeDimensions(
      n.kind === 'Folder' ? 'Folder' : 'File',
      nodeSize,
    );
    return {
      ...n,
      position: { x: child?.x ?? 0, y: child?.y ?? 0 },
      width,
      height,
    };
  });

  return { nodes: positioned, edges, engine: 'elk' };
}

async function layoutWithDagre(
  nodes: GraphNode[],
  edges: GraphEdge[],
  nodeSize: NodeSize,
): Promise<LayoutResult> {
  const dagre = await import('@dagrejs/dagre');
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 60 });

  for (const n of nodes) {
    const { width, height } = getNodeDimensions(
      n.kind === 'Folder' ? 'Folder' : 'File',
      nodeSize,
    );
    g.setNode(n.id, { width, height });
  }

  for (const e of edges) {
    if (e.kind === 'contains') {
      continue;
    }
    g.setEdge(e.source, e.target);
  }

  dagre.layout(g);

  const positioned = nodes.map((n) => {
    const gn = g.node(n.id);
    const { width, height } = getNodeDimensions(
      n.kind === 'Folder' ? 'Folder' : 'File',
      nodeSize,
    );
    return {
      ...n,
      position: {
        x: (gn?.x ?? 0) - (gn?.width ?? 0) / 2,
        y: (gn?.y ?? 0) - (gn?.height ?? 0) / 2,
      },
      width,
      height,
    };
  });

  return { nodes: positioned, edges, engine: 'dagre' };
}

/**
 * Run ELK with a 2s budget; fall back to Dagre on failure/timeout.
 */
export async function layoutGraph(
  snapshot: GraphSnapshot,
  collapsedFolders: Set<string>,
  nodeSize: NodeSize = 'medium',
): Promise<LayoutResult> {
  const { nodes, edges } = visibleGraph(snapshot, collapsedFolders);

  if (nodes.length === 0) {
    return { nodes: [], edges: [], engine: 'elk' };
  }

  try {
    return await layoutWithElk(nodes, edges, nodeSize);
  } catch {
    return layoutWithDagre(nodes, edges, nodeSize);
  }
}
