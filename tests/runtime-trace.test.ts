import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TraceCollector } from '../src/runtime/TraceCollector.ts';
import {
  RuntimeTraceEventSchema,
  RuntimeTraceSchema,
  RUNTIME_TRACE_LIMITATIONS,
  computeDurationMs,
  serializeRuntimeTrace,
} from '../src/runtime/types.ts';
import type { RuntimeTraceEvent } from '../src/runtime/types.ts';
import {
  buildStaticSymbolIndex,
  correlateRuntimeSpan,
  staticSymbolEntry,
} from '../src/runtime/TraceCorrelation.ts';

function runEvents(collector: TraceCollector, events: RuntimeTraceEvent[]) {
  const allIssues = [];
  for (const event of events) {
    const result = collector.ingest(event);
    allIssues.push(...result.issues);
  }
  return allIssues;
}

describe('TraceCollector trace lifecycle', () => {
  it('records started → completed trace lifecycle', () => {
    const collector = new TraceCollector();
    runEvents(collector, [
      { type: 'trace-started', traceId: 't1', startedAt: 1000 },
      { type: 'trace-completed', traceId: 't1', completedAt: 1500 },
    ]);

    const traces = collector.getCompletedTraces();
    assert.equal(traces.length, 1);
    assert.equal(traces[0]!.status, 'completed');
    assert.equal(traces[0]!.startedAt, 1000);
    assert.equal(traces[0]!.completedAt, 1500);
    assert.equal(traces[0]!.durationMs, 500);
  });
});

describe('TraceCollector span lifecycle', () => {
  it('records span started → completed', () => {
    const collector = new TraceCollector();
    runEvents(collector, [
      { type: 'trace-started', traceId: 't1', startedAt: 1000 },
      {
        type: 'span-started',
        traceId: 't1',
        spanId: 's1',
        startedAt: 1005,
        functionName: 'handler',
      },
      { type: 'span-completed', traceId: 't1', spanId: 's1', completedAt: 1100 },
      { type: 'trace-completed', traceId: 't1', completedAt: 1200 },
    ]);

    const trace = collector.getCompletedTraces()[0]!;
    assert.equal(trace.spans.length, 1);
    assert.equal(trace.spans[0]!.status, 'completed');
    assert.equal(trace.spans[0]!.durationMs, 95);
  });
});

describe('TraceCollector parent-child spans', () => {
  it('preserves parent-child relationship A → B', () => {
    const collector = new TraceCollector();
    runEvents(collector, [
      { type: 'trace-started', traceId: 't1', startedAt: 0 },
      { type: 'span-started', traceId: 't1', spanId: 'a', startedAt: 1 },
      {
        type: 'span-started',
        traceId: 't1',
        spanId: 'b',
        parentSpanId: 'a',
        startedAt: 2,
      },
      { type: 'span-completed', traceId: 't1', spanId: 'b', completedAt: 3 },
      { type: 'span-completed', traceId: 't1', spanId: 'a', completedAt: 4 },
      { type: 'trace-completed', traceId: 't1', completedAt: 5 },
    ]);

    const trace = collector.getCompletedTraces()[0]!;
    const b = trace.spans.find((s) => s.spanId === 'b');
    assert.equal(b?.parentSpanId, 'a');
  });

  it('supports multiple children A → B and A → C', () => {
    const collector = new TraceCollector();
    runEvents(collector, [
      { type: 'trace-started', traceId: 't1', startedAt: 0 },
      { type: 'span-started', traceId: 't1', spanId: 'a', startedAt: 1 },
      {
        type: 'span-started',
        traceId: 't1',
        spanId: 'b',
        parentSpanId: 'a',
        startedAt: 2,
      },
      {
        type: 'span-started',
        traceId: 't1',
        spanId: 'c',
        parentSpanId: 'a',
        startedAt: 2,
      },
      { type: 'trace-completed', traceId: 't1', completedAt: 10 },
    ]);

    const trace = collector.getCompletedTraces()[0]!;
    const children = trace.spans.filter((s) => s.parentSpanId === 'a');
    assert.equal(children.length, 2);
    assert.deepEqual(
      children.map((s) => s.spanId).sort(),
      ['b', 'c'],
    );
  });

  it('supports nested spans at least three levels deep', () => {
    const collector = new TraceCollector();
    runEvents(collector, [
      { type: 'trace-started', traceId: 't1', startedAt: 0 },
      { type: 'span-started', traceId: 't1', spanId: 'd0', startedAt: 1 },
      {
        type: 'span-started',
        traceId: 't1',
        spanId: 'd1',
        parentSpanId: 'd0',
        startedAt: 2,
      },
      {
        type: 'span-started',
        traceId: 't1',
        spanId: 'd2',
        parentSpanId: 'd1',
        startedAt: 3,
      },
      { type: 'trace-completed', traceId: 't1', completedAt: 10 },
    ]);

    const trace = collector.getCompletedTraces()[0]!;
    assert.equal(trace.spans.length, 3);
    const d2 = trace.spans.find((s) => s.spanId === 'd2');
    assert.equal(d2?.parentSpanId, 'd1');
  });
});

describe('TraceCollector errors', () => {
  it('preserves span error status and message', () => {
    const collector = new TraceCollector();
    runEvents(collector, [
      { type: 'trace-started', traceId: 't1', startedAt: 0 },
      { type: 'span-started', traceId: 't1', spanId: 's1', startedAt: 1 },
      {
        type: 'span-errored',
        traceId: 't1',
        spanId: 's1',
        completedAt: 5,
        error: { name: 'TypeError', message: 'boom' },
      },
      { type: 'trace-completed', traceId: 't1', completedAt: 6 },
    ]);

    const trace = collector.getCompletedTraces()[0]!;
    const span = trace.spans[0]!;
    assert.equal(span.status, 'error');
    assert.equal(span.error?.name, 'TypeError');
    assert.equal(span.error?.message, 'boom');
  });

  it('marks trace status as error when a span errored', () => {
    const collector = new TraceCollector();
    runEvents(collector, [
      { type: 'trace-started', traceId: 't1', startedAt: 0 },
      { type: 'span-started', traceId: 't1', spanId: 's1', startedAt: 1 },
      {
        type: 'span-errored',
        traceId: 't1',
        spanId: 's1',
        completedAt: 5,
        error: { message: 'failed' },
      },
      { type: 'trace-completed', traceId: 't1', completedAt: 6 },
    ]);

    assert.equal(collector.getCompletedTraces()[0]!.status, 'error');
  });
});

describe('TraceCollector timing', () => {
  it('calculates duration from producer timestamps', () => {
    assert.equal(computeDurationMs(100, 250), 150);
    assert.equal(computeDurationMs(undefined, 250), undefined);
    assert.equal(computeDurationMs(100, undefined), undefined);
    assert.equal(computeDurationMs(250, 100), undefined);
  });

  it('leaves duration undefined when completion timestamp is missing', () => {
    const collector = new TraceCollector();
    collector.ingest({ type: 'trace-started', traceId: 't1', startedAt: 100 });
    collector.ingest({
      type: 'span-started',
      traceId: 't1',
      spanId: 's1',
      startedAt: 110,
    });

    const active = collector.getActiveTrace('t1');
    assert.equal(active?.spans[0]!.durationMs, undefined);
    assert.equal(active?.spans[0]!.status, 'active');
  });
});

describe('TraceCollector out-of-order events', () => {
  it('tolerates child completed before parent completed', () => {
    const collector = new TraceCollector();
    runEvents(collector, [
      { type: 'trace-started', traceId: 't1', startedAt: 0 },
      { type: 'span-started', traceId: 't1', spanId: 'a', startedAt: 1 },
      {
        type: 'span-started',
        traceId: 't1',
        spanId: 'b',
        parentSpanId: 'a',
        startedAt: 2,
      },
      { type: 'span-completed', traceId: 't1', spanId: 'b', completedAt: 3 },
      { type: 'span-completed', traceId: 't1', spanId: 'a', completedAt: 4 },
      { type: 'trace-completed', traceId: 't1', completedAt: 5 },
    ]);

    const trace = collector.getCompletedTraces()[0]!;
    assert.equal(trace.spans.find((s) => s.spanId === 'b')?.durationMs, 1);
  });

  it('tolerates span completion before span start', () => {
    const collector = new TraceCollector();
    const issues = runEvents(collector, [
      { type: 'trace-started', traceId: 't1', startedAt: 0 },
      { type: 'span-completed', traceId: 't1', spanId: 's1', completedAt: 5 },
      {
        type: 'span-started',
        traceId: 't1',
        spanId: 's1',
        startedAt: 1,
        functionName: 'lateStart',
      },
      { type: 'trace-completed', traceId: 't1', completedAt: 10 },
    ]);

    assert.ok(issues.some((i) => i.code === 'orphan_completion'));
    const span = collector.getCompletedTraces()[0]!.spans[0]!;
    assert.equal(span.status, 'completed');
    assert.equal(span.durationMs, 4);
    assert.equal(span.functionName, 'lateStart');
  });

  it('does not crash on unknown parent span reference', () => {
    const collector = new TraceCollector();
    const issues = runEvents(collector, [
      { type: 'trace-started', traceId: 't1', startedAt: 0 },
      {
        type: 'span-started',
        traceId: 't1',
        spanId: 'child',
        parentSpanId: 'missing-parent',
        startedAt: 1,
      },
      { type: 'trace-completed', traceId: 't1', completedAt: 2 },
    ]);

    assert.ok(issues.some((i) => i.code === 'unknown_parent_span'));
    const child = collector.getCompletedTraces()[0]!.spans[0]!;
    assert.equal(child.parentSpanId, 'missing-parent');
  });
});

describe('TraceCollector unresolved spans', () => {
  it('keeps unresolved runtime span without fabricating symbolId', () => {
    const collector = new TraceCollector();
    runEvents(collector, [
      { type: 'trace-started', traceId: 't1', startedAt: 0 },
      {
        type: 'span-started',
        traceId: 't1',
        spanId: 's1',
        startedAt: 1,
        functionName: 'unknownHandler',
      },
      { type: 'trace-completed', traceId: 't1', completedAt: 2 },
    ]);

    const span = collector.getCompletedTraces()[0]!.spans[0]!;
    assert.equal(span.resolution, 'unresolved');
    assert.equal(span.functionName, 'unknownHandler');
    assert.equal(span.symbolId, undefined);
  });
});

describe('TraceCollector route correlation', () => {
  it('preserves supplied routeId on the trace', () => {
    const collector = new TraceCollector();
    runEvents(collector, [
      {
        type: 'trace-started',
        traceId: 't1',
        routeId: 'route:get:/api/users',
        startedAt: 0,
      },
      { type: 'trace-completed', traceId: 't1', completedAt: 1 },
    ]);

    assert.equal(
      collector.getCompletedTraces()[0]!.routeId,
      'route:get:/api/users',
    );
  });
});

describe('TraceCollector determinism', () => {
  it('produces equivalent serialized output for the same event sequence', () => {
    const events: RuntimeTraceEvent[] = [
      { type: 'trace-started', traceId: 't1', startedAt: 0 },
      { type: 'span-started', traceId: 't1', spanId: 'b', startedAt: 2 },
      { type: 'span-started', traceId: 't1', spanId: 'a', startedAt: 1 },
      { type: 'trace-completed', traceId: 't1', completedAt: 10 },
    ];

    const c1 = new TraceCollector();
    const c2 = new TraceCollector();
    runEvents(c1, events);
    runEvents(c2, events);

    const s1 = JSON.stringify(serializeRuntimeTrace(c1.getCompletedTraces()[0]!));
    const s2 = JSON.stringify(serializeRuntimeTrace(c2.getCompletedTraces()[0]!));
    assert.equal(s1, s2);
  });
});

describe('TraceCorrelation exact matching', () => {
  const entry = staticSymbolEntry('/proj/src/handler.ts', 'loginHandler', 12);
  const index = buildStaticSymbolIndex([entry]);

  it('resolves by exact symbolId', () => {
    const result = correlateRuntimeSpan({ symbolId: entry.symbolId }, index);
    assert.equal(result.resolution, 'resolved');
    assert.equal(result.symbolId, entry.symbolId);
  });

  it('resolves by exact filePath + line + functionName', () => {
    const result = correlateRuntimeSpan(
      {
        filePath: '/proj/src/handler.ts',
        line: 12,
        functionName: 'loginHandler',
      },
      index,
    );
    assert.equal(result.resolution, 'resolved');
    assert.equal(result.symbolId, entry.symbolId);
  });

  it('returns unresolved when no exact match exists', () => {
    const result = correlateRuntimeSpan(
      { functionName: 'unknownHandler' },
      index,
    );
    assert.equal(result.resolution, 'unresolved');
    assert.equal(result.symbolId, undefined);
  });

  it('does not fabricate symbolId for unknown runtime metadata', () => {
    const result = correlateRuntimeSpan(
      { functionName: 'unknownHandler', filePath: '/other.ts', line: 1 },
      index,
    );
    assert.equal(result.resolution, 'unresolved');
    assert.equal(result.symbolId, undefined);
  });
});

describe('TraceCollector symbol correlation integration', () => {
  it('enriches spans with resolved symbolId from static index', () => {
    const entry = staticSymbolEntry('/proj/service.ts', 'getUser', 40);
    const collector = new TraceCollector();
    collector.setSymbolIndex(buildStaticSymbolIndex([entry]));

    runEvents(collector, [
      { type: 'trace-started', traceId: 't1', startedAt: 0 },
      {
        type: 'span-started',
        traceId: 't1',
        spanId: 's1',
        startedAt: 1,
        filePath: '/proj/service.ts',
        line: 40,
        functionName: 'getUser',
      },
      { type: 'trace-completed', traceId: 't1', completedAt: 2 },
    ]);

    const span = collector.getCompletedTraces()[0]!.spans[0]!;
    assert.equal(span.resolution, 'resolved');
    assert.equal(span.symbolId, entry.symbolId);
  });
});

describe('runtime trace serialization schemas', () => {
  it('validates RuntimeTrace wire shape', () => {
    const trace = {
      traceId: 't1',
      startedAt: 0,
      status: 'completed' as const,
      spans: [],
      completedAt: 1,
      durationMs: 1,
    };
    assert.ok(RuntimeTraceSchema.safeParse(trace).success);
  });

  it('validates RuntimeTraceEvent wire shapes', () => {
    const event = {
      type: 'span-errored' as const,
      traceId: 't1',
      spanId: 's1',
      completedAt: 5,
      error: { message: 'x' },
    };
    assert.ok(RuntimeTraceEventSchema.safeParse(event).success);
  });
});

describe('TraceCollector session management', () => {
  it('disposes active sessions without moving them to completed traces', () => {
    const collector = new TraceCollector();
    collector.ingest({ type: 'trace-started', traceId: 't1', startedAt: 0 });
    assert.ok(collector.getActiveTrace('t1'));
    assert.ok(collector.dispose('t1'));
    assert.equal(collector.getActiveTrace('t1'), undefined);
    assert.equal(collector.getCompletedTraces().length, 0);
  });

  it('clears active and completed traces', () => {
    const collector = new TraceCollector();
    runEvents(collector, [
      { type: 'trace-started', traceId: 't1', startedAt: 0 },
      { type: 'trace-completed', traceId: 't1', completedAt: 1 },
    ]);
    collector.clear();
    assert.equal(collector.getCompletedTraces().length, 0);
  });
});

describe('static vs runtime semantics', () => {
  it('documents that runtime traces are observational evidence', () => {
    assert.ok(
      RUNTIME_TRACE_LIMITATIONS.some((l) => l.includes('observed execution')),
    );
    assert.ok(
      RUNTIME_TRACE_LIMITATIONS.some((l) => l.includes('static')),
    );
  });
});
