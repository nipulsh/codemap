import type { Edge, Node } from '@xyflow/react';

export type EdgeFilter =
  | 'all'
  | 'imports'
  | 'dynamicImport'
  | 'exports'
  | 'contains'
  | 'cycles';

export const EDGE_FILTER_OPTIONS: { value: EdgeFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'imports', label: 'Imports' },
  { value: 'dynamicImport', label: 'Dynamic Imports' },
  { value: 'exports', label: 'Exports' },
  { value: 'contains', label: 'Contains' },
  { value: 'cycles', label: 'Cycles' },
];

function edgeMatchesFilter(edge: Edge, filter: EdgeFilter): boolean {
  const className = edge.className ?? '';

  switch (filter) {
    case 'all':
      return true;
    case 'imports':
      return className.includes('cm-edge-imports');
    case 'dynamicImport':
      return className.includes('cm-edge-dynamicImport');
    case 'exports':
      return className.includes('cm-edge-exports');
    case 'contains':
      return className.includes('cm-edge-contains');
    case 'cycles':
      return className.includes('cm-edge-cycle');
    default:
      return true;
  }
}

export function filterEdges(edges: Edge[], filter: EdgeFilter): Edge[] {
  if (filter === 'all') {
    return edges;
  }
  return edges.filter((edge) => edgeMatchesFilter(edge, filter));
}

export function filterNodes(
  nodes: Node[],
  visibleEdges: Edge[],
  filter: EdgeFilter,
): Node[] {
  if (filter === 'all') {
    return nodes;
  }

  const connected = new Set<string>();
  for (const edge of visibleEdges) {
    connected.add(edge.source);
    connected.add(edge.target);
  }

  return nodes.filter((node) => connected.has(node.id));
}
