import type { TraceCollector } from '../TraceCollector';
import type { TraceRequestAttributes } from '../types';
/** Resolves a static CodeMap route ID from safe HTTP routing metadata. */
export interface RouteResolutionContext {
  method: string;
  routePattern?: string;
  baseUrl?: string;
}

export type RouteResolver = (
  context: RouteResolutionContext,
) => string | undefined;

export interface ExpressInstrumentationOptions {
  collector: TraceCollector;
  routeResolver?: RouteResolver;
  /** When true, attach safe HTTP metadata (method, route pattern, status code). */
  includeRequestMetadata?: boolean;
}

export interface InstrumentationHandle {
  dispose(): void;
}

export interface SpanMetadata {
  symbolId?: string;
  functionName?: string;
  filePath?: string;
  line?: number;
}

export interface RuntimeEventSink {
  ingest: TraceCollector['ingest'];
}

export type { TraceRequestAttributes } from '../types';
