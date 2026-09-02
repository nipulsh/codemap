export {
  withCodeMapSpan,
  withCodeMapSpanSync,
  getTraceContext,
  newTraceId,
  newSpanId,
} from './context';
export {
  instrumentExpress,
  createRouteResolverFromDefinitions,
  resolveExpressRoutePattern,
  EXPRESS_INSTRUMENTATION_LIMITATIONS,
} from './express';
export type {
  ExpressInstrumentationOptions,
  InstrumentationHandle,
  RouteResolver,
  RouteResolutionContext,
  SpanMetadata,
  RuntimeEventSink,
  TraceRequestAttributes,
} from './types';
