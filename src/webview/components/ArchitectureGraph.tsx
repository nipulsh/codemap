import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  applyEdgeChanges,
  applyNodeChanges,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { GraphSnapshot } from '../../../shared/graph';
import { layoutGraph } from '../layout/autoLayout';
import type { NodeSize } from '../layout/nodeSizes';
import { filterEdges, filterNodes, type EdgeFilter } from '../edgeFilter';
import { applySearchToNodes } from '../nodeSearch';
import { FileNode, FolderNode, type ArchitectureNodeData } from './Nodes';
import { postToExtension } from '../hooks/useExtensionMessages';

const nodeTypes: NodeTypes = {
  folder: FolderNode,
  file: FileNode,
};

interface Props {
  snapshot: GraphSnapshot;
  nodeSize: NodeSize;
  edgeFilter: EdgeFilter;
  searchQuery: string;
  onLayoutEngine?: (engine: string) => void;
}

function applyHoverToNodes(
  nodes: Node[],
  edges: Edge[],
  hoveredNodeId: string | null,
): Node[] {
  if (!hoveredNodeId) {
    return nodes;
  }

  const neighborIds = new Set<string>();
  for (const edge of edges) {
    if (edge.source === hoveredNodeId) {
      neighborIds.add(edge.target);
    } else if (edge.target === hoveredNodeId) {
      neighborIds.add(edge.source);
    }
  }

  return nodes.map((node) => {
    if (node.id === hoveredNodeId) {
      return { ...node, className: 'cm-hovered' };
    }
    if (neighborIds.has(node.id)) {
      return { ...node, className: 'cm-neighbor' };
    }
    return node;
  });
}

function applyHoverToEdges(edges: Edge[], hoveredNodeId: string | null): Edge[] {
  if (!hoveredNodeId) {
    return edges;
  }

  return edges.map((edge) => {
    if (edge.source !== hoveredNodeId && edge.target !== hoveredNodeId) {
      return edge;
    }
    const className = [edge.className, 'cm-edge-highlighted'].filter(Boolean).join(' ');
    return { ...edge, className };
  });
}

export function ArchitectureGraph({
  snapshot,
  nodeSize,
  edgeFilter,
  searchQuery,
  onLayoutEngine,
}: Props) {
  const [layoutNodes, setLayoutNodes] = useState<Node[]>([]);
  const [layoutEdges, setLayoutEdges] = useState<Edge[]>([]);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
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
      const result = await layoutGraph(snapshot, collapsed, nodeSize);
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
        }));

      setLayoutNodes(rfNodes);
      setLayoutEdges([...rfEdges, ...containsEdges]);
      setHoveredNodeId(null);
      setLayouting(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [snapshot, collapsed, nodeSize, toggleCollapse, onLayoutEngine]);

  const visibleEdges = useMemo(
    () => filterEdges(layoutEdges, edgeFilter),
    [layoutEdges, edgeFilter],
  );

  const visibleNodes = useMemo(
    () => filterNodes(layoutNodes, visibleEdges, edgeFilter),
    [layoutNodes, visibleEdges, edgeFilter],
  );

  const hoveredNodes = useMemo(
    () => applyHoverToNodes(visibleNodes, visibleEdges, hoveredNodeId),
    [visibleNodes, visibleEdges, hoveredNodeId],
  );

  const nodes = useMemo(
    () => applySearchToNodes(hoveredNodes, searchQuery),
    [hoveredNodes, searchQuery],
  );

  const edges = useMemo(
    () => applyHoverToEdges(visibleEdges, hoveredNodeId),
    [visibleEdges, hoveredNodeId],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<Node>[]) => {
      setLayoutNodes((current) => applyNodeChanges(changes, current));
    },
    [],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) => {
      setLayoutEdges((current) => applyEdgeChanges(changes, current));
    },
    [],
  );

  const onNodeMouseEnter = useCallback((_: React.MouseEvent, node: Node) => {
    setHoveredNodeId(node.id);
  }, []);

  const onNodeMouseLeave = useCallback(() => {
    setHoveredNodeId(null);
  }, []);

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
        <span className="cm-legend-item cm-legend-folder">folder</span>
        <span className="cm-legend-item cm-legend-file">file</span>
        <span className="cm-legend-separator" aria-hidden="true" />
        <span className="cm-legend-item cm-legend-imports">imports</span>
        <span className="cm-legend-item cm-legend-dynamic">dynamicImport</span>
        <span className="cm-legend-item cm-legend-exports">exports</span>
        <span className="cm-legend-item cm-legend-contains">contains</span>
        <span className="cm-legend-item cm-legend-cycle">cycle</span>
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
        onNodeMouseEnter={onNodeMouseEnter}
        onNodeMouseLeave={onNodeMouseLeave}
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
