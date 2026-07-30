import type { CalleeRef } from '../parser/types';
import { normalizePath } from '../utils/path';

export interface CachedFunctionCalls {
  nodeId: string;
  filePath: string;
  functionName: string;
  callees: CalleeRef[];
}

export class FunctionCache {
  private readonly map = new Map<string, CachedFunctionCalls>();

  get(nodeId: string): CachedFunctionCalls | undefined {
    return this.map.get(nodeId);
  }

  set(entry: CachedFunctionCalls): void {
    this.map.set(entry.nodeId, entry);
  }

  invalidate(nodeId: string): void {
    this.map.delete(nodeId);
  }

  /** Invalidate all function cache entries belonging to a file. */
  invalidateFile(filePath: string): void {
    const normalized = normalizePath(filePath);
    for (const [id, entry] of this.map) {
      if (normalizePath(entry.filePath) === normalized) {
        this.map.delete(id);
      }
    }
  }

  clear(): void {
    this.map.clear();
  }

  has(nodeId: string): boolean {
    return this.map.has(nodeId);
  }
}
