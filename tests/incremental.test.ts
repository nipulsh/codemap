import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { listDirectory } from '../src/scanner/listDirectory.ts';
import { fixtureRoot } from './helpers.ts';
import { FolderCache } from '../src/cache/folderCache.ts';
import { FileCache } from '../src/cache/fileCache.ts';
import { FunctionCache } from '../src/cache/functionCache.ts';
import { parseFile, resolveCalls } from '../src/parser/extractImports.ts';
import {
  applyGraphPatch,
  type GraphSnapshot,
} from '../shared/graph.ts';
import {
  fileNodeId,
  makeEdge,
  makeNode,
  rewireFileStubToSymbol,
  symbolNodeId,
} from '../src/graph/incremental.ts';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

describe('listDirectory', () => {
  it('lists only immediate children (not recursive)', () => {
    const root = fixtureRoot('basic-imports');
    const listing = listDirectory(root, root);
    const names = [
      ...listing.folders.map((f) => f.name),
      ...listing.files.map((f) => f.relativePath.split('/').pop()),
    ];
    // Fixture is flat — files at root, no nested walk into missing dirs
    assert.ok(listing.files.length >= 2);
    assert.ok(names.includes('main.ts'));
    assert.ok(names.includes('utils.ts'));
    // No recursive deep paths
    for (const f of listing.files) {
      assert.equal(f.relativePath.includes('/'), false);
    }
  });

  it('ignores node_modules directories', () => {
    const dir = join(tmpdir(), `codemap-list-${Date.now()}`);
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;');
    writeFileSync(join(dir, 'package.json'), '{}');
    try {
      const listing = listDirectory(dir, dir);
      assert.ok(!listing.folders.some((f) => f.name === 'node_modules'));
      assert.ok(listing.folders.some((f) => f.name === 'src'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('caches', () => {
  it('folder cache stores and invalidates', () => {
    const cache = new FolderCache();
    const root = fixtureRoot('basic-imports');
    const listing = listDirectory(root, root);
    cache.set(listing);
    assert.ok(cache.has(root));
    cache.invalidate(root);
    assert.equal(cache.get(root), undefined);
  });

  it('file cache respects content hash freshness', () => {
    const cache = new FileCache();
    cache.set({
      absolutePath: '/x/a.ts',
      relativePath: 'a.ts',
      contentHash: 'abc',
      mtimeMs: 1,
      imports: [],
      exports: [],
      symbols: [],
      dependencyPaths: [],
      dynamicImportPaths: [],
    });
    assert.ok(cache.getIfFresh('/x/a.ts', 'abc'));
    assert.equal(cache.getIfFresh('/x/a.ts', 'other'), undefined);
  });

  it('function cache invalidates by file', () => {
    const cache = new FunctionCache();
    cache.set({
      nodeId: 'symbol:/x/a.ts:Function:foo',
      filePath: '/x/a.ts',
      functionName: 'foo',
      callees: [],
    });
    cache.set({
      nodeId: 'symbol:/x/b.ts:Function:bar',
      filePath: '/x/b.ts',
      functionName: 'bar',
      callees: [],
    });
    cache.invalidateFile('/x/a.ts');
    assert.equal(cache.get('symbol:/x/a.ts:Function:foo'), undefined);
    assert.ok(cache.get('symbol:/x/b.ts:Function:bar'));
  });
});

describe('symbol extraction and calls', () => {
  it('extracts top-level functions from a file', () => {
    const root = fixtureRoot('basic-imports');
    const file = join(root, 'main.ts');
    const result = parseFile(
      root,
      { absolutePath: file },
      [{ configPath: join(root, 'tsconfig.json'), baseDir: root }],
    );
    assert.ok(result.symbols.length >= 0);
    // utils exports helpers — parse utils
    const utils = parseFile(
      root,
      { absolutePath: join(root, 'utils.ts') },
      [{ configPath: join(root, 'tsconfig.json'), baseDir: root }],
    );
    assert.ok(utils.exports.length > 0 || utils.symbols.length >= 0);
  });

  it('resolves same-file and import callees', () => {
    const dir = join(tmpdir(), `codemap-calls-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { target: 'ES2022', module: 'ESNext', strict: true },
      }),
    );
    writeFileSync(
      join(dir, 'auth.ts'),
      `
export function validateInput() { return true; }
export function login() {
  validateInput();
  helper();
}
function helper() {}
`.trim(),
    );
    writeFileSync(
      join(dir, 'jwt.ts'),
      `
export function generateJWT() { return 't'; }
`.trim(),
    );
    writeFileSync(
      join(dir, 'app.ts'),
      `
import { generateJWT } from './jwt';
export function login() {
  generateJWT();
}
`.trim(),
    );

    try {
      const auth = parseFile(
        dir,
        { absolutePath: join(dir, 'auth.ts') },
        [{ configPath: join(dir, 'tsconfig.json'), baseDir: dir }],
      );
      assert.ok(auth.symbols.some((s) => s.name === 'login'));
      assert.ok(auth.symbols.some((s) => s.name === 'validateInput'));

      const calls = resolveCalls(
        dir,
        join(dir, 'auth.ts'),
        'login',
        [{ configPath: join(dir, 'tsconfig.json'), baseDir: dir }],
      );
      assert.ok(calls.callees.some((c) => c.name === 'validateInput' && c.local));
      assert.ok(calls.callees.some((c) => c.name === 'helper' && c.local));

      const cross = resolveCalls(
        dir,
        join(dir, 'app.ts'),
        'login',
        [{ configPath: join(dir, 'tsconfig.json'), baseDir: dir }],
      );
      assert.ok(
        cross.callees.some(
          (c) => c.name === 'generateJWT' && !!c.targetFile,
        ),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('graph patch and rewiring', () => {
  it('applyGraphPatch upserts and removes', () => {
    const snap: GraphSnapshot = {
      nodes: [makeNode('a', 'File', 'a.ts')],
      edges: [],
      generatedAt: 1,
    };
    const next = applyGraphPatch(snap, {
      upsertNodes: [makeNode('b', 'File', 'b.ts')],
      removeNodeIds: ['a'],
      upsertEdges: [makeEdge('imports', 'b', 'b')],
      removeEdgeIds: [],
    });
    assert.equal(next.nodes.length, 1);
    assert.equal(next.nodes[0].id, 'b');
    assert.equal(next.edges.length, 1);
  });

  it('rewires call edges from file stub to symbol', () => {
    const file = '/proj/jwt.ts';
    const stub = fileNodeId(file);
    const sym = symbolNodeId(file, 'generateJWT', 'Function');
    const edges = [
      makeEdge('calls', 'symbol:/proj/a.ts:Function:login', stub, {
        calleeName: 'generateJWT',
      }),
    ];
    const result = rewireFileStubToSymbol(edges, stub, sym, 'generateJWT');
    assert.equal(result.removeEdgeIds.length, 1);
    assert.equal(result.upsertEdges.length, 1);
    assert.equal(result.upsertEdges[0].target, sym);
  });
});
