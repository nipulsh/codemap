import type { GraphEdge, GraphNode, GraphSnapshot } from '../../../shared/graph';
import { nodeSize } from '../layout/autoLayout';

export interface TraceLayoutNode extends GraphNode {
  position: { x: number; y: number };
  width: number;
  height: number;
}

/** Depth-first vertical layout for static route traces. */
export function layoutTraceByDepth(snapshot: GraphSnapshot): {
  nodes: TraceLayoutNode[];
  edges: GraphEdge[];
} {
  const byDepth = new Map<number, GraphNode[]>();

  for (const node of snapshot.nodes) {
    const depth =
      node.kind === 'Route'
        ? -1
        : ((node.metadata?.traceDepth as number | undefined) ?? 0);
    if (!byDepth.has(depth)) {
      byDepth.set(depth, []);
    }
    byDepth.get(depth)!.push(node);
  }

  const positioned: TraceLayoutNode[] = [];
  const sortedDepths = [...byDepth.keys()].sort((a, b) => a - b);

  for (const depth of sortedDepths) {
    const group = byDepth.get(depth)!;
    group.sort((a, b) => a.id.localeCompare(b.id));
    const rowY = (depth + 1) * 100;
    group.forEach((node, index) => {
      const size = nodeSize(node.kind);
      positioned.push({
        ...node,
        position: { x: index * (size.width + 40), y: rowY },
        width: size.width,
        height: size.height,
      });
    });
  }

  return { nodes: positioned, edges: snapshot.edges };
}
