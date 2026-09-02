import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useEdgesState,
  useNodesState,
  useReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeTypes,
} from '@xyflow/react';
import type { GraphPatch, GraphSnapshot } from '../../../shared/graph';
import { layoutGraph, layoutNewNodes, nodeSize } from '../layout/autoLayout';
import {
  ClassNode,
  ComponentNode,
  EnumNode,
  FileNode,
  FolderNode,
  FunctionNode,
  InterfaceNode,
  RouteNode,
  WorkspaceNode,
  kindToNodeType,
  type ArchitectureNodeData,
} from './Nodes';
import { postToExtension } from '../hooks/useExtensionMessages';
import type { TraceLayoutNode } from '../routeTrace/layoutTraceByDepth';

const nodeTypes: NodeTypes = {
  workspace: WorkspaceNode,
  folder: FolderNode,
  file: FileNode,
  function: FunctionNode,
  class: ClassNode,
  interface: InterfaceNode,
  enum: EnumNode,
  component: ComponentNode,
  route: RouteNode,
};

interface Props {
  snapshot: GraphSnapshot;
  lastPatch: GraphPatch | null;
  fullVersion: number;
  onLayoutEngine?: (engine: string) => void;
  clearLastPatch?: () => void;
  traceMode?: boolean;
  overlayMode?: boolean;
  traceLayout?: { nodes: TraceLayoutNode[]; edges: GraphSnapshot['edges'] } | null;
  onNodeSelect?: (nodeId: string) => void;
}

function ArchitectureGraphInner({
  snapshot,
  lastPatch,
  fullVersion,
  onLayoutEngine,
  clearLastPatch,
  traceMode = false,
  overlayMode = false,
  traceLayout = null,
  onNodeSelect,
}: Props) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const positionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const nodesRef = useRef<Node[]>([]);
  const layoutFullVersionRef = useRef(-1);
  const { fitView } = useReactFlow();

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  const toRfNode = useCallback((n: {
    id: string;
    kind: ArchitectureNodeData['kind'];
    label: string;
    filePath?: string;
    line?: number;
    metadata?: Record<string, unknown>;
    position: { x: number; y: number };
    width: number;
    height: number;
  }): Node => ({
    id: n.id,
    type: kindToNodeType(n.kind),
    position: n.position,
    data: {
      label: n.label,
      kind: n.kind,
      filePath: n.filePath,
      line: n.line,
      cycle: !!n.metadata?.cycle || !!n.metadata?.isCycle,
      expanded: !!n.metadata?.expanded,
      lazy: !!n.metadata?.lazy,
      traceDepth: n.metadata?.traceDepth as number | undefined,
      traceResolution: n.metadata?.traceResolution as ArchitectureNodeData['traceResolution'],
      relativePath: n.metadata?.relativePath as string | undefined,
      staticTrace: !!n.metadata?.staticTrace || n.kind === 'Route',
      overlayObservation: n.metadata?.overlayObservation as ArchitectureNodeData['overlayObservation'],
      overlayMetricsLabel: n.metadata?.overlayMetricsLabel as string | undefined,
      overlayError: n.metadata?.overlayError as ArchitectureNodeData['overlayError'],
      runtimeOnly: !!n.metadata?.runtimeOnly,
    } satisfies ArchitectureNodeData,
    style: { width: n.width, height: n.height },
  }), []);

  const toRfEdges = useCallback((graphEdges: GraphSnapshot['edges']): Edge[] => {
    return graphEdges.map((e) => {
      const asyncFlow = !!e.metadata?.async;
      const isCycle = !!e.metadata?.cycle || !!e.metadata?.isCycle;
      const overlayObservation = e.metadata?.overlayObservation as string | undefined;
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        animated: e.kind === 'dynamicImport' || asyncFlow,
        className: [
          `cm-edge-${e.kind}`,
          asyncFlow ? 'cm-edge-async' : '',
          isCycle ? 'cm-edge-cycle' : '',
          overlayObservation ? `cm-edge-overlay-${overlayObservation}` : '',
        ]
          .filter(Boolean)
          .join(' '),
        label:
          overlayObservation === 'observed'
            ? '✓'
            : overlayObservation === 'unobserved'
              ? '○'
              : overlayObservation === 'runtime-only'
                ? '⚡'
                : isCycle
                  ? 'cycle'
                  : e.kind === 'dynamicImport'
                    ? 'dynamic'
                    : asyncFlow
                      ? 'async'
                      : undefined,
        style: edgeStyle(e.kind, asyncFlow, isCycle),
      };
    });
  }, []);

  // Trace layout — depth-based, no ELK
  useEffect(() => {
    if (!traceMode || !traceLayout) {
      return;
    }
    let cancelled = false;
    void (async () => {
      if (cancelled) {
        return;
      }
      onLayoutEngine?.('trace-depth');
      const pos = new Map<string, { x: number; y: number }>();
      for (const n of traceLayout.nodes) {
        pos.set(n.id, n.position);
      }
      positionsRef.current = pos;
      setNodes(traceLayout.nodes.map(toRfNode));
      setEdges(toRfEdges(traceLayout.edges));
      layoutFullVersionRef.current = fullVersion;
      requestAnimationFrame(() => {
        void fitView({ padding: 0.2, duration: 200 });
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [
    traceMode,
    traceLayout,
    fullVersion,
    onLayoutEngine,
    setNodes,
    setEdges,
    toRfNode,
    toRfEdges,
    fitView,
  ]);

  // Initial / full-refresh layout only
  useEffect(() => {
    if (traceMode) {
      return;
    }
    if (layoutFullVersionRef.current === fullVersion) {
      return;
    }
    let cancelled = false;

    void (async () => {
      const result = await layoutGraph(snapshot);
      if (cancelled) {
        return;
      }
      onLayoutEngine?.(result.engine);
      const pos = new Map<string, { x: number; y: number }>();
      for (const n of result.nodes) {
        pos.set(n.id, n.position);
      }
      positionsRef.current = pos;
      setNodes(result.nodes.map(toRfNode));
      setEdges(toRfEdges(result.edges));
      layoutFullVersionRef.current = fullVersion;
      requestAnimationFrame(() => {
        void fitView({ padding: 0.15, duration: 200 });
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [
    fullVersion,
    snapshot,
    onLayoutEngine,
    setNodes,
    setEdges,
    toRfNode,
    toRfEdges,
    fitView,
    traceMode,
  ]);

  // Incremental patch layout — never moves existing nodes
  useEffect(() => {
    if (traceMode) {
      return;
    }
    if (!lastPatch || layoutFullVersionRef.current !== fullVersion) {
      return;
    }

    const newNodeIds = new Set(
      (lastPatch.upsertNodes ?? [])
        .map((n) => n.id)
        .filter((id) => !positionsRef.current.has(id)),
    );
    const newNodes = snapshot.nodes.filter((n) => newNodeIds.has(n.id));

    const updatedPositions = layoutNewNodes(
      positionsRef.current,
      newNodes,
      snapshot.edges,
    );

    for (const id of lastPatch.removeNodeIds ?? []) {
      updatedPositions.delete(id);
    }

    // Keep dragged positions for existing nodes
    for (const n of nodesRef.current) {
      if (!newNodeIds.has(n.id) && updatedPositions.has(n.id)) {
        updatedPositions.set(n.id, n.position);
      }
    }

    positionsRef.current = updatedPositions;

    const rfNodes: Node[] = snapshot.nodes.map((n) => {
      const size = nodeSize(n.kind);
      const position = updatedPositions.get(n.id) ?? { x: 0, y: 0 };
      return toRfNode({
        ...n,
        position,
        width: size.width,
        height: size.height,
      });
    });

    setNodes(rfNodes);
    setEdges(toRfEdges(snapshot.edges));
    clearLastPatch?.();
  }, [
    lastPatch,
    fullVersion,
    snapshot,
    setNodes,
    setEdges,
    toRfNode,
    toRfEdges,
    clearLastPatch,
    traceMode,
  ]);

  const onNodeDoubleClick = useCallback(
    (event: React.MouseEvent, node: Node) => {
      const data = node.data as ArchitectureNodeData;

      if (traceMode) {
        if (data.traceResolution === 'external' || data.traceResolution === 'unresolved') {
          return;
        }
        if (data.filePath) {
          postToExtension({
            type: 'node:open',
            payload: { filePath: data.filePath, line: data.line },
          });
        }
        return;
      }

      // Ctrl/Cmd + double-click opens in editor
      if (event.ctrlKey || event.metaKey) {
        if (data.filePath) {
          postToExtension({
            type: 'node:open',
            payload: { filePath: data.filePath, line: data.line },
          });
        }
        return;
      }

      const expanded = !!data.expanded;

      if (data.kind === 'Workspace' || data.kind === 'Folder') {
        if (!data.filePath) {
          return;
        }
        postToExtension({
          type: expanded ? 'folder:collapse' : 'folder:expand',
          payload: { path: data.filePath },
        });
        return;
      }

      if (data.kind === 'File') {
        if (!data.filePath) {
          return;
        }
        postToExtension({
          type: expanded ? 'file:collapse' : 'file:expand',
          payload: { path: data.filePath },
        });
        return;
      }

      if (
        data.kind === 'Function' ||
        data.kind === 'Component' ||
        data.kind === 'Class'
      ) {
        postToExtension({
          type: expanded ? 'function:collapse' : 'function:expand',
          payload: { nodeId: node.id },
        });
      }
    },
    [traceMode],
  );

  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (overlayMode && onNodeSelect) {
        onNodeSelect(node.id);
      }
    },
    [overlayMode, onNodeSelect],
  );

  const legend = useMemo(
    () => (
      <div className="cm-legend">
        {traceMode && overlayMode ? (
          <>
            <span className="cm-legend-item cm-legend-overlay-observed">observed</span>
            <span className="cm-legend-item cm-legend-overlay-unobserved">unobserved</span>
            <span className="cm-legend-item cm-legend-overlay-runtime">runtime-only</span>
            <span className="cm-legend-item cm-legend-overlay-unresolved">unresolved</span>
          </>
        ) : traceMode ? (
          <>
            <span className="cm-legend-item cm-legend-route">route</span>
            <span className="cm-legend-item cm-legend-calls">static calls</span>
            <span className="cm-legend-item cm-legend-cycle">cycle</span>
            <span className="cm-legend-item cm-legend-external">external</span>
          </>
        ) : (
          <>
            <span className="cm-legend-item cm-legend-hierarchy">hierarchy</span>
            <span className="cm-legend-item cm-legend-contains">contains</span>
            <span className="cm-legend-item cm-legend-calls">calls</span>
            <span className="cm-legend-item cm-legend-imports">imports</span>
            <span className="cm-legend-item cm-legend-dynamic">dynamic</span>
            <span className="cm-legend-item cm-legend-async">async</span>
          </>
        )}
      </div>
    ),
    [traceMode, overlayMode],
  );

  return (
    <div className="cm-graph-wrap">
      {legend}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDoubleClick={onNodeDoubleClick}
        onNodeClick={onNodeClick}
        nodeTypes={nodeTypes}
        fitView={false}
        minZoom={0.05}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} size={1} />
        <Controls showInteractive={false} />
        <MiniMap
          nodeColor={(n) => {
            switch (n.type) {
              case 'workspace':
                return 'var(--cm-workspace)';
              case 'folder':
                return 'var(--cm-folder)';
              case 'function':
                return 'var(--cm-function)';
              case 'component':
                return 'var(--cm-component)';
              case 'class':
                return 'var(--cm-class)';
              case 'interface':
                return 'var(--cm-interface)';
              case 'enum':
                return 'var(--cm-enum)';
              default:
                return 'var(--cm-file)';
            }
          }}
          maskColor="rgba(0,0,0,0.45)"
        />
      </ReactFlow>
    </div>
  );
}

function edgeStyle(
  kind: string,
  asyncFlow: boolean,
  isCycle = false,
): React.CSSProperties | undefined {
  if (isCycle) {
    return { stroke: '#c678dd', strokeWidth: 2, strokeDasharray: '4 4' };
  }
  if (asyncFlow) {
    return { stroke: '#e2a66e', strokeWidth: 2 };
  }
  switch (kind) {
    case 'hierarchy':
      return { stroke: '#8a8a8a', strokeWidth: 2 };
    case 'contains':
      return { stroke: '#6a6a6a', strokeWidth: 1 };
    case 'calls':
      return { stroke: '#5b9bd5', strokeWidth: 2 };
    case 'imports':
      return { stroke: '#9b59b6', strokeDasharray: '6 4', strokeWidth: 1.5 };
    case 'dynamicImport':
      return { stroke: '#f1c40f', strokeDasharray: '2 3', strokeWidth: 1.5 };
    case 'handles':
      return { stroke: '#56b6c2', strokeWidth: 2 };
    case 'servedBy':
      return { stroke: '#6a6a6a', strokeWidth: 1, strokeDasharray: '2 4' };
    case 'exports':
      return { stroke: '#c3e88d', strokeWidth: 1.5 };
    default:
      return undefined;
  }
}

export function ArchitectureGraph(props: Props) {
  return (
    <ReactFlowProvider>
      <ArchitectureGraphInner {...props} />
    </ReactFlowProvider>
  );
}
