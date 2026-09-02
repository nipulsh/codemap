import { join } from 'node:path';
import type { ModuleInfo, WorkspaceAnalysisResult } from '../analysis/types';
import type {
  ArchitectureModule,
  ImportantFile,
  ProjectArchitecture,
} from './types';
import { classifyFileRole, classifyModuleRole } from './roleClassifier';

const ENTRY_POINT_FILENAMES = new Set([
  'activate.ts',
  'main.ts',
  'index.ts',
  'extension.ts',
  'server.ts',
  'app.ts',
]);

function detectEntryPoints(result: WorkspaceAnalysisResult): ProjectArchitecture['entryPoints'] {
  const entryPoints: ProjectArchitecture['entryPoints'] = [];
  const seen = new Set<string>();
  const fileSet = new Set(result.files.map((f) => f.relativePath));

  function add(
    rawPath: string,
    reason: string,
    confidence: 'high' | 'medium' | 'low',
    signals: string[],
  ): void {
    const candidates = [
      rawPath,
      rawPath.replace(/^\.\//, ''),
      rawPath.replace(/\.js$/, '.ts'),
      rawPath.replace(/^\.\//, '').replace(/\.js$/, '.ts'),
      join('src', rawPath.replace(/^\.\//, '').replace(/\.js$/, '.ts')).replace(/\\/g, '/'),
    ];

    for (const c of candidates) {
      if (fileSet.has(c) && !seen.has(c)) {
        seen.add(c);
        entryPoints.push({ path: c, reason, confidence, signals: [...signals].sort() });
        return;
      }
    }
  }

  const { metadata } = result;

  if (metadata.main) {
    add(metadata.main, 'package.json main field', 'high', ['package.json:main']);
  }

  if (metadata.bin) {
    const bins =
      typeof metadata.bin === 'string'
        ? { default: metadata.bin }
        : metadata.bin;
    for (const [name, path] of Object.entries(bins)) {
      add(path, `package.json bin (${name})`, 'high', [`package.json:bin:${name}`]);
    }
  }

  if (metadata.vscodeExtension?.main) {
    add(
      metadata.vscodeExtension.main,
      'VS Code extension entry (package.json main)',
      'high',
      ['vscode-extension:main'],
    );
  }

  for (const file of result.files) {
    const base = file.relativePath.split('/').pop() ?? file.relativePath;
    if (ENTRY_POINT_FILENAMES.has(base)) {
      const isRootish =
        file.relativePath.split('/').length <= 3 ||
        file.relativePath.includes('/extension/');
      if (isRootish) {
        add(
          file.relativePath,
          `conventional entry filename (${base})`,
          'medium',
          [`filename:${base}`],
        );
      }
    }
  }

  entryPoints.sort((a, b) => a.path.localeCompare(b.path));
  return entryPoints;
}

function computeFanMetrics(result: WorkspaceAnalysisResult): {
  fanIn: Map<string, number>;
  fanOut: Map<string, number>;
  deps: Map<string, Set<string>>;
  dependents: Map<string, Set<string>>;
} {
  const fanIn = new Map<string, number>();
  const fanOut = new Map<string, number>();
  const deps = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();

  for (const file of result.files) {
    fanIn.set(file.relativePath, 0);
    fanOut.set(file.relativePath, 0);
    deps.set(file.relativePath, new Set());
    dependents.set(file.relativePath, new Set());
  }

  for (const dep of result.dependencies) {
    if (dep.kind !== 'imports' && dep.kind !== 'exports') {
      continue;
    }
    fanOut.set(dep.source, (fanOut.get(dep.source) ?? 0) + 1);
    fanIn.set(dep.target, (fanIn.get(dep.target) ?? 0) + 1);
    deps.get(dep.source)?.add(dep.target);
    dependents.get(dep.target)?.add(dep.source);
  }

  return { fanIn, fanOut, deps, dependents };
}

function buildImportantFiles(
  result: WorkspaceAnalysisResult,
  entryPaths: Set<string>,
  fanIn: Map<string, number>,
  fanOut: Map<string, number>,
): ImportantFile[] {
  const important: ImportantFile[] = [];

  for (const file of result.files) {
    if (file.parseError) {
      continue;
    }

    const fi = fanIn.get(file.relativePath) ?? 0;
    const fo = fanOut.get(file.relativePath) ?? 0;
    const exportCount = file.exports.filter((e) => !e.isReExport).length;
    const scoreReasons: string[] = [];
    let score = 0;

    if (entryPaths.has(file.relativePath)) {
      score += 10;
      scoreReasons.push('declared entry point');
    }
    score += fi * 2;
    if (fi > 0) {
      scoreReasons.push(`fan-in: ${fi}`);
    }
    score += fo;
    if (fo > 0) {
      scoreReasons.push(`fan-out: ${fo}`);
    }
    score += exportCount * 0.5;
    if (exportCount > 0) {
      scoreReasons.push(`exports: ${exportCount}`);
    }

    const role = classifyFileRole({
      relativePath: file.relativePath,
      exports: file.exports.map((e) => e.name),
      imports: file.imports.map((i) => i.specifier),
      isDeclaredEntryPoint: entryPaths.has(file.relativePath),
    });

    important.push({
      path: file.relativePath,
      role,
      fanIn: fi,
      fanOut: fo,
      exportCount,
      score,
      scoreReasons: scoreReasons.sort(),
    });
  }

  important.sort((a, b) => {
    const cmp = b.score - a.score;
    return cmp !== 0 ? cmp : a.path.localeCompare(b.path);
  });

  return important.slice(0, 20);
}

function buildModules(
  result: WorkspaceAnalysisResult,
  deps: Map<string, Set<string>>,
  dependents: Map<string, Set<string>>,
): ArchitectureModule[] {
  const modules: ArchitectureModule[] = [];

  // O(1) lookups instead of scanning every module's file list per dependency
  // edge (previously O(edges × files), measurable at a few thousand files).
  // First module wins on duplicates, matching the former `.find()` semantics.
  const moduleByFile = new Map<string, ModuleInfo>();
  for (const mod of result.modules) {
    for (const filePath of mod.files) {
      if (!moduleByFile.has(filePath)) {
        moduleByFile.set(filePath, mod);
      }
    }
  }
  for (const mod of result.modules) {
    if (mod.fileCount < 1) {
      continue;
    }

    // Preserve result.files ordering (sorted by relativePath).
    const wanted = new Set(mod.files);
    const modFiles = result.files.filter((f) => wanted.has(f.relativePath));

    const allExports = [
      ...new Set(modFiles.flatMap((f) => f.exports.map((e) => e.name))),
    ].sort();

    const moduleDeps = new Set<string>();
    const moduleDependents = new Set<string>();

    for (const filePath of mod.files) {
      for (const d of deps.get(filePath) ?? []) {
        const targetModule = moduleByFile.get(d);
        if (targetModule && targetModule.path !== mod.path) {
          moduleDeps.add(targetModule.path || '(root)');
        }
      }
      for (const d of dependents.get(filePath) ?? []) {
        const sourceModule = moduleByFile.get(d);
        if (sourceModule && sourceModule.path !== mod.path) {
          moduleDependents.add(sourceModule.path || '(root)');
        }
      }
    }

    const role = classifyModuleRole(mod.path, modFiles);
    const purpose = describeModulePurpose(mod.path, role.role, mod.fileCount);

    modules.push({
      name: mod.name,
      path: mod.path || '(root)',
      purpose,
      fileCount: mod.fileCount,
      files: [...mod.files],
      role,
      exports: allExports,
      dependencies: [...moduleDeps].sort(),
      dependents: [...moduleDependents].sort(),
    });
  }

  const significant = modules.filter(
    (m) =>
      m.fileCount >= 2 ||
      m.path.startsWith('src/') ||
      m.path === '(root)' ||
      m.role.role !== 'utility',
  );

  significant.sort((a, b) => a.path.localeCompare(b.path));
  return significant;
}

function describeModulePurpose(
  path: string,
  role: string,
  fileCount: number,
): string {
  if (path === '(root)' || path === '') {
    return `Root-level module with ${fileCount} source file(s).`;
  }
  return `Directory \`${path}\` (${fileCount} file(s)); heuristic role: ${role}.`;
}

function buildTechnologies(result: WorkspaceAnalysisResult): string[] {
  const tech = new Set<string>();

  if (result.metadata.hasTypeScript) {
    tech.add('TypeScript');
  }

  const allDeps = [
    ...result.metadata.dependencies,
    ...result.metadata.devDependencies,
  ];

  const depMap: Record<string, string> = {
    react: 'React',
    'react-dom': 'React DOM',
    '@xyflow/react': 'React Flow',
    zod: 'Zod',
    typescript: 'TypeScript',
    elkjs: 'ELK.js',
    '@dagrejs/dagre': 'Dagre',
    express: 'Express',
    fastify: 'Fastify',
    next: 'Next.js',
  };

  for (const dep of allDeps) {
    const label = depMap[dep];
    if (label) {
      tech.add(label);
    }
  }

  if (result.metadata.vscodeExtension) {
    tech.add('VS Code Extension API');
  }

  if (result.tsconfigs.length > 0) {
    tech.add('TypeScript Project References');
  }

  return [...tech].sort();
}

function buildSummary(result: WorkspaceAnalysisResult): string {
  const name = result.metadata.name ?? 'Unknown project';
  const desc = result.metadata.description;
  const fileCount = result.files.length;
  const parts = [
    `${name} is a codebase with ${fileCount} analyzed source file(s).`,
  ];
  if (desc) {
    parts.push(desc);
  }
  if (result.metadata.vscodeExtension) {
    parts.push('The project is configured as a VS Code extension.');
  }
  if (result.metadata.hasTypeScript) {
    parts.push('TypeScript configuration was detected.');
  }
  return parts.join(' ');
}

function inferArchitecturalRules(
  result: WorkspaceAnalysisResult,
): ProjectArchitecture['architecturalRules'] {
  const rules: ProjectArchitecture['architecturalRules'] = [];

  const hasWebview = result.files.some((f) =>
    f.relativePath.includes('webview'),
  );
  const hasWorkers = result.files.some((f) =>
    f.relativePath.includes('workers'),
  );
  const hasExplorer = result.files.some((f) =>
    f.relativePath.includes('explorer'),
  );

  if (hasWebview) {
    rules.push({
      rule: 'Webview layer is separated from extension host logic.',
      source: 'inferred',
    });
  }
  if (hasWorkers) {
    rules.push({
      rule: 'CPU-intensive parsing runs in worker threads.',
      source: 'inferred',
    });
  }
  if (hasExplorer) {
    rules.push({
      rule: 'Explorer/orchestration logic is centralized in a dedicated service module.',
      source: 'inferred',
    });
  }

  rules.push({
    rule: 'Static analysis may not resolve dynamic or runtime-only behavior.',
    source: 'static',
  });

  return rules.sort((a, b) => a.rule.localeCompare(b.rule));
}

/**
 * Convert WorkspaceAnalysisResult into a stable ProjectArchitecture model.
 * Deterministic — no LLM involvement.
 */
export function analyzeArchitecture(
  result: WorkspaceAnalysisResult,
): ProjectArchitecture {
  const entryPoints = detectEntryPoints(result);
  const entryPaths = new Set(entryPoints.map((e) => e.path));
  const { fanIn, fanOut, deps, dependents } = computeFanMetrics(result);

  const modules = buildModules(result, deps, dependents);
  const importantFiles = buildImportantFiles(
    result,
    entryPaths,
    fanIn,
    fanOut,
  );

  return {
    projectName: result.metadata.name ?? 'Unknown Project',
    summary: buildSummary(result),
    technologies: buildTechnologies(result),
    entryPoints,
    modules,
    importantFiles,
    dependencies: result.dependencies.map((d) => ({
      source: d.source,
      target: d.target,
      kind: d.kind,
    })),
    cycles: result.cycles.map((c) => ({ filePaths: c.filePaths })),
    architecturalRules: inferArchitecturalRules(result),
    knownLimitations: result.limitations.map((l) => l.description).sort(),
    metadata: {
      fileCount: result.files.length,
      moduleCount: modules.length,
      parseErrorCount: result.parseErrorCount,
      hasTypeScript: result.metadata.hasTypeScript,
    },
  };
}
