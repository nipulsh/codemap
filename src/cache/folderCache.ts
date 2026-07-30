import type { DirectoryListing } from '../scanner/listDirectory';
import { normalizePath } from '../utils/path';

export class FolderCache {
  private readonly map = new Map<string, DirectoryListing>();

  get(dirPath: string): DirectoryListing | undefined {
    return this.map.get(normalizePath(dirPath));
  }

  set(listing: DirectoryListing): void {
    this.map.set(normalizePath(listing.path), listing);
  }

  invalidate(dirPath: string): void {
    this.map.delete(normalizePath(dirPath));
  }

  clear(): void {
    this.map.clear();
  }

  has(dirPath: string): boolean {
    return this.map.has(normalizePath(dirPath));
  }
}
