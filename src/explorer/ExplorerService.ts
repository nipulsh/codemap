import type {
  GraphEdge,
  GraphNode,
  GraphPatch,
  GraphSnapshot,
  NodeKind,
} from '../../shared/graph';
import { FolderCache } from '../cache/folderCache';
import { FileCache } from '../cache/fileCache';
import { FunctionCache } from '../cache/functionCache';
import {
  listDirectory,
  findNearestTsConfig,
  workspaceLabel,
} from '../scanner/listDirectory';
import type { TsConfigInfo } from '../scanner/types';
import type { WorkerPool } from '../parser/workerPool';
import { isSourceFile } from '../scanner/ignore';
import { contentHash, fileMtimeMs } from '../utils/hash';
import { normalizePath, toPosix } from '../utils/path';
import { basename, relative } from 'node:path';
import {
  applyPatchToMaps,
  fileNodeId,
  folderNodeId,
  makeEdge,
  makeNode,
  symbolNodeId,
  workspaceNodeId,
} from '../graph/incremental';
import { BackgroundPrefetch } from './prefetch';
import type { SymbolInfo } from '../parser/types';

export type ExplorerEmit = {
  full?: GraphSnapshot;
  patch?: GraphPatch;
  progress?: { message: string; percent?: number };
  error?: { message: string; scope: string };
};

/**
 * Orchestrates lazy folder/file/function expansion with multi-layer caches.
 */
export class ExplorerService {
  private readonly folderCache = new FolderCache();
  private readonly fileCache = new FileCache();
  private readonly functionCache = new FunctionCache();

  private readonly nodeMap = new Map<string, GraphNode>();
  private readonly edgeMap = new Map<string, GraphEdge>();
  private readonly expandedFolders = new Set<string>();
  private readonly expandedFiles = new Set<string>();
  private readonly expandedFunctions = new Set<string>();
  /** Children created under a parent (for collapse). */
  private readonly childrenOf = new Map<string, Set<string>>();

  private tsconfigs: TsConfigInfo[] = [];
  private prefetch: BackgroundPrefetch | undefined;
  private workspaceRoot = '';

  constructor(
    private readonly pool: WorkerPool,
    private readonly emit: (msg: ExplorerEmit) => void,
  ) {}

  async bootstrap(workspaceRoot: string): Promise<void> {
    this.clearState();
    this.workspaceRoot = normalizePath(workspaceRoot);
    this.prefetch = new BackgroundPrefetch(
      this.pool,
      this.fileCache,
      () => this.tsconfigs,
      this.workspaceRoot,
    );

    this.emit({
      progress: { message: 'Loading workspace…', percent: 10 },
    });

    const listing = listDirectory(this.workspaceRoot, this.workspaceRoot);
    this.folderCache.set(listing);
    this.mergeTsconfigs(listing.tsconfigs);

    const rootId = workspaceNodeId(this.workspaceRoot);
    const nodes: GraphNode[] = [
      makeNode(rootId, 'Workspace', workspaceLabel(this.workspaceRoot), {
        filePath: this.workspaceRoot,
        metadata: { expanded: true },
      }),
    ];
    const edges: GraphEdge[] = [];

    for (const folder of listing.folders) {
      const id = folderNodeId(folder.absolutePath);
      nodes.push(
        makeNode(id, 'Folder', folder.name, {
          filePath: folder.absolutePath,
          metadata: { expanded: false, relativePath: folder.relativePath },
        }),
      );
      edges.push(makeEdge('hierarchy', rootId, id));
      this.trackChild(rootId, id);
    }

    for (const file of listing.files) {
      const id = fileNodeId(file.absolutePath);
      nodes.push(
        makeNode(id, 'File', basename(file.absolutePath), {
          filePath: file.absolutePath,
          metadata: {
            expanded: false,
            relativePath: file.relativePath,
            parseable: isSourceFile(basename(file.absolutePath)),
          },
        }),
      );
      edges.push(makeEdge('hierarchy', rootId, id));
      this.trackChild(rootId, id);
    }

    for (const n of nodes) {
      this.nodeMap.set(n.id, n);
    }
    for (const e of edges) {
      this.edgeMap.set(e.id, e);
    }
    this.expandedFolders.add(this.workspaceRoot);

    this.emit({
      full: {
        nodes,
        edges,
        generatedAt: Date.now(),
        workspaceRoot: toPosix(this.workspaceRoot),
      },
    });
  }

  async refresh(): Promise<void> {
    const root = this.workspaceRoot;
    if (!root) {
      return;
    }
    const expandedFolders = [...this.expandedFolders];
    const expandedFiles = [...this.expandedFiles];
    const expandedFunctions = [...this.expandedFunctions];

    this.folderCache.clear();
    this.fileCache.clear();
    this.functionCache.clear();

    await this.bootstrap(root);

    for (const folder of expandedFolders) {
      if (folder !== root) {
        await this.expandFolder(folder);
      }
    }
    for (const file of expandedFiles) {
      await this.expandFile(file);
    }
    for (const fnId of expandedFunctions) {
      await this.expandFunction(fnId);
    }
  }

  async expandFolder(path: string): Promise<void> {
    const dir = normalizePath(path);
    const parentId =
      dir === this.workspaceRoot
        ? workspaceNodeId(this.workspaceRoot)
        : folderNodeId(dir);

    if (this.expandedFolders.has(dir) && this.childrenOf.has(parentId)) {
      // Already expanded — mark node metadata
      const node = this.nodeMap.get(parentId);
      if (node) {
        this.patch({
          upsertNodes: [
            {
              ...node,
              metadata: { ...node.metadata, expanded: true },
            },
          ],
        });
      }
      return;
    }

    let listing = this.folderCache.get(dir);
    if (!listing) {
      listing = listDirectory(dir, this.workspaceRoot);
      this.folderCache.set(listing);
      this.mergeTsconfigs(listing.tsconfigs);
    }

    const upsertNodes: GraphNode[] = [];
    const upsertEdges: GraphEdge[] = [];

    const parent = this.nodeMap.get(parentId);
    if (parent) {
      upsertNodes.push({
        ...parent,
        metadata: { ...parent.metadata, expanded: true },
      });
    }

    for (const folder of listing.folders) {
      const id = folderNodeId(folder.absolutePath);
      if (!this.nodeMap.has(id)) {
        upsertNodes.push(
          makeNode(id, 'Folder', folder.name, {
            filePath: folder.absolutePath,
            metadata: {
              expanded: false,
              relativePath: folder.relativePath,
            },
          }),
        );
      }
      upsertEdges.push(makeEdge('hierarchy', parentId, id));
      this.trackChild(parentId, id);
    }

    for (const file of listing.files) {
      const id = fileNodeId(file.absolutePath);
      if (!this.nodeMap.has(id)) {
        upsertNodes.push(
          makeNode(id, 'File', basename(file.absolutePath), {
            filePath: file.absolutePath,
            metadata: {
              expanded: false,
              relativePath: file.relativePath,
              parseable: isSourceFile(basename(file.absolutePath)),
              lazy: false,
            },
          }),
        );
      }
      upsertEdges.push(makeEdge('hierarchy', parentId, id));
      this.trackChild(parentId, id);
    }

    this.expandedFolders.add(dir);
    this.patch({ upsertNodes, upsertEdges });

    // Background prefetch source files
    this.prefetch?.enqueueFiles(listing.files.map((f) => f.absolutePath));
  }

  async collapseFolder(path: string): Promise<void> {
    const dir = normalizePath(path);
    if (dir === this.workspaceRoot) {
      return;
    }
    const parentId = folderNodeId(dir);
    const removeNodeIds: string[] = [];
    const removeEdgeIds: string[] = [];

    this.collectDescendants(parentId, removeNodeIds, removeEdgeIds, false);

    this.expandedFolders.delete(dir);
    for (const id of removeNodeIds) {
      const node = this.nodeMap.get(id);
      if (node?.kind === 'Folder' && node.filePath) {
        this.expandedFolders.delete(normalizePath(node.filePath));
      }
      if (node?.kind === 'File' && node.filePath) {
        this.expandedFiles.delete(normalizePath(node.filePath));
      }
      if (
        node &&
        (node.kind === 'Function' ||
          node.kind === 'Class' ||
          node.kind === 'Interface' ||
          node.kind === 'Enum' ||
          node.kind === 'Component')
      ) {
        this.expandedFunctions.delete(id);
      }
    }

    const parent = this.nodeMap.get(parentId);
    const upsertNodes: GraphNode[] = parent
      ? [{ ...parent, metadata: { ...parent.metadata, expanded: false } }]
      : [];

    this.patch({ removeNodeIds, removeEdgeIds, upsertNodes });
  }

  async expandFile(path: string): Promise<void> {
    const filePath = normalizePath(path);
    if (!isSourceFile(basename(filePath))) {
      // Non-source: nothing to expand
      return;
    }

    const fid = fileNodeId(filePath);
    this.emit({
      progress: { message: `Parsing ${basename(filePath)}…` },
    });

    const parsed = await this.ensureParsed(filePath);
    const upsertNodes: GraphNode[] = [];
    const upsertEdges: GraphEdge[] = [];
    const removeEdgeIds: string[] = [];

    const fileNode = this.nodeMap.get(fid) ??
      makeNode(fid, 'File', basename(filePath), {
        filePath,
        metadata: { relativePath: toPosix(relative(this.workspaceRoot, filePath)) },
      });

    upsertNodes.push({
      ...fileNode,
      metadata: {
        ...fileNode.metadata,
        expanded: true,
        exportNames: parsed.exports.map((e) => e.name),
        importCount: parsed.imports.length,
        parseError: parsed.parseError,
        lazy: false,
      },
    });

    // Ensure file is attached to hierarchy if it was a stub
    if (!this.nodeMap.has(fid)) {
      const parentDir = filePath.includes('/')
        ? filePath.slice(0, filePath.lastIndexOf('/'))
        : this.workspaceRoot;
      const parentId =
        parentDir === this.workspaceRoot
          ? workspaceNodeId(this.workspaceRoot)
          : this.nodeMap.has(folderNodeId(parentDir))
            ? folderNodeId(parentDir)
            : workspaceNodeId(this.workspaceRoot);
      upsertEdges.push(makeEdge('hierarchy', parentId, fid));
      this.trackChild(parentId, fid);
    }

    for (const sym of parsed.symbols) {
      const sid = symbolNodeId(filePath, sym.name, sym.kind as NodeKind);
      if (!this.nodeMap.has(sid)) {
        upsertNodes.push(
          makeNode(sid, sym.kind as NodeKind, formatSymbolLabel(sym), {
            filePath,
            line: sym.line,
            metadata: {
              expanded: false,
              symbolName: sym.name,
              exported: sym.exported,
            },
          }),
        );
      }
      upsertEdges.push(makeEdge('contains', fid, sid));
      this.trackChild(fid, sid);
    }

    // Import edges to file nodes (stubs if not present)
    for (const dep of parsed.dependencyPaths) {
      const tid = fileNodeId(dep);
      if (!this.nodeMap.has(tid) && !upsertNodes.some((n) => n.id === tid)) {
        upsertNodes.push(
          makeNode(tid, 'File', basename(dep), {
            filePath: dep,
            metadata: {
              expanded: false,
              lazy: true,
              relativePath: toPosix(relative(this.workspaceRoot, dep)),
            },
          }),
        );
      }
      upsertEdges.push(makeEdge('imports', fid, tid));
    }

    for (const dep of parsed.dynamicImportPaths) {
      const tid = fileNodeId(dep);
      if (!this.nodeMap.has(tid) && !upsertNodes.some((n) => n.id === tid)) {
        upsertNodes.push(
          makeNode(tid, 'File', basename(dep), {
            filePath: dep,
            metadata: {
              expanded: false,
              lazy: true,
              relativePath: toPosix(relative(this.workspaceRoot, dep)),
            },
          }),
        );
      }
      upsertEdges.push(makeEdge('dynamicImport', fid, tid));
    }

    // Rewire call edges that targeted this file stub to concrete symbols
    const rewire = this.rewireCallsToFile(filePath, parsed.symbols);
    removeEdgeIds.push(...rewire.removeEdgeIds);
    upsertEdges.push(...rewire.upsertEdges);
    upsertNodes.push(...rewire.upsertNodes);

    this.expandedFiles.add(filePath);
    this.patch({ upsertNodes, upsertEdges, removeEdgeIds });
    this.emit({ progress: { message: '', percent: 100 } });
  }

  async collapseFile(path: string): Promise<void> {
    const filePath = normalizePath(path);
    const fid = fileNodeId(filePath);
    const removeNodeIds: string[] = [];
    const removeEdgeIds: string[] = [];

    this.collectDescendants(fid, removeNodeIds, removeEdgeIds, false);

    this.expandedFiles.delete(filePath);
    for (const id of removeNodeIds) {
      this.expandedFunctions.delete(id);
    }

    // Also remove import edges from this file (keep stub targets)
    for (const [eid, e] of this.edgeMap) {
      if (
        e.source === fid &&
        (e.kind === 'imports' || e.kind === 'dynamicImport' || e.kind === 'contains')
      ) {
        removeEdgeIds.push(eid);
      }
    }

    const fileNode = this.nodeMap.get(fid);
    const upsertNodes: GraphNode[] = fileNode
      ? [
          {
            ...fileNode,
            metadata: { ...fileNode.metadata, expanded: false },
          },
        ]
      : [];

    this.patch({ removeNodeIds, removeEdgeIds, upsertNodes });
  }

  async expandFunction(nodeId: string): Promise<void> {
    const node = this.nodeMap.get(nodeId);
    if (!node || !node.filePath) {
      return;
    }

    const filePath = normalizePath(node.filePath);
    const functionName =
      (node.metadata?.symbolName as string | undefined) ?? node.label.replace(/\(\)$/, '');

    this.emit({
      progress: { message: `Resolving calls in ${functionName}…` },
    });

    let cached = this.functionCache.get(nodeId);
    if (!cached) {
      await this.ensureTsconfigFor(filePath);
      const result = await this.pool.resolveCalls({
        workspaceRoot: this.workspaceRoot,
        filePath,
        functionName,
        tsconfigs: this.tsconfigs,
      });
      cached = {
        nodeId,
        filePath,
        functionName,
        callees: result.callees,
      };
      this.functionCache.set(cached);
    }

    const upsertNodes: GraphNode[] = [
      {
        ...node,
        metadata: { ...node.metadata, expanded: true },
      },
    ];
    const upsertEdges: GraphEdge[] = [];

    for (const callee of cached.callees) {
      if (callee.local) {
        // Find local symbol node
        const localSym = this.findLocalSymbolNode(filePath, callee.name);
        if (localSym) {
          upsertEdges.push(
            makeEdge('calls', nodeId, localSym, {
              calleeName: callee.name,
              async: callee.async,
            }),
          );
          this.trackChild(nodeId, localSym);
        }
        continue;
      }

      if (callee.targetFile) {
        const targetPath = normalizePath(callee.targetFile);
        const targetExpanded = this.expandedFiles.has(targetPath);
        const targetSymId = this.findSymbolInFile(targetPath, callee.name);

        if (targetExpanded && targetSymId) {
          upsertEdges.push(
            makeEdge('calls', nodeId, targetSymId, {
              calleeName: callee.name,
              async: callee.async,
            }),
          );
          this.trackChild(nodeId, targetSymId);
        } else {
          // Point at file stub
          const tid = fileNodeId(targetPath);
          if (!this.nodeMap.has(tid) && !upsertNodes.some((n) => n.id === tid)) {
            upsertNodes.push(
              makeNode(tid, 'File', basename(targetPath), {
                filePath: targetPath,
                metadata: {
                  expanded: false,
                  lazy: true,
                  collapsedTarget: true,
                  relativePath: toPosix(
                    relative(this.workspaceRoot, targetPath),
                  ),
                },
              }),
            );
          }
          upsertEdges.push(
            makeEdge('calls', nodeId, tid, {
              calleeName: callee.name,
              async: callee.async,
              collapsedTarget: true,
            }),
          );
          this.trackChild(nodeId, tid);
        }
      } else {
        // Unresolved external — create a lightweight function stub under same file? skip
      }
    }

    this.expandedFunctions.add(nodeId);
    this.patch({ upsertNodes, upsertEdges });
    this.emit({ progress: { message: '' } });
  }

  async collapseFunction(nodeId: string): Promise<void> {
    const removeEdgeIds: string[] = [];
    for (const [eid, e] of this.edgeMap) {
      if (e.kind === 'calls' && e.source === nodeId) {
        removeEdgeIds.push(eid);
      }
    }
    this.expandedFunctions.delete(nodeId);
    const node = this.nodeMap.get(nodeId);
    const upsertNodes: GraphNode[] = node
      ? [{ ...node, metadata: { ...node.metadata, expanded: false } }]
      : [];
    this.patch({ removeEdgeIds, upsertNodes });
  }

  /** Invalidate caches for a changed file; re-expand if needed. */
  async onFileChanged(filePath: string): Promise<void> {
    const path = normalizePath(filePath);
    this.fileCache.invalidate(path);
    this.functionCache.invalidateFile(path);

    if (this.expandedFiles.has(path)) {
      // Remove symbol children and re-expand
      await this.collapseFile(path);
      await this.expandFile(path);
    }
  }

  async onDirectoryChanged(dirPath: string): Promise<void> {
    const dir = normalizePath(dirPath);
    this.folderCache.invalidate(dir);
    if (this.expandedFolders.has(dir)) {
      const parentId =
        dir === this.workspaceRoot
          ? workspaceNodeId(this.workspaceRoot)
          : folderNodeId(dir);

      // Remove current children and re-expand
      const removeNodeIds: string[] = [];
      const removeEdgeIds: string[] = [];
      this.collectDescendants(parentId, removeNodeIds, removeEdgeIds, false);
      this.expandedFolders.delete(dir);
      this.patch({ removeNodeIds, removeEdgeIds });
      await this.expandFolder(dir);
    }
  }

  dispose(): void {
    this.prefetch?.cancel();
    this.clearState();
  }

  // ─── internals ─────────────────────────────────────────────

  private clearState(): void {
    this.nodeMap.clear();
    this.edgeMap.clear();
    this.expandedFolders.clear();
    this.expandedFiles.clear();
    this.expandedFunctions.clear();
    this.childrenOf.clear();
    this.folderCache.clear();
    this.fileCache.clear();
    this.functionCache.clear();
    this.tsconfigs = [];
    this.prefetch?.cancel();
    this.prefetch = undefined;
  }

  private patch(partial: Partial<GraphPatch>): void {
    const patch: GraphPatch = {
      upsertNodes: partial.upsertNodes ?? [],
      removeNodeIds: partial.removeNodeIds ?? [],
      upsertEdges: partial.upsertEdges ?? [],
      removeEdgeIds: partial.removeEdgeIds ?? [],
    };
    applyPatchToMaps(this.nodeMap, this.edgeMap, patch);
    // Clean childrenOf for removed nodes
    for (const id of patch.removeNodeIds ?? []) {
      this.childrenOf.delete(id);
      for (const [, kids] of this.childrenOf) {
        kids.delete(id);
      }
    }
    this.emit({ patch });
  }

  private trackChild(parentId: string, childId: string): void {
    if (!this.childrenOf.has(parentId)) {
      this.childrenOf.set(parentId, new Set());
    }
    this.childrenOf.get(parentId)!.add(childId);
  }

  private collectDescendants(
    parentId: string,
    removeNodeIds: string[],
    removeEdgeIds: string[],
    includeParent: boolean,
  ): void {
    const kids = this.childrenOf.get(parentId);
    if (!kids) {
      if (includeParent) {
        removeNodeIds.push(parentId);
      }
      return;
    }

    for (const childId of [...kids]) {
      this.collectDescendants(childId, removeNodeIds, removeEdgeIds, true);
      removeNodeIds.push(childId);
    }
    this.childrenOf.delete(parentId);

    for (const [eid, e] of this.edgeMap) {
      if (e.source === parentId || removeNodeIds.includes(e.target) || removeNodeIds.includes(e.source)) {
        if (e.source === parentId || removeNodeIds.includes(e.source) || removeNodeIds.includes(e.target)) {
          removeEdgeIds.push(eid);
        }
      }
    }

    if (includeParent) {
      removeNodeIds.push(parentId);
    }
  }

  private mergeTsconfigs(configs: TsConfigInfo[]): void {
    for (const c of configs) {
      if (!this.tsconfigs.some((t) => t.configPath === c.configPath)) {
        this.tsconfigs.push(c);
      }
    }
  }

  private async ensureTsconfigFor(filePath: string): Promise<void> {
    if (this.tsconfigs.length > 0) {
      // Still try nearest if none covers
      const nearest = findNearestTsConfig(filePath);
      if (nearest) {
        this.mergeTsconfigs([nearest]);
      }
      return;
    }
    const nearest = findNearestTsConfig(filePath);
    if (nearest) {
      this.mergeTsconfigs([nearest]);
    }
  }

  private async ensureParsed(filePath: string) {
    const path = normalizePath(filePath);
    let hash: string;
    let mtime: number;
    try {
      hash = contentHash(path);
      mtime = fileMtimeMs(path);
    } catch (err) {
      throw err;
    }

    const fresh = this.fileCache.getIfFresh(path, hash);
    if (fresh) {
      return fresh;
    }

    await this.ensureTsconfigFor(path);
    const result = await this.pool.parseFile({
      workspaceRoot: this.workspaceRoot,
      file: { absolutePath: path },
      tsconfigs: this.tsconfigs,
    });

    const cached = {
      absolutePath: path,
      relativePath: toPosix(relative(this.workspaceRoot, path)),
      contentHash: hash,
      mtimeMs: mtime,
      imports: result.imports,
      exports: result.exports,
      symbols: result.symbols ?? [],
      dependencyPaths: result.dependencyPaths,
      dynamicImportPaths: result.dynamicImportPaths,
      parseError: result.error,
    };
    this.fileCache.set(cached);
    return cached;
  }

  private findLocalSymbolNode(filePath: string, name: string): string | undefined {
    for (const kind of [
      'Function',
      'Component',
      'Class',
      'Interface',
      'Enum',
    ] as NodeKind[]) {
      const id = symbolNodeId(filePath, name, kind);
      if (this.nodeMap.has(id)) {
        return id;
      }
    }
    // Method-style names
    const simple = name.includes('.') ? name.split('.').pop()! : name;
    if (simple !== name) {
      return this.findLocalSymbolNode(filePath, simple);
    }
    return undefined;
  }

  private findSymbolInFile(filePath: string, name: string): string | undefined {
    return this.findLocalSymbolNode(filePath, name);
  }

  private rewireCallsToFile(
    filePath: string,
    symbols: SymbolInfo[],
  ): {
    removeEdgeIds: string[];
    upsertEdges: GraphEdge[];
    upsertNodes: GraphNode[];
  } {
    const fileStubId = fileNodeId(filePath);
    const removeEdgeIds: string[] = [];
    const upsertEdges: GraphEdge[] = [];
    const upsertNodes: GraphNode[] = [];
    const symbolByName = new Map(symbols.map((s) => [s.name, s]));

    for (const [eid, e] of this.edgeMap) {
      if (e.kind !== 'calls' || e.target !== fileStubId) {
        continue;
      }
      const calleeName = e.metadata?.calleeName as string | undefined;
      if (!calleeName) {
        continue;
      }
      const sym = symbolByName.get(calleeName);
      if (!sym) {
        continue;
      }
      const sid = symbolNodeId(filePath, sym.name, sym.kind as NodeKind);
      if (!this.nodeMap.has(sid) && !upsertNodes.some((n) => n.id === sid)) {
        // Will be added by expandFile symbol loop; ensure exists
        upsertNodes.push(
          makeNode(sid, sym.kind as NodeKind, formatSymbolLabel(sym), {
            filePath,
            line: sym.line,
            metadata: {
              expanded: false,
              symbolName: sym.name,
              exported: sym.exported,
            },
          }),
        );
      }
      removeEdgeIds.push(eid);
      const newEdge = makeEdge('calls', e.source, sid, {
        ...e.metadata,
        calleeName,
        rewired: true,
      });
      // Avoid duplicate edge ids colliding — remove old first
      upsertEdges.push(newEdge);
    }

    return { removeEdgeIds, upsertEdges, upsertNodes };
  }
}

function formatSymbolLabel(sym: SymbolInfo): string {
  if (sym.kind === 'Function' || sym.kind === 'Component') {
    return `${sym.name}()`;
  }
  return sym.name;
}
