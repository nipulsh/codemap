/**
 * Benchmark: lazy explorer startup vs eager WorkspaceAnalysisService.
 *
 * These are different operations and are not interchangeable:
 *  - lazy  = ExplorerService.bootstrap(): one directory listing, root-level nodes
 *            only, nothing parsed. Then a first interaction: expand `src/` and
 *            expand one file (which parses that single file in a worker).
 *  - eager = WorkspaceAnalysisService.analyze(): scan + parse every file, build
 *            the full graph, extract routes.
 *
 * The point of the comparison is to confirm Phase 5+ did not regress the
 * original lazy path: bootstrap time must stay independent of workspace size.
 *
 * Requires the compiled worker (`npm run compile`) for the lazy expand steps.
 * Run: npx tsx --expose-gc tests/performance/lazy-vs-eager.bench.ts
 */
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkspaceAnalysisService } from '../../src/analysis/WorkspaceAnalysisService.ts';
import { ExplorerService, type ExplorerEmit } from '../../src/explorer/ExplorerService.ts';
import { WorkerPool } from '../../src/parser/workerPool.ts';
import {
  createSuite,
  isDirectRun,
  measureAsync,
  measureSync,
  runSuiteMain,
  type BenchmarkSuiteResult,
} from './benchmark-utils.ts';
import { createSyntheticWorkspace } from './synthetic-workspace.ts';

const WORKER_SCRIPT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  '..',
  'out',
  'parser',
  'workers',
  'parseWorker.js',
);

export const LAZY_EAGER_SCENARIOS = [
  { name: 'small', fileCount: 50, routeCount: 4 },
  { name: 'medium', fileCount: 250, routeCount: 20 },
  { name: 'large', fileCount: 1000, routeCount: 80 },
];

export async function runLazyVsEagerBenchmark(): Promise<BenchmarkSuiteResult> {
  const suite = createSuite(
    'lazy-vs-eager',
    'ExplorerService.bootstrap() (lazy) vs WorkspaceAnalysisService.analyze() (eager)',
  );
  const workerAvailable = existsSync(WORKER_SCRIPT);
  const pool = workerAvailable
    ? new WorkerPool({ workerScript: WORKER_SCRIPT, numWorkers: 2 })
    : undefined;

  try {
    for (const scenario of LAZY_EAGER_SCENARIOS) {
      const ws = createSyntheticWorkspace({
        name: `lazy-eager-${scenario.name}`,
        fileCount: scenario.fileCount,
        routeCount: scenario.routeCount,
      });
      try {
        const emitted: ExplorerEmit[] = [];
        const explorer = new ExplorerService(
          (pool ?? ({} as unknown as WorkerPool)),
          (msg) => emitted.push(msg),
        );

        const bootstrap = await measureAsync(
          `${scenario.name} / lazy bootstrap`,
          () => explorer.bootstrap(ws.root),
          () => {
            const full = emitted.find((m) => m.full)?.full;
            return {
              files: ws.totalFiles,
              rootNodes: full?.nodes.length ?? 0,
              rootEdges: full?.edges.length ?? 0,
            };
          },
        );
        suite.measurements.push(bootstrap.measurement);

        if (pool) {
          const srcDir = join(ws.root, 'src');
          const firstModule = readdirSync(srcDir).find((d) => d.startsWith('mod'));
          const modDir = firstModule ? join(srcDir, firstModule) : srcDir;
          const firstFile = readdirSync(modDir).find((f) => f.endsWith('.ts'));

          const expand = await measureAsync(
            `${scenario.name} / lazy expand src + one folder + one file`,
            async () => {
              await explorer.expandFolder(srcDir);
              await explorer.expandFolder(modDir);
              if (firstFile) {
                await explorer.expandFile(join(modDir, firstFile));
              }
            },
            () => ({
              files: ws.totalFiles,
              patches: emitted.filter((m) => m.patch).length,
              errors: emitted.filter((m) => m.error).length,
            }),
          );
          suite.measurements.push(expand.measurement);
        }
        await explorer.dispose();

        const service = new WorkspaceAnalysisService();
        const eager = measureSync(
          `${scenario.name} / eager full analysis`,
          () => service.analyze(ws.root),
          (result) => ({
            files: result.files.length,
            nodes: result.graph.nodes.length,
            edges: result.graph.edges.length,
            routes: result.routes.length,
          }),
        );
        suite.measurements.push(eager.measurement);
      } finally {
        ws.cleanup();
      }
    }
  } finally {
    await pool?.dispose();
  }

  if (!workerAvailable) {
    suite.notes.push(
      'Compiled worker not found (run `npm run compile`); lazy expand steps were skipped.',
    );
  }
  suite.notes.push(
    'Lazy bootstrap lists only the workspace root; its cost must not scale with file count.',
    'Eager analysis parses every file; it is the cost paid for architecture documentation and route tracing, not for opening the graph.',
  );
  return suite;
}

if (isDirectRun(import.meta.url)) {
  void runSuiteMain(runLazyVsEagerBenchmark);
}
