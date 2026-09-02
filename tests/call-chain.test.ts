import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeFixture,
  analyzeWithCallChains,
  makeTestRoute,
  traceRoute,
} from './helpers.ts';
import {
  CallChainAnalyzer,
  createCallChainContext,
} from '../src/routes/CallChainAnalyzer.ts';
import { CallTraceGraphBuilder } from '../src/routes/CallTraceGraphBuilder.ts';
import { DEFAULT_CALL_CHAIN_MAX_DEPTH } from '../src/routes/types.ts';

describe('CallChainAnalyzer linear chain', () => {
  it('traces route handler through service and repository layers', () => {
    const analysis = analyzeFixture('call-chain');
    const route = analysis.routes.find(
      (r) => r.method === 'POST' && r.path === '/api/login',
    );
    assert.ok(route, 'expected POST /api/login route');

    const trace = traceRoute(analysis, route);
    assert.ok(trace.entryHandler);
    assert.equal(trace.entryHandler!.depth, 0);
    assert.equal(trace.entryHandler!.functionName, 'loginHandler');

    const depths = new Map(trace.nodes.map((n) => [n.functionName, n.depth]));
    assert.equal(depths.get('loginHandler'), 0);
    assert.equal(depths.get('authenticate'), 1);
    assert.equal(depths.get('findUser'), 2);
    assert.equal(depths.get('dbQuery'), 3);
    assert.equal(trace.truncated, false);
  });

  it('orders nodes by BFS depth', () => {
    const analysis = analyzeFixture('call-chain');
    const route = analysis.routes.find((r) => r.path === '/api/login')!;
    const trace = traceRoute(analysis, route);

    for (let i = 1; i < trace.nodes.length; i++) {
      const prev = trace.nodes[i - 1];
      const curr = trace.nodes[i];
      assert.ok(
        curr.depth >= prev.depth,
        'nodes must be sorted by non-decreasing depth',
      );
    }
  });
});

describe('CallChainAnalyzer branching', () => {
  it('records multiple callees from one handler', () => {
    const analysis = analyzeFixture('call-chain');
    const route = analysis.routes.find((r) => r.path === '/branch')!;
    const trace = traceRoute(analysis, route);

    const handlerNode = trace.entryHandler!;
    const childEdges = trace.edges.filter((e) => e.from === handlerNode.id);
    assert.equal(childEdges.length, 3);

    const childNames = childEdges
      .map((e) => trace.nodes.find((n) => n.id === e.to)?.functionName)
      .sort();
    assert.deepEqual(childNames, ['audit', 'authenticateBranch', 'validate']);
  });
});

describe('CallChainAnalyzer depth limit', () => {
  it('truncates chains deeper than maxDepth', () => {
    const analysis = analyzeFixture('call-chain');
    const route = makeTestRoute(
      analysis,
      'deep.ts',
      'deep0',
      'GET',
      '/deep',
    );
    const trace = traceRoute(analysis, route, 8);

    assert.equal(trace.maxDepth, 8);
    assert.equal(trace.truncated, true);
    assert.ok(
      trace.limitations.some((l) => l.includes('maxDepth=8')),
      'must document truncation',
    );
    const maxObserved = Math.max(...trace.nodes.map((n) => n.depth));
    assert.ok(maxObserved <= 8);
  });
});

describe('CallChainAnalyzer cycles and recursion', () => {
  it('detects mutual recursion without infinite expansion', () => {
    const analysis = analyzeFixture('call-chain');
    const route = makeTestRoute(analysis, 'cycle.ts', 'fnA', 'GET', '/cycle');
    const trace = traceRoute(analysis, route);

    assert.ok(trace.nodes.some((n) => n.functionName === 'fnA'));
    assert.ok(trace.nodes.some((n) => n.functionName === 'fnB'));
    assert.ok(trace.nodes.some((n) => n.functionName === 'fnC'));
    assert.ok(
      trace.edges.some((e) => e.isCycle),
      'expected a cycle edge',
    );
    assert.ok(trace.nodes.length <= 4);
  });

  it('handles direct recursion safely', () => {
    const analysis = analyzeFixture('call-chain');
    const route = makeTestRoute(
      analysis,
      'recursive.ts',
      'fnRecursive',
      'GET',
      '/recursive',
    );
    const trace = traceRoute(analysis, route);

    assert.ok(trace.edges.some((e) => e.isCycle));
    assert.ok(trace.nodes.length >= 1);
  });
});

describe('CallChainAnalyzer external and unresolved', () => {
  it('marks external module calls as external resolution', () => {
    const analysis = analyzeFixture('call-chain');
    const route = makeTestRoute(
      analysis,
      'external.ts',
      'externalHandler',
      'GET',
      '/external',
    );
    const trace = traceRoute(analysis, route);

    assert.ok(
      trace.nodes.some(
        (n) => n.resolution === 'external' && n.functionName === 'compare',
      ),
    );
    assert.ok(
      trace.unresolved.some((u) => u.reason === 'external-module'),
    );
  });

  it('marks dynamic dispatch as unresolved', () => {
    const analysis = analyzeFixture('call-chain');
    const route = makeTestRoute(
      analysis,
      'dynamic.ts',
      'dynamicHandler',
      'GET',
      '/dynamic',
    );
    const trace = traceRoute(analysis, route);

    assert.ok(
      trace.unresolved.some((u) => u.reason === 'dynamic-dispatch'),
    );
  });

  it('reports handler resolution failure for missing handlers', () => {
    const analysis = analyzeFixture('call-chain');
    const route = makeTestRoute(
      analysis,
      'linear-handlers.ts',
      'missingHandler',
      'GET',
      '/missing',
    );
    const trace = traceRoute(analysis, route);
    assert.equal(trace.entryHandler, undefined);
    assert.ok(
      trace.limitations.some((l) => l.includes('could not be resolved')),
    );
  });
});

describe('CallChainAnalyzer determinism and sharing', () => {
  it('produces deterministic trace IDs across repeated analysis', () => {
    const analysis = analyzeFixture('call-chain');
    const route = analysis.routes.find((r) => r.path === '/api/login')!;
    const t1 = traceRoute(analysis, route);
    const t2 = traceRoute(analysis, route);
    assert.deepEqual(
      t1.nodes.map((n) => n.id),
      t2.nodes.map((n) => n.id),
    );
  });

  it('reuses the same symbol ID for shared handlers across routes', () => {
    const analysis = analyzeFixture('call-chain');
    const routeA = analysis.routes.find((r) => r.path === '/a')!;
    const routeB = analysis.routes.find((r) => r.path === '/b')!;
    const traceA = traceRoute(analysis, routeA);
    const traceB = traceRoute(analysis, routeB);

    assert.equal(traceA.entryHandler!.id, traceB.entryHandler!.id);
  });
});

describe('CallChainAnalyzer API', () => {
  it('analyzeRoutes processes multiple routes', () => {
    const analysis = analyzeFixture('call-chain');
    const ctx = createCallChainContext(
      analysis.workspaceRoot,
      analysis.files,
      analysis.tsconfigs,
    );
    const login = analysis.routes.find((r) => r.path === '/api/login')!;
    const branch = analysis.routes.find((r) => r.path === '/branch')!;
    const traces = new CallChainAnalyzer().analyzeRoutes(
      [login, branch],
      ctx,
    );
    assert.equal(traces.length, 2);
    assert.notEqual(traces[0].routeId, traces[1].routeId);
  });

  it('uses default maxDepth of 8', () => {
    assert.equal(DEFAULT_CALL_CHAIN_MAX_DEPTH, 8);
  });
});

describe('WorkspaceAnalysisService call-chain integration', () => {
  it('includes routeTraces only when includeCallChains is true', () => {
    const without = analyzeFixture('call-chain');
    assert.equal(without.routeTraces, undefined);

    const withChains = analyzeWithCallChains('call-chain');
    assert.ok(withChains.routeTraces);
    assert.ok(withChains.routeTraces!.length >= 2);
  });
});

describe('CallTraceGraphBuilder', () => {
  it('emits calls edges for resolved static trace steps', () => {
    const analysis = analyzeWithCallChains('call-chain');
    const traces = analysis.routeTraces!;
    const patch = new CallTraceGraphBuilder().build(traces);

    assert.ok(patch.upsertEdges.some((e) => e.kind === 'calls'));
    assert.ok(patch.upsertEdges.some((e) => e.kind === 'handles'));

    const callEdges = analysis.graph.edges.filter(
      (e) => e.kind === 'calls' && e.metadata?.staticTrace === true,
    );
    assert.ok(callEdges.length >= 1);
  });
});

describe('static trace limitations', () => {
  it('documents that traces are not runtime execution order', () => {
    const analysis = analyzeFixture('call-chain');
    const route = analysis.routes.find((r) => r.path === '/api/login')!;
    const trace = traceRoute(analysis, route);
    assert.ok(
      trace.limitations.some((l) =>
        l.toLowerCase().includes('runtime execution order'),
      ),
    );
  });
});
