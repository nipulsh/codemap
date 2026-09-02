import { readFileSync } from 'node:fs';
import { createCallResolver, type CallResolver } from '../parser/extractImports';
import type { CalleeRef } from '../parser/types';
import type { SourceFileInfo } from '../analysis/types';
import type { SourceTextReader } from '../analysis/SourceTextCache';
import type { TsConfigInfo } from '../scanner/types';
import { symbolNodeId } from '../graph/incremental';
import { normalizePath } from '../utils/path';
import {
  isAnalysisCancelledError,
  throwIfAborted,
} from '../utils/cancellation';
import type {
  CallChainOptions,
  RouteDefinition,
  StaticRouteTrace,
  TraceCallEdge,
  TraceCallNode,
  TraceUnresolvedCall,
} from './types';
import {
  DEFAULT_CALL_CHAIN_MAX_DEPTH,
  STATIC_TRACE_LIMITATIONS,
} from './types';

interface HandlerEntry {
  filePath: string;
  functionName: string;
  displayName: string;
  line?: number;
}

interface QueueItem {
  filePath: string;
  functionName: string;
  displayName: string;
  depth: number;
  nodeId: string;
  line?: number;
}

/**
 * Reusable workspace knowledge for call-chain traversal.
 *
 * One context = one analysis. It owns a CallResolver that loads tsconfig
 * projects once and keeps each parsed AST for the lifetime of the context, so
 * every (file, function) pair costs one AST walk rather than a full re-parse.
 * Contexts are intended to be short-lived; drop the reference once the traces
 * have been produced.
 */
export class CallChainContext {
  private readonly workspaceFiles: Set<string>;
  private readonly fileByPath: Map<string, SourceFileInfo>;
  private readonly contentCache = new Map<string, string>();
  private readonly calleeCache = new Map<string, CalleeRef[]>();
  private readonly resolver: CallResolver;
  /** Diagnostics for benchmarks/tests: how often resolveCallees hit its cache. */
  readonly stats = { calleeLookups: 0, calleeCacheHits: 0 };

  constructor(
    readonly workspaceRoot: string,
    files: SourceFileInfo[],
    tsconfigs: TsConfigInfo[],
    private readonly textReader?: SourceTextReader,
  ) {
    this.workspaceFiles = new Set(
      files.map((f) => normalizePath(f.absolutePath)),
    );
    this.fileByPath = new Map(
      files.map((f) => [normalizePath(f.absolutePath), f]),
    );
    this.resolver = createCallResolver(
      workspaceRoot,
      tsconfigs.map((t) => ({ configPath: t.configPath, baseDir: t.baseDir })),
    );
  }

  /** Number of files whose AST is currently held by this context. */
  get parsedFileCount(): number {
    return this.resolver.cachedFileCount;
  }

  getFile(absolutePath: string): SourceFileInfo | undefined {
    return this.fileByPath.get(normalizePath(absolutePath));
  }

  getFileContent(absolutePath: string): string {
    const key = normalizePath(absolutePath);
    const cached = this.contentCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const content = this.textReader
      ? this.textReader.read(key)
      : readFileSync(key, 'utf8');
    this.contentCache.set(key, content);
    return content;
  }

  resolveCallees(filePath: string, functionName: string): CalleeRef[] {
    const key = `${normalizePath(filePath)}:${functionName}`;
    this.stats.calleeLookups += 1;
    const hit = this.calleeCache.get(key);
    if (hit) {
      this.stats.calleeCacheHits += 1;
      return hit;
    }

    const result = this.resolver.resolve(
      filePath,
      functionName,
      this.getFileContent(filePath),
    );
    this.calleeCache.set(key, result.callees);
    return result.callees;
  }

  isInWorkspace(filePath: string | undefined): boolean {
    if (!filePath) {
      return false;
    }
    return this.workspaceFiles.has(normalizePath(filePath));
  }
}

function resolveEntryHandler(
  route: RouteDefinition,
  ctx: CallChainContext,
): HandlerEntry | undefined {
  if (!route.handlerSymbol || route.handlerSymbol.includes('inline-handler')) {
    return undefined;
  }

  const routeFilePath = normalizePath(route.sourceFile);
  const routeFile = ctx.getFile(routeFilePath);
  if (!routeFile) {
    return undefined;
  }

  const simpleName = route.handlerSymbol.includes('.')
    ? route.handlerSymbol.split('.').pop()!
    : route.handlerSymbol;

  function findInFile(
    filePath: string,
    functionName: string,
    displayName: string,
  ): HandlerEntry | undefined {
    const file = ctx.getFile(filePath);
    if (!file) {
      return undefined;
    }
    const sym = file.symbols.find((s) => s.name === functionName);
    if (!sym) {
      return undefined;
    }
    return {
      filePath: normalizePath(filePath),
      functionName,
      displayName,
      line: sym.line,
    };
  }

  const local = findInFile(routeFilePath, simpleName, route.handlerSymbol);
  if (local) {
    return local;
  }

  for (const imp of routeFile.imports) {
    if (!imp.resolvedPath) {
      continue;
    }
    const imported = imp.names.includes(simpleName) || imp.names.includes('*');
    if (!imported) {
      continue;
    }
    const resolved = findInFile(
      imp.resolvedPath,
      simpleName,
      route.handlerSymbol,
    );
    if (resolved) {
      return resolved;
    }
  }

  return undefined;
}

function makeResolvedNode(
  filePath: string,
  functionName: string,
  displayName: string,
  depth: number,
  line: number | undefined,
  ctx: CallChainContext,
): TraceCallNode {
  const normalized = normalizePath(filePath);
  const file = ctx.getFile(normalized);
  const sym = file?.symbols.find((s) => s.name === functionName);
  const symbolId = sym
    ? symbolNodeId(normalized, sym.name, sym.kind)
    : undefined;

  return {
    id: symbolId ?? `trace:${normalized}:${functionName}:${depth}`,
    symbolId,
    functionName: displayName,
    filePath: normalized,
    line: line ?? sym?.line,
    depth,
    resolution: 'resolved',
  };
}

function makeExternalNode(
  displayName: string,
  callerFile: string,
  line: number | undefined,
  depth: number,
): TraceCallNode {
  const id = `external:${displayName}:${normalizePath(callerFile)}:${line ?? 0}:${depth}`;
  return {
    id,
    functionName: displayName,
    filePath: normalizePath(callerFile),
    line,
    depth,
    resolution: 'external',
  };
}

function visitKey(filePath: string, functionName: string): string {
  return `${normalizePath(filePath)}:${functionName}`;
}

function edgeKey(from: string, to: string): string {
  return `${from}->${to}`;
}

function isDynamicCallee(name: string): boolean {
  return name.includes('[') && name.includes(']');
}

/**
 * Bounded BFS static call-chain analysis from route handlers.
 * Reuses parser call resolution; does not perform its own AST walking.
 */
export class CallChainAnalyzer {
  analyzeRoute(
    route: RouteDefinition,
    ctx: CallChainContext,
    options: CallChainOptions = {},
  ): StaticRouteTrace {
    const maxDepth = options.maxDepth ?? DEFAULT_CALL_CHAIN_MAX_DEPTH;
    const limitations: string[] = [...STATIC_TRACE_LIMITATIONS];
    const nodes: TraceCallNode[] = [];
    const edges: TraceCallEdge[] = [];
    const unresolved: TraceUnresolvedCall[] = [];
    const edgeSeen = new Set<string>();
    const nodeById = new Map<string, TraceCallNode>();
    const expanded = new Set<string>();
    let truncated = false;
    let truncationNoted = false;

    const entry = resolveEntryHandler(route, ctx);
    if (!entry) {
      limitations.push('Route handler could not be resolved for static tracing.');
      return {
        routeId: route.id,
        route,
        nodes,
        edges,
        maxDepth,
        truncated: false,
        unresolved,
        limitations,
      };
    }

    const entryNode = makeResolvedNode(
      entry.filePath,
      entry.functionName,
      entry.displayName,
      0,
      entry.line,
      ctx,
    );

    nodeById.set(entryNode.id, entryNode);
    nodes.push(entryNode);

    const queue: QueueItem[] = [
      {
        filePath: entry.filePath,
        functionName: entry.functionName,
        displayName: entry.displayName,
        depth: 0,
        nodeId: entryNode.id,
        line: entry.line,
      },
    ];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const currentKey = visitKey(current.filePath, current.functionName);

      if (expanded.has(currentKey)) {
        continue;
      }
      expanded.add(currentKey);

      if (current.depth >= maxDepth) {
        truncated = true;
        if (!truncationNoted) {
          limitations.push(`Trace truncated at maxDepth=${maxDepth}.`);
          truncationNoted = true;
        }
        continue;
      }

      const callees = ctx.resolveCallees(current.filePath, current.functionName);

      for (const callee of callees) {
        const childDepth = current.depth + 1;
        const displayName = callee.name;

        if (isDynamicCallee(displayName)) {
          unresolved.push({
            fromNodeId: current.nodeId,
            displayName,
            reason: 'dynamic-dispatch',
            line: callee.line,
          });
          continue;
        }

        if (displayName.includes('.') && callee.local && !callee.targetFile) {
          unresolved.push({
            fromNodeId: current.nodeId,
            displayName,
            reason: 'unsupported-pattern',
            line: callee.line,
          });
          continue;
        }

        let childNode: TraceCallNode;
        let targetFilePath: string;
        let targetFunctionName: string;
        let edgeResolved = true;
        let isCycle = false;

        if (callee.targetFile && ctx.isInWorkspace(callee.targetFile)) {
          targetFilePath = normalizePath(callee.targetFile);
          targetFunctionName = callee.name;
          childNode = makeResolvedNode(
            targetFilePath,
            targetFunctionName,
            displayName,
            childDepth,
            callee.line,
            ctx,
          );
        } else if (callee.local && !callee.targetFile) {
          const sym = ctx.getFile(current.filePath)?.symbols.find(
            (s) => s.name === callee.name,
          );
          if (!sym) {
            unresolved.push({
              fromNodeId: current.nodeId,
              displayName,
              reason: 'missing-symbol',
              line: callee.line,
            });
            continue;
          }
          targetFilePath = normalizePath(current.filePath);
          targetFunctionName = callee.name;
          childNode = makeResolvedNode(
            targetFilePath,
            targetFunctionName,
            displayName,
            childDepth,
            callee.line,
            ctx,
          );
        } else {
          childNode = makeExternalNode(
            displayName,
            current.filePath,
            callee.line,
            childDepth,
          );
          targetFilePath = '';
          targetFunctionName = '';
          edgeResolved = false;
          unresolved.push({
            fromNodeId: current.nodeId,
            displayName,
            reason: 'external-module',
            line: callee.line,
          });
        }

        const targetKey = targetFunctionName
          ? visitKey(targetFilePath, targetFunctionName)
          : '';

        if (targetKey && expanded.has(targetKey)) {
          isCycle = true;
          const existing = nodeById.get(childNode.id);
          if (existing) {
            childNode = existing;
          }
        }

        if (!nodeById.has(childNode.id)) {
          nodeById.set(childNode.id, childNode);
          nodes.push(childNode);
        } else if (targetKey && expanded.has(targetKey)) {
          childNode = nodeById.get(childNode.id)!;
          isCycle = true;
        }

        const ek = edgeKey(current.nodeId, childNode.id);
        if (!edgeSeen.has(ek)) {
          edgeSeen.add(ek);
          edges.push({
            from: current.nodeId,
            to: childNode.id,
            kind: 'calls',
            resolved: edgeResolved,
            isCycle: isCycle || undefined,
          });
        }

        if (
          edgeResolved &&
          targetKey &&
          !expanded.has(targetKey) &&
          childDepth < maxDepth
        ) {
          queue.push({
            filePath: targetFilePath,
            functionName: targetFunctionName,
            displayName: childNode.functionName,
            depth: childDepth,
            nodeId: childNode.id,
            line: childNode.line,
          });
        } else if (edgeResolved && targetKey && expanded.has(targetKey)) {
          truncated = false; // cycle is not truncation
        } else if (edgeResolved && childDepth >= maxDepth) {
          truncated = true;
          if (!truncationNoted) {
            limitations.push(`Trace truncated at maxDepth=${maxDepth}.`);
            truncationNoted = true;
          }
        }
      }
    }

    nodes.sort((a, b) => {
      const depthCmp = a.depth - b.depth;
      if (depthCmp !== 0) {
        return depthCmp;
      }
      const fileCmp = a.filePath.localeCompare(b.filePath);
      return fileCmp !== 0 ? fileCmp : a.functionName.localeCompare(b.functionName);
    });

    edges.sort((a, b) => {
      const fromCmp = a.from.localeCompare(b.from);
      return fromCmp !== 0 ? fromCmp : a.to.localeCompare(b.to);
    });

    return {
      routeId: route.id,
      route,
      entryHandler: entryNode,
      nodes,
      edges,
      maxDepth,
      truncated,
      unresolved,
      limitations: [...new Set(limitations)].sort(),
    };
  }

  analyzeRoutes(
    routes: RouteDefinition[],
    ctx: CallChainContext,
    options: CallChainOptions = {},
  ): StaticRouteTrace[] {
    const iterator = this.analyzeRoutesIncremental(routes, ctx, options);
    let step = iterator.next();
    while (!step.done) {
      step = iterator.next();
    }
    return step.value;
  }

  /**
   * Incremental variant: yields after each route so callers can interleave
   * event-loop turns or cancellation checks.
   *
   * Failure isolation: an unexpected error while tracing one route (for example
   * a source file deleted between scan and trace) produces a trace that records
   * the failure instead of aborting the remaining routes.
   */
  *analyzeRoutesIncremental(
    routes: RouteDefinition[],
    ctx: CallChainContext,
    options: CallChainOptions = {},
  ): Generator<void, StaticRouteTrace[], void> {
    const traces: StaticRouteTrace[] = [];
    for (const route of routes) {
      throwIfAborted(options.signal);
      try {
        traces.push(this.analyzeRoute(route, ctx, options));
      } catch (err) {
        if (isAnalysisCancelledError(err)) {
          throw err;
        }
        traces.push(failedTrace(route, options, err));
      }
      yield;
    }
    return traces;
  }
}

function failedTrace(
  route: RouteDefinition,
  options: CallChainOptions,
  err: unknown,
): StaticRouteTrace {
  const message = err instanceof Error ? err.message : String(err);
  return {
    routeId: route.id,
    route,
    nodes: [],
    edges: [],
    maxDepth: options.maxDepth ?? DEFAULT_CALL_CHAIN_MAX_DEPTH,
    truncated: false,
    unresolved: [
      {
        fromNodeId: route.id,
        displayName: route.handlerSymbol ?? route.id,
        reason: 'resolution-failed',
        line: route.handlerLine ?? route.line,
      },
    ],
    limitations: [
      ...STATIC_TRACE_LIMITATIONS,
      `Static tracing failed for this route: ${message}`,
    ].sort(),
  };
}

export function createCallChainContext(
  workspaceRoot: string,
  files: SourceFileInfo[],
  tsconfigs: TsConfigInfo[],
  textReader?: SourceTextReader,
): CallChainContext {
  return new CallChainContext(workspaceRoot, files, tsconfigs, textReader);
}
