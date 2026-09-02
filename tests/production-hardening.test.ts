import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { Server } from 'node:http';
import {
  WorkerPool,
  WorkerPoolDisposedError,
} from '../src/parser/workerPool.ts';
import { FileCache, isCachedFileParse } from '../src/cache/fileCache.ts';
import { FileSystemDiskCache } from '../src/cache/fsDiskCache.ts';
import { SourceTextCache } from '../src/analysis/SourceTextCache.ts';
import { mayContainExpressRoutes } from '../src/routes/RouteAnalyzer.ts';
import { createCallResolver } from '../src/parser/extractImports.ts';
import { WorkspaceAnalysisService } from '../src/analysis/WorkspaceAnalysisService.ts';
import { AnalysisCancelledError } from '../src/utils/cancellation.ts';
import { TraceCollector } from '../src/runtime/TraceCollector.ts';
import { createTraceOverlay } from '../src/runtime/TraceOverlay.ts';
import { layoutGraph } from '../src/webview/layout/autoLayout.ts';
import type { GraphSnapshot } from '../shared/graph.ts';
import type { RuntimeTrace } from '../src/runtime/types.ts';
import { analyzeFixture, analyzeWithCallChains, traceRoute } from './helpers.ts';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const mockWorker = (name: string) =>
  join(__dirname, 'fixtures', 'mock-workers', name);

describe('WorkerPool failure recovery', () => {
  it('rejects in-flight tasks when a worker exits with code 0', async () => {
    const pool = new WorkerPool({
      workerScript: mockWorker('exitWorker.js'),
      numWorkers: 1,
    });
    try {
      const task = pool.parseFile({
        workspaceRoot: '/ws',
        file: { absolutePath: '/ws/a.ts' },
        tsconfigs: [],
      });
      await assert.rejects(task, /exited with code 0/);
      assert.equal(pool.stats().workersReplaced, 1);
    } finally {
      await pool.dispose();
    }
  });

  it('recovers after a worker crash and completes the next task', async () => {
    const crashFlag = join(tmpdir(), `codemap-flaky-${Date.now()}.flag`);
    process.env.CODEMAP_FLAKY_CRASH_FLAG = crashFlag;
    const pool = new WorkerPool({
      workerScript: mockWorker('flakyWorker.js'),
      numWorkers: 1,
    });
    try {
      await assert.rejects(
        pool.parseFile({
          workspaceRoot: '/ws',
          file: { absolutePath: '/ws/first.ts' },
          tsconfigs: [],
        }),
        /exited with code 1/,
      );

      const result = await pool.parseFile({
        workspaceRoot: '/ws',
        file: { absolutePath: '/ws/second.ts' },
        tsconfigs: [],
      });
      assert.equal(result.filePath, '/ws/second.ts');
      assert.ok(pool.stats().workersReplaced >= 1);
    } finally {
      delete process.env.CODEMAP_FLAKY_CRASH_FLAG;
      try {
        rmSync(crashFlag, { force: true });
      } catch {
        // ignore
      }
      await pool.dispose();
    }
  });

  it('rejects queued and in-flight tasks on dispose()', async () => {
    const pool = new WorkerPool({
      workerScript: mockWorker('errorWorker.js'),
      numWorkers: 1,
    });
    try {
      const pending = pool.parseFiles({
        workspaceRoot: '/ws',
        files: [
          { absolutePath: '/ws/a.ts' },
          { absolutePath: '/ws/b.ts' },
          { absolutePath: '/ws/c.ts' },
        ],
        tsconfigs: [],
        priority: 'low',
      });
      pending.catch(() => undefined);
      await pool.dispose();
      await assert.rejects(pending, WorkerPoolDisposedError);
      assert.equal(pool.stats().disposed, true);
    } finally {
      await pool.dispose();
    }
  });

  it('rejects new tasks immediately after dispose()', async () => {
    const pool = new WorkerPool({
      workerScript: mockWorker('errorWorker.js'),
      numWorkers: 1,
    });
    await pool.dispose();
    await assert.rejects(
      pool.parseFile({
        workspaceRoot: '/ws',
        file: { absolutePath: '/ws/late.ts' },
        tsconfigs: [],
      }),
      WorkerPoolDisposedError,
    );
  });
});

describe('FileSystemDiskCache robustness', () => {
  it('deletes corrupt JSON files on read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codemap-cache-corrupt-'));
    const key = 'file_x_ts';
    writeFileSync(join(dir, `${key}.json`), '{ not valid json');
    const cache = new FileSystemDiskCache(dir, 60_000);
    const value = await cache.get(key);
    assert.equal(value, undefined);
    await cache.load();
    assert.equal(await cache.get(key), undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it('deletes malformed cache envelopes on read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codemap-cache-malformed-'));
    const key = 'file_y_ts';
    writeFileSync(
      join(dir, `${key}.json`),
      JSON.stringify({ timestamp: Date.now(), noDataField: true }),
    );
    const cache = new FileSystemDiskCache(dir, 60_000);
    assert.equal(await cache.get(key), undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns a hit for valid entries and misses after invalidation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codemap-cache-hit-'));
    const cache = new FileSystemDiskCache(dir, 60_000);
    await cache.set('/proj/a.ts', { symbols: [] });
    assert.deepEqual(await cache.get('/proj/a.ts'), { symbols: [] });
    await cache.invalidate('/proj/a.ts');
    assert.equal(await cache.get('/proj/a.ts'), undefined);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('FileCache disk validation', () => {
  it('rejects structurally invalid disk entries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codemap-filecache-'));
    const disk = new FileSystemDiskCache(dir, 60_000);
    await disk.load();
    await disk.set('/proj/bad.ts', { only: 'garbage' });
    const cache = new FileCache(disk);
    assert.equal(await cache.getAsync('/proj/bad.ts'), undefined);
    assert.equal(await cache.hasAsync('/proj/bad.ts'), false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('accepts valid CachedFileParse entries from disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codemap-filecache-good-'));
    const disk = new FileSystemDiskCache(dir, 60_000);
    await disk.load();
    const entry = {
      absolutePath: '/proj/good.ts',
      relativePath: 'good.ts',
      contentHash: 'abc',
      mtimeMs: 1,
      imports: [],
      exports: [],
      symbols: [],
      dependencyPaths: [],
      dynamicImportPaths: [],
    };
    assert.ok(isCachedFileParse(entry));
    await disk.set('/proj/good.ts', entry);
    const cache = new FileCache(disk);
    const loaded = await cache.getAsync('/proj/good.ts');
    assert.deepEqual(loaded, entry);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('TraceCollector retention policy', () => {
  it('evicts oldest completed traces when maxCompletedTraces is exceeded', () => {
    const collector = new TraceCollector({ maxCompletedTraces: 2 });
    for (let i = 0; i < 3; i++) {
      collector.ingest({ type: 'trace-started', traceId: `t${i}`, startedAt: i });
      collector.ingest({ type: 'trace-completed', traceId: `t${i}`, completedAt: i + 1 });
    }
    const ids = collector.getCompletedTraces().map((t) => t.traceId);
    assert.deepEqual(ids, ['t1', 't2']);
    assert.equal(collector.getStats().evictedCompletedTraces, 1);
  });

  it('rejects spans beyond maxSpansPerTrace', () => {
    const collector = new TraceCollector({ maxSpansPerTrace: 2 });
    collector.ingest({ type: 'trace-started', traceId: 't1', startedAt: 0 });
    collector.ingest({ type: 'span-started', traceId: 't1', spanId: 's1', startedAt: 1 });
    collector.ingest({ type: 'span-started', traceId: 't1', spanId: 's2', startedAt: 2 });
    const third = collector.ingest({
      type: 'span-started',
      traceId: 't1',
      spanId: 's3',
      startedAt: 3,
    });
    assert.ok(third.issues.some((i) => i.code === 'span_limit_exceeded'));
    collector.ingest({ type: 'trace-completed', traceId: 't1', completedAt: 4 });
    assert.equal(collector.getCompletedTraces()[0]!.spans.length, 2);
    assert.equal(collector.getStats().droppedSpans, 1);
  });

  it('ignores late events for already-completed traces', () => {
    const collector = new TraceCollector();
    collector.ingest({ type: 'trace-started', traceId: 't1', startedAt: 0 });
    collector.ingest({ type: 'trace-completed', traceId: 't1', completedAt: 1 });
    const late = collector.ingest({
      type: 'span-started',
      traceId: 't1',
      spanId: 'late',
      startedAt: 2,
    });
    assert.ok(late.issues.some((i) => i.code === 'late_event'));
    assert.equal(collector.getStats().lateEvents, 1);
  });
});

describe('Failure isolation', () => {
  it('still produces a static overlay when runtime trace has no spans', () => {
    const analysis = analyzeWithCallChains('call-chain');
    const route = analysis.routes.find(
      (r) => r.method === 'POST' && r.path === '/api/login',
    );
    assert.ok(route);
    const staticTrace = traceRoute(analysis, route);
    const emptyRuntime: RuntimeTrace = {
      traceId: 'rt-empty',
      startedAt: 0,
      status: 'completed',
      spans: [],
      completedAt: 1,
      durationMs: 1,
    };
    const overlay = createTraceOverlay(staticTrace, emptyRuntime);
    assert.ok(overlay.nodes.length >= 1);
    assert.equal(overlay.runtimeTrace.traceId, 'rt-empty');
  });

  it('continues workspace analysis when one file is malformed', () => {
    const result = analyzeFixture('malformed');
    assert.ok(result.files.some((f) => f.relativePath.endsWith('good.ts')));
    assert.ok(result.parseErrorCount >= 1);
    assert.ok(result.graph.nodes.length >= 1);
  });

  it('layoutGraph falls back to incremental placement for large graphs', async () => {
    const nodes: GraphSnapshot['nodes'] = Array.from({ length: 500 }, (_, i) => ({
      id: `file:/ws/n${i}.ts`,
      kind: 'File' as const,
      label: `n${i}`,
      filePath: `/ws/n${i}.ts`,
      metadata: {},
    }));
    nodes.unshift({
      id: 'workspace:/ws',
      kind: 'Workspace',
      label: 'ws',
      filePath: '/ws',
      metadata: {},
    });
    const edges = nodes.slice(1).map((n, i) => ({
      id: `hierarchy:ws->${n.id}`,
      kind: 'hierarchy' as const,
      source: i === 0 ? 'workspace:/ws' : nodes[Math.floor(i / 10)]!.id,
      target: n.id,
    }));
    const snapshot: GraphSnapshot = {
      nodes,
      edges,
      generatedAt: 0,
      workspaceRoot: '/ws',
    };
    const result = await layoutGraph(snapshot);
    assert.equal(result.engine, 'incremental');
    assert.equal(result.nodes.length, nodes.length);
  });
});

describe('Phase 10 performance regressions', () => {
  it('mayContainExpressRoutes skips handler files that only import express types', () => {
    const handler = `
import type { Request, Response } from 'express';
export function handler(_req: Request, res: Response) {
  res.json({ ok: true });
}
`;
    const routeFile = `
import express from 'express';
import { handler } from './handler';
const app = express();
app.get('/items', handler);
export default app;
`;
    assert.equal(mayContainExpressRoutes(handler), false);
    assert.equal(mayContainExpressRoutes(routeFile), true);
  });

  it('SourceTextCache reuses published text and tracks hits', () => {
    const cache = new SourceTextCache(1024 * 1024);
    cache.set('/ws/a.ts', 'export const a = 1;');
    assert.equal(cache.read('/ws/a.ts'), 'export const a = 1;');
    const stats = cache.stats();
    assert.equal(stats.hits, 1);
    assert.equal(stats.entries, 1);
  });

  it('createCallResolver caches parsed files across repeated lookups', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codemap-resolver-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext' } }),
    );
    writeFileSync(
      join(dir, 'src', 'svc.ts'),
      'export function run() { helper(); }\nfunction helper() {}',
    );
    try {
      const resolver = createCallResolver(dir, [
        { configPath: join(dir, 'tsconfig.json'), baseDir: dir },
      ]);
      assert.equal(resolver.cachedFileCount, 0);
      resolver.resolve(join(dir, 'src', 'svc.ts'), 'run');
      assert.equal(resolver.cachedFileCount, 1);
      resolver.resolve(join(dir, 'src', 'svc.ts'), 'helper');
      assert.equal(resolver.cachedFileCount, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('analyzeAsync rejects with AnalysisCancelledError when aborted early', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codemap-cancel-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'cancel-test' }));
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext' } }),
    );
    for (let i = 0; i < 40; i++) {
      writeFileSync(join(dir, 'src', `f${i}.ts`), `export const v${i} = ${i};`);
    }
    const controller = new AbortController();
    const service = new WorkspaceAnalysisService();
    const promise = service.analyzeAsync(dir, { signal: controller.signal });
    controller.abort();
    await assert.rejects(promise, AnalysisCancelledError);
    rmSync(dir, { recursive: true, force: true });
  });

  it('records AnalysisTimings from a successful analysis run', () => {
    const result = analyzeFixture('small-app');
    assert.ok(result.timings);
    assert.ok(result.timings.scanMs >= 0);
    assert.ok(result.timings.parseMs >= 0);
  });
});

describe('Express instrumentation security boundary', () => {
  it('does not capture headers, cookies, or bodies in trace attributes', async () => {
    const collector = new TraceCollector();
    const app = express();
    const { instrumentExpress } = await import(
      '../src/runtime/instrumentation/instrumentation.ts'
    );
    instrumentExpress(app, {
      collector,
      includeRequestMetadata: true,
    });
    app.get('/secret', (req, res) => {
      req.headers.authorization = 'Bearer secret-token';
      (req as express.Request & { body?: unknown }).body = { password: 'hunter2' };
      res.status(204).end();
    });

    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      throw new Error('expected server address');
    }
    try {
      await fetch(`http://127.0.0.1:${addr.port}/secret`);
      const trace = collector.getCompletedTraces()[0]!;
      const serialized = JSON.stringify(trace.attributes ?? {});
      assert.equal(serialized.includes('secret-token'), false);
      assert.equal(serialized.includes('hunter2'), false);
      assert.equal(serialized.includes('authorization'), false);
      assert.equal(serialized.includes('cookie'), false);
      assert.deepEqual(Object.keys(trace.attributes ?? {}).sort(), [
        'httpMethod',
        'routePattern',
        'statusCode',
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
