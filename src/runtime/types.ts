import { z } from 'zod';

/** Observed execution status for a trace or span. */
export type RuntimeTraceStatus = 'active' | 'completed' | 'error';

export type RuntimeSpanResolution = 'resolved' | 'unresolved';

export interface RuntimeError {
  name?: string;
  message: string;
}

/** One observed function invocation within a runtime trace. */
export interface RuntimeSpan {
  spanId: string;
  traceId: string;
  parentSpanId?: string;
  symbolId?: string;
  functionName?: string;
  filePath?: string;
  line?: number;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  status: RuntimeTraceStatus;
  resolution: RuntimeSpanResolution;
  error?: RuntimeError;
}

/**
 * Observed execution of one request/run.
 * Distinct from StaticRouteTrace (source-derived possible call structure).
 */
/** Safe HTTP request metadata (no headers, bodies, cookies, or secrets). */
export interface TraceRequestAttributes {
  httpMethod?: string;
  routePattern?: string;
  statusCode?: number;
}

export interface RuntimeTrace {
  traceId: string;
  routeId?: string;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  status: RuntimeTraceStatus;
  spans: RuntimeSpan[];
  attributes?: TraceRequestAttributes;
}

export interface RuntimeTraceStartedEvent {
  type: 'trace-started';
  traceId: string;
  routeId?: string;
  startedAt: number;
}

export interface RuntimeSpanStartedEvent {
  type: 'span-started';
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  symbolId?: string;
  functionName?: string;
  filePath?: string;
  line?: number;
  startedAt: number;
}

export interface RuntimeSpanCompletedEvent {
  type: 'span-completed';
  traceId: string;
  spanId: string;
  completedAt: number;
}

export interface RuntimeSpanErroredEvent {
  type: 'span-errored';
  traceId: string;
  spanId: string;
  completedAt: number;
  error: RuntimeError;
}

export interface RuntimeTraceCompletedEvent {
  type: 'trace-completed';
  traceId: string;
  completedAt: number;
  attributes?: TraceRequestAttributes;
}

export type RuntimeTraceEvent =
  | RuntimeTraceStartedEvent
  | RuntimeSpanStartedEvent
  | RuntimeSpanCompletedEvent
  | RuntimeSpanErroredEvent
  | RuntimeTraceCompletedEvent;

export type CollectorIssueCode =
  | 'unknown_trace'
  | 'unknown_parent_span'
  | 'duplicate_span_start'
  | 'orphan_completion'
  /** Event referenced a trace that already completed; ignored (no zombie session). */
  | 'late_event'
  /** span-started rejected because the trace reached maxSpansPerTrace. */
  | 'span_limit_exceeded'
  /** New trace rejected because maxActiveTraces sessions are already open. */
  | 'active_trace_limit';

export interface CollectorIssue {
  code: CollectorIssueCode;
  message: string;
  event: RuntimeTraceEvent;
}

export interface CollectorResult {
  traceId: string;
  issues: CollectorIssue[];
}

export const RuntimeErrorSchema = z.object({
  name: z.string().optional(),
  message: z.string(),
});

export const RuntimeSpanSchema = z.object({
  spanId: z.string(),
  traceId: z.string(),
  parentSpanId: z.string().optional(),
  symbolId: z.string().optional(),
  functionName: z.string().optional(),
  filePath: z.string().optional(),
  line: z.number().optional(),
  startedAt: z.number(),
  completedAt: z.number().optional(),
  durationMs: z.number().optional(),
  status: z.enum(['active', 'completed', 'error']),
  resolution: z.enum(['resolved', 'unresolved']),
  error: RuntimeErrorSchema.optional(),
});

export const TraceRequestAttributesSchema = z.object({
  httpMethod: z.string().optional(),
  routePattern: z.string().optional(),
  statusCode: z.number().optional(),
});

export const RuntimeTraceSchema = z.object({
  traceId: z.string(),
  routeId: z.string().optional(),
  startedAt: z.number(),
  completedAt: z.number().optional(),
  durationMs: z.number().optional(),
  status: z.enum(['active', 'completed', 'error']),
  spans: z.array(RuntimeSpanSchema),
  attributes: TraceRequestAttributesSchema.optional(),
});

export const RuntimeTraceEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('trace-started'),
    traceId: z.string(),
    routeId: z.string().optional(),
    startedAt: z.number(),
  }),
  z.object({
    type: z.literal('span-started'),
    traceId: z.string(),
    spanId: z.string(),
    parentSpanId: z.string().optional(),
    symbolId: z.string().optional(),
    functionName: z.string().optional(),
    filePath: z.string().optional(),
    line: z.number().optional(),
    startedAt: z.number(),
  }),
  z.object({
    type: z.literal('span-completed'),
    traceId: z.string(),
    spanId: z.string(),
    completedAt: z.number(),
  }),
  z.object({
    type: z.literal('span-errored'),
    traceId: z.string(),
    spanId: z.string(),
    completedAt: z.number(),
    error: RuntimeErrorSchema,
  }),
  z.object({
    type: z.literal('trace-completed'),
    traceId: z.string(),
    completedAt: z.number(),
    attributes: TraceRequestAttributesSchema.optional(),
  }),
]);

/** Compute duration when both timestamps are present and non-negative. */
export function computeDurationMs(
  startedAt: number | undefined,
  completedAt: number | undefined,
): number | undefined {
  if (startedAt === undefined || completedAt === undefined) {
    return undefined;
  }
  const duration = completedAt - startedAt;
  return duration >= 0 ? duration : undefined;
}

/** Deterministic serialized trace (sorted spans) for comparison and wire transport. */
export function serializeRuntimeTrace(trace: RuntimeTrace): RuntimeTrace {
  return {
    ...trace,
    spans: [...trace.spans].sort((a, b) => a.spanId.localeCompare(b.spanId)),
  };
}

export function createActiveTrace(
  traceId: string,
  startedAt: number,
  routeId?: string,
): RuntimeTrace {
  return {
    traceId,
    routeId,
    startedAt,
    status: 'active',
    spans: [],
  };
}

export function createActiveSpan(
  event: RuntimeSpanStartedEvent,
  resolution: RuntimeSpanResolution,
): RuntimeSpan {
  return {
    spanId: event.spanId,
    traceId: event.traceId,
    parentSpanId: event.parentSpanId,
    symbolId: event.symbolId,
    functionName: event.functionName,
    filePath: event.filePath,
    line: event.line,
    startedAt: event.startedAt,
    status: 'active',
    resolution,
  };
}

export const RUNTIME_TRACE_LIMITATIONS = [
  'RuntimeTrace represents observed execution for one actual run/request, not all possible static paths.',
  'Unobserved static branches may still execute in other requests.',
  'A missing runtime span does not invalidate statically inferred structure.',
] as const;
