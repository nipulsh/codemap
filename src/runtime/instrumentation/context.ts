import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { RuntimeError } from '../types';
import type { RuntimeEventSink, SpanMetadata } from './types';

export interface TraceContext {
  traceId: string;
  currentSpanId?: string;
  collector: RuntimeEventSink;
}

const traceContextStorage = new AsyncLocalStorage<TraceContext>();

export function runWithTraceContext<T>(
  context: TraceContext,
  fn: () => T,
): T {
  return traceContextStorage.run(context, fn);
}

export function getTraceContext(): TraceContext | undefined {
  return traceContextStorage.getStore();
}

export function newTraceId(): string {
  return `trace:${randomUUID()}`;
}

export function newSpanId(): string {
  return `span:${randomUUID()}`;
}

export function toRuntimeError(error: unknown): RuntimeError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }
  return { message: String(error) };
}

/**
 * Emit span-started and return the immutable child context the wrapped
 * function must run in.
 *
 * The parent context is never mutated: each span gets its own context object
 * via AsyncLocalStorage.run(). Mutating a shared `currentSpanId` (the pre-Phase
 * 10 approach) mis-parented spans when two withCodeMapSpan calls ran
 * concurrently inside one request (e.g. Promise.all), because the second call
 * observed the first call's spanId as its parent and the restore order raced.
 */
function openSpan(
  ctx: TraceContext,
  name: string,
  metadata: SpanMetadata | undefined,
): { spanId: string; childContext: TraceContext } {
  const spanId = newSpanId();
  ctx.collector.ingest({
    type: 'span-started',
    traceId: ctx.traceId,
    spanId,
    parentSpanId: ctx.currentSpanId,
    symbolId: metadata?.symbolId,
    functionName: metadata?.functionName ?? name,
    filePath: metadata?.filePath,
    line: metadata?.line,
    startedAt: Date.now(),
  });
  return {
    spanId,
    childContext: {
      traceId: ctx.traceId,
      currentSpanId: spanId,
      collector: ctx.collector,
    },
  };
}

function completeSpan(ctx: TraceContext, spanId: string): void {
  ctx.collector.ingest({
    type: 'span-completed',
    traceId: ctx.traceId,
    spanId,
    completedAt: Date.now(),
  });
}

function failSpan(ctx: TraceContext, spanId: string, error: unknown): void {
  ctx.collector.ingest({
    type: 'span-errored',
    traceId: ctx.traceId,
    spanId,
    completedAt: Date.now(),
    error: toRuntimeError(error),
  });
}

export async function withCodeMapSpan<T>(
  name: string,
  fn: () => T | Promise<T>,
  metadata?: SpanMetadata,
): Promise<T> {
  const ctx = getTraceContext();
  if (!ctx) {
    return fn();
  }

  const { spanId, childContext } = openSpan(ctx, name, metadata);

  try {
    const result = await traceContextStorage.run(childContext, fn);
    completeSpan(ctx, spanId);
    return result;
  } catch (error) {
    failSpan(ctx, spanId, error);
    throw error;
  }
}

/** Synchronous explicit span helper. */
export function withCodeMapSpanSync<T>(
  name: string,
  fn: () => T,
  metadata?: SpanMetadata,
): T {
  const ctx = getTraceContext();
  if (!ctx) {
    return fn();
  }

  const { spanId, childContext } = openSpan(ctx, name, metadata);

  try {
    const result = traceContextStorage.run(childContext, fn);
    completeSpan(ctx, spanId);
    return result;
  } catch (error) {
    failSpan(ctx, spanId, error);
    throw error;
  }
}
