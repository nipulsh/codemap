import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { scanWorkspace } from '../scanner/workspaceScanner';
import { createParseSession } from '../parser/extractImports';
import { InMemoryDependencyIndex } from '../cache/dependencyIndex';
import { generateGraph } from '../graph/generator';
import { normalizePath, toPosix } from '../utils/path';
import { throwIfAborted, yieldToEventLoop } from '../utils/cancellation';
import { SourceTextCache } from './SourceTextCache';
import type {
  AnalysisLimitation,
  AnalysisTimings,
  CycleInfo,
  DependencyInfo,
  ModuleInfo,
  ProjectMetadata,
  SourceFileInfo,
  WorkspaceAnalysisOptions,
  WorkspaceAnalysisResult,
} from './types';
import type { GraphEdge, GraphNode } from '../../shared/graph';
import { RouteAnalyzer } from '../routes/RouteAnalyzer';
import {
  RouteGraphBuilder,
  mergeRouteGraphIntoSnapshot,
} from '../routes/RouteGraphBuilder';
import {
  CallChainAnalyzer,
  createCallChainContext,
} from '../routes/CallChainAnalyzer';
import { CallTraceGraphBuilder } from '../routes/CallTraceGraphBuilder';

const STATIC_LIMITATIONS: AnalysisLimitation[] = [
  {
    id: 'dynamic-dispatch',
    description:
      'Dynamic dispatch, reflection, and runtime-generated calls may not appear in the dependency graph.',
  },
  {
    id: 'dependency-injection',
    description:
      'Dependency injection and interface-based wiring can obscure concrete call targets.',
  },
  {
    id: 'dynamic-imports',
    description:
      'Dynamic imports are detected but their runtime targets may not always resolve.',
  },
  {
    id: 'single-hop-calls',
    description:
      'Function call relationships are not included in the eager analysis graph (lazy explorer only).',
  },
];

function readProjectMetadata(workspaceRoot: string): ProjectMetadata {
  const pkgPath = join(workspaceRoot, 'package.json');
  const metadata: ProjectMetadata = {
    dependencies: [],
    devDependencies: [],
    scripts: {},
    hasTypeScript: false,
    tsconfigPaths: [],
  };

  if (existsSync(pkgPath)) {
    try {
      const raw = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<
        string,
        unknown
      >;
      metadata.name = typeof raw.name === 'string' ? raw.name : undefined;
      metadata.version =
        typeof raw.version === 'string' ? raw.version : undefined;
      metadata.description =
        typeof raw.description === 'string' ? raw.description : undefined;
      metadata.main = typeof raw.main === 'string' ? raw.main : undefined;
      metadata.bin =
        typeof raw.bin === 'string' || typeof raw.bin === 'object'
          ? (raw.bin as ProjectMetadata['bin'])
          : undefined;
      metadata.scripts =
        typeof raw.scripts === 'object' && raw.scripts !== null
          ? (raw.scripts as Record<string, string>)
          : {};
      metadata.dependencies = Object.keys(
        (raw.dependencies as Record<string, string>) ?? {},
      ).sort();
      metadata.devDependencies = Object.keys(
        (raw.devDependencies as Record<string, string>) ?? {},
      ).sort();

      if (raw.engines && typeof raw.engines === 'object') {
        const engines = raw.engines as Record<string, string>;
        if (engines.vscode) {
          metadata.vscodeExtension = metadata.vscodeExtension ?? {};
        }
      }

      if (typeof raw.main === 'string' && raw.main.endsWith('.js')) {
        metadata.vscodeExtension = {
          ...metadata.vscodeExtension,
          main: raw.main,
        };
      }

      const contributes = raw.contributes as Record<string, unknown> | undefined;
      if (contributes) {
        metadata.vscodeExtension = metadata.vscodeExtension ?? {};
      }

      if (Array.isArray(raw.activationEvents)) {
        metadata.vscodeExtension = {
          ...metadata.vscodeExtension,
          activationEvents: raw.activationEvents as string[],
        };
      }
    } catch {
      // package.json unreadable — continue with defaults
    }
  }

  return metadata;
}

function buildModules(
  workspaceRoot: string,
  files: SourceFileInfo[],
): ModuleInfo[] {
  const byDir = new Map<string, string[]>();

  for (const file of files) {
    const dir = toPosix(dirname(file.relativePath));
    const key = dir === '.' ? '' : dir;
    if (!byDir.has(key)) {
      byDir.set(key, []);
    }
    byDir.get(key)!.push(file.relativePath);
  }

  const modules: ModuleInfo[] = [];
  for (const [path, dirFiles] of byDir) {
    dirFiles.sort();
    modules.push({
      path,
      name: path ? path.split('/').pop()! : '(root)',
      fileCount: dirFiles.length,
      files: dirFiles,
    });
  }

  modules.sort((a, b) => a.path.localeCompare(b.path));
  return modules;
}

function extractDependencies(
  workspaceRoot: string,
  graph: { nodes: GraphNode[]; edges: GraphEdge[] },
): DependencyInfo[] {
  const idToRel = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.kind === 'File' && node.filePath) {
      idToRel.set(
        node.id,
        toPosix(relative(workspaceRoot, normalizePath(node.filePath))),
      );
    }
  }

  const deps: DependencyInfo[] = [];
  for (const edge of graph.edges) {
    if (
      edge.kind !== 'imports' &&
      edge.kind !== 'dynamicImport' &&
      edge.kind !== 'exports'
    ) {
      continue;
    }
    const source = idToRel.get(edge.source);
    const target = idToRel.get(edge.target);
    if (!source || !target) {
      continue;
    }
    deps.push({ source, target, kind: edge.kind });
  }

  deps.sort((a, b) => {
    const cmp = a.source.localeCompare(b.source);
    return cmp !== 0 ? cmp : a.target.localeCompare(b.target);
  });
  return deps;
}

function extractCycles(
  workspaceRoot: string,
  graph: { nodes: GraphNode[]; edges: GraphEdge[] },
): CycleInfo[] {
  const cycleNodeIds = graph.nodes
    .filter((n) => n.metadata?.cycle === true)
    .map((n) => n.id);
  const cycleEdgeIds = graph.edges
    .filter((e) => e.metadata?.cycle === true)
    .map((e) => e.id);

  if (cycleNodeIds.length === 0) {
    return [];
  }

  const filePaths = graph.nodes
    .filter((n) => n.metadata?.cycle === true && n.filePath)
    .map((n) => toPosix(relative(workspaceRoot, normalizePath(n.filePath!))))
    .sort();

  return [
    {
      nodeIds: cycleNodeIds.sort(),
      edgeIds: cycleEdgeIds.sort(),
      filePaths,
    },
  ];
}

/** Default time slice before analyzeAsync() yields to the event loop. */
const ASYNC_YIELD_INTERVAL_MS = 12;

/**
 * Eager full-workspace analysis pipeline.
 * Reuses scanner, parser, dependency index, and graph generator.
 * Does not interact with ExplorerService or the webview.
 *
 * The pipeline is written once as a generator; analyze() drains it
 * synchronously (existing behaviour) while analyzeAsync() yields to the event
 * loop between units of work so progress UI stays responsive and an
 * AbortSignal can actually interrupt a long analysis.
 */
export class WorkspaceAnalysisService {
  analyze(
    workspaceRoot: string,
    options: WorkspaceAnalysisOptions = {},
  ): WorkspaceAnalysisResult {
    const iterator = this.pipeline(workspaceRoot, options);
    let step = iterator.next();
    while (!step.done) {
      step = iterator.next();
    }
    return step.value;
  }

  /**
   * Same pipeline and output as analyze(), but periodically yields to the
   * event loop. Cancellation via options.signal takes effect at the next
   * checkpoint (per parsed file, per route, per traced route, per stage).
   */
  async analyzeAsync(
    workspaceRoot: string,
    options: WorkspaceAnalysisOptions = {},
  ): Promise<WorkspaceAnalysisResult> {
    throwIfAborted(options.signal);
    const iterator = this.pipeline(workspaceRoot, options);
    let lastYield = performance.now();
    for (;;) {
      const step = iterator.next();
      if (step.done) {
        return step.value;
      }
      const now = performance.now();
      if (now - lastYield >= ASYNC_YIELD_INTERVAL_MS) {
        await yieldToEventLoop();
        lastYield = performance.now();
      }
    }
  }

  private *pipeline(
    workspaceRoot: string,
    options: WorkspaceAnalysisOptions,
  ): Generator<void, WorkspaceAnalysisResult, void> {
    const { onProgress, signal } = options;
    const startedAt = performance.now();
    const timings: AnalysisTimings = {
      scanMs: 0,
      parseMs: 0,
      indexMs: 0,
      graphBuildMs: 0,
      totalMs: 0,
    };

    throwIfAborted(signal);
    const metadata = readProjectMetadata(workspaceRoot);

    // One text cache per run: the scanner publishes the bytes it already read
    // for hashing, and the parser / route analyzer / call-chain tracer reuse
    // them instead of re-reading every file. Dropped when the pipeline ends.
    const textCache = new SourceTextCache(options.sourceTextCacheBytes);

    onProgress?.('Scanning workspace…', 0);
    const scanStart = performance.now();
    const scan = scanWorkspace(workspaceRoot, onProgress, {
      publishText: (absolutePath, text) => textCache.set(absolutePath, text),
    });
    timings.scanMs = performance.now() - scanStart;
    yield;
    throwIfAborted(signal);

    metadata.hasTypeScript = scan.tsconfigs.length > 0;
    metadata.tsconfigPaths = scan.tsconfigs
      .map((t) => toPosix(relative(workspaceRoot, t.configPath)))
      .sort();

    onProgress?.('Parsing source files…', 40);
    const parseStart = performance.now();
    const parseSession = createParseSession(scan.workspaceRoot, scan.tsconfigs);
    for (const file of scan.files) {
      throwIfAborted(signal);
      parseSession.parseOne({
        absolutePath: file.absolutePath,
        content: textCache.peek(file.absolutePath),
      });
      yield;
    }
    const parseResults = parseSession.finish();
    timings.parseMs = performance.now() - parseStart;
    yield;
    throwIfAborted(signal);

    const byPath = new Map(
      parseResults.map((r) => [normalizePath(r.filePath), r]),
    );

    const files: SourceFileInfo[] = [];
    let parseErrorCount = 0;

    for (const scanned of scan.files) {
      const parsed = byPath.get(normalizePath(scanned.absolutePath));
      if (parsed?.error) {
        parseErrorCount++;
      }
      files.push({
        absolutePath: scanned.absolutePath,
        relativePath: scanned.relativePath,
        contentHash: scanned.contentHash,
        mtimeMs: scanned.mtimeMs,
        imports: parsed?.imports ?? [],
        exports: parsed?.exports ?? [],
        symbols: parsed?.symbols ?? [],
        dependencyPaths: parsed?.dependencyPaths ?? [],
        dynamicImportPaths: parsed?.dynamicImportPaths ?? [],
        parseError: parsed?.error,
      });
    }

    files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

    onProgress?.('Building dependency index…', 70);
    const indexStart = performance.now();
    const index = new InMemoryDependencyIndex();
    for (const file of files) {
      index.set({
        absolutePath: file.absolutePath,
        relativePath: file.relativePath,
        contentHash: file.contentHash,
        mtimeMs: file.mtimeMs,
        imports: file.imports,
        exports: file.exports,
        dependencyPaths: file.dependencyPaths,
        dynamicImportPaths: file.dynamicImportPaths,
        parseError: file.parseError,
      });
    }
    timings.indexMs = performance.now() - indexStart;
    yield;
    throwIfAborted(signal);

    onProgress?.('Generating graph…', 85);
    const graphStart = performance.now();
    let graph = generateGraph({
      workspaceRoot: scan.workspaceRoot,
      files: index.all(),
    });
    timings.graphBuildMs = performance.now() - graphStart;
    yield;
    throwIfAborted(signal);

    const includeRoutes = options.includeRoutes !== false;
    let routes: WorkspaceAnalysisResult['routes'] = [];
    let routeExtraction: WorkspaceAnalysisResult['routeExtraction'] = {
      routes: [],
      errors: [],
    };
    let routeTraces: WorkspaceAnalysisResult['routeTraces'];

    if (includeRoutes) {
      onProgress?.('Extracting HTTP routes…', 92);
      const routeStart = performance.now();
      const routeAnalyzer = new RouteAnalyzer();
      routeExtraction = yield* routeAnalyzer.analyzeIncremental(files, {
        signal,
        textReader: textCache,
      });
      routes = routeExtraction.routes;

      const routeGraphBuilder = new RouteGraphBuilder();
      const routePatch = routeGraphBuilder.build(routes, files);
      graph = {
        ...graph,
        ...mergeRouteGraphIntoSnapshot(graph, routePatch),
      };
      timings.routeAnalysisMs = performance.now() - routeStart;
      yield;
      throwIfAborted(signal);

      if (options.includeCallChains) {
        onProgress?.('Tracing static call chains…', 96);
        const chainStart = performance.now();
        const ctx = createCallChainContext(
          scan.workspaceRoot,
          files,
          scan.tsconfigs,
          textCache,
        );
        const callChainAnalyzer = new CallChainAnalyzer();
        routeTraces = yield* callChainAnalyzer.analyzeRoutesIncremental(
          routes,
          ctx,
          {
            maxDepth: options.callChainMaxDepth,
            signal,
          },
        );

        const tracePatch = new CallTraceGraphBuilder().build(routeTraces);
        graph = {
          ...graph,
          ...mergeRouteGraphIntoSnapshot(graph, tracePatch),
        };
        timings.callChainAnalysisMs = performance.now() - chainStart;
        yield;
        throwIfAborted(signal);
      }
    }

    const modules = buildModules(scan.workspaceRoot, files);
    const dependencies = extractDependencies(scan.workspaceRoot, graph);
    const cycles = extractCycles(scan.workspaceRoot, graph);

    timings.totalMs = performance.now() - startedAt;
    onProgress?.('Analysis complete', 100);

    return {
      workspaceRoot: scan.workspaceRoot,
      metadata,
      files,
      modules,
      graph,
      dependencies,
      cycles,
      limitations: [...STATIC_LIMITATIONS],
      tsconfigs: scan.tsconfigs,
      parseErrorCount,
      analyzedAt: Date.now(),
      routes,
      routeExtraction,
      routeTraces,
      timings,
    };
  }
}
