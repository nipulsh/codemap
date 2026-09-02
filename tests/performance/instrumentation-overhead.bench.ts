/**
 * Benchmark: Express request overhead with and without CodeMap instrumentation.
 *
 * A real HTTP server is started for each variant and driven by an in-process
 * keep-alive client at fixed concurrency. Per-request latency is measured with
 * process.hrtime; throughput is requests / wall time; CPU is process.cpuUsage()
 * over the run (server + client share the process, so the *difference* between
 * baseline and instrumented is the meaningful CPU number, not the absolute).
 *
 * Cases (identical handler code; the only difference is whether
 * instrumentExpress() is installed):
 *   A  HTTP instrumentation only
 *   B  HTTP + one explicit span
 *   C  HTTP + nested spans (3 levels)
 *   D  HTTP + error span (handler span throws, 500 returned)
 *
 * Run: npx tsx --expose-gc tests/performance/instrumentation-overhead.bench.ts
 */
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { TraceCollector } from '../../src/runtime/TraceCollector.ts';
import {
  createRouteResolverFromDefinitions,
  instrumentExpress,
  withCodeMapSpan,
} from '../../src/runtime/instrumentation/instrumentation.ts';
import {
  createSuite,
  isDirectRun,
  mean,
  percentile,
  round,
  runSuiteMain,
  type BenchmarkMeasurement,
  type BenchmarkSuiteResult,
} from './benchmark-utils.ts';

export type OverheadCase = 'A-http-only' | 'B-one-span' | 'C-nested-spans' | 'D-error-span';
export const OVERHEAD_CASES: OverheadCase[] = [
  'A-http-only',
  'B-one-span',
  'C-nested-spans',
  'D-error-span',
];

const REQUESTS = Number(process.env.CODEMAP_BENCH_REQUESTS ?? 3000);
const WARMUP = 300;
const CONCURRENCY = 16;

async function repository(id: string): Promise<{ id: string }> {
  await Promise.resolve();
  return { id };
}

async function service(id: string): Promise<{ id: string }> {
  return withCodeMapSpan('UserService.load', () =>
    withCodeMapSpan('UserRepository.find', () => repository(id)),
  );
}

export function buildApp(kind: OverheadCase, instrumented: boolean, collector: TraceCollector): Express {
  const app = express();
  if (instrumented) {
    instrumentExpress(app, {
      collector,
      includeRequestMetadata: true,
      routeResolver: createRouteResolverFromDefinitions([
        { id: 'route:GET:/items/:id', method: 'GET', path: '/items/:id' },
      ]),
    });
  }

  app.get('/items/:id', (req: Request, res: Response, next: NextFunction) => {
    const id = String(req.params.id);
    const run = async (): Promise<void> => {
      switch (kind) {
        case 'A-http-only':
          res.json({ id });
          return;
        case 'B-one-span':
          res.json(await withCodeMapSpan('UserService.load', () => repository(id)));
          return;
        case 'C-nested-spans':
          res.json(await service(id));
          return;
        case 'D-error-span':
          await withCodeMapSpan('UserService.fail', async () => {
            await Promise.resolve();
            throw new Error(`no item ${id}`);
          });
          return;
      }
    };
    run().catch(next);
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  });
  return app;
}

function listen(app: Express): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function request(agent: http.Agent, port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const start = process.hrtime.bigint();
    const req = http.get({ host: '127.0.0.1', port, path, agent }, (res) => {
      res.on('data', () => undefined);
      res.on('end', () => {
        resolve(Number(process.hrtime.bigint() - start) / 1e6);
      });
    });
    req.on('error', reject);
  });
}

interface LoadResult {
  latencies: number[];
  wallMs: number;
  cpuMs: number;
}

async function runLoad(port: number, total: number, concurrency: number, record: boolean): Promise<LoadResult> {
  const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency });
  const latencies: number[] = [];
  let next = 0;
  const cpuStart = process.cpuUsage();
  const wallStart = process.hrtime.bigint();
  const worker = async (): Promise<void> => {
    while (next < total) {
      const i = next++;
      const ms = await request(agent, port, `/items/${i % 100}`);
      if (record) {
        latencies.push(ms);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const wallMs = Number(process.hrtime.bigint() - wallStart) / 1e6;
  const cpu = process.cpuUsage(cpuStart);
  agent.destroy();
  return { latencies, wallMs, cpuMs: (cpu.user + cpu.system) / 1000 };
}

export interface OverheadSample {
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  rps: number;
  cpuMsPerReq: number;
}

async function measureVariant(kind: OverheadCase, instrumented: boolean): Promise<{
  sample: OverheadSample;
  collector: TraceCollector;
}> {
  const collector = new TraceCollector({ maxCompletedTraces: 100 });
  const server = await listen(buildApp(kind, instrumented, collector));
  const port = (server.address() as AddressInfo).port;
  try {
    await runLoad(port, WARMUP, CONCURRENCY, false);
    const load = await runLoad(port, REQUESTS, CONCURRENCY, true);
    return {
      collector,
      sample: {
        meanMs: mean(load.latencies),
        p50Ms: percentile(load.latencies, 50),
        p95Ms: percentile(load.latencies, 95),
        p99Ms: percentile(load.latencies, 99),
        rps: round((REQUESTS / load.wallMs) * 1000, 0),
        cpuMsPerReq: round(load.cpuMs / REQUESTS, 4),
      },
    };
  } finally {
    await close(server);
  }
}

function toMeasurement(
  scenario: string,
  sample: OverheadSample,
  extra: Record<string, number | string | undefined> = {},
): BenchmarkMeasurement {
  return {
    scenario,
    ms: sample.meanMs,
    heapUsedDeltaMb: 0,
    rssAfterMb: round(process.memoryUsage().rss / 1024 / 1024, 2),
    metrics: {
      requests: REQUESTS,
      concurrency: CONCURRENCY,
      p50Ms: sample.p50Ms,
      p95Ms: sample.p95Ms,
      p99Ms: sample.p99Ms,
      rps: sample.rps,
      cpuMsPerReq: sample.cpuMsPerReq,
      ...extra,
    },
  };
}

export async function runInstrumentationOverheadBenchmark(): Promise<BenchmarkSuiteResult> {
  const suite = createSuite(
    'instrumentation-overhead',
    `Express baseline vs instrumentExpress(): ${REQUESTS} requests, concurrency ${CONCURRENCY}, keep-alive, in-process client`,
  );

  for (const kind of OVERHEAD_CASES) {
    // Alternate order per case to spread thermal/JIT drift across both variants.
    const baseline = await measureVariant(kind, false);
    const instrumented = await measureVariant(kind, true);
    const baselineAgain = await measureVariant(kind, false);

    const base: OverheadSample = {
      meanMs: round((baseline.sample.meanMs + baselineAgain.sample.meanMs) / 2, 3),
      p50Ms: round((baseline.sample.p50Ms + baselineAgain.sample.p50Ms) / 2, 3),
      p95Ms: round((baseline.sample.p95Ms + baselineAgain.sample.p95Ms) / 2, 3),
      p99Ms: round((baseline.sample.p99Ms + baselineAgain.sample.p99Ms) / 2, 3),
      rps: round((baseline.sample.rps + baselineAgain.sample.rps) / 2, 0),
      cpuMsPerReq: round(
        (baseline.sample.cpuMsPerReq + baselineAgain.sample.cpuMsPerReq) / 2,
        4,
      ),
    };
    const inst = instrumented.sample;
    const stats = instrumented.collector.getStats();

    suite.measurements.push(toMeasurement(`${kind} / baseline`, base));
    suite.measurements.push(
      toMeasurement(`${kind} / instrumented`, inst, {
        tracesCompleted: stats.completedTraces + stats.evictedCompletedTraces,
        tracesActiveAfter: stats.activeTraces,
        spansPerTrace: instrumented.collector.getCompletedTraces()[0]?.spans.length,
      }),
    );
    suite.measurements.push({
      scenario: `${kind} / difference`,
      ms: round(inst.meanMs - base.meanMs, 3),
      heapUsedDeltaMb: 0,
      rssAfterMb: 0,
      metrics: {
        meanDeltaMs: round(inst.meanMs - base.meanMs, 3),
        meanDeltaPct: base.meanMs ? round(((inst.meanMs - base.meanMs) / base.meanMs) * 100, 1) : undefined,
        p50DeltaMs: round(inst.p50Ms - base.p50Ms, 3),
        p95DeltaMs: round(inst.p95Ms - base.p95Ms, 3),
        p99DeltaMs: round(inst.p99Ms - base.p99Ms, 3),
        rpsDeltaPct: base.rps ? round(((inst.rps - base.rps) / base.rps) * 100, 1) : undefined,
        cpuDeltaUsPerReq: round((inst.cpuMsPerReq - base.cpuMsPerReq) * 1000, 1),
      },
    });
  }

  suite.notes.push(
    'Baseline is the mean of two runs bracketing the instrumented run (before and after) to reduce drift; single-machine, single-process numbers — not a statistical study.',
    'Handler code is identical in both variants; withCodeMapSpan() is a passthrough when no trace context is active, so the baseline still pays one AsyncLocalStorage.getStore() per span call.',
    'Client and server run in the same Node process; absolute latency includes client overhead, the difference column is the instrumentation cost.',
  );
  return suite;
}

if (isDirectRun(import.meta.url)) {
  void runSuiteMain(runInstrumentationOverheadBenchmark);
}
