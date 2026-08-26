export type NodeSize = 'small' | 'medium' | 'large';

export const NODE_SIZES: NodeSize[] = ['small', 'medium', 'large'];

const DIMENSIONS: Record<
  NodeSize,
  { file: { width: number; height: number }; folder: { width: number; height: number } }
> = {
  small: {
    file: { width: 120, height: 40 },
    folder: { width: 140, height: 44 },
  },
  medium: {
    file: { width: 160, height: 55 },
    folder: { width: 180, height: 60 },
  },
  large: {
    file: { width: 220, height: 75 },
    folder: { width: 240, height: 80 },
  },
};

export function getNodeDimensions(
  kind: 'Folder' | 'File',
  size: NodeSize,
): { width: number; height: number } {
  return kind === 'Folder' ? DIMENSIONS[size].folder : DIMENSIONS[size].file;
}
