import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanWorkspace } from '../src/scanner/workspaceScanner.ts';
import { parseFiles } from '../src/parser/extractImports.ts';
import { InMemoryDependencyIndex } from '../src/cache/dependencyIndex.ts';
import { generateGraph } from '../src/graph/generator.ts';
import type { GraphSnapshot } from '../shared/graph.ts';
import { normalizePath } from '../src/utils/path.ts';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export function fixtureRoot(name: string): string {
  return join(__dirname, 'fixtures', name);
}

export function buildGraphFromFixture(name: string): GraphSnapshot {
  const workspaceRoot = fixtureRoot(name);
  const scan = scanWorkspace(workspaceRoot);
  const results = parseFiles(
    scan.workspaceRoot,
    scan.files.map((f) => ({ absolutePath: f.absolutePath })),
    scan.tsconfigs,
  );

  const index = new InMemoryDependencyIndex();
  const byPath = new Map(results.map((r) => [normalizePath(r.filePath), r]));

  for (const file of scan.files) {
    const parsed = byPath.get(normalizePath(file.absolutePath));
    index.set({
      absolutePath: file.absolutePath,
      relativePath: file.relativePath,
      contentHash: file.contentHash,
      mtimeMs: file.mtimeMs,
      imports: parsed?.imports ?? [],
      exports: parsed?.exports ?? [],
      dependencyPaths: parsed?.dependencyPaths ?? [],
      dynamicImportPaths: parsed?.dynamicImportPaths ?? [],
      parseError: parsed?.error,
    });
  }

  return generateGraph({
    workspaceRoot: scan.workspaceRoot,
    files: index.all(),
  });
}

export function findFileNode(snapshot: GraphSnapshot, endsWith: string) {
  return snapshot.nodes.find(
    (n) =>
      n.kind === 'File' &&
      (n.filePath?.replace(/\\/g, '/').endsWith(endsWith) ||
        n.label === endsWith),
  );
}

export function hasEdge(
  snapshot: GraphSnapshot,
  kind: string,
  sourceEndsWith: string,
  targetEndsWith: string,
): boolean {
  const source = findFileNode(snapshot, sourceEndsWith);
  const target = findFileNode(snapshot, targetEndsWith);
  if (!source || !target) {
    return false;
  }
  return snapshot.edges.some(
    (e) =>
      e.kind === kind && e.source === source.id && e.target === target.id,
  );
}
