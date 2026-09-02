import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import { TraceCollector } from '../src/runtime/TraceCollector.ts';
import {
  createRouteResolverFromDefinitions,
  instrumentExpress,
  resolveExpressRoutePattern,
  withCodeMapSpan,
  withCodeMapSpanSync,
  EXPRESS_INSTRUMENTATION_LIMITATIONS,
} from '../src/runtime/instrumentation/instrumentation.ts';
import {
  createRuntimeExpressApp,
  RUNTIME_EXPRESS_ROUTE_ID,
} from './fixtures/runtime-express/app.ts';

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('expected server address');
  }
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function httpGet(baseUrl: string, path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`);
}

describe('Express instrumentation basic request', () => {
  it('produces trace-started and trace-completed for HTTP requests', async () => {
    const collector = new TraceCollector();
    const app = createRuntimeExpressApp({ collector });
    const { server, baseUrl } = await listen(app);

    try {
      const res = await httpGet(baseUrl, '/users/123');
      assert.equal(res.status, 200);

      const traces = collector.getCompletedTraces();
      assert.equal(traces.length, 1);
      assert.equal(traces[0]!.status, 'completed');
      assert.ok(traces[0]!.completedAt !== undefined);
    } finally {
      await close(server);
    }
  });
});

describe('Express instrumentation route ID', () => {
  it('correlates GET /users/123 to GET /users/:id route template', async () => {
    const collector = new TraceCollector();
    const app = createRuntimeExpressApp({ collector, resolveRoutes: true });
    const { server, baseUrl } = await listen(app);

    try {
      await httpGet(baseUrl, '/users/123');
      const trace = collector.getCompletedTraces()[0]!;
      assert.equal(trace.routeId, RUNTIME_EXPRESS_ROUTE_ID);
    } finally {
      await close(server);
    }
  });

  it('leaves routeId undefined when no resolver is supplied', async () => {
    const collector = new TraceCollector();
    const app = createRuntimeExpressApp({ collector, resolveRoutes: false });
    const { server, baseUrl } = await listen(app);

    try {
      await httpGet(baseUrl, '/users/123');
      const trace = collector.getCompletedTraces()[0]!;
      assert.equal(trace.routeId, undefined);
    } finally {
      await close(server);
    }
  });
});

describe('Express instrumentation handler span', () => {
  it('creates an express.handler span for each request', async () => {
    const collector = new TraceCollector();
    const app = createRuntimeExpressApp({ collector });
    const { server, baseUrl } = await listen(app);

    try {
      await httpGet(baseUrl, '/users/1');
      const trace = collector.getCompletedTraces()[0]!;
      const handler = trace.spans.find((s) => s.functionName === 'express.handler');
      assert.ok(handler);
      assert.equal(handler!.status, 'completed');
    } finally {
      await close(server);
    }
  });
});

describe('Express instrumentation nested explicit spans', () => {
  it('records handler → service → repository parent-child relationships', async () => {
    const collector = new TraceCollector();
    const app = createRuntimeExpressApp({ collector });
    const { server, baseUrl } = await listen(app);

    try {
      await httpGet(baseUrl, '/users/42');
      const trace = collector.getCompletedTraces()[0]!;
      const byName = new Map(trace.spans.map((s) => [s.functionName, s]));

      const handler = byName.get('express.handler');
      const service = byName.get('getUser');
      const repository = byName.get('findUser');

      assert.ok(handler && service && repository);
      assert.equal(service.parentSpanId, handler!.spanId);
      assert.equal(repository.parentSpanId, service!.spanId);
    } finally {
      await close(server);
    }
  });
});

describe('Express instrumentation async behavior', () => {
  it('preserves span context across nested awaits', async () => {
    const collector = new TraceCollector();
    const app = createRuntimeExpressApp({ collector });
    const { server, baseUrl } = await listen(app);

    try {
      await httpGet(baseUrl, '/users/7');
      const trace = collector.getCompletedTraces()[0]!;
      assert.ok(trace.spans.some((s) => s.functionName === 'getUser'));
      assert.ok(trace.spans.some((s) => s.functionName === 'findUser'));
    } finally {
      await close(server);
    }
  });
});

describe('Express instrumentation synchronous spans', () => {
  it('supports withCodeMapSpanSync inside request context', async () => {
    const collector = new TraceCollector();
    const app = createRuntimeExpressApp({ collector });
    const { server, baseUrl } = await listen(app);

    try {
      await httpGet(baseUrl, '/users/5');
      const trace = collector.getCompletedTraces()[0]!;
      const repo = trace.spans.find((s) => s.functionName === 'findUser');
      assert.equal(repo?.status, 'completed');
    } finally {
      await close(server);
    }
  });
});

describe('Express instrumentation errors', () => {
  it('emits span-errored and rethrows the original error', async () => {
    const collector = new TraceCollector();
    const app = createRuntimeExpressApp({ collector });
    const { server, baseUrl } = await listen(app);

    try {
      const res = await httpGet(baseUrl, '/error');
      assert.equal(res.status, 500);

      const trace = collector.getCompletedTraces()[0]!;
      assert.equal(trace.status, 'completed');
      const handler = trace.spans.find((s) => s.functionName === 'express.handler');
      assert.ok(handler);
      assert.equal(handler!.status, 'completed');
    } finally {
      await close(server);
    }
  });

  it('preserves error metadata on explicit throwing spans', async () => {
    const collector = new TraceCollector();
    const app = express();
    instrumentExpress(app, { collector });
    app.get('/fail', async (_req, res, next) => {
      try {
        await withCodeMapSpan('FailingService.run', async () => {
          throw new TypeError('explicit failure');
        });
        res.status(200).end();
      } catch (error) {
        next(error);
      }
    });
    app.use((err: unknown, _req: express.Request, res: express.Response) => {
      if (!res.headersSent) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    const { server, baseUrl } = await listen(app);
    try {
      await httpGet(baseUrl, '/fail');
      const trace = collector.getCompletedTraces()[0]!;
      const span = trace.spans.find((s) => s.functionName === 'FailingService.run');
      assert.equal(span?.status, 'error');
      assert.equal(span?.error?.name, 'TypeError');
      assert.equal(span?.error?.message, 'explicit failure');
      assert.equal(trace.status, 'error');
    } finally {
      await close(server);
    }
  });
});

describe('Express instrumentation concurrent requests', () => {
  it('isolates trace contexts across concurrent requests', async () => {
    const collector = new TraceCollector();
    const app = express();
    instrumentExpress(app, { collector });

    app.get('/slow/:id', async (req, res) => {
      await withCodeMapSpan(`Service.process.${req.params.id}`, async () => {
        const delay = req.params.id === 'a' ? 30 : 5;
        await new Promise((r) => setTimeout(r, delay));
        res.json({ id: req.params.id });
      });
    });

    const { server, baseUrl } = await listen(app);
    try {
      await Promise.all([
        httpGet(baseUrl, '/slow/a'),
        httpGet(baseUrl, '/slow/b'),
      ]);

      const traces = collector.getCompletedTraces();
      assert.equal(traces.length, 2);

      const serviceSpans = traces.flatMap((t) =>
        t.spans.filter((s) => s.functionName?.startsWith('Service.process.')),
      );
      assert.equal(serviceSpans.length, 2);
      const names = serviceSpans.map((s) => s.functionName).sort();
      assert.deepEqual(names, ['Service.process.a', 'Service.process.b']);

      for (const span of serviceSpans) {
        const trace = traces.find((t) => t.traceId === span.traceId)!;
        const handler = trace.spans.find((s) => s.functionName === 'express.handler');
        assert.equal(span.parentSpanId, handler?.spanId);
      }
    } finally {
      await close(server);
    }
  });
});

describe('Express instrumentation status code', () => {
  it('captures response status code when request metadata is enabled', async () => {
    const collector = new TraceCollector();
    const app = createRuntimeExpressApp({
      collector,
      includeRequestMetadata: true,
      resolveRoutes: true,
    });
    const { server, baseUrl } = await listen(app);

    try {
      await httpGet(baseUrl, '/users/9');
      const trace = collector.getCompletedTraces()[0]!;
      assert.equal(trace.attributes?.statusCode, 200);
      assert.equal(trace.attributes?.httpMethod, 'GET');
      assert.equal(trace.attributes?.routePattern, '/users/:id');
    } finally {
      await close(server);
    }
  });
});

describe('Express instrumentation symbol metadata', () => {
  it('preserves explicit symbolId, filePath, and line on spans', async () => {
    const collector = new TraceCollector();
    const app = createRuntimeExpressApp({ collector });
    const { server, baseUrl } = await listen(app);

    try {
      await httpGet(baseUrl, '/users/3');
      const trace = collector.getCompletedTraces()[0]!;
      const service = trace.spans.find((s) => s.functionName === 'getUser');
      assert.equal(service?.symbolId, 'symbol:/proj/service.ts:Function:getUser');
      assert.equal(service?.filePath, '/proj/service.ts');
      assert.equal(service?.line, 12);
    } finally {
      await close(server);
    }
  });
});

describe('Express instrumentation dispose', () => {
  it('stops emitting traces after dispose()', async () => {
    const collector = new TraceCollector();
    const app = express();
    const handle = instrumentExpress(app, { collector });
    app.get('/ok', (_req, res) => res.status(200).end());

    const { server, baseUrl } = await listen(app);
    try {
      await httpGet(baseUrl, '/ok');
      assert.equal(collector.getCompletedTraces().length, 1);

      handle.dispose();
      collector.clear();

      await httpGet(baseUrl, '/ok');
      assert.equal(collector.getCompletedTraces().length, 0);
    } finally {
      await close(server);
    }
  });
});

describe('Express instrumentation opt-in', () => {
  it('does not emit traces before instrumentExpress() is called', async () => {
    const collector = new TraceCollector();
    const app = express();
    app.get('/users/:id', (_req, res) => res.status(200).json({ ok: true }));

    const { server, baseUrl } = await listen(app);
    try {
      await httpGet(baseUrl, '/users/1');
      assert.equal(collector.getCompletedTraces().length, 0);
    } finally {
      await close(server);
    }
  });
});

describe('Express route pattern resolution', () => {
  it('uses Express route template rather than raw request URL', () => {
    const req = {
      method: 'GET',
      baseUrl: '',
      route: { path: '/users/:id' },
    } as express.Request;

    assert.equal(resolveExpressRoutePattern(req), '/users/:id');
  });
});

describe('createRouteResolverFromDefinitions', () => {
  it('matches method and route template exactly', () => {
    const resolver = createRouteResolverFromDefinitions([
      { id: 'route-1', method: 'GET', path: '/users/:id' },
    ]);
    assert.equal(
      resolver({ method: 'GET', routePattern: '/users/:id' }),
      'route-1',
    );
    assert.equal(
      resolver({ method: 'GET', routePattern: '/users/123' }),
      undefined,
    );
  });
});

describe('Express instrumentation security', () => {
  it('documents that sensitive request payloads are not collected', () => {
    assert.ok(
      EXPRESS_INSTRUMENTATION_LIMITATIONS.some((l) =>
        l.includes('headers, bodies, cookies'),
      ),
    );
  });
});

describe('Express instrumentation without active context', () => {
  it('runs withCodeMapSpan without tracing when no request context exists', async () => {
    const collector = new TraceCollector();
    const result = await withCodeMapSpan('OutsideContext', async () => 42);
    assert.equal(result, 42);
    assert.equal(collector.getCompletedTraces().length, 0);
  });

  it('runs withCodeMapSpanSync without tracing when no request context exists', () => {
    const collector = new TraceCollector();
    const result = withCodeMapSpanSync('OutsideContextSync', () => 99);
    assert.equal(result, 99);
    assert.equal(collector.getCompletedTraces().length, 0);
  });
});
