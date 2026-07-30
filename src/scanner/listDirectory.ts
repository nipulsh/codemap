import { readdirSync, realpathSync, existsSync, statSync } from 'node:fs';
import { join, basename, relative } from 'node:path';
import { contentHash, fileMtimeMs } from '../utils/hash';
import { toPosix, normalizePath } from '../utils/path';
import { isSourceFile, shouldIgnoreDirectory, shouldIgnoreFile } from './ignore';
import type { ScannedFile, TsConfigInfo } from './types';

export interface ListedFolder {
  absolutePath: string;
  relativePath: string;
  name: string;
}

export interface DirectoryListing {
  path: string;
  folders: ListedFolder[];
  files: ScannedFile[];
  /** tsconfig files found as immediate children (not recursive) */
  tsconfigs: TsConfigInfo[];
}

function safeRealpath(p: string): string {
  try {
    return normalizePath(realpathSync(p));
  } catch {
    return normalizePath(p);
  }
}

/**
 * List immediate children of a directory. Does not recurse.
 */
export function listDirectory(
  dirPath: string,
  workspaceRoot: string,
): DirectoryListing {
  const root = safeRealpath(workspaceRoot);
  const dir = safeRealpath(dirPath);
  const folders: ListedFolder[] = [];
  const files: ScannedFile[] = [];
  const tsconfigs: TsConfigInfo[] = [];

  if (!existsSync(dir)) {
    return { path: dir, folders, files, tsconfigs };
  }

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { path: dir, folders, files, tsconfigs };
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (shouldIgnoreDirectory(entry.name)) {
        continue;
      }
      const real = safeRealpath(fullPath);
      folders.push({
        absolutePath: real,
        relativePath: toPosix(relative(root, real)),
        name: entry.name,
      });
      continue;
    }

    if (!entry.isFile() && !entry.isSymbolicLink()) {
      continue;
    }

    const rel = toPosix(relative(root, fullPath));

    if (/^tsconfig.*\.json$/i.test(entry.name)) {
      const real = safeRealpath(fullPath);
      tsconfigs.push({
        configPath: real,
        baseDir: normalizePath(join(real, '..')),
      });
      continue;
    }

    // Show non-source files at root/folders (package.json, README) as File nodes,
    // but only parse source files later.
    if (isSourceFile(entry.name)) {
      if (shouldIgnoreFile(rel)) {
        continue;
      }
      const real = safeRealpath(fullPath);
      try {
        files.push({
          absolutePath: real,
          relativePath: toPosix(relative(root, real)),
          mtimeMs: fileMtimeMs(real),
          contentHash: contentHash(real),
        });
      } catch {
        // skip
      }
      continue;
    }

    // Non-source files: include common project files for explorer visibility
    if (isExplorerVisibleFile(entry.name)) {
      const real = safeRealpath(fullPath);
      try {
        const st = statSync(real);
        files.push({
          absolutePath: real,
          relativePath: toPosix(relative(root, real)),
          mtimeMs: st.mtimeMs,
          contentHash: contentHash(real),
        });
      } catch {
        // skip
      }
    }
  }

  folders.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  return { path: dir, folders, files, tsconfigs };
}

function isExplorerVisibleFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return (
    lower === 'package.json' ||
    lower === 'readme.md' ||
    lower === 'readme' ||
    lower.endsWith('.md') ||
    lower === 'pnpm-workspace.yaml' ||
    lower === 'turbo.json' ||
    lower === 'next.config.js' ||
    lower === 'next.config.mjs' ||
    lower === 'next.config.ts' ||
    lower === 'vite.config.ts' ||
    lower === 'vite.config.js'
  );
}

/**
 * Walk up from a file looking for the nearest tsconfig.json.
 */
export function findNearestTsConfig(filePath: string): TsConfigInfo | undefined {
  let current = normalizePath(filePath);
  // Start from containing directory
  current = normalizePath(join(current, '..'));
  const seen = new Set<string>();

  while (!seen.has(current)) {
    seen.add(current);
    const candidate = join(current, 'tsconfig.json');
    if (existsSync(candidate)) {
      const real = safeRealpath(candidate);
      return {
        configPath: real,
        baseDir: normalizePath(join(real, '..')),
      };
    }
    const parent = normalizePath(join(current, '..'));
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return undefined;
}

export function workspaceLabel(workspaceRoot: string): string {
  return basename(safeRealpath(workspaceRoot)) || workspaceRoot;
}
