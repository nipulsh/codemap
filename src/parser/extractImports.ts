import * as ts from 'typescript';
import { readFileSync, existsSync } from 'node:fs';
import type {
  ExportSpec,
  FileParseResult,
  ImportSpec,
  ResolveCallsResult,
} from './types';
import { normalizePath } from '../utils/path';
import { throwIfAborted } from '../utils/cancellation';
import { extractSymbols, resolveFunctionCallees } from './extractSymbols';

interface ProjectContext {
  configPath: string;
  baseDir: string;
  options: ts.CompilerOptions;
  /**
   * Options actually used for module resolution (baseUrl defaulted to baseDir),
   * computed once so the resolution cache sees a stable options object.
   */
  resolutionOptions?: ts.CompilerOptions;
  resolutionCache?: ts.ModuleResolutionCache;
}

/**
 * Config host that never enumerates project files. We only need compilerOptions
 * (paths, baseUrl, target…) — the `fileNames` glob that ts.sys would perform over
 * the whole workspace was measured at tens of milliseconds per call and its
 * result was never used.
 */
const NO_GLOB_CONFIG_HOST: ts.ParseConfigHost = {
  useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
  fileExists: ts.sys.fileExists,
  readFile: ts.sys.readFile,
  readDirectory: () => [],
};

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
      NO_GLOB_CONFIG_HOST,
      cfg.baseDir,
      undefined,
      cfg.configPath,
    );
    projects.push({
      configPath: cfg.configPath,
      baseDir: normalizePath(cfg.baseDir),
      options: parsed.options,
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
    });
  }

  return projects;
}

const getCanonicalFileName = ts.sys.useCaseSensitiveFileNames
  ? (fileName: string) => fileName
  : (fileName: string) => fileName.toLowerCase();

/** Effective resolution options + per-project resolution cache (created lazily once). */
function resolutionContextFor(project: ProjectContext): {
  options: ts.CompilerOptions;
  cache: ts.ModuleResolutionCache;
} {
  if (!project.resolutionOptions || !project.resolutionCache) {
    project.resolutionOptions = {
      ...project.options,
      baseUrl: project.options.baseUrl ?? project.baseDir,
    };
    project.resolutionCache = ts.createModuleResolutionCache(
      project.baseDir || ts.sys.getCurrentDirectory(),
      getCanonicalFileName,
      project.resolutionOptions,
    );
  }
  return { options: project.resolutionOptions, cache: project.resolutionCache };
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
  cache?: ts.ModuleResolutionCache,
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
    cache,
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
  cache?: ts.ModuleResolutionCache,
): { imports: ImportSpec[]; exports: ExportSpec[]; dynamicImportPaths: string[] } {
  const imports: ImportSpec[] = [];
  const exports: ExportSpec[] = [];
  const dynamicImportPaths: string[] = [];
  const filePath = normalizePath(sourceFile.fileName);

  const visit = (node: ts.Node): void => {
    // import … from '…'
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      const resolvedPath = resolveModule(specifier, filePath, options, cache);
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
        const fromPath = resolveModule(specifier, filePath, options, cache);
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
      const resolvedPath = resolveModule(specifier, filePath, options, cache);
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

/** Load tsconfig projects once and normalise the default project's baseDir. */
function loadProjectsForWorkspace(
  workspaceRoot: string,
  tsconfigs: Array<{ configPath: string; baseDir: string }>,
): ProjectContext[] {
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

  return projects;
}

function scriptKindFor(filePath: string): ts.ScriptKind {
  return filePath.endsWith('.tsx') || filePath.endsWith('.jsx')
    ? ts.ScriptKind.TSX
    : filePath.endsWith('.js') || filePath.endsWith('.jsx')
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
}

/**
 * Incremental parse session: files are parsed one at a time (so callers can
 * check cancellation or yield between files) and the barrel-hop pass runs once
 * in finish(). Output is identical to a single parseFiles() call.
 */
export interface ParseSession {
  parseOne(file: { absolutePath: string; content?: string }): void;
  finish(): FileParseResult[];
}

export function createParseSession(
  workspaceRoot: string,
  tsconfigs: Array<{ configPath: string; baseDir: string }>,
): ParseSession {
  const projects = loadProjectsForWorkspace(workspaceRoot, tsconfigs);
  const preliminary = new Map<string, FileParseResult>();

  return {
    parseOne(f) {
      const filePath = normalizePath(f.absolutePath);
      const project = pickProject(filePath, projects);

      let content = '';
      try {
        content = f.content ?? readFileSync(f.absolutePath, 'utf8');
      } catch {
        content = '';
      }

      try {
        const sourceFile = ts.createSourceFile(
          filePath,
          content,
          project.options.target ?? ts.ScriptTarget.ES2022,
          true,
          scriptKindFor(filePath),
        );

        const parseDiagnostics = (sourceFile as ts.SourceFile & {
          parseDiagnostics?: readonly ts.Diagnostic[];
        }).parseDiagnostics;
        const syntaxError = parseDiagnostics?.find(
          (d) => d.category === ts.DiagnosticCategory.Error,
        );

        const resolution = resolutionContextFor(project);
        const { imports, exports, dynamicImportPaths } = extractFromSourceFile(
          sourceFile,
          resolution.options,
          resolution.cache,
        );

        const symbols = extractSymbols(sourceFile);

        preliminary.set(filePath, {
          filePath,
          imports,
          exports,
          symbols,
          dependencyPaths: [],
          dynamicImportPaths,
          error: syntaxError
            ? ts.flattenDiagnosticMessageText(syntaxError.messageText, '\n')
            : undefined,
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
    },

    finish() {
      // Second pass: barrel hop
      const results: FileParseResult[] = [];
      for (const [, result] of preliminary) {
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
    },
  };
}

export function parseFiles(
  workspaceRoot: string,
  files: Array<{ absolutePath: string; content?: string }>,
  tsconfigs: Array<{ configPath: string; baseDir: string }>,
  options: { signal?: AbortSignal } = {},
): FileParseResult[] {
  const session = createParseSession(workspaceRoot, tsconfigs);
  for (const f of files) {
    throwIfAborted(options.signal);
    session.parseOne(f);
  }
  return session.finish();
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
 * Reusable call resolver. Loads tsconfig projects once and parses each file at
 * most once, so resolving N functions across a workspace costs N AST walks
 * instead of N × (tsconfig load + module resolution + full re-parse).
 *
 * Hold one instance for the lifetime of a single analysis (e.g. one
 * CallChainAnalyzer.analyzeRoutes call); discard it afterwards so parsed ASTs
 * are released.
 */
export interface CallResolver {
  resolve(
    filePath: string,
    functionName: string,
    content?: string,
  ): ResolveCallsResult;
  /** Number of files whose AST is currently cached (diagnostics/benchmarks). */
  readonly cachedFileCount: number;
}

interface ParsedFileState {
  sourceFile: ts.SourceFile;
  imports: ImportSpec[];
  symbols: ReturnType<typeof extractSymbols>;
}

export function createCallResolver(
  workspaceRoot: string,
  tsconfigs: Array<{ configPath: string; baseDir: string }>,
): CallResolver {
  const projects = loadProjectsForWorkspace(workspaceRoot, tsconfigs);
  const parsed = new Map<string, ParsedFileState>();

  function load(
    normalized: string,
    originalPath: string,
    content?: string,
  ): ParsedFileState {
    const cached = parsed.get(normalized);
    if (cached) {
      return cached;
    }
    const sourceText = content ?? readFileSync(originalPath, 'utf8');
    const project = pickProject(normalized, projects);
    const sourceFile = ts.createSourceFile(
      normalized,
      sourceText,
      project.options.target ?? ts.ScriptTarget.ES2022,
      true,
      scriptKindFor(normalized),
    );
    const resolution = resolutionContextFor(project);
    const { imports } = extractFromSourceFile(
      sourceFile,
      resolution.options,
      resolution.cache,
    );
    const state: ParsedFileState = {
      sourceFile,
      imports,
      symbols: extractSymbols(sourceFile),
    };
    parsed.set(normalized, state);
    return state;
  }

  return {
    get cachedFileCount() {
      return parsed.size;
    },
    resolve(filePath, functionName, content) {
      const normalized = normalizePath(filePath);
      try {
        const state = load(normalized, filePath, content);
        const callees = resolveFunctionCallees(
          state.sourceFile,
          functionName,
          state.imports,
          state.symbols,
        );
        return { filePath: normalized, functionName, callees };
      } catch (err) {
        return {
          filePath: normalized,
          functionName,
          callees: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

/**
 * Resolve immediate callees of a named function in a file.
 *
 * One-shot convenience wrapper; for repeated resolution within one analysis use
 * createCallResolver() so projects and parsed files are reused.
 */
export function resolveCalls(
  workspaceRoot: string,
  filePath: string,
  functionName: string,
  tsconfigs: Array<{ configPath: string; baseDir: string }>,
  content?: string,
): ResolveCallsResult {
  return createCallResolver(workspaceRoot, tsconfigs).resolve(
    filePath,
    functionName,
    content,
  );
}
