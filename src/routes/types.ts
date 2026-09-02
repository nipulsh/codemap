export type HttpMethod =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'PATCH'
  | 'DELETE'
  | 'OPTIONS'
  | 'HEAD';

export type RouteFramework = 'express';

export type RouteConfidence = 'high' | 'medium' | 'low';

/** Framework-neutral static HTTP route model. */
export interface RouteDefinition {
  id: string;

  method: HttpMethod;
  path: string;

  framework: RouteFramework;

  /** Absolute source file path */
  sourceFile: string;
  line: number;

  handlerSymbol?: string;
  handlerLine?: number;

  routerVariable?: string;
  mountPrefix?: string;

  confidence: RouteConfidence;
  handlerResolved: boolean;

  /** True when mount prefix could not be statically resolved */
  unresolvedMount?: boolean;
}

export interface RouteExtractionResult {
  routes: RouteDefinition[];
  errors: Array<{ filePath: string; message: string }>;
}

export type TraceNodeResolution = 'resolved' | 'unresolved' | 'external';

export type TraceUnresolvedReason =
  | 'dynamic-dispatch'
  | 'external-module'
  | 'missing-symbol'
  | 'unsupported-pattern'
  | 'resolution-failed';

export interface TraceCallNode {
  id: string;
  symbolId?: string;
  functionName: string;
  filePath: string;
  line?: number;
  depth: number;
  resolution: TraceNodeResolution;
  /** Present when this node closes a cycle back to an ancestor */
  cycleTargetId?: string;
}

export interface TraceCallEdge {
  from: string;
  to: string;
  kind: 'calls';
  resolved: boolean;
  /** True when edge closes a cycle to an already-visited node */
  isCycle?: boolean;
}

export interface TraceUnresolvedCall {
  fromNodeId: string;
  displayName: string;
  reason: TraceUnresolvedReason;
  line?: number;
}

/** Static call-chain trace from a route handler. Not a runtime execution trace. */
export interface StaticRouteTrace {
  routeId: string;
  route: RouteDefinition;
  entryHandler?: TraceCallNode;
  nodes: TraceCallNode[];
  edges: TraceCallEdge[];
  maxDepth: number;
  truncated: boolean;
  unresolved: TraceUnresolvedCall[];
  limitations: string[];
}

export interface CallChainOptions {
  maxDepth?: number;
  /** Cooperative cancellation, checked before each route. */
  signal?: AbortSignal;
}

export const DEFAULT_CALL_CHAIN_MAX_DEPTH = 8;

export const STATIC_TRACE_LIMITATIONS = [
  'StaticRouteTrace represents statically inferred call relationships, not confirmed runtime execution order.',
  'Branch order reflects source appearance, not runtime scheduling.',
  'Dynamic dispatch, computed property access, and reflection cannot be resolved statically.',
] as const;
