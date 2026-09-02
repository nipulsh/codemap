import type { ExportSpec, ImportSpec, SymbolInfo } from '../parser/types';
import { normalizePath } from '../utils/path';
import { FileSystemDiskCache } from './fsDiskCache';

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

/**
 * Structural check for entries read back from disk. A cache file that parses
 * as JSON but does not look like a CachedFileParse must not reach callers that
 * iterate `imports`/`symbols` etc.
 */
export function isCachedFileParse(value: unknown): value is CachedFileParse {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.absolutePath === 'string' &&
    typeof v.relativePath === 'string' &&
    typeof v.contentHash === 'string' &&
    typeof v.mtimeMs === 'number' &&
    Array.isArray(v.imports) &&
    Array.isArray(v.exports) &&
    Array.isArray(v.symbols) &&
    Array.isArray(v.dependencyPaths) &&
    Array.isArray(v.dynamicImportPaths) &&
    (v.parseError === undefined || typeof v.parseError === 'string')
  );
}

export class FileCache {
  private readonly map = new Map<string, CachedFileParse>();
  private readonly diskCache: FileSystemDiskCache;

  constructor(diskCache: FileSystemDiskCache = new FileSystemDiskCache()) {
    this.diskCache = diskCache;
    // Initialize the disk cache asynchronously
    this.diskCache.load().catch(err => {
      console.warn('Failed to initialize disk cache:', err);
    });
  }

  /** Read from disk, discarding entries that do not have the expected shape. */
  private async readDisk(normalizedPath: string): Promise<CachedFileParse | undefined> {
    let raw: unknown;
    try {
      raw = await this.diskCache.get<unknown>(normalizedPath);
    } catch {
      return undefined;
    }
    if (raw === undefined) {
      return undefined;
    }
    if (!isCachedFileParse(raw)) {
      this.diskCache.invalidate(normalizedPath).catch(() => undefined);
      return undefined;
    }
    return raw;
  }

  get(absolutePath: string): CachedFileParse | undefined {
    const normalizedPath = normalizePath(absolutePath);

    // Check memory cache first
    const cached = this.map.get(normalizedPath);
    if (cached) {
      return cached;
    }

    // If not in memory, try disk cache
    return undefined; // Will be implemented after we implement async get
  }

  async getAsync(absolutePath: string): Promise<CachedFileParse | undefined> {
    const normalizedPath = normalizePath(absolutePath);

    // Check memory cache first
    const cached = this.map.get(normalizedPath);
    if (cached) {
      return cached;
    }

    // If not in memory, try disk cache
    const diskCached = await this.readDisk(normalizedPath);
    if (diskCached) {
      // Store in memory cache for faster access next time
      this.map.set(normalizedPath, diskCached);
      return diskCached;
    }

    return undefined;
  }

  set(file: CachedFileParse): void {
    const normalizedPath = normalizePath(file.absolutePath);
    this.map.set(normalizedPath, file);
    // Also save to disk cache (fire and forget)
    this.diskCache.set(normalizedPath, file).catch(err => {
      console.warn(`Failed to cache file ${normalizedPath} to disk:`, err);
    });
  }

  async setAsync(file: CachedFileParse): Promise<void> {
    const normalizedPath = normalizePath(file.absolutePath);
    this.map.set(normalizedPath, file);
    await this.diskCache.set(normalizedPath, file);
  }

  invalidate(absolutePath: string): void {
    const normalizedPath = normalizePath(absolutePath);
    this.map.delete(normalizedPath);
    // Also remove from disk cache (fire and forget)
    this.diskCache.invalidate(normalizedPath).catch(err => {
      console.warn(`Failed to invalidate cache for ${normalizedPath}:`, err);
    });
  }

  async invalidateAsync(absolutePath: string): Promise<void> {
    const normalizedPath = normalizePath(absolutePath);
    this.map.delete(normalizedPath);
    await this.diskCache.invalidate(normalizedPath);
  }

  clear(): void {
    this.map.clear();
    // Clear disk cache (fire and forget)
    this.diskCache.clear().catch(err => {
      console.warn('Failed to clear disk cache:', err);
    });
  }

  async clearAsync(): Promise<void> {
    this.map.clear();
    await this.diskCache.clear();
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

  /** Async has — checks memory, then disk (and warms memory on hit). */
  async hasAsync(absolutePath: string): Promise<boolean> {
    const normalizedPath = normalizePath(absolutePath);
    if (this.map.has(normalizedPath)) {
      return true;
    }
    const cached = await this.readDisk(normalizedPath);
    if (cached !== undefined) {
      this.map.set(normalizedPath, cached);
      return true;
    }
    return false;
  }

  /** Async version of getIfFresh */
  async getIfFreshAsync(
    absolutePath: string,
    contentHash: string,
  ): Promise<CachedFileParse | undefined> {
    const cached = await this.getAsync(absolutePath);
    if (cached && cached.contentHash === contentHash) {
      return cached;
    }
    return undefined;
  }
}
