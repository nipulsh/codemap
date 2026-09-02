/**
 * Benchmark: RouteAnalyzer.analyze() on synthetic Express workspaces.
 *
 * Scenarios scale the number of routes (tens → thousands) for both simple
 * app-level registrations and mounted/nested routers. The workspace is analysed
 * once (scan + parse) so the reported time isolates route extraction itself.
 *
 * Run: npx tsx --expose-gc tests/performance/route-analysis.bench.ts
 */
import { scanWorkspace } from '../../src/scanner/workspaceScanner.ts';
import { parseFiles } from '../../src/parser/extractImports.ts';
import { RouteAnalyzer } from '../../src/routes/RouteAnalyzer.ts';
import { SourceTextCache } from '../../src/analysis/SourceTextCache.ts';
import type { SourceFileInfo } from '../../src/analysis/types.ts';
import { normalizePath } from '../../src/utils/path.ts';
import {
  createSuite,
  isDirectRun,
  measureSync,
  medianOf,
  runSuiteMain,
  type BenchmarkSuiteResult,
} from './benchmark-utils.ts';
import {
  createSyntheticWorkspace,
  type RouteStyle,
} from './synthetic-workspace.ts';

interface RouteScenario {
  name: string;
  routeCount: number;
  routeStyle: RouteStyle;
  /** Non-route module files, to measure the cost of skipping irrelevant files. */
  fileCount: number;
}

export const ROUTE_SCENARIOS: RouteScenario[] = [
  { name: 'few-routes/app', routeCount: 10, routeStyle: 'app', fileCount: 20 },
  { name: 'few-routes/nested', routeCount: 10, routeStyle: 'nested', fileCount: 20 },
  { name: 'hundreds/app', routeCount: 300, routeStyle: 'app', fileCount: 100 },
  { name: 'hundreds/router', routeCount: 300, routeStyle: 'router', fileCount: 100 },
  { name: 'hundreds/mounted', routeCount: 300, routeStyle: 'mounted', fileCount: 100 },
  { name: 'hundreds/nested', routeCount: 300, routeStyle: 'nested', fileCount: 100 },
  { name: 'thousands/app', routeCount: 3000, routeStyle: 'app', fileCount: 200 },
  { name: 'thousands/nested', routeCount: 3000, routeStyle: 'nested', fileCount: 200 },
];

function loadFiles(root: string): { files: SourceFileInfo[]; textCache: SourceTextCache } {
  const textCache = new SourceTextCache();
  const scan = scanWorkspace(root, undefined, {
    publishText: (p, text) => textCache.set(p, text),
  });
  const parsed = parseFiles(
    scan.workspaceRoot,
    scan.files.map((f) => ({
      absolutePath: f.absolutePath,
      content: textCache.peek(f.absolutePath),
    })),
    scan.tsconfigs,
  );
  const byPath = new Map(parsed.map((p) => [normalizePath(p.filePath), p]));
  const files: SourceFileInfo[] = scan.files.map((f) => {
    const p = byPath.get(normalizePath(f.absolutePath));
    return {
      absolutePath: f.absolutePath,
      relativePath: f.relativePath,
      contentHash: f.contentHash,
      mtimeMs: f.mtimeMs,
      imports: p?.imports ?? [],
      exports: p?.exports ?? [],
      symbols: p?.symbols ?? [],
      dependencyPaths: p?.dependencyPaths ?? [],
      dynamicImportPaths: p?.dynamicImportPaths ?? [],
      parseError: p?.error,
    };
  });
  return { files, textCache };
}

export async function runRouteAnalysisBenchmark(): Promise<BenchmarkSuiteResult> {
  const suite = createSuite(
    'route-analysis',
    'RouteAnalyzer.analyze() across route counts and registration styles',
  );

  for (const scenario of ROUTE_SCENARIOS) {
    const ws = createSyntheticWorkspace({
      name: `routes-${scenario.name.replace('/', '-')}`,
      fileCount: scenario.fileCount,
      routeCount: scenario.routeCount,
      routeStyle: scenario.routeStyle,
      routesPerFile: 25,
      chainDepth: 1,
    });
    try {
      const { files, textCache } = loadFiles(ws.root);
      const analyzer = new RouteAnalyzer();

      // Cold: text read from disk. Warm: text served from the per-run cache.
      const cold = measureSync(
        `${scenario.name} (disk reads)`,
        () => analyzer.analyze(files),
        (result, ms) => ({
          style: scenario.routeStyle,
          files: files.length,
          routes: result.routes.length,
          errors: result.errors.length,
          usPerRoute: result.routes.length
            ? Math.round((ms * 1000) / result.routes.length)
            : undefined,
        }),
      );
      suite.measurements.push(cold.measurement);

      const warmMedian = medianOf(5, () =>
        analyzer.analyze(files, { textReader: textCache }),
      );
      const warm = measureSync(
        `${scenario.name} (text cache)`,
        () => analyzer.analyze(files, { textReader: textCache }),
        (result) => ({
          style: scenario.routeStyle,
          files: files.length,
          routes: result.routes.length,
          medianMs5: warmMedian,
          lowConfidence: result.routes.filter((r) => r.confidence === 'low').length,
        }),
      );
      suite.measurements.push(warm.measurement);
    } finally {
      ws.cleanup();
    }
  }

  suite.notes.push(
    'Route extraction only AST-parses files containing both `express` and a `.get`/`.post`/… property access; handler files with type-only express imports cost one cheap regex scan.',
    'Nested/mounted styles exercise app.use() prefix resolution; unresolved mounts are reported as low-confidence routes, never dropped.',
  );
  return suite;
}

if (isDirectRun(import.meta.url)) {
  void runSuiteMain(runRouteAnalysisBenchmark);
}
