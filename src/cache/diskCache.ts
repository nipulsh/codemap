/**
 * Disk cache interface reserved for Phase 2.
 * Phase 1 uses InMemoryDependencyIndex only.
 */
export interface DiskCache {
  load(): Promise<void>;
  save(): Promise<void>;
  invalidate(absolutePath: string): void;
}

export class NoOpDiskCache implements DiskCache {
  async load(): Promise<void> {
    /* Phase 2 */
  }
  async save(): Promise<void> {
    /* Phase 2 */
  }
  invalidate(_absolutePath: string): void {
    /* Phase 2 */
  }
}
