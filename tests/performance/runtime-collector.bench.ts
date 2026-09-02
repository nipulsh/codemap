/**
 * Benchmark: TraceCollector.ingest() under realistic and adversarial event streams.
 *
 * Scenarios:
 *  - many small traces (HTTP-like: 1 handler span + a few nested spans)
 *  - one trace with many spans (1k / 10k / 50k) — ingestion cost per event
 *  - interleaved concurrent traces (events of N traces round-robin)
 *  - out-of-order / orphan / duplicate events
 *  - retention: completed-trace eviction and per-trace span limit
 *
 * Run: npx tsx --expose-gc tests/performance/runtime-collector.bench.ts
 */
import { TraceCollector } from '../../src/runtime/TraceCollector.ts';
import type { RuntimeTraceEvent } from '../../src/runtime/types.ts';
import {
  createSuite,
  isDirectRun,
  measureSync,
  round,
  runSuiteMain,
  type BenchmarkSuiteResult,
} from './benchmark-utils.ts';

/** Build the event stream for one trace with `spanCount` spans nested at random depth. */
export function traceEvents(
  traceId: string,
  spanCount: number,
  base = 1_700_000_000_000,
): RuntimeTraceEvent[] {
  const events: RuntimeTraceEvent[] = [
    { type: 'trace-started', traceId, routeId: 'route:bench', startedAt: base },
  ];
  const spanIds: string[] = [];
  for (let i = 0; i < spanCount; i++) {
    const spanId = `${traceId}:span:${i}`;
    const parentSpanId = i === 0 ? undefined : spanIds[(i * 7919) % i];
    spanIds.push(spanId);
    events.push({
      type: 'span-started',
      traceId,
      spanId,
      parentSpanId,
      functionName: `fn${i % 50}`,
      filePath: `/ws/src/svc/svc${i % 10}.ts`,
      line: (i % 40) + 1,
      startedAt: base + i,
    });
  }
  for (let i = spanCount - 1; i >= 0; i--) {
    if (i % 101 === 0) {
      events.push({
        type: 'span-errored',
        traceId,
        spanId: spanIds[i]!,
        completedAt: base + spanCount + i,
        error: { name: 'Error', message: 'boom' },
      });
    } else {
      events.push({
        type: 'span-completed',
        traceId,
        spanId: spanIds[i]!,
        completedAt: base + spanCount + i,
      });
    }
  }
  events.push({
    type: 'trace-completed',
    traceId,
    completedAt: base + 2 * spanCount + 1,
    attributes: { httpMethod: 'GET', routePattern: '/api/items/:id', statusCode: 200 },
  });
  return events;
}

function interleave(streams: RuntimeTraceEvent[][]): RuntimeTraceEvent[] {
  const out: RuntimeTraceEvent[] = [];
  const max = Math.max(...streams.map((s) => s.length));
  for (let i = 0; i < max; i++) {
    for (const s of streams) {
      if (i < s.length) {
        out.push(s[i]!);
      }
    }
  }
  return out;
}

function ingestAll(collector: TraceCollector, events: RuntimeTraceEvent[]): number {
  let issues = 0;
  for (const event of events) {
    issues += collector.ingest(event).issues.length;
  }
  return issues;
}

export async function runRuntimeCollectorBenchmark(): Promise<BenchmarkSuiteResult> {
  const suite = createSuite(
    'runtime-collector',
    'TraceCollector.ingest() throughput, ordering robustness, and retention behaviour',
  );

  // Many small HTTP-like traces.
  for (const traceCount of [1_000, 10_000]) {
    const events = Array.from({ length: traceCount }, (_, i) =>
      traceEvents(`trace:${i}`, 5),
    ).flat();
    const collector = new TraceCollector({ maxCompletedTraces: traceCount });
    const { measurement } = measureSync(
      `${traceCount} traces × 5 spans`,
      () => ingestAll(collector, events),
      (issues, ms) => ({
        events: events.length,
        issues,
        completed: collector.getStats().completedTraces,
        active: collector.getStats().activeTraces,
        usPerEvent: round((ms * 1000) / events.length, 2),
      }),
    );
    suite.measurements.push(measurement);
  }

  // One very large trace.
  for (const spanCount of [1_000, 10_000, 50_000]) {
    const events = traceEvents('trace:big', spanCount);
    const collector = new TraceCollector({ maxSpansPerTrace: 100_000 });
    const { measurement } = measureSync(
      `1 trace × ${spanCount} spans`,
      () => ingestAll(collector, events),
      (issues, ms) => ({
        events: events.length,
        issues,
        spansKept: collector.getCompletedTraces()[0]?.spans.length ?? 0,
        usPerEvent: round((ms * 1000) / events.length, 2),
      }),
    );
    suite.measurements.push(measurement);
  }

  // Interleaved concurrent traces (events of many in-flight traces round-robin).
  {
    const streams = Array.from({ length: 500 }, (_, i) => traceEvents(`trace:c${i}`, 20));
    const events = interleave(streams);
    const collector = new TraceCollector();
    const { measurement } = measureSync(
      '500 interleaved traces × 20 spans',
      () => ingestAll(collector, events),
      (issues, ms) => {
        const stats = collector.getStats();
        return {
          events: events.length,
          issues,
          completed: stats.completedTraces,
          active: stats.activeTraces,
          usPerEvent: round((ms * 1000) / events.length, 2),
        };
      },
    );
    suite.measurements.push(measurement);
  }

  // Out-of-order + orphan + duplicate + late events.
  {
    const base = traceEvents('trace:ooo', 2_000);
    const shuffled = [...base];
    // Deterministic shuffle of the middle (keep trace-started first, trace-completed last).
    let seed = 12345;
    for (let i = shuffled.length - 2; i > 1; i--) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      const j = 1 + (seed % i);
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    const events: RuntimeTraceEvent[] = [
      ...shuffled,
      // duplicates and late events after completion
      ...base.slice(1, 200),
    ];
    const collector = new TraceCollector();
    const { measurement } = measureSync(
      'out-of-order + duplicate + late events (2k spans)',
      () => ingestAll(collector, events),
      (issues, ms) => {
        const stats = collector.getStats();
        return {
          events: events.length,
          issues,
          lateEvents: stats.lateEvents,
          completed: stats.completedTraces,
          active: stats.activeTraces,
          usPerEvent: round((ms * 1000) / events.length, 2),
        };
      },
    );
    suite.measurements.push(measurement);
  }

  // Retention: completed-trace FIFO eviction and per-trace span limit.
  {
    const events = Array.from({ length: 5_000 }, (_, i) =>
      traceEvents(`trace:r${i}`, 4),
    ).flat();
    const collector = new TraceCollector({ maxCompletedTraces: 1_000 });
    const { measurement } = measureSync(
      'retention: 5k traces into maxCompletedTraces=1000',
      () => ingestAll(collector, events),
      (issues, ms) => {
        const stats = collector.getStats();
        return {
          events: events.length,
          issues,
          completed: stats.completedTraces,
          evicted: stats.evictedCompletedTraces,
          usPerEvent: round((ms * 1000) / events.length, 2),
        };
      },
    );
    suite.measurements.push(measurement);

    const bigEvents = traceEvents('trace:cap', 20_000);
    const capped = new TraceCollector({ maxSpansPerTrace: 5_000 });
    const cappedRun = measureSync(
      'retention: 20k-span trace into maxSpansPerTrace=5000',
      () => ingestAll(capped, bigEvents),
      (issues, ms) => {
        const stats = capped.getStats();
        return {
          events: bigEvents.length,
          issues,
          spansKept: capped.getCompletedTraces()[0]?.spans.length ?? 0,
          droppedSpans: stats.droppedSpans,
          usPerEvent: round((ms * 1000) / bigEvents.length, 2),
        };
      },
    );
    suite.measurements.push(cappedRun.measurement);
  }

  suite.notes.push(
    'usPerEvent should be roughly constant across span counts: sessions no longer re-sort spans on every event (sorting happens once per snapshot).',
    'issues counts collector diagnostics (orphan completions, duplicates, late events, dropped spans); none of them throw.',
  );
  return suite;
}

if (isDirectRun(import.meta.url)) {
  void runSuiteMain(runRuntimeCollectorBenchmark);
}
