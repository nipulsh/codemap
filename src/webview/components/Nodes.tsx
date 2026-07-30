import type { NodeProps } from '@xyflow/react';
import { Handle, Position } from '@xyflow/react';
import type { NodeKind } from '../../../shared/graph';

export interface ArchitectureNodeData {
  label: string;
  kind: NodeKind;
  filePath?: string;
  line?: number;
  cycle?: boolean;
  expanded?: boolean;
  lazy?: boolean;
  [key: string]: unknown;
}

const ICONS: Record<string, string> = {
  Workspace: 'W',
  Folder: 'D',
  File: 'F',
  Function: 'ƒ',
  Class: 'C',
  Interface: 'I',
  Enum: 'E',
  Component: 'R',
};

function NodeShell({
  data,
  className,
}: {
  data: ArchitectureNodeData;
  className: string;
}) {
  const icon = ICONS[data.kind] ?? '?';
  return (
    <div
      className={`cm-node ${className} ${data.cycle ? 'cm-cycle' : ''} ${data.expanded ? 'cm-expanded' : ''} ${data.lazy ? 'cm-lazy' : ''}`}
    >
      <Handle type="target" position={Position.Left} />
      <span className="cm-node-icon" aria-hidden>
        {icon}
      </span>
      <span className="cm-node-label">{data.label}</span>
      {data.expanded ? (
        <span className="cm-node-badge" title="Expanded">
          ▾
        </span>
      ) : data.kind === 'Folder' ||
        data.kind === 'File' ||
        data.kind === 'Function' ||
        data.kind === 'Component' ||
        data.kind === 'Class' ? (
        <span className="cm-node-badge cm-node-badge-muted" title="Double-click to expand">
          ▸
        </span>
      ) : null}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export function WorkspaceNode({ data }: NodeProps & { data: ArchitectureNodeData }) {
  return <NodeShell data={data} className="cm-workspace" />;
}

export function FolderNode({ data }: NodeProps & { data: ArchitectureNodeData }) {
  return <NodeShell data={data} className="cm-folder" />;
}

export function FileNode({ data }: NodeProps & { data: ArchitectureNodeData }) {
  return <NodeShell data={data} className="cm-file" />;
}

export function FunctionNode({ data }: NodeProps & { data: ArchitectureNodeData }) {
  return <NodeShell data={data} className="cm-function" />;
}

export function ClassNode({ data }: NodeProps & { data: ArchitectureNodeData }) {
  return <NodeShell data={data} className="cm-class" />;
}

export function InterfaceNode({ data }: NodeProps & { data: ArchitectureNodeData }) {
  return <NodeShell data={data} className="cm-interface" />;
}

export function EnumNode({ data }: NodeProps & { data: ArchitectureNodeData }) {
  return <NodeShell data={data} className="cm-enum" />;
}

export function ComponentNode({ data }: NodeProps & { data: ArchitectureNodeData }) {
  return <NodeShell data={data} className="cm-component" />;
}

export function kindToNodeType(kind: NodeKind): string {
  switch (kind) {
    case 'Workspace':
      return 'workspace';
    case 'Folder':
      return 'folder';
    case 'File':
      return 'file';
    case 'Function':
      return 'function';
    case 'Class':
      return 'class';
    case 'Interface':
      return 'interface';
    case 'Enum':
      return 'enum';
    case 'Component':
      return 'component';
    default:
      return 'file';
  }
}
