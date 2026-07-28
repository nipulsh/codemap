import { readdirSync, realpathSync, existsSync } from 'node:fs';
import { join, basename, relative } from 'node:path';
import { contentHash, fileMtimeMs } from '../utils/hash';
import { toPosix, normalizePath } from '../utils/path';
import { isSourceFile, shouldIgnoreDirectory, shouldIgnoreFile } from './ignore';
import type { ScanProgressCallback, ScanResult, ScannedFile, TsConfigInfo } from './types';

function safeRealpath(p: string): string {
  try {
    return normalizePath(realpathSync(p));
  } catch {
    return normalizePath(p);
  }
}

function walkDirectory(
  dir: string,
  workspaceRoot: string,
  files: ScannedFile[],
  tsconfigs: TsConfigInfo[],
  onProgress?: ScanProgressCallback,
): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (shouldIgnoreDirectory(entry.name)) {
        continue;
      }
      walkDirectory(fullPath, workspaceRoot, files, tsconfigs, onProgress);
      continue;
    }

    if (!entry.isFile() && !entry.isSymbolicLink()) {
      continue;
    }

    const rel = toPosix(relative(workspaceRoot, fullPath));

    if (/^tsconfig.*\.json$/i.test(entry.name)) {
      const real = safeRealpath(fullPath);
      tsconfigs.push({
        configPath: real,
        baseDir: normalizePath(join(real, '..')),
      });
      continue;
    }

    if (!isSourceFile(entry.name)) {
      continue;
    }

    if (shouldIgnoreFile(rel)) {
      continue;
    }

    const real = safeRealpath(fullPath);
    try {
      files.push({
        absolutePath: real,
        relativePath: toPosix(relative(workspaceRoot, real)),
        mtimeMs: fileMtimeMs(real),
        contentHash: contentHash(real),
      });
      if (files.length % 100 === 0) {
        onProgress?.(`Scanning… ${files.length} files`, undefined);
      }
    } catch {
      // Skip unreadable files
    }
  }
}

/**
 * Walk a workspace root, collect source files and tsconfigs.
 * Symlinks are resolved via realpath before indexing.
 */
export function scanWorkspace(
  workspaceRoot: string,
  onProgress?: ScanProgressCallback,
): ScanResult {
  const root = safeRealpath(workspaceRoot);
  onProgress?.('Starting workspace scan…', 0);

  const files: ScannedFile[] = [];
  const tsconfigs: TsConfigInfo[] = [];

  if (existsSync(root)) {
    walkDirectory(root, root, files, tsconfigs, onProgress);
  }

  // Prefer deeper / more specific tsconfigs; keep discovery order stable
  tsconfigs.sort((a, b) => a.configPath.localeCompare(b.configPath));
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  onProgress?.(
    `Scan complete: ${files.length} files, ${tsconfigs.length} tsconfigs`,
    30,
  );

  return {
    workspaceRoot: root,
    files,
    tsconfigs,
  };
}

export function findTsConfigForFile(
  filePath: string,
  tsconfigs: TsConfigInfo[],
): TsConfigInfo | undefined {
  const normalized = normalizePath(filePath);
  let best: TsConfigInfo | undefined;
  let bestLen = -1;

  for (const cfg of tsconfigs) {
    const base = cfg.baseDir;
    if (
      (normalized === base || normalized.startsWith(base + '/')) &&
      base.length > bestLen
    ) {
      // Prefer non-solution-ish names when tied later; for now longest baseDir wins
      if (
        basename(cfg.configPath) === 'tsconfig.json' ||
        !best ||
        basename(best.configPath) !== 'tsconfig.json'
      ) {
        best = cfg;
        bestLen = base.length;
      } else if (base.length > bestLen) {
        best = cfg;
        bestLen = base.length;
      }
    }
  }

  return best;
}
