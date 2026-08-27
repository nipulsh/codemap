import type { ExportSpec, ImportSpec } from '../parser/types';

export interface IndexedFile {
  absolutePath: string;
  relativePath: string;
  contentHash: string;
  mtimeMs: number;
  imports: ImportSpec[];
  exports: ExportSpec[];
  /** Static dependency absolute paths (after barrel hop) */
  dependencyPaths: string[];
  dynamicImportPaths: string[];
  parseError?: string;
}



/**
 * In-memory dependency index. Disk persistence arrives in Phase 2.
 */
export interface DependencyIndex {
  get(absolutePath: string): IndexedFile | undefined;
  set(file: IndexedFile): void;
  delete(absolutePath: string): void;
  clear(): void;
  all(): IndexedFile[];
  readonly size: number;
}

export class InMemoryDependencyIndex implements DependencyIndex {
  private readonly map = new Map<string, IndexedFile>();

  get(absolutePath: string): IndexedFile | undefined {
    return this.map.get(absolutePath);
  }

  set(file: IndexedFile): void {
    this.map.set(file.absolutePath, file);
  }

  delete(absolutePath: string): void {
    this.map.delete(absolutePath);
  }

  clear(): void {
    this.map.clear();
  }

  all(): IndexedFile[] {
    return [...this.map.values()];
  }

  get size(): number {
    return this.map.size;
  }
}
