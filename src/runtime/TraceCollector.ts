import { TraceSession } from './TraceSession';
import {
  type CollectorIssue,
  type CollectorResult,
  type RuntimeTrace,
  type RuntimeTraceEvent,
} from './types';
import type { StaticSymbolIndex } from './TraceCorrelation';

/**
 * Bounded retention for runtime traces.
 *
 * Eviction semantics (all deterministic, none silent — every drop is counted
 * in `getStats()` and, where an event is involved, reported as a CollectorIssue):
 *
 * - `maxCompletedTraces`: completed traces are kept in completion order (FIFO).
 *   When the limit is exceeded the oldest completed trace is evicted.
 *   Active traces are never evicted by this rule.
 * - `maxSpansPerTrace`: once a trace holds this many spans, further
 *   span-started events for it are rejected (`span_limit_exceeded`). The trace
 *   still completes normally with the spans it has.
 * - `maxActiveTraces`: when this many traces are simultaneously active, events
 *   that would open a new trace are rejected (`active_trace_limit`). Existing
 *   active traces are never deleted to make room.
 */
export interface TraceRetentionOptions {
  maxCompletedTraces?: number;
  maxSpansPerTrace?: number;
  maxActiveTraces?: number;
}

export const DEFAULT_TRACE_RETENTION: Required<TraceRetentionOptions> = {
  maxCompletedTraces: 1000,
  maxSpansPerTrace: 10_000,
  maxActiveTraces: 10_000,
};

export interface TraceCollectorStats {
  activeTraces: number;
  completedTraces: number;
  /** Completed traces evicted by maxCompletedTraces since the last clear(). */
  evictedCompletedTraces: number;
  /** span-started events rejected by maxSpansPerTrace since the last clear(). */
  droppedSpans: number;
  /** Traces rejected by maxActiveTraces since the last clear(). */
  rejectedTraces: number;
  /** Events ignored because their trace had already completed. */
  lateEvents: number;
  retention: Required<TraceRetentionOptions>;
}

export class TraceCollector {
  private readonly sessions = new Map<string, TraceSession>();
  /** Completed traces in completion order; the Map preserves insertion order. */
  private readonly completed = new Map<string, RuntimeTrace>();
  private symbolIndex?: StaticSymbolIndex;
  private retention: Required<TraceRetentionOptions>;
  private evictedCompletedTraces = 0;
  private droppedSpans = 0;
  private rejectedTraces = 0;
  private lateEvents = 0;

  constructor(retention: TraceRetentionOptions = {}) {
    this.retention = normalizeRetention(retention);
  }

  setSymbolIndex(index: StaticSymbolIndex | undefined): void {
    this.symbolIndex = index;
  }

  getRetention(): Required<TraceRetentionOptions> {
    return { ...this.retention };
  }

  /** Update retention; a lower maxCompletedTraces evicts oldest traces immediately. */
  setRetention(retention: TraceRetentionOptions): void {
    this.retention = normalizeRetention({ ...this.retention, ...retention });
    this.evictCompleted();
  }

  ingest(event: RuntimeTraceEvent): CollectorResult {
    const resolved = this.ensureSession(event);
    if (!resolved.session) {
      return { traceId: event.traceId, issues: resolved.issues };
    }

    const { session } = resolved;
    const issues = [...resolved.issues, ...session.apply(event, this.symbolIndex)];
    for (const issue of issues) {
      if (issue.code === 'span_limit_exceeded') {
        this.droppedSpans += 1;
      }
    }

    if (session.isCompleted()) {
      this.sessions.delete(event.traceId);
      this.completed.set(event.traceId, session.toTrace());
      this.evictCompleted();
    }

    return {
      traceId: event.traceId,
      issues,
    };
  }

  getActiveTrace(traceId: string): RuntimeTrace | undefined {
    return this.sessions.get(traceId)?.toTrace();
  }

  getActiveTraceIds(): string[] {
    return [...this.sessions.keys()];
  }

  /** Completed traces in completion order (oldest first). Spans are already sorted. */
  getCompletedTraces(): RuntimeTrace[] {
    return [...this.completed.values()].map((trace) => ({
      ...trace,
      spans: [...trace.spans],
    }));
  }

  getTrace(traceId: string): RuntimeTrace | undefined {
    const active = this.getActiveTrace(traceId);
    if (active) {
      return active;
    }
    const done = this.completed.get(traceId);
    return done ? { ...done, spans: [...done.spans] } : undefined;
  }

  dispose(traceId: string): boolean {
    return this.sessions.delete(traceId);
  }

  clear(): void {
    this.sessions.clear();
    this.completed.clear();
    this.evictedCompletedTraces = 0;
    this.droppedSpans = 0;
    this.rejectedTraces = 0;
    this.lateEvents = 0;
  }

  getStats(): TraceCollectorStats {
    return {
      activeTraces: this.sessions.size,
      completedTraces: this.completed.size,
      evictedCompletedTraces: this.evictedCompletedTraces,
      droppedSpans: this.droppedSpans,
      rejectedTraces: this.rejectedTraces,
      lateEvents: this.lateEvents,
      retention: this.getRetention(),
    };
  }

  private evictCompleted(): void {
    while (this.completed.size > this.retention.maxCompletedTraces) {
      const oldest = this.completed.keys().next();
      if (oldest.done) {
        break;
      }
      this.completed.delete(oldest.value);
      this.evictedCompletedTraces += 1;
    }
  }

  private ensureSession(event: RuntimeTraceEvent): {
    session: TraceSession | undefined;
    issues: CollectorIssue[];
  } {
    const existing = this.sessions.get(event.traceId);
    if (existing) {
      return { session: existing, issues: [] };
    }

    // A completion/span event for a trace that already finished (e.g. a
    // background span outliving the HTTP response) must not resurrect the trace
    // as a never-completing session. Record it and drop it.
    if (this.completed.has(event.traceId)) {
      this.lateEvents += 1;
      return {
        session: undefined,
        issues: [
          {
            code: 'late_event',
            message: `Ignored ${event.type} for already-completed trace ${event.traceId}`,
            event,
          },
        ],
      };
    }

    if (this.sessions.size >= this.retention.maxActiveTraces) {
      this.rejectedTraces += 1;
      return {
        session: undefined,
        issues: [
          {
            code: 'active_trace_limit',
            message: `Rejected ${event.type} for ${event.traceId}: ${this.sessions.size} active traces (limit ${this.retention.maxActiveTraces})`,
            event,
          },
        ],
      };
    }

    const limits = { maxSpansPerTrace: this.retention.maxSpansPerTrace };

    if (event.type === 'trace-started') {
      const session = new TraceSession(
        event.traceId,
        event.startedAt,
        event.routeId,
        limits,
      );
      this.sessions.set(event.traceId, session);
      return { session, issues: [] };
    }

    const startedAt =
      event.type === 'span-started'
        ? event.startedAt
        : event.completedAt;

    const session = new TraceSession(event.traceId, startedAt, undefined, limits);
    this.sessions.set(event.traceId, session);

    const bootstrapEvent: RuntimeTraceEvent = {
      type: 'trace-started',
      traceId: event.traceId,
      startedAt,
      routeId: undefined,
    };
    session.apply(bootstrapEvent, this.symbolIndex);

    return {
      session,
      issues: [
        {
          code: 'unknown_trace',
          message: `Auto-created trace session for ${event.traceId} before trace-started`,
          event,
        },
      ],
    };
  }
}

function normalizeRetention(
  retention: TraceRetentionOptions,
): Required<TraceRetentionOptions> {
  return {
    maxCompletedTraces: positiveOr(
      retention.maxCompletedTraces,
      DEFAULT_TRACE_RETENTION.maxCompletedTraces,
    ),
    maxSpansPerTrace: positiveOr(
      retention.maxSpansPerTrace,
      DEFAULT_TRACE_RETENTION.maxSpansPerTrace,
    ),
    maxActiveTraces: positiveOr(
      retention.maxActiveTraces,
      DEFAULT_TRACE_RETENTION.maxActiveTraces,
    ),
  };
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && value > 0 ? value : fallback;
}
