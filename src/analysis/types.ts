import type { GraphSnapshot } from '../../shared/graph';
import type { ImportSpec, ExportSpec, SymbolInfo } from '../parser/types';
import type { TsConfigInfo } from '../scanner/types';
import type { RouteDefinition, RouteExtractionResult } from '../routes/types';
import type { StaticRouteTrace } from '../routes/types';

export interface ProjectMetadata {
  name?: string;
  version?: string;
  description?: string;
  main?: string;
  bin?: Record<string, string> | string;
  dependencies: string[];
  devDependencies: string[];
  scripts: Record<string, string>;
  hasTypeScript: boolean;
  tsconfigPaths: string[];
  vscodeExtension?: {
    main?: string;
    activationEvents?: string[];
  };
}

export interface SourceFileInfo {
  absolutePath: string;
  relativePath: string;
  contentHash: string;
  mtimeMs: number;
  imports: ImportSpec[];
  exports: ExportSpec[];
  symbols: SymbolInfo[];
  dependencyPaths: string[];
  dynamicImportPaths: string[];
  parseError?: string;
}

export interface ModuleInfo {
  /** Workspace-relative directory path (posix) */
  path: string;
  name: string;
  fileCount: number;
  files: string[];
}

export interface EntryPointInfo {
  /** Workspace-relative file path (posix) */
  path: string;
  reason: string;
  confidence: 'high' | 'medium' | 'low';
  signals: string[];
}

export interface DependencyInfo {
  source: string;
  target: string;
  kind: 'imports' | 'dynamicImport' | 'exports';
}

export interface CycleInfo {
  nodeIds: string[];
  edgeIds: string[];
  /** Workspace-relative file paths involved in cycles */
  filePaths: string[];
}

export interface AnalysisLimitation {
  id: string;
  description: string;
}

/**
 * Internal diagnostic timings (wall-clock milliseconds) for one analysis pass.
 * Intended for benchmarks and regression diagnosis, not for end users.
 */
export interface AnalysisTimings {
  scanMs: number;
  parseMs: number;
  indexMs: number;
  graphBuildMs: number;
  routeAnalysisMs?: number;
  callChainAnalysisMs?: number;
  totalMs: number;
}

/** Canonical output of an eager full-workspace analysis pass. */
export interface WorkspaceAnalysisResult {
  workspaceRoot: string;
  metadata: ProjectMetadata;
  files: SourceFileInfo[];
  modules: ModuleInfo[];
  graph: GraphSnapshot;
  dependencies: DependencyInfo[];
  cycles: CycleInfo[];
  limitations: AnalysisLimitation[];
  tsconfigs: TsConfigInfo[];
  parseErrorCount: number;
  analyzedAt: number;
  routes: RouteDefinition[];
  routeExtraction: RouteExtractionResult;
  routeTraces?: StaticRouteTrace[];
  timings: AnalysisTimings;
}

export interface WorkspaceAnalysisOptions {
  onProgress?: (message: string, percent?: number) => void;
  /** When true, extract HTTP routes (default: true). */
  includeRoutes?: boolean;
  /** When true, compute static call-chain traces for routes (default: false). */
  includeCallChains?: boolean;
  /** Max BFS depth for call-chain tracing (default: 8). */
  callChainMaxDepth?: number;
  /**
   * Cooperative cancellation. Checked between files/routes and between stages.
   * When aborted, analyze()/analyzeAsync() throw AnalysisCancelledError.
   */
  signal?: AbortSignal;
  /**
   * Byte budget for the per-run source text cache shared by scanner, parser,
   * route analyzer and call-chain tracer (default: 64 MiB). Files beyond the
   * budget are re-read from disk; results are unaffected.
   */
  sourceTextCacheBytes?: number;
}
