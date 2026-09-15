import type { NodeKind } from '../../../shared/graph';

export type NodeSize = 'small' | 'medium' | 'large';

export const NODE_SIZES: NodeSize[] = ['small', 'medium', 'large'];

type NodeCategory = 'workspace' | 'folder' | 'file' | 'symbol' | 'route';

const NODE_KIND_CATEGORY: Record<NodeKind, NodeCategory> = {
  Workspace: 'workspace',
  Folder: 'folder',
  File: 'file',
  Function: 'symbol',
  Class: 'symbol',
  Interface: 'symbol',
  Enum: 'symbol',
  Component: 'symbol',
  Route: 'route',
};

const DIMENSIONS: Record<
  NodeSize,
  Record<NodeCategory, { width: number; height: number }>
> = {
  small: {
    workspace: { width: 160, height: 44 },
    folder: { width: 140, height: 40 },
    file: { width: 120, height: 36 },
    symbol: { width: 110, height: 32 },
    route: { width: 160, height: 40 },
  },
  medium: {
    workspace: { width: 200, height: 52 },
    folder: { width: 180, height: 48 },
    file: { width: 160, height: 40 },
    symbol: { width: 150, height: 36 },
    route: { width: 200, height: 44 },
  },
  large: {
    workspace: { width: 260, height: 64 },
    folder: { width: 240, height: 60 },
    file: { width: 220, height: 52 },
    symbol: { width: 200, height: 48 },
    route: { width: 260, height: 56 },
  },
};

export function getNodeDimensions(
  kind: NodeKind,
  size: NodeSize,
): { width: number; height: number } {
  const category = NODE_KIND_CATEGORY[kind] ?? 'file';
  return DIMENSIONS[size][category];
}
