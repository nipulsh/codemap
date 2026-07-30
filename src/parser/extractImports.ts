import * as ts from 'typescript';
import { readFileSync, existsSync } from 'node:fs';
import type {
  ExportSpec,
  FileParseResult,
  ImportSpec,
  ResolveCallsResult,
} from './types';
import { normalizePath } from '../utils/path';
import { extractSymbols, resolveFunctionCallees } from './extractSymbols';

interface ProjectContext {
  configPath: string;
  baseDir: string;
  options: ts.CompilerOptions;
  fileNames: string[];
}

function loadProjects(
  tsconfigs: Array<{ configPath: string; baseDir: string }>,
): ProjectContext[] {
  const projects: ProjectContext[] = [];

  for (const cfg of tsconfigs) {
    if (!existsSync(cfg.configPath)) {
      continue;
    }
    const readResult = ts.readConfigFile(cfg.configPath, ts.sys.readFile);
    if (readResult.error) {
      continue;
    }
    const parsed = ts.parseJsonConfigFileContent(
      readResult.config,
      ts.sys,
      cfg.baseDir,
      undefined,
      cfg.configPath,
    );
    projects.push({
      configPath: cfg.configPath,
      baseDir: normalizePath(cfg.baseDir),
      options: parsed.options,
      fileNames: parsed.fileNames.map(normalizePath),
    });
  }

  if (projects.length === 0) {
    projects.push({
      configPath: '',
      baseDir: '',
      options: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        jsx: ts.JsxEmit.ReactJSX,
        allowJs: true,
        esModuleInterop: true,
        strict: true,
      },
      fileNames: [],
    });
  }

  return projects;
}

function pickProject(
  filePath: string,
  projects: ProjectContext[],
): ProjectContext {
  const normalized = normalizePath(filePath);
  let best = projects[0];
  let bestLen = -1;

  for (const project of projects) {
    if (!project.baseDir) {
      continue;
    }
    if (
      (normalized === project.baseDir ||
        normalized.startsWith(project.baseDir + '/') ||
        normalized.startsWith(project.baseDir + '\\')) &&
      project.baseDir.length > bestLen
    ) {
      best = project;
      bestLen = project.baseDir.length;
    }
  }

  return best;
}

function resolveModule(
  specifier: string,
  containingFile: string,
  options: ts.CompilerOptions,
): string | undefined {
  if (specifier.startsWith('node:') || !isRelativeOrAlias(specifier, options)) {
    // Skip bare package imports for graph edges (node_modules already ignored)
    // but still allow path aliases (non-relative that match paths)
    if (!options.paths && !specifier.startsWith('.') && !specifier.startsWith('/')) {
      // Check if it might be a path alias
      if (!options.paths || !matchesPathAlias(specifier, options)) {
        return undefined;
      }
    } else if (
      !specifier.startsWith('.') &&
      !specifier.startsWith('/') &&
      !matchesPathAlias(specifier, options)
    ) {
      return undefined;
    }
  }

  const resolved = ts.resolveModuleName(
    specifier,
    containingFile,
    options,
    ts.sys,
  );
  const resolvedName = resolved.resolvedModule?.resolvedFileName;
  if (!resolvedName) {
    return undefined;
  }
  // Skip .d.ts from node_modules
  const normalized = normalizePath(resolvedName);
  if (normalized.includes('/node_modules/')) {
    return undefined;
  }
  return normalized;
}

function isRelativeOrAlias(
  specifier: string,
  options: ts.CompilerOptions,
): boolean {
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    return true;
  }
  return matchesPathAlias(specifier, options);
}

function matchesPathAlias(
  specifier: string,
  options: ts.CompilerOptions,
): boolean {
  if (!options.paths) {
    return false;
  }
  for (const pattern of Object.keys(options.paths)) {
    const prefix = pattern.replace(/\*$/, '');
    if (specifier === pattern || (pattern.endsWith('*') && specifier.startsWith(prefix))) {
      return true;
    }
  }
  return false;
}

function extractFromSourceFile(
  sourceFile: ts.SourceFile,
  options: ts.CompilerOptions,
): { imports: ImportSpec[]; exports: ExportSpec[]; dynamicImportPaths: string[] } {
  const imports: ImportSpec[] = [];
  const exports: ExportSpec[] = [];
  const dynamicImportPaths: string[] = [];
  const filePath = normalizePath(sourceFile.fileName);

  const visit = (node: ts.Node): void => {
    // import … from '…'
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      const resolvedPath = resolveModule(specifier, filePath, options);
      const names: string[] = [];
      const clause = node.importClause;
      if (clause?.name) {
        names.push('default');
      }
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          names.push('*');
        } else if (ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) {
            names.push(el.name.text);
          }
        }
      }
      imports.push({
        specifier,
        resolvedPath,
        kind: 'static',
        isTypeOnly: !!clause?.isTypeOnly,
        names,
      });
    }

    // export … from '…'
    if (ts.isExportDeclaration(node)) {
      const moduleSpec = node.moduleSpecifier;
      if (moduleSpec && ts.isStringLiteral(moduleSpec)) {
        const specifier = moduleSpec.text;
        const fromPath = resolveModule(specifier, filePath, options);
        if (node.exportClause && ts.isNamedExports(node.exportClause)) {
          for (const el of node.exportClause.elements) {
            exports.push({
              name: el.name.text,
              isReExport: true,
              fromPath,
              fromSpecifier: specifier,
              isTypeOnly: !!node.isTypeOnly || !!el.isTypeOnly,
            });
          }
        } else {
          // export * from '…'
          exports.push({
            name: '*',
            isReExport: true,
            fromPath,
            fromSpecifier: specifier,
            isTypeOnly: !!node.isTypeOnly,
          });
        }
        // Re-exports also create an import-like dependency
        imports.push({
          specifier,
          resolvedPath: fromPath,
          kind: 'static',
          isTypeOnly: !!node.isTypeOnly,
          names: ['*'],
        });
      } else if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) {
          exports.push({
            name: el.name.text,
            isReExport: false,
            isTypeOnly: !!node.isTypeOnly || !!el.isTypeOnly,
          });
        }
      }
    }

    // export function / const / class / default
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isVariableStatement(node)) {
      const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
      const isExport = mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (isExport) {
        if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
          if (node.name) {
            exports.push({
              name: node.name.text,
              isReExport: false,
              isTypeOnly: false,
            });
          }
        } else if (ts.isVariableStatement(node)) {
          for (const decl of node.declarationList.declarations) {
            if (ts.isIdentifier(decl.name)) {
              exports.push({
                name: decl.name.text,
                isReExport: false,
                isTypeOnly: false,
              });
            }
          }
        }
      }
    }

    if (ts.isExportAssignment(node)) {
      exports.push({
        name: 'default',
        isReExport: false,
        isTypeOnly: false,
      });
    }

    // dynamic import('…')
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const specifier = (node.arguments[0] as ts.StringLiteral).text;
      const resolvedPath = resolveModule(specifier, filePath, options);
      imports.push({
        specifier,
        resolvedPath,
        kind: 'dynamic',
        isTypeOnly: false,
        names: [],
      });
      if (resolvedPath) {
        dynamicImportPaths.push(resolvedPath);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return { imports, exports, dynamicImportPaths };
}

/**
 * Resolve one hop through barrel re-exports: if A imports B and B only re-exports from C,
 * dependency of A becomes C (when B is a pure re-export barrel for that binding).
 * Phase 1: for any import of a module that has re-export-from targets, also include
 * those underlying modules as dependencies (one hop).
 */
function resolveBarrelHop(
  imports: ImportSpec[],
  allResults: Map<string, FileParseResult>,
): string[] {
  const deps = new Set<string>();

  for (const imp of imports) {
    if (imp.kind !== 'static' || !imp.resolvedPath) {
      continue;
    }
    deps.add(imp.resolvedPath);

    const target = allResults.get(imp.resolvedPath);
    if (!target) {
      continue;
    }

    const reExports = target.exports.filter((e) => e.isReExport && e.fromPath);
    if (reExports.length === 0) {
      continue;
    }

    // One-hop: if target is primarily a barrel (has re-exports), link through
    for (const re of reExports) {
      if (re.fromPath) {
        deps.add(re.fromPath);
      }
    }
  }

  return [...deps];
}

export function parseFiles(
  workspaceRoot: string,
  files: Array<{ absolutePath: string; content?: string }>,
  tsconfigs: Array<{ configPath: string; baseDir: string }>,
): FileParseResult[] {
  const projects = loadProjects(
    tsconfigs.map((t) => ({
      configPath: t.configPath,
      baseDir: t.baseDir || workspaceRoot,
    })),
  );

  // Ensure default project has workspace baseDir
  for (const p of projects) {
    if (!p.baseDir) {
      p.baseDir = normalizePath(workspaceRoot);
      p.options.baseUrl = p.options.baseUrl ?? p.baseDir;
    }
  }

  const contentMap = new Map<string, string>();
  for (const f of files) {
    const path = normalizePath(f.absolutePath);
    try {
      contentMap.set(
        path,
        f.content ?? readFileSync(f.absolutePath, 'utf8'),
      );
    } catch (err) {
      contentMap.set(path, '');
    }
  }

  const preliminary = new Map<string, FileParseResult>();

  for (const f of files) {
    const filePath = normalizePath(f.absolutePath);
    const project = pickProject(filePath, projects);
    const content = contentMap.get(filePath) ?? '';

    try {
      const sourceFile = ts.createSourceFile(
        filePath,
        content,
        project.options.target ?? ts.ScriptTarget.ES2022,
        true,
        filePath.endsWith('.tsx') || filePath.endsWith('.jsx')
          ? ts.ScriptKind.TSX
          : filePath.endsWith('.js') || filePath.endsWith('.jsx')
            ? ts.ScriptKind.JS
            : ts.ScriptKind.TS,
      );

      const { imports, exports, dynamicImportPaths } = extractFromSourceFile(
        sourceFile,
        {
          ...project.options,
          baseUrl: project.options.baseUrl ?? project.baseDir,
        },
      );

      const symbols = extractSymbols(sourceFile);

      preliminary.set(filePath, {
        filePath,
        imports,
        exports,
        symbols,
        dependencyPaths: [],
        dynamicImportPaths,
      });
    } catch (err) {
      preliminary.set(filePath, {
        filePath,
        imports: [],
        exports: [],
        symbols: [],
        dependencyPaths: [],
        dynamicImportPaths: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Second pass: barrel hop
  const results: FileParseResult[] = [];
  for (const [filePath, result] of preliminary) {
    const deps = resolveBarrelHop(result.imports, preliminary);
    // Also keep dynamic imports separate
    const staticDeps = deps.filter(
      (d) => !result.dynamicImportPaths.includes(d),
    );
    results.push({
      ...result,
      dependencyPaths: staticDeps,
    });
  }

  return results;
}

/**
 * Parse a single file (used for lazy file expansion).
 */
export function parseFile(
  workspaceRoot: string,
  file: { absolutePath: string; content?: string },
  tsconfigs: Array<{ configPath: string; baseDir: string }>,
): FileParseResult {
  const results = parseFiles(workspaceRoot, [file], tsconfigs);
  return (
    results[0] ?? {
      filePath: normalizePath(file.absolutePath),
      imports: [],
      exports: [],
      symbols: [],
      dependencyPaths: [],
      dynamicImportPaths: [],
      error: 'Parse returned no result',
    }
  );
}

/**
 * Resolve immediate callees of a named function in a file.
 */
export function resolveCalls(
  workspaceRoot: string,
  filePath: string,
  functionName: string,
  tsconfigs: Array<{ configPath: string; baseDir: string }>,
  content?: string,
): ResolveCallsResult {
  const normalized = normalizePath(filePath);
  const projects = loadProjects(
    tsconfigs.map((t) => ({
      configPath: t.configPath,
      baseDir: t.baseDir || workspaceRoot,
    })),
  );
  for (const p of projects) {
    if (!p.baseDir) {
      p.baseDir = normalizePath(workspaceRoot);
      p.options.baseUrl = p.options.baseUrl ?? p.baseDir;
    }
  }

  try {
    const sourceText =
      content ?? readFileSync(filePath, 'utf8');
    const project = pickProject(normalized, projects);
    const sourceFile = ts.createSourceFile(
      normalized,
      sourceText,
      project.options.target ?? ts.ScriptTarget.ES2022,
      true,
      normalized.endsWith('.tsx') || normalized.endsWith('.jsx')
        ? ts.ScriptKind.TSX
        : normalized.endsWith('.js') || normalized.endsWith('.jsx')
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS,
    );

    const options = {
      ...project.options,
      baseUrl: project.options.baseUrl ?? project.baseDir,
    };
    const { imports } = extractFromSourceFile(sourceFile, options);
    const symbols = extractSymbols(sourceFile);
    const callees = resolveFunctionCallees(
      sourceFile,
      functionName,
      imports,
      symbols,
    );

    return {
      filePath: normalized,
      functionName,
      callees,
    };
  } catch (err) {
    return {
      filePath: normalized,
      functionName,
      callees: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
