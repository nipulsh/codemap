/**
 * Disk cache interface for persisting parsed file data.
 */
export interface DiskCache {
  /**
   * Load cached data from disk into memory.
   * @returns Promise that resolves when loading is complete
   */
  load(): Promise<void>;

  /**
   * Save dirty cached data to disk.
   * @returns Promise that resolves when saving is complete
   */
  save(): Promise<void>;

  /**
   * Get a cached item by its absolute path.
   * @param absolutePath The absolute path of the file
   * @returns Promise resolving to the cached data or undefined if not found/expired
   */
  get<T = unknown>(absolutePath: string): Promise<T | undefined>;

  /**
   * Store an item in the cache.
   * @param absolutePath The absolute path of the file
   * @param data The data to cache
   * @returns Promise that resolves when the item is stored
   */
  set<T = unknown>(absolutePath: string, data: T): Promise<void>;

  /**
   * Remove an item from the cache.
   * @param absolutePath The absolute path of the file to remove
   * @returns Promise that resolves when the item is removed
   */
  invalidate(absolutePath: string): Promise<void>;

  /**
   * Clear all cached data.
   * @returns Promise that resolves when the cache is cleared
   */
  clear(): Promise<void>;
}

/**
 * In-memory disk cache implementation (no-op) for when persistence is not needed.
 */
export class NoOpDiskCache implements DiskCache {
  async load(): Promise<void> {
    // No operation
  }

  async save(): Promise<void> {
    // No operation
  }

  async get<T = unknown>(_absolutePath: string): Promise<T | undefined> {
    return undefined;
  }

  async set<T = unknown>(_absolutePath: string, _data: T): Promise<void> {
    // No operation
  }

  async invalidate(_absolutePath: string): Promise<void> {
    // No operation
  }

  async clear(): Promise<void> {
    // No operation
  }
}
