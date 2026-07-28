import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { GraphSnapshot } from '../../../shared/graph';
import { layoutGraph } from '../layout/autoLayout';
import { FileNode, FolderNode, type ArchitectureNodeData } from './Nodes';
import { postToExtension } from '../hooks/useExtensionMessages';

const nodeTypes: NodeTypes = {
  folder: FolderNode,
  file: FileNode,
};

interface Props {
  snapshot: GraphSnapshot;
  onLayoutEngine?: (engine: string) => void;
}

export function ArchitectureGraph({ snapshot, onLayoutEngine }: Props) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [layouting, setLayouting] = useState(false);

  const toggleCollapse = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLayouting(true);

    void (async () => {
      const result = await layoutGraph(snapshot, collapsed);
      if (cancelled) {
        return;
      }

      onLayoutEngine?.(result.engine);

      const rfNodes: Node[] = result.nodes.map((n) => ({
        id: n.id,
        type: n.kind === 'Folder' ? 'folder' : 'file',
        position: n.position,
        data: {
          label: n.label,
          kind: n.kind,
          filePath: n.filePath,
          cycle: !!n.metadata?.cycle,
          collapsed: collapsed.has(n.id),
          onToggleCollapse: toggleCollapse,
        } satisfies ArchitectureNodeData,
        style: { width: n.width, height: n.height },
      }));

      const rfEdges: Edge[] = result.edges
        .filter((e) => e.kind !== 'contains')
        .map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          animated: e.kind === 'dynamicImport',
          className: [
            `cm-edge-${e.kind}`,
            e.metadata?.cycle ? 'cm-edge-cycle' : '',
          ]
            .filter(Boolean)
            .join(' '),
          label: e.kind === 'dynamicImport' ? 'dynamic' : undefined,
        }));

      // Contains edges as subtle dashed links
      const containsEdges: Edge[] = result.edges
        .filter((e) => e.kind === 'contains')
        .map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          className: 'cm-edge-contains',
          style: { strokeDasharray: '4 4', opacity: 0.35 },
        }));

      setNodes(rfNodes);
      setEdges([...rfEdges, ...containsEdges]);
      setLayouting(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [snapshot, collapsed, setNodes, setEdges, toggleCollapse, onLayoutEngine]);

  const onNodeDoubleClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      const data = node.data as ArchitectureNodeData;
      if (data.kind === 'Folder') {
        toggleCollapse(node.id);
        return;
      }
      if (data.filePath) {
        postToExtension({
          type: 'node:open',
          payload: { filePath: data.filePath },
        });
      }
    },
    [toggleCollapse],
  );

  const legend = useMemo(
    () => (
      <div className="cm-legend">
        <span className="cm-legend-item cm-legend-imports">imports</span>
        <span className="cm-legend-item cm-legend-dynamic">dynamicImport</span>
        <span className="cm-legend-item cm-legend-exports">exports</span>
        {layouting ? <span className="cm-legend-item">layout…</span> : null}
      </div>
    ),
    [layouting],
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
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.05}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} size={1} />
        <Controls showInteractive={false} />
        <MiniMap
          nodeColor={(n) => {
            if (n.type === 'folder') {
              return 'var(--cm-folder)';
            }
            return 'var(--cm-file)';
          }}
          maskColor="rgba(0,0,0,0.45)"
        />
      </ReactFlow>
    </div>
  );
}
