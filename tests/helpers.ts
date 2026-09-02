import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkspaceAnalysisService } from '../src/analysis/WorkspaceAnalysisService.ts';
import type {
  WorkspaceAnalysisOptions,
  WorkspaceAnalysisResult,
} from '../src/analysis/types.ts';
import type { GraphSnapshot } from '../shared/graph.ts';
import {
  CallChainAnalyzer,
  createCallChainContext,
} from '../src/routes/CallChainAnalyzer.ts';
import type { RouteDefinition, StaticRouteTrace } from '../src/routes/types.ts';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export function fixtureRoot(name: string): string {
  return join(__dirname, 'fixtures', name);
}

export function buildGraphFromFixture(name: string): GraphSnapshot {
  return analyzeFixture(name).graph;
}

export function analyzeFixture(name: string): WorkspaceAnalysisResult {
  const service = new WorkspaceAnalysisService();
  return service.analyze(fixtureRoot(name));
}

export function routesFromFixture(name: string) {
  return analyzeFixture(name).routes;
}

export function analyzeWithCallChains(
  name: string,
  options: WorkspaceAnalysisOptions = {},
): WorkspaceAnalysisResult {
  const service = new WorkspaceAnalysisService();
  return service.analyze(fixtureRoot(name), {
    includeCallChains: true,
    ...options,
  });
}

export function traceRoute(
  analysis: WorkspaceAnalysisResult,
  route: RouteDefinition,
  maxDepth?: number,
): StaticRouteTrace {
  const ctx = createCallChainContext(
    analysis.workspaceRoot,
    analysis.files,
    analysis.tsconfigs,
  );
  return new CallChainAnalyzer().analyzeRoute(route, ctx, { maxDepth });
}

export function makeTestRoute(
  analysis: WorkspaceAnalysisResult,
  fileEndsWith: string,
  handlerSymbol: string,
  method: RouteDefinition['method'],
  path: string,
): RouteDefinition {
  const file = analysis.files.find((f) =>
    f.relativePath.replace(/\\/g, '/').endsWith(fileEndsWith),
  );
  if (!file) {
    throw new Error(`fixture file not found: ${fileEndsWith}`);
  }
  return {
    id: `test:${method}:${path}`,
    method,
    path,
    framework: 'express',
    sourceFile: file.absolutePath,
    line: 1,
    handlerSymbol,
    handlerResolved: true,
    confidence: 'high',
  };
}

export function findFileNode(snapshot: GraphSnapshot, endsWith: string) {
  return snapshot.nodes.find(
    (n) =>
      n.kind === 'File' &&
      (n.filePath?.replace(/\\/g, '/').endsWith(endsWith) ||
        n.label === endsWith),
  );
}

export function hasEdge(
  snapshot: GraphSnapshot,
  kind: string,
  sourceEndsWith: string,
  targetEndsWith: string,
): boolean {
  const source = findFileNode(snapshot, sourceEndsWith);
  const target = findFileNode(snapshot, targetEndsWith);
  if (!source || !target) {
    return false;
  }
  return snapshot.edges.some(
    (e) =>
      e.kind === kind && e.source === source.id && e.target === target.id,
  );
}
