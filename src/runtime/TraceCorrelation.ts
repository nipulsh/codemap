import { normalizePath } from '../utils/path';
import { symbolNodeId } from '../graph/incremental';
import type { SymbolInfo, SymbolKind } from '../parser/types';
import type { StaticRouteTrace, TraceCallNode } from '../routes/types';
import type { RuntimeSpan } from './types';

export interface StaticSymbolEntry {
  symbolId: string;
  functionName: string;
  filePath: string;
  line: number;
}

/** Index of statically known symbols for exact runtime correlation. */
export interface StaticSymbolIndex {
  bySymbolId: Map<string, StaticSymbolEntry>;
  byExactLocation: Map<string, StaticSymbolEntry>;
  byFileAndName: Map<string, StaticSymbolEntry[]>;
}

/** Index of static trace nodes for runtime ↔ static overlay correlation. */
export interface StaticTraceNodeIndex {
  nodesById: Map<string, TraceCallNode>;
  bySymbolId: Map<string, string>;
  byExactLocation: Map<string, string>;
  byFileAndName: Map<string, string[]>;
}

export type MatchMethod =
  | 'symbol-id'
  | 'file-line-name'
  | 'unique-file-name'
  | 'none';

export type MatchConfidence = 'exact' | 'strong' | 'heuristic' | 'none';

export interface CorrelationInput {
  symbolId?: string;
  filePath?: string;
  line?: number;
  functionName?: string;
}

export interface CorrelationResult {
  symbolId?: string;
  functionName?: string;
  filePath?: string;
  line?: number;
  resolution: 'resolved' | 'unresolved';
}

export interface RuntimeStaticMatch {
  runtimeSpanId: string;
  staticNodeId?: string;
  method: MatchMethod;
  confidence: MatchConfidence;
}

function locationKey(
  filePath: string,
  line: number,
  functionName: string,
): string {
  return `${normalizePath(filePath)}:${line}:${functionName}`;
}

function fileNameKey(filePath: string, functionName: string): string {
  return `${normalizePath(filePath)}:${functionName}`;
}

export function buildStaticSymbolIndex(
  entries: StaticSymbolEntry[],
): StaticSymbolIndex {
  const bySymbolId = new Map<string, StaticSymbolEntry>();
  const byExactLocation = new Map<string, StaticSymbolEntry>();
  const byFileAndName = new Map<string, StaticSymbolEntry[]>();

  for (const entry of entries) {
    bySymbolId.set(entry.symbolId, entry);
    byExactLocation.set(
      locationKey(entry.filePath, entry.line, entry.functionName),
      entry,
    );
    const fnKey = fileNameKey(entry.filePath, entry.functionName);
    const list = byFileAndName.get(fnKey) ?? [];
    list.push(entry);
    byFileAndName.set(fnKey, list);
  }

  return { bySymbolId, byExactLocation, byFileAndName };
}

export function collectStaticTraceNodes(
  trace: StaticRouteTrace,
): TraceCallNode[] {
  const byId = new Map<string, TraceCallNode>();
  if (trace.entryHandler) {
    byId.set(trace.entryHandler.id, trace.entryHandler);
  }
  for (const node of trace.nodes) {
    byId.set(node.id, node);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function buildStaticTraceNodeIndex(
  trace: StaticRouteTrace,
): StaticTraceNodeIndex {
  const nodesById = new Map<string, TraceCallNode>();
  const bySymbolId = new Map<string, string>();
  const byExactLocation = new Map<string, string>();
  const byFileAndName = new Map<string, string[]>();

  for (const node of collectStaticTraceNodes(trace)) {
    nodesById.set(node.id, node);

    if (node.symbolId) {
      bySymbolId.set(node.symbolId, node.id);
    }

    if (node.line !== undefined) {
      byExactLocation.set(
        locationKey(node.filePath, node.line, node.functionName),
        node.id,
      );
    }

    const fnKey = fileNameKey(node.filePath, node.functionName);
    const list = byFileAndName.get(fnKey) ?? [];
    list.push(node.id);
    byFileAndName.set(fnKey, list);
  }

  return { nodesById, bySymbolId, byExactLocation, byFileAndName };
}

export function staticSymbolEntry(
  filePath: string,
  functionName: string,
  line: number,
  kind: SymbolKind = 'Function',
): StaticSymbolEntry {
  return {
    symbolId: symbolNodeId(filePath, functionName, kind),
    functionName,
    filePath,
    line,
  };
}

export function entriesFromFileSymbols(
  filePath: string,
  symbols: SymbolInfo[],
): StaticSymbolEntry[] {
  return symbols.map((sym) =>
    staticSymbolEntry(filePath, sym.name, sym.line, sym.kind),
  );
}

function matchStaticNodeId(
  input: CorrelationInput,
  index: StaticTraceNodeIndex,
): { staticNodeId?: string; method: MatchMethod; confidence: MatchConfidence } {
  if (input.symbolId) {
    const byId = index.bySymbolId.get(input.symbolId);
    if (byId) {
      return {
        staticNodeId: byId,
        method: 'symbol-id',
        confidence: 'exact',
      };
    }
  }

  if (input.filePath && input.line !== undefined && input.functionName) {
    const byLoc = index.byExactLocation.get(
      locationKey(input.filePath, input.line, input.functionName),
    );
    if (byLoc) {
      return {
        staticNodeId: byLoc,
        method: 'file-line-name',
        confidence: 'strong',
      };
    }
  }

  if (input.filePath && input.functionName) {
    const candidates = index.byFileAndName.get(
      fileNameKey(input.filePath, input.functionName),
    );
    if (candidates?.length === 1) {
      return {
        staticNodeId: candidates[0]!,
        method: 'unique-file-name',
        confidence: 'heuristic',
      };
    }
  }

  return { method: 'none', confidence: 'none' };
}

/** Correlate one runtime span to a static trace node with explicit precedence. */
export function correlateSpanToStaticNode(
  span: RuntimeSpan,
  index: StaticTraceNodeIndex,
): RuntimeStaticMatch {
  const match = matchStaticNodeId(
    {
      symbolId: span.symbolId,
      filePath: span.filePath,
      line: span.line,
      functionName: span.functionName,
    },
    index,
  );

  return {
    runtimeSpanId: span.spanId,
    staticNodeId: match.staticNodeId,
    method: match.method,
    confidence: match.confidence,
  };
}

/**
 * Exact-match correlation to static symbol entries.
 * Prefer correlateSpanToStaticNode for overlay work against StaticRouteTrace nodes.
 */
export function correlateRuntimeSpan(
  input: CorrelationInput,
  index: StaticSymbolIndex,
): CorrelationResult {
  if (input.symbolId) {
    const byId = index.bySymbolId.get(input.symbolId);
    if (byId) {
      return {
        symbolId: byId.symbolId,
        functionName: byId.functionName,
        filePath: byId.filePath,
        line: byId.line,
        resolution: 'resolved',
      };
    }
  }

  if (input.filePath && input.line !== undefined && input.functionName) {
    const byLoc = index.byExactLocation.get(
      locationKey(input.filePath, input.line, input.functionName),
    );
    if (byLoc) {
      return {
        symbolId: byLoc.symbolId,
        functionName: byLoc.functionName,
        filePath: byLoc.filePath,
        line: byLoc.line,
        resolution: 'resolved',
      };
    }
  }

  if (input.filePath && input.functionName) {
    const candidates = index.byFileAndName.get(
      fileNameKey(input.filePath, input.functionName),
    );
    if (candidates?.length === 1) {
      const only = candidates[0]!;
      return {
        symbolId: only.symbolId,
        functionName: only.functionName,
        filePath: only.filePath,
        line: only.line,
        resolution: 'resolved',
      };
    }
  }

  return {
    symbolId: input.symbolId,
    functionName: input.functionName,
    filePath: input.filePath,
    line: input.line,
    resolution: 'unresolved',
  };
}

export function staticEdgeKey(from: string, to: string): string {
  return `${from}->${to}`;
}
