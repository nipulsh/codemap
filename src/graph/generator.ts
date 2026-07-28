import type { GraphEdge, GraphNode, GraphSnapshot } from '../../shared/graph';
import type { IndexedFile } from '../cache/dependencyIndex';
import { normalizePath, toPosix } from '../utils/path';
import { dirname, basename } from 'node:path';

function fileNodeId(absolutePath: string): string {
  return `file:${normalizePath(absolutePath)}`;
}

function folderNodeId(absolutePath: string): string {
  return `folder:${normalizePath(absolutePath)}`;
}

function edgeId(kind: string, source: string, target: string): string {
  return `${kind}:${source}->${target}`;
}

/**
 * Detect strongly connected components / simple cycles via DFS coloring.
 * Marks nodes and edges that participate in at least one cycle.
 */
export function detectCycles(
  nodes: GraphNode[],
  edges: GraphEdge[],
): { cycleNodeIds: Set<string>; cycleEdgeIds: Set<string> } {
  const fileNodes = new Set(
    nodes.filter((n) => n.kind === 'File').map((n) => n.id),
  );
  const adj = new Map<string, Array<{ to: string; edgeId: string }>>();

  for (const e of edges) {
    if (
      (e.kind === 'imports' || e.kind === 'dynamicImport') &&
      fileNodes.has(e.source) &&
      fileNodes.has(e.target)
    ) {
      if (!adj.has(e.source)) {
        adj.set(e.source, []);
      }
      adj.get(e.source)!.push({ to: e.target, edgeId: e.id });
    }
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const cycleNodeIds = new Set<string>();
  const cycleEdgeIds = new Set<string>();
  const stack: string[] = [];

  for (const id of fileNodes) {
    color.set(id, WHITE);
  }

  function dfs(u: string): void {
    color.set(u, GRAY);
    stack.push(u);

    for (const { to, edgeId: eid } of adj.get(u) ?? []) {
      const c = color.get(to) ?? WHITE;
      if (c === GRAY) {
        // Back edge — mark cycle from to..u
        cycleEdgeIds.add(eid);
        let i = stack.lastIndexOf(to);
        if (i >= 0) {
          for (let j = i; j < stack.length; j++) {
            cycleNodeIds.add(stack[j]);
          }
          // Mark edges along the cycle
          for (let j = i; j < stack.length - 1; j++) {
            const from = stack[j];
            const next = stack[j + 1];
            for (const edge of adj.get(from) ?? []) {
              if (edge.to === next) {
                cycleEdgeIds.add(edge.edgeId);
              }
            }
          }
        }
      } else if (c === WHITE) {
        dfs(to);
      }
    }

    stack.pop();
    color.set(u, BLACK);
  }

  for (const id of fileNodes) {
    if (color.get(id) === WHITE) {
      dfs(id);
    }
  }

  return { cycleNodeIds, cycleEdgeIds };
}

function ensureFolderChain(
  workspaceRoot: string,
  fileAbsPath: string,
  nodeMap: Map<string, GraphNode>,
  edgeMap: Map<string, GraphEdge>,
): string {
  const root = normalizePath(workspaceRoot);
  const fileDir = normalizePath(dirname(fileAbsPath));

  // Build list of folder absolute paths from root down to fileDir
  let current = fileDir;
  const folders: string[] = [];
  while (
    (current === root || current.startsWith(root + '/')) &&
    current !== root
  ) {
    folders.unshift(current);
    const parent = normalizePath(dirname(current));
    if (parent === current) {
      break;
    }
    current = parent;
  }

  // Ensure workspace root folder exists
  const rootId = folderNodeId(root);
  if (!nodeMap.has(rootId)) {
    nodeMap.set(rootId, {
      id: rootId,
      kind: 'Folder',
      label: basename(root) || root,
      filePath: root,
      metadata: { collapsed: false },
    });
  }

  let parentId = rootId;
  for (const folder of folders) {
    const id = folderNodeId(folder);
    if (!nodeMap.has(id)) {
      nodeMap.set(id, {
        id,
        kind: 'Folder',
        label: basename(folder),
        filePath: folder,
        metadata: { collapsed: false },
      });
    }
    const cid = edgeId('contains', parentId, id);
    if (!edgeMap.has(cid)) {
      edgeMap.set(cid, {
        id: cid,
        kind: 'contains',
        source: parentId,
        target: id,
      });
    }
    parentId = id;
  }

  return parentId;
}

export interface GenerateGraphOptions {
  workspaceRoot: string;
  files: IndexedFile[];
}

/**
 * Build a GraphSnapshot from the dependency index.
 * Emits Folder/File nodes and contains/imports/exports/dynamicImport edges.
 */
export function generateGraph(options: GenerateGraphOptions): GraphSnapshot {
  const { workspaceRoot, files } = options;
  const root = normalizePath(workspaceRoot);
  const nodeMap = new Map<string, GraphNode>();
  const edgeMap = new Map<string, GraphEdge>();

  const pathSet = new Set(files.map((f) => f.absolutePath));

  for (const file of files) {
    const parentFolderId = ensureFolderChain(
      root,
      file.absolutePath,
      nodeMap,
      edgeMap,
    );

    const fid = fileNodeId(file.absolutePath);
    nodeMap.set(fid, {
      id: fid,
      kind: 'File',
      label: basename(file.absolutePath),
      filePath: file.absolutePath,
      metadata: {
        relativePath: file.relativePath,
        exportNames: file.exports.map((e) => e.name),
        importCount: file.imports.length,
        parseError: file.parseError,
      },
    });

    const containsId = edgeId('contains', parentFolderId, fid);
    edgeMap.set(containsId, {
      id: containsId,
      kind: 'contains',
      source: parentFolderId,
      target: fid,
    });

    // Static import edges (after barrel resolution)
    for (const dep of file.dependencyPaths) {
      if (!pathSet.has(dep)) {
        continue;
      }
      const tid = fileNodeId(dep);
      const eid = edgeId('imports', fid, tid);
      edgeMap.set(eid, {
        id: eid,
        kind: 'imports',
        source: fid,
        target: tid,
      });
    }

    // Dynamic import edges
    for (const dep of file.dynamicImportPaths) {
      if (!pathSet.has(dep)) {
        continue;
      }
      const tid = fileNodeId(dep);
      const eid = edgeId('dynamicImport', fid, tid);
      edgeMap.set(eid, {
        id: eid,
        kind: 'dynamicImport',
        source: fid,
        target: tid,
      });
    }

    // Export edges: file → re-export source (shows re-export relationship)
    for (const exp of file.exports) {
      if (exp.isReExport && exp.fromPath && pathSet.has(exp.fromPath)) {
        const tid = fileNodeId(exp.fromPath);
        const eid = edgeId('exports', fid, tid);
        if (!edgeMap.has(eid)) {
          edgeMap.set(eid, {
            id: eid,
            kind: 'exports',
            source: fid,
            target: tid,
            metadata: { exportName: exp.name },
          });
        }
      }
    }
  }

  let nodes = [...nodeMap.values()];
  let edges = [...edgeMap.values()];

  const { cycleNodeIds, cycleEdgeIds } = detectCycles(nodes, edges);

  nodes = nodes.map((n) =>
    cycleNodeIds.has(n.id)
      ? { ...n, metadata: { ...n.metadata, cycle: true } }
      : n,
  );
  edges = edges.map((e) =>
    cycleEdgeIds.has(e.id)
      ? { ...e, metadata: { ...e.metadata, cycle: true } }
      : e,
  );

  return {
    nodes,
    edges,
    generatedAt: Date.now(),
    workspaceRoot: toPosix(root),
  };
}
