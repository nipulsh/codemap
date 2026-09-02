/**
 * Benchmark: CallChainAnalyzer.analyzeRoutes() over call-graph shapes and depth limits.
 *
 * Shapes: linear (deep), dag (branching, width² edges per level), cyclic,
 * recursive, shared (many routes → one handler). Each shape is traced with
 * callChainMaxDepth ∈ {4, 8, 16, 32}. Reported metrics include visited nodes,
 * edges, the deepest node reached, whether the trace was truncated, and the
 * callee-cache hit ratio of the CallChainContext.
 *
 * Run: npx tsx --expose-gc tests/performance/call-chain.bench.ts
 */
import { WorkspaceAnalysisService } from '../../src/analysis/WorkspaceAnalysisService.ts';
import {
  CallChainAnalyzer,
  createCallChainContext,
} from '../../src/routes/CallChainAnalyzer.ts';
import type { StaticRouteTrace } from '../../src/routes/types.ts';
import {
  createSuite,
  isDirectRun,
  measureSync,
  round,
  runSuiteMain,
  type BenchmarkSuiteResult,
} from './benchmark-utils.ts';
import {
  createCallChainWorkspace,
  type CallChainWorkspaceSpec,
} from './synthetic-workspace.ts';

export const DEPTHS = [4, 8, 16, 32];

export const CHAIN_SHAPES: Array<{ name: string; spec: CallChainWorkspaceSpec }> = [
  { name: 'shallow-linear', spec: { shape: 'linear', depth: 3 } },
  { name: 'deep-linear', spec: { shape: 'linear', depth: 40 } },
  { name: 'branching-dag', spec: { shape: 'dag', depth: 6, width: 4 } },
  { name: 'wide-dag', spec: { shape: 'dag', depth: 4, width: 8 } },
  { name: 'cyclic', spec: { shape: 'cyclic', depth: 12 } },
  { name: 'recursive', spec: { shape: 'recursive', depth: 6 } },
  { name: 'shared-handler-x200', spec: { shape: 'shared', depth: 4, routeCount: 200 } },
];

function summarize(traces: StaticRouteTrace[]) {
  let nodes = 0;
  let edges = 0;
  let cycles = 0;
  let unresolved = 0;
  let deepest = 0;
  let truncated = 0;
  for (const t of traces) {
    nodes += t.nodes.length + (t.entryHandler ? 1 : 0);
    edges += t.edges.length;
    cycles += t.edges.filter((e) => e.isCycle).length;
    unresolved += t.unresolved.length;
    truncated += t.truncated ? 1 : 0;
    for (const n of t.nodes) {
      deepest = Math.max(deepest, n.depth);
    }
  }
  return { nodes, edges, cycles, unresolved, deepest, truncated };
}

export async function runCallChainBenchmark(): Promise<BenchmarkSuiteResult> {
  const suite = createSuite(
    'call-chain',
    'CallChainAnalyzer.analyzeRoutes() across graph shapes and callChainMaxDepth',
  );
  const service = new WorkspaceAnalysisService();
  const analyzer = new CallChainAnalyzer();

  for (const shape of CHAIN_SHAPES) {
    const ws = createCallChainWorkspace(shape.spec);
    try {
      // Static analysis without call chains: gives us routes + parsed files once.
      const analysis = service.analyze(ws.root, { includeCallChains: false });

      for (const maxDepth of DEPTHS) {
        const ctx = createCallChainContext(
          analysis.workspaceRoot,
          analysis.files,
          analysis.tsconfigs,
        );
        const { measurement } = measureSync(
          `${shape.name} depth=${maxDepth}`,
          () => analyzer.analyzeRoutes(analysis.routes, ctx, { maxDepth }),
          (traces) => {
            const s = summarize(traces);
            const lookups = ctx.stats.calleeLookups;
            return {
              routes: analysis.routes.length,
              files: analysis.files.length,
              nodes: s.nodes,
              edges: s.edges,
              deepest: s.deepest,
              cycleEdges: s.cycles,
              truncated: s.truncated,
              unresolved: s.unresolved,
              parsedFiles: ctx.parsedFileCount,
              calleeLookups: lookups,
              calleeCacheHitPct: lookups
                ? round((ctx.stats.calleeCacheHits / lookups) * 100, 1)
                : 0,
            };
          },
        );
        suite.measurements.push(measurement);
      }
    } finally {
      ws.cleanup();
    }
  }

  suite.notes.push(
    'deepest ≤ depth for every scenario: the depth limit bounds traversal; cyclic/recursive graphs terminate via visited-set + cycle edges.',
    'shared-handler: 200 routes share one handler; callee resolution for the chain is served from the context cache after the first route.',
    'Each depth run uses a fresh CallChainContext, so parsedFiles reflects files touched for that depth only.',
  );
  return suite;
}

if (isDirectRun(import.meta.url)) {
  void runSuiteMain(runCallChainBenchmark);
}
