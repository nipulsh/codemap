import { readFileSync } from 'node:fs';
import { normalizePath } from '../utils/path';

/** Default cap on retained source text for one analysis run. */
export const DEFAULT_SOURCE_TEXT_CACHE_BYTES = 64 * 1024 * 1024;

export interface SourceTextCacheStats {
  /** Files currently held in memory. */
  entries: number;
  /** Approximate UTF-16 bytes held (2 × string length). */
  retainedBytes: number;
  hits: number;
  misses: number;
  /** Files that were not retained because the byte budget was exhausted. */
  rejected: number;
}

/**
 * Per-analysis source text cache.
 *
 * Before Phase 10 every source file was read from disk up to three times per
 * analysis: once by the scanner (hashing), once by the parser and once more by
 * the route analyzer. This cache lets the scanner publish the text it already
 * read so later stages reuse it.
 *
 * Retention is bounded by a byte budget; once exhausted, further files are
 * simply not retained and `read()` falls back to the filesystem. This keeps
 * memory predictable on very large workspaces without changing results.
 *
 * The cache is scoped to a single pipeline run and should be dropped when the
 * run finishes so the text can be garbage-collected.
 */
export class SourceTextCache {
  private readonly texts = new Map<string, string>();
  private retainedBytes = 0;
  private hits = 0;
  private misses = 0;
  private rejected = 0;

  constructor(
    private readonly maxBytes: number = DEFAULT_SOURCE_TEXT_CACHE_BYTES,
  ) {}

  /** Retain `text` for `absolutePath` if the byte budget allows. */
  set(absolutePath: string, text: string): void {
    const key = normalizePath(absolutePath);
    const bytes = text.length * 2;
    const existing = this.texts.get(key);
    if (existing !== undefined) {
      this.retainedBytes -= existing.length * 2;
      this.texts.delete(key);
    }
    if (this.retainedBytes + bytes > this.maxBytes) {
      this.rejected += 1;
      return;
    }
    this.texts.set(key, text);
    this.retainedBytes += bytes;
  }

  /** Cached text only; undefined when the file was never retained. */
  peek(absolutePath: string): string | undefined {
    return this.texts.get(normalizePath(absolutePath));
  }

  /**
   * Return the file text, reading from disk on a miss. Disk reads are retained
   * (budget permitting) so repeated reads of the same file stay cheap.
   * Throws the underlying fs error when the file cannot be read.
   */
  read(absolutePath: string): string {
    const key = normalizePath(absolutePath);
    const cached = this.texts.get(key);
    if (cached !== undefined) {
      this.hits += 1;
      return cached;
    }
    this.misses += 1;
    const text = readFileSync(absolutePath, 'utf8');
    this.set(key, text);
    return text;
  }

  clear(): void {
    this.texts.clear();
    this.retainedBytes = 0;
  }

  stats(): SourceTextCacheStats {
    return {
      entries: this.texts.size,
      retainedBytes: this.retainedBytes,
      hits: this.hits,
      misses: this.misses,
      rejected: this.rejected,
    };
  }
}

/** Minimal reader interface accepted by analysis stages. */
export interface SourceTextReader {
  read(absolutePath: string): string;
}
