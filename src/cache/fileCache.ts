import type { ExportSpec, ImportSpec, SymbolInfo } from '../parser/types';
import { normalizePath } from '../utils/path';

export interface CachedFileParse {
  absolutePath: string;
  relativePath: string;
  contentHash: string;
  mtimeMs: number;
  imports: ImportSpec[];
  exports: ExportSpec[];
  symbols: SymbolInfo[];
  dependencyPaths: string[];
  dynamicImportPaths: string[];
  parseError?: string;
}

export class FileCache {
  private readonly map = new Map<string, CachedFileParse>();

  get(absolutePath: string): CachedFileParse | undefined {
    return this.map.get(normalizePath(absolutePath));
  }

  set(file: CachedFileParse): void {
    this.map.set(normalizePath(file.absolutePath), file);
  }

  invalidate(absolutePath: string): void {
    this.map.delete(normalizePath(absolutePath));
  }

  clear(): void {
    this.map.clear();
  }

  has(absolutePath: string): boolean {
    return this.map.has(normalizePath(absolutePath));
  }

  /** Return cached entry only if content hash still matches. */
  getIfFresh(
    absolutePath: string,
    contentHash: string,
  ): CachedFileParse | undefined {
    const cached = this.get(absolutePath);
    if (cached && cached.contentHash === contentHash) {
      return cached;
    }
    return undefined;
  }
}
