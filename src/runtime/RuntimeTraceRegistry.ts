import {
  TraceCollector,
  type TraceCollectorStats,
  type TraceRetentionOptions,
} from './TraceCollector';
import type { RuntimeTrace } from './types';
import type { StaticRouteTrace } from '../routes/types';
import { createTraceOverlay } from './TraceOverlay';
import type { TraceOverlay } from './TraceOverlay';
import type { RuntimeTraceSummaryWire } from '../../shared/runtimeTrace';

let collector: TraceCollector | undefined;
let pendingRetention: TraceRetentionOptions | undefined;

/**
 * Shared runtime trace collector for instrumentation and the extension host.
 *
 * Retention is bounded (see TraceRetentionOptions / DEFAULT_TRACE_RETENTION):
 * the registry keeps at most `maxCompletedTraces` completed traces, evicting
 * the oldest first, so a long-running instrumented session cannot grow the
 * extension host's memory without bound.
 */
export function getRuntimeTraceCollector(): TraceCollector {
  if (!collector) {
    collector = new TraceCollector(pendingRetention);
  }
  return collector;
}

/** Configure retention for the shared collector (applies immediately). */
export function configureRuntimeTraceRetention(
  retention: TraceRetentionOptions,
): void {
  pendingRetention = { ...pendingRetention, ...retention };
  collector?.setRetention(retention);
}

export function getRuntimeTraceCollectorStats(): TraceCollectorStats {
  return getRuntimeTraceCollector().getStats();
}

export function resetRuntimeTraceCollector(): void {
  collector?.clear();
  collector = undefined;
}

export function listRuntimeTraceSummaries(): RuntimeTraceSummaryWire[] {
  return getRuntimeTraceCollector()
    .getCompletedTraces()
    .map(toRuntimeTraceSummary)
    .sort((a, b) => b.startedAt - a.startedAt || a.traceId.localeCompare(b.traceId));
}

export function getRuntimeTraceById(traceId: string): RuntimeTrace | undefined {
  return getRuntimeTraceCollector().getTrace(traceId);
}

export function buildTraceOverlay(
  staticTrace: StaticRouteTrace,
  runtimeTrace: RuntimeTrace,
): TraceOverlay {
  return createTraceOverlay(staticTrace, runtimeTrace);
}

function toRuntimeTraceSummary(trace: RuntimeTrace): RuntimeTraceSummaryWire {
  return {
    traceId: trace.traceId,
    routeId: trace.routeId,
    startedAt: trace.startedAt,
    completedAt: trace.completedAt,
    durationMs: trace.durationMs,
    status: trace.status,
    attributes: trace.attributes,
  };
}
