import { isSourceFile } from '../scanner/ignore';
import type { WorkerPool } from '../parser/workerPool';
import type { FileCache } from '../cache/fileCache';
import type { TsConfigInfo } from '../scanner/types';
import { contentHash, fileMtimeMs } from '../utils/hash';
import { normalizePath, toPosix } from '../utils/path';
import { relative } from 'node:path';
import { basename } from 'node:path';

/**
 * Low-priority background parsing of files after a folder expands.
 * Never posts graph patches — only fills FileCache.
 */
export class BackgroundPrefetch {
  private readonly queued = new Set<string>();
  private cancelled = false;

  constructor(
    private readonly pool: WorkerPool,
    private readonly fileCache: FileCache,
    private readonly getTsconfigs: () => TsConfigInfo[],
    private readonly workspaceRoot: string,
  ) {}

  enqueueFiles(absolutePaths: string[]): void {
    const sourceFiles = absolutePaths.filter((p) =>
      isSourceFile(basename(p)),
    );
    if (sourceFiles.length === 0) {
      return;
    }

    const toParse = sourceFiles.filter((p) => {
      const norm = normalizePath(p);
      if (this.queued.has(norm) || this.fileCache.has(norm)) {
        return false;
      }
      this.queued.add(norm);
      return true;
    });

    if (toParse.length === 0) {
      return;
    }

    void this.run(toParse);
  }

  private async run(paths: string[]): Promise<void> {
    if (this.cancelled) {
      return;
    }

    // Batch in small chunks so user expands stay responsive
    const chunkSize = 8;
    for (let i = 0; i < paths.length; i += chunkSize) {
      if (this.cancelled) {
        return;
      }
      const chunk = paths.slice(i, i + chunkSize);
      try {
        const results = await this.pool.parseFiles({
          workspaceRoot: this.workspaceRoot,
          files: chunk.map((absolutePath) => ({ absolutePath })),
          tsconfigs: this.getTsconfigs(),
          priority: 'low',
        });

        for (const r of results) {
          const path = normalizePath(r.filePath);
          this.queued.delete(path);
          if (this.fileCache.has(path)) {
            continue;
          }
          try {
            this.fileCache.set({
              absolutePath: path,
              relativePath: toPosix(relative(this.workspaceRoot, path)),
              contentHash: contentHash(path),
              mtimeMs: fileMtimeMs(path),
              imports: r.imports,
              exports: r.exports,
              symbols: r.symbols ?? [],
              dependencyPaths: r.dependencyPaths,
              dynamicImportPaths: r.dynamicImportPaths,
              parseError: r.error,
            });
          } catch {
            // file may have been deleted
          }
        }
      } catch {
        for (const p of chunk) {
          this.queued.delete(normalizePath(p));
        }
      }
    }
  }

  cancel(): void {
    this.cancelled = true;
  }
}
