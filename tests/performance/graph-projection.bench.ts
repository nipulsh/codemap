/**
 * Benchmark: pure projection/layout functions the webview runs on large graphs.
 *
 * Browser automation is impractical here, so the functions React Flow is fed
 * with are benchmarked directly in Node:
 *  - applyGraphPatch()          (snapshot + patch merge)
 *  - filterTraceByDepth()       (route trace depth filter)
 *  - projectTraceToSnapshot()   (StaticRouteTrace → GraphSnapshot)
 *  - layoutTraceByDepth()       (route trace layout)
 *  - layoutNewNodes()           (incremental placement)
 *  - layoutGraph()              (ELK on tree edges; incremental fallback when large)
 *  - GraphSnapshotSchema.parse  (zod validation on the webview boundary)
 *
 * Fixtures: 1,000 nodes with 5,000 and 10,000 edges (plus a 250-node baseline).
 *
 * Run: npx tsx --expose-gc tests/performance/graph-projection.bench.ts
 */
import {
  applyGraphPatch,
  GraphSnapshotSchema,
  type GraphEdge,
  type GraphNode,
  type GraphSnapshot,
} from '../../shared/graph.ts';
import { filterTraceByDepth, projectTraceToSnapshot } from '../../shared/routeTrace.ts';
import { layoutGraph, layoutNewNodes } from '../../src/webview/layout/autoLayout.ts';
import { layoutTraceByDepth } from '../../src/webview/routeTrace/layoutTraceByDepth.ts';
import {
  createSuite,
  isDirectRun,
  measureAsync,
  measureSync,
  medianOf,
  runSuiteMain,
  type BenchmarkSuiteResult,
} from './benchmark-utils.ts';
import { createRng } from './synthetic-workspace.ts';
import { buildStaticTrace } from './trace-overlay.bench.ts';

export const GRAPH_SIZES = [
  { name: '250 nodes / 1k edges', nodes: 250, edges: 1_000 },
  { name: '1k nodes / 5k edges', nodes: 1_000, edges: 5_000 },
  { name: '1k nodes / 10k edges', nodes: 1_000, edges: 10_000 },
];

export function buildGraph(nodeCount: number, edgeCount: number, seed = 3): GraphSnapshot {
  const rng = createRng(seed);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const kinds: GraphNode['kind'][] = ['File', 'Function', 'Class', 'Function', 'Function'];
  for (let i = 0; i < nodeCount; i++) {
    const kind = i === 0 ? 'Workspace' : i < nodeCount / 10 ? 'Folder' : kinds[i % kinds.length]!;
    nodes.push({
      id: `${kind.toLowerCase()}:/ws/src/n${i}`,
      kind,
      label: `n${i}`,
      filePath: `/ws/src/dir${i % 25}/n${i}.ts`,
      metadata: { relativePath: `src/dir${i % 25}/n${i}.ts`, traceDepth: i % 12 },
    });
  }
  // Hierarchy backbone so every node has a parent, then random imports/calls.
  for (let i = 1; i < nodeCount; i++) {
    const parent = nodes[Math.floor((i - 1) / 10)]!;
    edges.push({
      id: `hierarchy:${parent.id}->${nodes[i]!.id}`,
      kind: 'hierarchy',
      source: parent.id,
      target: nodes[i]!.id,
    });
  }
  const seen = new Set(edges.map((e) => e.id));
  while (edges.length < edgeCount) {
    const a = nodes[Math.floor(rng() * nodeCount)]!;
    const b = nodes[Math.floor(rng() * nodeCount)]!;
    if (a === b) {
      continue;
    }
    const kind: GraphEdge['kind'] = rng() < 0.5 ? 'imports' : 'calls';
    const id = `${kind}:${a.id}->${b.id}`;
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    edges.push({ id, kind, source: a.id, target: b.id });
  }
  return { nodes, edges, generatedAt: 0, workspaceRoot: '/ws' };
}

export async function runGraphProjectionBenchmark(): Promise<BenchmarkSuiteResult> {
  const suite = createSuite(
    'graph-projection',
    'Projection, patching, validation and layout functions on large graphs (pure functions, no browser)',
  );

  for (const size of GRAPH_SIZES) {
    const snapshot = buildGraph(size.nodes, size.edges);

    const validate = measureSync(
      `${size.name} / GraphSnapshotSchema.parse`,
      () => GraphSnapshotSchema.parse(snapshot),
      () => ({ nodes: size.nodes, edges: size.edges, medianMs5: medianOf(5, () => GraphSnapshotSchema.parse(snapshot)) }),
    );
    suite.measurements.push(validate.measurement);

    const patch = {
      upsertNodes: snapshot.nodes.slice(0, Math.floor(size.nodes / 10)).map((n) => ({
        ...n,
        metadata: { ...n.metadata, expanded: true },
      })),
      removeNodeIds: [] as string[],
      upsertEdges: snapshot.edges.slice(0, Math.floor(size.edges / 10)),
      removeEdgeIds: [] as string[],
    };
    const patched = measureSync(
      `${size.name} / applyGraphPatch (10% upsert)`,
      () => applyGraphPatch(snapshot, patch),
      () => ({ nodes: size.nodes, edges: size.edges, medianMs5: medianOf(5, () => applyGraphPatch(snapshot, patch)) }),
    );
    suite.measurements.push(patched.measurement);

    const existing = new Map(snapshot.nodes.slice(0, Math.floor(size.nodes / 2)).map((n, i) => [n.id, { x: (i % 20) * 200, y: Math.floor(i / 20) * 60 }]));
    const newNodes = snapshot.nodes.slice(Math.floor(size.nodes / 2));
    const incremental = measureSync(
      `${size.name} / layoutNewNodes (50% new)`,
      () => layoutNewNodes(existing, newNodes, snapshot.edges),
      (positions) => ({ nodes: size.nodes, edges: size.edges, positioned: positions.size }),
    );
    suite.measurements.push(incremental.measurement);

    const traceLayout = measureSync(
      `${size.name} / layoutTraceByDepth`,
      () => layoutTraceByDepth(snapshot),
      (r) => ({ nodes: r.nodes.length, edges: r.edges.length }),
    );
    suite.measurements.push(traceLayout.measurement);

    const full = await measureAsync(
      `${size.name} / layoutGraph (ELK or incremental)`,
      () => layoutGraph(snapshot),
      (r) => ({ nodes: r.nodes.length, edges: r.edges.length, engine: r.engine }),
    );
    suite.measurements.push(full.measurement);
  }

  // Route trace projection on a large static trace.
  for (const nodeCount of [200, 1_000, 3_000]) {
    const trace = buildStaticTrace(nodeCount);
    const project = measureSync(
      `static trace ${nodeCount} nodes / projectTraceToSnapshot`,
      () => projectTraceToSnapshot(trace, '/ws'),
      (s) => ({ nodes: s.nodes.length, edges: s.edges.length, medianMs5: medianOf(5, () => projectTraceToSnapshot(trace, '/ws')) }),
    );
    suite.measurements.push(project.measurement);
    const filtered = measureSync(
      `static trace ${nodeCount} nodes / filterTraceByDepth(4)`,
      () => filterTraceByDepth(trace, 4),
      (t) => ({ nodes: t.nodes.length, edges: t.edges.length }),
    );
    suite.measurements.push(filtered.measurement);
  }

  suite.notes.push(
    'layoutGraph uses hierarchy/contains edges only for placement; import/call edges are visual. Graphs above 400 nodes or 600 tree edges use the incremental tree layout instead of ELK.',
    'All other functions are linear or n·log n in nodes+edges; pathological growth would show as medianMs5 rising faster than input size.',
  );
  return suite;
}

if (isDirectRun(import.meta.url)) {
  void runSuiteMain(runGraphProjectionBenchmark);
}
