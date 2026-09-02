/**
 * Deterministic synthetic workspace generator for benchmarks and stress tests.
 *
 * Given the same spec (including seed) the generator always produces byte-identical
 * files, so it can also back determinism tests. Everything is written to a fresh
 * temp directory; call cleanup() when done.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type RouteStyle = 'app' | 'router' | 'mounted' | 'nested';

export interface SyntheticWorkspaceSpec {
  name: string;
  /** Plain module source files (excludes route/handler/service chain files). */
  fileCount: number;
  /** Files per src/modN directory. Default 10. */
  filesPerModule?: number;
  /** Static imports per module file (to earlier files). Default 3. */
  importsPerFile?: number;
  /** Express routes to generate. Default 0. */
  routeCount?: number;
  /** Routes registered per routes file. Default 10. */
  routesPerFile?: number;
  /** How routes are registered. Default 'router'. */
  routeStyle?: RouteStyle;
  /** Number of routes that share one handler (1 = each route has its own). Default 1. */
  routesPerHandler?: number;
  /** Call-chain depth below each handler (handler → service… → repository). Default 3. */
  chainDepth?: number;
  /** Inject an import cycle every N module files (0 disables). Default 0. */
  cycleEvery?: number;
  seed?: number;
}

export interface SyntheticWorkspace {
  root: string;
  spec: Required<SyntheticWorkspaceSpec>;
  /** Total source files written (modules + routes + handler chains). */
  totalFiles: number;
  cleanup(): void;
}

/** Small deterministic PRNG (mulberry32). */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function withDefaults(spec: SyntheticWorkspaceSpec): Required<SyntheticWorkspaceSpec> {
  return {
    name: spec.name,
    fileCount: spec.fileCount,
    filesPerModule: spec.filesPerModule ?? 10,
    importsPerFile: spec.importsPerFile ?? 3,
    routeCount: spec.routeCount ?? 0,
    routesPerFile: spec.routesPerFile ?? 10,
    routeStyle: spec.routeStyle ?? 'router',
    routesPerHandler: Math.max(1, spec.routesPerHandler ?? 1),
    chainDepth: Math.max(1, spec.chainDepth ?? 3),
    cycleEvery: spec.cycleEvery ?? 0,
    seed: spec.seed ?? 42,
  };
}

function moduleFilePath(index: number, filesPerModule: number): string {
  const mod = Math.floor(index / filesPerModule);
  const file = index % filesPerModule;
  return `src/mod${mod}/file${file}.ts`;
}

function relativeImport(fromFile: string, toFile: string): string {
  const fromParts = fromFile.split('/').slice(0, -1);
  const toParts = toFile.replace(/\.ts$/, '').split('/');
  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common] === toParts[common]
  ) {
    common++;
  }
  const ups = fromParts.length - common;
  const prefix = ups === 0 ? './' : '../'.repeat(ups);
  return prefix + toParts.slice(common).join('/');
}

function writeFile(root: string, relPath: string, content: string): void {
  const abs = join(root, ...relPath.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

function moduleFileContent(
  index: number,
  filePath: string,
  importTargets: number[],
  filesPerModule: number,
): string {
  const lines: string[] = [];
  for (const target of importTargets) {
    const targetPath = moduleFilePath(target, filesPerModule);
    lines.push(
      `import { fn_${target}_0 } from '${relativeImport(filePath, targetPath)}';`,
    );
  }
  if (importTargets.length > 0) {
    lines.push('');
  }
  const calls = importTargets.map((t) => `fn_${t}_0(x)`).join(' + ');
  lines.push(
    `export interface Model${index} {`,
    '  id: string;',
    `  value: number;`,
    '}',
    '',
    `export function fn_${index}_0(x: number): number {`,
    `  return ${calls ? `${calls} + ` : ''}helper_${index}(x) + ${index};`,
    '}',
    '',
    `export function fn_${index}_1(model: Model${index}): Model${index} {`,
    `  return { ...model, value: fn_${index}_0(model.value) };`,
    '}',
    '',
    `function helper_${index}(x: number): number {`,
    '  return x * 2;',
    '}',
    '',
    `export const constant_${index} = ${index};`,
    '',
  );
  return lines.join('\n');
}

function chainFunctionName(handlerIndex: number, level: number): string {
  return level === 0 ? `handler_${handlerIndex}` : `service_${handlerIndex}_${level}`;
}

function chainFilePath(handlerIndex: number, level: number, chainDepth: number): string {
  if (level === 0) {
    return `src/handlers/handler${handlerIndex}.ts`;
  }
  if (level === chainDepth - 1) {
    return `src/repositories/repository${handlerIndex}.ts`;
  }
  return `src/services/service${handlerIndex}_${level}.ts`;
}

function writeHandlerChain(
  root: string,
  handlerIndex: number,
  chainDepth: number,
): number {
  let written = 0;
  for (let level = 0; level < chainDepth; level++) {
    const path = chainFilePath(handlerIndex, level, chainDepth);
    const name = chainFunctionName(handlerIndex, level);
    const lines: string[] = [];
    const hasNext = level < chainDepth - 1;
    if (hasNext) {
      const nextPath = chainFilePath(handlerIndex, level + 1, chainDepth);
      const nextName = chainFunctionName(handlerIndex, level + 1);
      lines.push(`import { ${nextName} } from '${relativeImport(path, nextPath)}';`);
    }
    if (level === 0) {
      lines.push(`import type { Request, Response } from 'express';`, '');
      lines.push(
        `export async function ${name}(req: Request, res: Response): Promise<void> {`,
        hasNext
          ? `  const data = await ${chainFunctionName(handlerIndex, 1)}(String(req.params.id));`
          : `  const data = { id: String(req.params.id) };`,
        '  res.json(data);',
        '}',
        '',
      );
    } else {
      lines.push('');
      lines.push(
        `export async function ${name}(id: string): Promise<{ id: string }> {`,
        hasNext
          ? `  return ${chainFunctionName(handlerIndex, level + 1)}(id);`
          : `  return { id };`,
        '}',
        '',
      );
    }
    writeFile(root, path, lines.join('\n'));
    written++;
  }
  return written;
}

function routesFileContent(
  fileIndex: number,
  routes: Array<{ routeIndex: number; handlerIndex: number; method: string }>,
  style: RouteStyle,
  filePath: string,
): string {
  const lines: string[] = [];
  const handlerImports = [...new Set(routes.map((r) => r.handlerIndex))].sort(
    (a, b) => a - b,
  );
  for (const h of handlerImports) {
    lines.push(
      `import { handler_${h} } from '${relativeImport(filePath, `src/handlers/handler${h}.ts`)}';`,
    );
  }

  switch (style) {
    case 'app':
      lines.unshift(`import express from 'express';`);
      lines.push('', 'const app = express();', '');
      for (const r of routes) {
        lines.push(`app.${r.method}('/api/r${r.routeIndex}/items/:id', handler_${r.handlerIndex});`);
      }
      lines.push('', 'export default app;', '');
      break;
    case 'router':
      lines.unshift(`import { Router } from 'express';`);
      lines.push('', `export const router${fileIndex} = Router();`, '');
      for (const r of routes) {
        lines.push(
          `router${fileIndex}.${r.method}('/api/r${r.routeIndex}/items/:id', handler_${r.handlerIndex});`,
        );
      }
      lines.push('', `export default router${fileIndex};`, '');
      break;
    case 'mounted':
      lines.unshift(`import express, { Router } from 'express';`);
      lines.push('', 'const app = express();', `const router${fileIndex} = Router();`, '');
      for (const r of routes) {
        lines.push(
          `router${fileIndex}.${r.method}('/r${r.routeIndex}/items/:id', handler_${r.handlerIndex});`,
        );
      }
      lines.push('', `app.use('/api/v${fileIndex}', router${fileIndex});`, '', 'export default app;', '');
      break;
    case 'nested':
      lines.unshift(`import express, { Router } from 'express';`);
      lines.push(
        '',
        'const app = express();',
        'const api = Router();',
        `const v${fileIndex} = Router();`,
        '',
      );
      for (const r of routes) {
        lines.push(
          `v${fileIndex}.${r.method}('/r${r.routeIndex}/items/:id', handler_${r.handlerIndex});`,
        );
      }
      lines.push(
        '',
        `api.use('/v${fileIndex}', v${fileIndex});`,
        `app.use('/api${fileIndex}', api);`,
        '',
        'export default app;',
        '',
      );
      break;
  }
  return lines.join('\n');
}

const METHODS = ['get', 'post', 'put', 'delete'];

export function createSyntheticWorkspace(
  input: SyntheticWorkspaceSpec,
): SyntheticWorkspace {
  const spec = withDefaults(input);
  const rng = createRng(spec.seed);
  const root = mkdtempSync(join(tmpdir(), `codemap-bench-${spec.name}-`));
  let totalFiles = 0;

  writeFile(
    root,
    'package.json',
    JSON.stringify(
      {
        name: `synthetic-${spec.name}`,
        version: '1.0.0',
        description: `Synthetic benchmark workspace (${spec.name})`,
        main: 'src/index.ts',
        dependencies: spec.routeCount > 0 ? { express: '^4.0.0' } : {},
        devDependencies: { typescript: '^5.0.0' },
      },
      null,
      2,
    ),
  );
  writeFile(
    root,
    'tsconfig.json',
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
        },
        include: ['src/**/*'],
      },
      null,
      2,
    ),
  );

  // Module files with deterministic imports to earlier files (acyclic by default).
  for (let i = 0; i < spec.fileCount; i++) {
    const path = moduleFilePath(i, spec.filesPerModule);
    const targets = new Set<number>();
    const available = i;
    const wanted = Math.min(spec.importsPerFile, available);
    while (targets.size < wanted) {
      targets.add(Math.floor(rng() * available));
    }
    if (spec.cycleEvery > 0 && i > 0 && i % spec.cycleEvery === 0) {
      // Forward import to i+1; file i+1 will import i by construction below.
      if (i + 1 < spec.fileCount) {
        targets.add(i + 1);
      }
    }
    if (spec.cycleEvery > 0 && i > 1 && (i - 1) % spec.cycleEvery === 0) {
      targets.add(i - 1);
    }
    writeFile(
      root,
      path,
      moduleFileContent(i, path, [...targets].sort((a, b) => a - b), spec.filesPerModule),
    );
    totalFiles++;
  }

  // Index file importing the first file of each module directory.
  const moduleCount = Math.ceil(spec.fileCount / spec.filesPerModule);
  const indexLines: string[] = [];
  for (let m = 0; m < moduleCount; m++) {
    const target = m * spec.filesPerModule;
    indexLines.push(
      `import { fn_${target}_0 } from '${relativeImport('src/index.ts', moduleFilePath(target, spec.filesPerModule))}';`,
    );
  }
  indexLines.push('', 'export function main(): number {');
  indexLines.push(
    `  return ${moduleCount > 0 ? Array.from({ length: moduleCount }, (_, m) => `fn_${m * spec.filesPerModule}_0(1)`).join(' + ') : '0'};`,
  );
  indexLines.push('}', '');
  writeFile(root, 'src/index.ts', indexLines.join('\n'));
  totalFiles++;

  // Express routes + handler chains.
  if (spec.routeCount > 0) {
    const handlerCount = Math.ceil(spec.routeCount / spec.routesPerHandler);
    for (let h = 0; h < handlerCount; h++) {
      totalFiles += writeHandlerChain(root, h, spec.chainDepth);
    }
    const routeFiles = Math.ceil(spec.routeCount / spec.routesPerFile);
    for (let f = 0; f < routeFiles; f++) {
      const routes: Array<{ routeIndex: number; handlerIndex: number; method: string }> = [];
      for (
        let r = f * spec.routesPerFile;
        r < Math.min(spec.routeCount, (f + 1) * spec.routesPerFile);
        r++
      ) {
        routes.push({
          routeIndex: r,
          handlerIndex: Math.floor(r / spec.routesPerHandler),
          method: METHODS[r % METHODS.length]!,
        });
      }
      const path = `src/routes/routes${f}.ts`;
      writeFile(root, path, routesFileContent(f, routes, spec.routeStyle, path));
      totalFiles++;
    }
  }

  return {
    root,
    spec,
    totalFiles,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// ─── Call-chain shape workspaces ─────────────────────────────────────────────

export type CallChainShape = 'linear' | 'dag' | 'cyclic' | 'shared' | 'recursive';

export interface CallChainWorkspaceSpec {
  shape: CallChainShape;
  /** Chain depth (linear/dag/cyclic) — number of function levels below the handler. */
  depth?: number;
  /** Functions per level for the dag shape. */
  width?: number;
  /** Routes for the shared shape. */
  routeCount?: number;
}

export interface CallChainWorkspace {
  root: string;
  spec: Required<CallChainWorkspaceSpec>;
  totalFiles: number;
  cleanup(): void;
}

function writeCommonProjectFiles(root: string, name: string): void {
  writeFile(
    root,
    'package.json',
    JSON.stringify(
      { name, version: '1.0.0', dependencies: { express: '^4.0.0' } },
      null,
      2,
    ),
  );
  writeFile(
    root,
    'tsconfig.json',
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
        },
        include: ['src/**/*'],
      },
      null,
      2,
    ),
  );
}

export function createCallChainWorkspace(
  input: CallChainWorkspaceSpec,
): CallChainWorkspace {
  const spec: Required<CallChainWorkspaceSpec> = {
    shape: input.shape,
    depth: Math.max(1, input.depth ?? 8),
    width: Math.max(1, input.width ?? 3),
    routeCount: Math.max(1, input.routeCount ?? 1),
  };
  const root = mkdtempSync(join(tmpdir(), `codemap-chain-${spec.shape}-`));
  writeCommonProjectFiles(root, `chain-${spec.shape}`);
  let totalFiles = 0;

  const routesLines = [
    `import { Router } from 'express';`,
    `import { entry } from './handler';`,
    '',
    'export const router = Router();',
  ];

  switch (spec.shape) {
    case 'linear':
    case 'recursive':
    case 'cyclic': {
      // handler → level1 → level2 → … → levelN (cyclic: levelN → level1; recursive: levelN calls itself)
      writeFile(
        root,
        'src/handler.ts',
        [
          `import type { Request, Response } from 'express';`,
          `import { level1 } from './levels/level1';`,
          '',
          'export async function entry(req: Request, res: Response): Promise<void> {',
          '  res.json(await level1(String(req.params.id)));',
          '}',
          '',
        ].join('\n'),
      );
      totalFiles++;
      for (let level = 1; level <= spec.depth; level++) {
        const isLast = level === spec.depth;
        const lines: string[] = [];
        if (!isLast) {
          lines.push(`import { level${level + 1} } from './level${level + 1}';`);
        } else if (spec.shape === 'cyclic') {
          lines.push(`import { level1 } from './level1';`);
        }
        lines.push('');
        lines.push(`export async function level${level}(id: string): Promise<{ id: string }> {`);
        if (!isLast) {
          lines.push(`  return level${level + 1}(id);`);
        } else if (spec.shape === 'cyclic') {
          lines.push(`  if (id === 'stop') {`, `    return { id };`, `  }`, `  return level1('stop');`);
        } else if (spec.shape === 'recursive') {
          lines.push(`  if (id.length > 10) {`, `    return { id };`, `  }`, `  return level${level}(id + 'x');`);
        } else {
          lines.push(`  return { id };`);
        }
        lines.push('}', '');
        writeFile(root, `src/levels/level${level}.ts`, lines.join('\n'));
        totalFiles++;
      }
      routesLines.push(`router.get('/api/items/:id', entry);`);
      break;
    }
    case 'dag': {
      // Each function at level d calls every function at level d+1 (width² edges per level).
      writeFile(
        root,
        'src/handler.ts',
        [
          `import type { Request, Response } from 'express';`,
          `import { ${Array.from({ length: spec.width }, (_, i) => `l1_f${i}`).join(', ')} } from './levels/level1';`,
          '',
          'export async function entry(req: Request, res: Response): Promise<void> {',
          `  const id = String(req.params.id);`,
          ...Array.from({ length: spec.width }, (_, i) => `  await l1_f${i}(id);`),
          '  res.json({ id });',
          '}',
          '',
        ].join('\n'),
      );
      totalFiles++;
      for (let level = 1; level <= spec.depth; level++) {
        const isLast = level === spec.depth;
        const lines: string[] = [];
        if (!isLast) {
          lines.push(
            `import { ${Array.from({ length: spec.width }, (_, i) => `l${level + 1}_f${i}`).join(', ')} } from './level${level + 1}';`,
            '',
          );
        }
        for (let f = 0; f < spec.width; f++) {
          lines.push(`export async function l${level}_f${f}(id: string): Promise<{ id: string }> {`);
          if (!isLast) {
            for (let g = 0; g < spec.width; g++) {
              lines.push(`  await l${level + 1}_f${g}(id);`);
            }
          }
          lines.push('  return { id };', '}', '');
        }
        writeFile(root, `src/levels/level${level}.ts`, lines.join('\n'));
        totalFiles++;
      }
      routesLines.push(`router.get('/api/items/:id', entry);`);
      break;
    }
    case 'shared': {
      // Many routes → one handler with a short chain.
      writeFile(
        root,
        'src/handler.ts',
        [
          `import type { Request, Response } from 'express';`,
          `import { level1 } from './levels/level1';`,
          '',
          'export async function entry(req: Request, res: Response): Promise<void> {',
          '  res.json(await level1(String(req.params.id)));',
          '}',
          '',
        ].join('\n'),
      );
      totalFiles++;
      for (let level = 1; level <= spec.depth; level++) {
        const isLast = level === spec.depth;
        const lines: string[] = [];
        if (!isLast) {
          lines.push(`import { level${level + 1} } from './level${level + 1}';`);
        }
        lines.push('');
        lines.push(`export async function level${level}(id: string): Promise<{ id: string }> {`);
        lines.push(isLast ? `  return { id };` : `  return level${level + 1}(id);`);
        lines.push('}', '');
        writeFile(root, `src/levels/level${level}.ts`, lines.join('\n'));
        totalFiles++;
      }
      for (let r = 0; r < spec.routeCount; r++) {
        routesLines.push(`router.${METHODS[r % METHODS.length]}('/api/shared${r}/:id', entry);`);
      }
      break;
    }
  }

  routesLines.push('', 'export default router;', '');
  writeFile(root, 'src/routes.ts', routesLines.join('\n'));
  totalFiles++;

  return {
    root,
    spec,
    totalFiles,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
