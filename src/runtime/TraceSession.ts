import {
  computeDurationMs,
  createActiveSpan,
  createActiveTrace,
  type CollectorIssue,
  type RuntimeSpan,
  type RuntimeTrace,
  type RuntimeTraceEvent,
  serializeRuntimeTrace,
} from './types';
import {
  correlateRuntimeSpan,
  type StaticSymbolIndex,
} from './TraceCorrelation';

interface PendingSpanFinish {
  completedAt: number;
  status: 'completed' | 'error';
  error?: { name?: string; message: string };
}

export interface TraceSessionLimits {
  /**
   * Maximum spans retained for this trace. Additional span-started events are
   * rejected with a `span_limit_exceeded` issue; the trace itself still
   * completes normally. Orphan completions are bounded by the same budget.
   */
  maxSpansPerTrace: number;
}

export class TraceSession {
  private readonly trace: RuntimeTrace;
  private readonly spans = new Map<string, RuntimeSpan>();
  private readonly pendingFinishes = new Map<string, PendingSpanFinish>();
  private readonly issues: CollectorIssue[] = [];
  private completed = false;
  private droppedSpans = 0;

  constructor(
    traceId: string,
    startedAt: number,
    routeId?: string,
    private readonly limits: TraceSessionLimits = {
      maxSpansPerTrace: Number.POSITIVE_INFINITY,
    },
  ) {
    this.trace = createActiveTrace(traceId, startedAt, routeId);
  }

  get traceId(): string {
    return this.trace.traceId;
  }

  get spanCount(): number {
    return this.spans.size;
  }

  /** Spans rejected because maxSpansPerTrace was reached. */
  get droppedSpanCount(): number {
    return this.droppedSpans;
  }

  isCompleted(): boolean {
    return this.completed;
  }

  apply(
    event: RuntimeTraceEvent,
    symbolIndex?: StaticSymbolIndex,
  ): CollectorIssue[] {
    const eventIssues: CollectorIssue[] = [];

    switch (event.type) {
      case 'trace-started':
        if (event.routeId !== undefined) {
          this.trace.routeId = event.routeId;
        }
        if (event.startedAt < this.trace.startedAt) {
          this.trace.startedAt = event.startedAt;
        }
        break;

      case 'span-started':
        eventIssues.push(...this.handleSpanStarted(event, symbolIndex));
        break;

      case 'span-completed':
        eventIssues.push(...this.handleSpanCompleted(event));
        break;

      case 'span-errored':
        eventIssues.push(...this.handleSpanErrored(event));
        break;

      case 'trace-completed':
        this.handleTraceCompleted(event);
        break;
    }

    this.issues.push(...eventIssues);
    return eventIssues;
  }

  /**
   * Snapshot of the trace with spans sorted by spanId. Sorting happens here,
   * once per snapshot, rather than on every ingested event.
   */
  toTrace(): RuntimeTrace {
    return serializeRuntimeTrace({
      ...this.trace,
      spans: [...this.spans.values()],
    });
  }

  getIssues(): CollectorIssue[] {
    return [...this.issues];
  }

  private handleSpanStarted(
    event: Extract<RuntimeTraceEvent, { type: 'span-started' }>,
    symbolIndex?: StaticSymbolIndex,
  ): CollectorIssue[] {
    const issues: CollectorIssue[] = [];

    if (this.spans.has(event.spanId)) {
      issues.push({
        code: 'duplicate_span_start',
        message: `Span ${event.spanId} already started`,
        event,
      });
      return issues;
    }

    if (this.spans.size >= this.limits.maxSpansPerTrace) {
      this.droppedSpans += 1;
      issues.push({
        code: 'span_limit_exceeded',
        message: `Span ${event.spanId} dropped: trace already holds ${this.spans.size} spans (limit ${this.limits.maxSpansPerTrace})`,
        event,
      });
      return issues;
    }

    if (
      event.parentSpanId &&
      !this.spans.has(event.parentSpanId) &&
      !this.pendingFinishes.has(event.parentSpanId)
    ) {
      issues.push({
        code: 'unknown_parent_span',
        message: `Parent span ${event.parentSpanId} not seen yet`,
        event,
      });
    }

    const correlation = symbolIndex
      ? correlateRuntimeSpan(
          {
            symbolId: event.symbolId,
            filePath: event.filePath,
            line: event.line,
            functionName: event.functionName,
          },
          symbolIndex,
        )
      : {
          symbolId: event.symbolId,
          functionName: event.functionName,
          filePath: event.filePath,
          line: event.line,
          resolution: event.symbolId ? ('resolved' as const) : ('unresolved' as const),
        };

    const span = createActiveSpan(event, correlation.resolution);
    span.symbolId = correlation.symbolId;
    span.functionName = correlation.functionName ?? span.functionName;
    span.filePath = correlation.filePath ?? span.filePath;
    span.line = correlation.line ?? span.line;

    const pending = this.pendingFinishes.get(event.spanId);
    if (pending) {
      this.applyFinish(span, pending);
      this.pendingFinishes.delete(event.spanId);
    }

    this.spans.set(event.spanId, span);
    return issues;
  }

  private handleSpanCompleted(
    event: Extract<RuntimeTraceEvent, { type: 'span-completed' }>,
  ): CollectorIssue[] {
    const span = this.spans.get(event.spanId);
    if (!span) {
      this.rememberOrphanFinish(event.spanId, {
        completedAt: event.completedAt,
        status: 'completed',
      });
      return [
        {
          code: 'orphan_completion',
          message: `Span ${event.spanId} completed before start event`,
          event,
        },
      ];
    }

    span.status = 'completed';
    span.completedAt = event.completedAt;
    span.durationMs = computeDurationMs(span.startedAt, span.completedAt);
    span.error = undefined;
    return [];
  }

  private handleSpanErrored(
    event: Extract<RuntimeTraceEvent, { type: 'span-errored' }>,
  ): CollectorIssue[] {
    const span = this.spans.get(event.spanId);
    if (!span) {
      this.rememberOrphanFinish(event.spanId, {
        completedAt: event.completedAt,
        status: 'error',
        error: event.error,
      });
      return [
        {
          code: 'orphan_completion',
          message: `Span ${event.spanId} errored before start event`,
          event,
        },
      ];
    }

    span.status = 'error';
    span.completedAt = event.completedAt;
    span.durationMs = computeDurationMs(span.startedAt, span.completedAt);
    span.error = { ...event.error };
    return [];
  }

  private handleTraceCompleted(
    event: Extract<RuntimeTraceEvent, { type: 'trace-completed' }>,
  ): void {
    this.trace.completedAt = event.completedAt;
    this.trace.durationMs = computeDurationMs(
      this.trace.startedAt,
      this.trace.completedAt,
    );
    if (event.attributes) {
      this.trace.attributes = { ...event.attributes };
    }
    let hasError = false;
    for (const span of this.spans.values()) {
      if (span.status === 'error') {
        hasError = true;
        break;
      }
    }
    this.trace.status = hasError ? 'error' : 'completed';
    this.completed = true;
  }

  private applyFinish(span: RuntimeSpan, pending: PendingSpanFinish): void {
    span.status = pending.status;
    span.completedAt = pending.completedAt;
    span.durationMs = computeDurationMs(span.startedAt, span.completedAt);
    if (pending.status === 'error' && pending.error) {
      span.error = { ...pending.error };
    }
  }

  /** Orphan completions share the span budget so they cannot grow unbounded. */
  private rememberOrphanFinish(spanId: string, finish: PendingSpanFinish): void {
    if (
      !this.pendingFinishes.has(spanId) &&
      this.pendingFinishes.size >= this.limits.maxSpansPerTrace
    ) {
      return;
    }
    this.pendingFinishes.set(spanId, finish);
  }
}
