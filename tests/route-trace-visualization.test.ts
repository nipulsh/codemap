import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  filterTraceByDepth,
  projectTraceToSnapshot,
  sortRoutes,
} from '../shared/routeTrace.ts';
import type { StaticRouteTraceWire } from '../shared/routeTrace.ts';
import { analyzeFixture, makeTestRoute, traceRoute } from './helpers.ts';

function sampleTrace(): StaticRouteTraceWire {
  const route = {
    id: 'route:test',
    method: 'GET' as const,
    path: '/api/users',
    framework: 'express' as const,
    sourceFile: '/proj/routes.ts',
    line: 10,
    handlerSymbol: 'getUsers',
    handlerResolved: true,
    confidence: 'high' as const,
  };

  const entryHandler = {
    id: 'symbol:/proj/handlers.ts:Function:getUsers',
    symbolId: 'symbol:/proj/handlers.ts:Function:getUsers',
    functionName: 'getUsers',
    filePath: '/proj/handlers.ts',
    line: 1,
    depth: 0,
    resolution: 'resolved' as const,
  };

  const service = {
    id: 'symbol:/proj/service.ts:Function:load',
    functionName: 'load',
    filePath: '/proj/service.ts',
    line: 5,
    depth: 1,
    resolution: 'resolved' as const,
  };

  const repo = {
    id: 'symbol:/proj/repo.ts:Function:find',
    functionName: 'find',
    filePath: '/proj/repo.ts',
    line: 8,
    depth: 2,
    resolution: 'resolved' as const,
  };

  return {
    routeId: route.id,
    route,
    entryHandler,
    nodes: [entryHandler, service, repo],
    edges: [
      { from: entryHandler.id, to: service.id, kind: 'calls', resolved: true },
      { from: service.id, to: repo.id, kind: 'calls', resolved: true },
    ],
    maxDepth: 8,
    truncated: false,
    unresolved: [],
    limitations: ['StaticRouteTrace represents statically inferred call relationships, not confirmed runtime execution order.'],
  };
}

describe('route trace projection', () => {
  it('projects trace nodes and edges into a graph snapshot', () => {
    const snapshot = projectTraceToSnapshot(sampleTrace(), '/proj');
    assert.ok(snapshot.nodes.some((n) => n.kind === 'Route'));
    assert.ok(snapshot.nodes.some((n) => n.metadata?.traceDepth === 1));
    assert.ok(snapshot.edges.some((e) => e.kind === 'handles'));
    assert.ok(snapshot.edges.some((e) => e.kind === 'calls'));
  });

  it('preserves depth metadata on projected nodes', () => {
    const snapshot = projectTraceToSnapshot(sampleTrace());
    const depths = snapshot.nodes
      .map((n) => n.metadata?.traceDepth)
      .filter((d) => typeof d === 'number' && d >= 0);
    assert.deepEqual(depths.sort((a, b) => (a as number) - (b as number)), [0, 1, 2]);
  });

  it('filters nodes by visible depth without recomputing analysis', () => {
    const filtered = filterTraceByDepth(sampleTrace(), 1);
    assert.ok(filtered.nodes.every((n) => n.depth <= 1));
    assert.equal(
      filtered.edges.every((e) => {
        const ids = new Set(filtered.nodes.map((n) => n.id));
        return ids.has(e.from) && ids.has(e.to);
      }),
      true,
    );
  });

  it('keeps cycle edge metadata in projection', () => {
    const trace = sampleTrace();
    trace.edges.push({
      from: 'symbol:/proj/repo.ts:Function:find',
      to: trace.entryHandler!.id,
      kind: 'calls',
      resolved: true,
      isCycle: true,
    });
    const snapshot = projectTraceToSnapshot(trace);
    assert.ok(snapshot.edges.some((e) => e.metadata?.isCycle === true));
  });

  it('sorts routes deterministically by path then method', () => {
    const routes = sortRoutes([
      {
        id: 'b',
        method: 'POST',
        path: '/z',
        framework: 'express',
        sourceFile: '/a.ts',
        line: 1,
        confidence: 'high',
        handlerResolved: true,
      },
      {
        id: 'a',
        method: 'GET',
        path: '/a',
        framework: 'express',
        sourceFile: '/a.ts',
        line: 1,
        confidence: 'high',
        handlerResolved: true,
      },
    ]);
    assert.equal(routes[0].path, '/a');
    assert.equal(routes[1].path, '/z');
  });

  it('includes unresolved metadata in source trace model', () => {
    const analysis = analyzeFixture('call-chain');
    const route = analysis.routes.find((r) => r.path === '/dynamic');
    assert.ok(route);
    const trace = traceRoute(analysis, route!);
    assert.ok(trace.unresolved.some((u) => u.reason === 'dynamic-dispatch'));
  });

  it('marks external calls in trace nodes', () => {
    const analysis = analyzeFixture('call-chain');
    const route = analysis.routes.find((r) => r.path === '/external');
    assert.ok(route);
    const trace = traceRoute(analysis, route!);
    assert.ok(trace.nodes.some((n) => n.resolution === 'external'));
  });

  it('reports truncation in deep traces', () => {
    const analysis = analyzeFixture('call-chain');
    const route = makeTestRoute(analysis, 'deep.ts', 'deep0', 'GET', '/deep');
    const trace = traceRoute(analysis, route, 8);
    assert.equal(trace.truncated, true);
  });
});

describe('route trace message protocol', () => {
  it('validates routeTrace:data messages', async () => {
    const { ExtensionToWebviewSchema } = await import('../shared/messages.ts');
    const parsed = ExtensionToWebviewSchema.parse({
      type: 'routeTrace:data',
      payload: { routes: [], traces: [] },
    });
    assert.equal(parsed.type, 'routeTrace:data');
  });

  it('validates routeTrace:request from webview', async () => {
    const { WebviewToExtensionSchema } = await import('../shared/messages.ts');
    const parsed = WebviewToExtensionSchema.parse({ type: 'routeTrace:request' });
    assert.equal(parsed.type, 'routeTrace:request');
  });
});
