/**
 * Benchmark: WorkspaceAnalysisService.analyze() against synthetic workspaces of
 * increasing size (small / medium / large / stress).
 *
 * Reports actual measured values only. Stage timings come from the service's own
 * AnalysisTimings diagnostics.
 */
import { WorkspaceAnalysisService } from '../../src/analysis/WorkspaceAnalysisService.ts';
import {
  createSuite,
  isDirectRun,
  measureAsync,
  measureSync,
  round,
  runSuiteMain,
  type BenchmarkSuiteResult,
} from './benchmark-utils.ts';
import { createSyntheticWorkspace } from './synthetic-workspace.ts';

export interface WorkspaceScenario {
  name: string;
  fileCount: number;
  routeCount: number;
}

export const WORKSPACE_SCENARIOS: WorkspaceScenario[] = [
  { name: 'small', fileCount: 50, routeCount: 4 },
  { name: 'medium', fileCount: 250, routeCount: 20 },
  { name: 'large', fileCount: 1000, routeCount: 80 },
  {
    name: 'stress',
    fileCount: Number(process.env.CODEMAP_BENCH_STRESS_FILES ?? 3000),
    routeCount: 240,
  },
];

export async function runWorkspaceAnalysisBenchmark(
  scenarios: WorkspaceScenario[] = WORKSPACE_SCENARIOS,
): Promise<BenchmarkSuiteResult> {
  const suite = createSuite(
    'workspace-analysis',
    'WorkspaceAnalysisService.analyze() on synthetic workspaces (routes on; call chains on/off)',
  );

  for (const scenario of scenarios) {
    const ws = createSyntheticWorkspace({
      name: scenario.name,
      fileCount: scenario.fileCount,
      routeCount: scenario.routeCount,
      chainDepth: 3,
      cycleEvery: 50,
    });
    try {
      const service = new WorkspaceAnalysisService();

      const base = measureSync(
        `${scenario.name}-workspace (routes, no call chains)`,
        () => service.analyze(ws.root),
        (result) => ({
          files: result.files.length,
          nodes: result.graph.nodes.length,
          edges: result.graph.edges.length,
          routes: result.routes.length,
          parseErrors: result.parseErrorCount,
          scanMs: round(result.timings.scanMs, 1),
          parseMs: round(result.timings.parseMs, 1),
          graphMs: round(result.timings.graphBuildMs, 1),
          routeMs: round(result.timings.routeAnalysisMs ?? 0, 1),
        }),
      );
      suite.measurements.push(base.measurement);

      const withChains = measureSync(
        `${scenario.name}-workspace (routes + call chains, depth 8)`,
        () => service.analyze(ws.root, { includeCallChains: true }),
        (result) => ({
          files: result.files.length,
          nodes: result.graph.nodes.length,
          edges: result.graph.edges.length,
          routes: result.routes.length,
          traces: result.routeTraces?.length ?? 0,
          parseMs: round(result.timings.parseMs, 1),
          routeMs: round(result.timings.routeAnalysisMs ?? 0, 1),
          callChainMs: round(result.timings.callChainAnalysisMs ?? 0, 1),
        }),
      );
      suite.measurements.push(withChains.measurement);

      if (scenario.name === 'medium' || scenario.name === 'large') {
        const async = await measureAsync(
          `${scenario.name}-workspace (analyzeAsync, yielding)`,
          () => service.analyzeAsync(ws.root),
          (result) => ({
            files: result.files.length,
            nodes: result.graph.nodes.length,
            edges: result.graph.edges.length,
            syncMs: base.measurement.ms,
          }),
        );
        suite.measurements.push(async.measurement);
      }
    } finally {
      ws.cleanup();
    }
  }

  suite.notes.push(
    'Synthetic files are small (~25 lines); real-world files are larger, so per-file parse cost will be higher.',
    'analyzeAsync yields to the event loop roughly every 12ms; its overhead versus analyze() is the cost of responsiveness/cancellation.',
    'Heap Δ approximates memory retained by the returned WorkspaceAnalysisResult (forced GC when --expose-gc is available).',
  );
  return suite;
}

if (isDirectRun(import.meta.url)) {
  void runSuiteMain(() => runWorkspaceAnalysisBenchmark());
}
