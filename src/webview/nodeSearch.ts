import type { Node } from '@xyflow/react';
import type { ArchitectureNodeData } from './components/Nodes';

export function nodeMatchesSearch(node: Node, query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed) {
    return true;
  }

  const needle = trimmed.toLowerCase();
  const data = node.data as ArchitectureNodeData;
  const label = data.label?.toLowerCase() ?? '';
  const filePath = data.filePath?.toLowerCase() ?? '';

  return label.includes(needle) || filePath.includes(needle);
}

export function applySearchToNodes(nodes: Node[], query: string): Node[] {
  const trimmed = query.trim();
  if (!trimmed) {
    return nodes;
  }

  return nodes.map((node) => {
    const isMatch = nodeMatchesSearch(node, trimmed);
    const searchClass = isMatch ? 'cm-search-match' : 'cm-search-dim';
    const existingClass = node.className ?? '';
    const className = existingClass
      ? `${existingClass} ${searchClass}`
      : searchClass;
    return { ...node, className };
  });
}
