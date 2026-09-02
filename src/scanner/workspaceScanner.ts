import { readdirSync, readFileSync, realpathSync, existsSync, statSync } from 'node:fs';
import { join, basename, relative } from 'node:path';
import { hashContent } from '../utils/hash';
import { toPosix, normalizePath } from '../utils/path';
import { isSourceFile, shouldIgnoreDirectory, shouldIgnoreFile } from './ignore';
import type { ScanProgressCallback, ScanResult, ScannedFile, TsConfigInfo } from './types';

export interface ScanWorkspaceOptions {
  /**
   * Optional sink for the file text the scanner already read while hashing.
   * Later pipeline stages (parser, route analyzer) can reuse it instead of
   * re-reading every file from disk.
   */
  publishText?: (absolutePath: string, text: string) => void;
}

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
  onProgress: ScanProgressCallback | undefined,
  publishText: ScanWorkspaceOptions['publishText'],
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
      walkDirectory(fullPath, workspaceRoot, files, tsconfigs, onProgress, publishText);
      continue;
    }

    const isSymlink = entry.isSymbolicLink();
    if (!entry.isFile() && !isSymlink) {
      continue;
    }

    const rel = toPosix(relative(workspaceRoot, fullPath));

    if (/^tsconfig.*\.json$/i.test(entry.name)) {
      const real = isSymlink ? safeRealpath(fullPath) : normalizePath(fullPath);
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

    // `dir` descends from an already-canonical root and symlinked directories
    // are not followed, so only symlinked entries need realpath resolution.
    const real = isSymlink ? safeRealpath(fullPath) : normalizePath(fullPath);
    try {
      const buffer = readFileSync(real);
      files.push({
        absolutePath: real,
        relativePath: toPosix(relative(workspaceRoot, real)),
        mtimeMs: statSync(real).mtimeMs,
        contentHash: hashContent(buffer),
      });
      publishText?.(real, buffer.toString('utf8'));
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
  options: ScanWorkspaceOptions = {},
): ScanResult {
  const root = safeRealpath(workspaceRoot);
  onProgress?.('Starting workspace scan…', 0);

  const files: ScannedFile[] = [];
  const tsconfigs: TsConfigInfo[] = [];

  if (existsSync(root)) {
    walkDirectory(root, root, files, tsconfigs, onProgress, options.publishText);
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
