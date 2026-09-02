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
  traceDepth?: number;
  traceResolution?: 'resolved' | 'unresolved' | 'external';
  relativePath?: string;
  staticTrace?: boolean;
  overlayObservation?: 'observed' | 'unobserved' | 'runtime-only' | 'unresolved';
  overlayMetricsLabel?: string;
  overlayError?: { name?: string; message: string };
  runtimeOnly?: boolean;
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
  Route: '⇢',
};

function NodeShell({
  data,
  className,
}: {
  data: ArchitectureNodeData;
  className: string;
}) {
  const icon = ICONS[data.kind] ?? '?';
  const depthLabel =
    data.traceDepth !== undefined && data.traceDepth >= 0
      ? `D${data.traceDepth}`
      : null;
  const resolutionLabel =
    data.traceResolution === 'external'
      ? '[external]'
      : data.traceResolution === 'unresolved'
        ? '[unresolved]'
        : null;

  const overlayLabel =
    data.overlayObservation === 'observed'
      ? '✓ observed'
      : data.overlayObservation === 'unobserved'
        ? '○ not observed'
        : data.overlayObservation === 'runtime-only'
          ? '⚡ runtime-only'
          : data.overlayObservation === 'unresolved'
            ? '⚠ unresolved'
            : null;

  const isTraceNode = !!data.staticTrace || data.kind === 'Route';
  const overlayClass = data.overlayObservation
    ? `cm-overlay-${data.overlayObservation}`
    : '';

  return (
    <div
      className={`cm-node ${className} ${data.cycle ? 'cm-cycle' : ''} ${data.expanded ? 'cm-expanded' : ''} ${data.lazy ? 'cm-lazy' : ''} ${data.traceResolution === 'external' ? 'cm-trace-external' : ''} ${overlayClass} ${data.runtimeOnly ? 'cm-runtime-only-node' : ''}`}
    >
      <Handle
        type="target"
        position={isTraceNode ? Position.Top : Position.Left}
      />
      {depthLabel ? (
        <span className="cm-node-depth" title={`Depth ${data.traceDepth}`}>
          {depthLabel}
        </span>
      ) : null}
      <span className="cm-node-icon" aria-hidden>
        {icon}
      </span>
      <span className="cm-node-label">{data.label}</span>
      {data.relativePath ? (
        <span className="cm-node-sub">{data.relativePath}</span>
      ) : null}
      {resolutionLabel ? (
        <span className="cm-node-badge cm-node-resolution">{resolutionLabel}</span>
      ) : null}
      {overlayLabel ? (
        <span className="cm-node-badge cm-node-overlay" title={overlayLabel}>
          {overlayLabel}
        </span>
      ) : null}
      {data.overlayMetricsLabel ? (
        <span className="cm-node-badge cm-node-metrics" title="Runtime metrics">
          {data.overlayMetricsLabel}
        </span>
      ) : null}
      {data.overlayError ? (
        <span className="cm-node-badge cm-node-error" title={data.overlayError.message}>
          ✕ {data.overlayError.name ?? 'Error'}
        </span>
      ) : null}
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
      <Handle
        type="source"
        position={isTraceNode ? Position.Bottom : Position.Right}
      />
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

export function RouteNode({ data }: NodeProps & { data: ArchitectureNodeData }) {
  return <NodeShell data={data} className="cm-route" />;
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
    case 'Route':
      return 'route';
    default:
      return 'file';
  }
}
