import type { NodeProps } from '@xyflow/react';
import { Handle, Position } from '@xyflow/react';

export interface ArchitectureNodeData {
  label: string;
  kind: 'Folder' | 'File' | 'Function' | 'Component';
  filePath?: string;
  cycle?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: (id: string) => void;
  [key: string]: unknown;
}

export function FolderNode({ id, data }: NodeProps & { data: ArchitectureNodeData }) {
  return (
    <div
      className={`cm-node cm-folder ${data.cycle ? 'cm-cycle' : ''} ${data.collapsed ? 'cm-collapsed' : ''}`}
    >
      <Handle type="target" position={Position.Left} />
      <button
        type="button"
        className="cm-collapse-btn"
        onClick={(e) => {
          e.stopPropagation();
          data.onToggleCollapse?.(id);
        }}
        aria-label={data.collapsed ? 'Expand folder' : 'Collapse folder'}
      >
        {data.collapsed ? '▸' : '▾'}
      </button>
      <span className="cm-node-label">{data.label}</span>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export function FileNode({ data }: NodeProps & { data: ArchitectureNodeData }) {
  return (
    <div className={`cm-node cm-file ${data.cycle ? 'cm-cycle' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <span className="cm-node-icon">F</span>
      <span className="cm-node-label">{data.label}</span>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
