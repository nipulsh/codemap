import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DiskCache } from './diskCache';
import { normalizePath } from '../utils/path';

/**
 * File system-based disk cache implementation.
 * Stores each cache entry as a separate JSON file in a cache directory.
 */
export class FileSystemDiskCache implements DiskCache {
  private readonly cacheDir: string;
  private readonly memoryCache: Map<string, { data: unknown; timestamp: number }> = new Map();
  private readonly dirtyKeys: Set<string> = new Set();
  private readonly defaultTtlMs: number = 24 * 60 * 60 * 1000; // 24 hours

  constructor(
    cacheDir?: string,
    private readonly ttlMs: number = 24 * 60 * 60 * 1000 // 24 hours default
  ) {
    // Use a dedicated cache directory in the user's home folder or temp directory
    this.cacheDir = cacheDir ?? join(homedir(), '.codemap', 'cache');
  }

  /**
   * Initialize the cache directory and load existing cache entries into memory.
   */
  async load(): Promise<void> {
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });

      // Read all files in the cache directory
      const files = await fs.readdir(this.cacheDir);

      for (const file of files) {
        if (!file.endsWith('.json')) {
          continue;
        }

        try {
          const filePath = join(this.cacheDir, file);
          const content = await fs.readFile(filePath, 'utf8');
          const parsed: unknown = JSON.parse(content);

          // Extract the original key from the filename (without .json extension)
          const key = file.slice(0, -5); // Remove .json

          // Envelope validation — malformed entries are treated like corrupt ones
          if (this.isValid(parsed)) {
            this.memoryCache.set(key, {
              data: parsed.data,
              timestamp: Date.now()
            });
          } else {
            throw new Error('Malformed or expired cache envelope');
          }
        } catch (err) {
          // Log corrupted cache files but continue processing others
          console.warn(`Failed to load cache entry ${file}:`, err);
          // Optionally delete corrupted file
          try {
            await fs.unlink(join(this.cacheDir, file));
          } catch (unlinkErr) {
            // Ignore errors when trying to delete corrupted files
          }
        }
      }
    } catch (err) {
      console.warn('Failed to initialize disk cache directory:', err);
      // Continue with empty cache if directory creation/reading fails
    }
  }

  /**
   * Save all dirty cache entries to disk.
   */
  async save(): Promise<void> {
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });

      const savePromises = Array.from(this.dirtyKeys).map(async (key) => {
        const entry = this.memoryCache.get(key);
        if (!entry) {
          return;
        }

        try {
          const filePath = join(this.cacheDir, `${key}.json`);
          const data = JSON.stringify({
            data: entry.data,
            timestamp: Date.now()
          });
          await fs.writeFile(filePath, data, 'utf8');
        } catch (err) {
          console.warn(`Failed to save cache entry ${key}:`, err);
        }
      });

      await Promise.all(savePromises);
      this.dirtyKeys.clear();
    } catch (err) {
      console.warn('Failed to save disk cache:', err);
    }
  }

  /**
   * Get a cached item by its key.
   */
  async get<T = unknown>(key: string): Promise<T | undefined> {
    const normalizedKey = this.normalizeKey(key);

    // Check memory cache first
    const cached = this.memoryCache.get(normalizedKey);
    if (cached && this.isValid(cached)) {
      return cached.data as T;
    }

    // If not in memory or expired, try to load from disk
    try {
      await this.loadEntryFromDisk(normalizedKey);
      const cachedAfterLoad = this.memoryCache.get(normalizedKey);
      if (cachedAfterLoad && this.isValid(cachedAfterLoad)) {
        return cachedAfterLoad.data as T;
      }
    } catch (err) {
      // Ignore errors - will return undefined
    }

    return undefined;
  }

  /**
   * Store an item in the cache.
   */
  async set<T = unknown>(key: string, data: T): Promise<void> {
    const normalizedKey = this.normalizeKey(key);
    this.memoryCache.set(normalizedKey, {
      data,
      timestamp: Date.now()
    });
    this.dirtyKeys.add(normalizedKey);
  }

  /**
   * Remove an item from the cache.
   */
  async invalidate(key: string): Promise<void> {
    const normalizedKey = this.normalizeKey(key);
    this.memoryCache.delete(normalizedKey);
    this.dirtyKeys.delete(normalizedKey);

    try {
      await fs.unlink(join(this.cacheDir, `${normalizedKey}.json`));
    } catch (err) {
      // Ignore if file doesn't exist
    }
  }

  /**
   * Clear all cached data.
   */
  async clear(): Promise<void> {
    this.memoryCache.clear();
    this.dirtyKeys.clear();

    try {
      const files = await fs.readdir(this.cacheDir);
      const unlinkPromises = files
        .filter(file => file.endsWith('.json'))
        .map(file => fs.unlink(join(this.cacheDir, file)));

      await Promise.all(unlinkPromises);
    } catch (err) {
      // Ignore if directory doesn't exist or other errors
    }
  }

  /**
   * Normalize a key for use as a filename.
   */
  private normalizeKey(key: string): string {
    // Replace characters that are problematic for file names
    return key.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
  }

  /**
   * Check if a cached entry has the expected envelope shape and is not expired.
   * Accepts unknown input because entries read from disk may be arbitrary JSON.
   */
  private isValid(entry: unknown): entry is { data: unknown; timestamp: number } {
    if (typeof entry !== 'object' || entry === null) {
      return false;
    }
    const { timestamp } = entry as { timestamp?: unknown };
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
      return false;
    }
    return (Date.now() - timestamp) < this.ttlMs;
  }

  /**
   * Load a specific cache entry from disk into memory.
   * Corrupt or malformed files are deleted so they are not re-read on every get().
   */
  private async loadEntryFromDisk(key: string): Promise<void> {
    const filePath = join(this.cacheDir, `${key}.json`);
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch {
      // Missing file or unreadable (permissions) — treat as a miss.
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      await this.removeQuietly(filePath);
      return;
    }

    if (this.isValid(parsed)) {
      this.memoryCache.set(key, {
        data: parsed.data,
        timestamp: Date.now()
      });
    } else {
      // Expired or malformed envelope
      await this.removeQuietly(filePath);
    }
  }

  private async removeQuietly(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath);
    } catch {
      // Ignore: read-only location or already gone
    }
  }
}