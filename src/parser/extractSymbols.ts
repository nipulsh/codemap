import * as ts from 'typescript';
import type { CalleeRef, ImportSpec, SymbolInfo, SymbolKind } from './types';

function lineOf(sourceFile: ts.SourceFile, pos: number): number {
  return sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
}

function isExported(node: ts.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function looksLikeComponent(
  name: string,
  node: ts.Node,
  sourceFile: ts.SourceFile,
): boolean {
  if (!/^[A-Z]/.test(name)) {
    return false;
  }
  const text = node.getText(sourceFile);
  return (
    /React\.(FC|FunctionComponent|Component)/.test(text) ||
    /<[A-Za-z]/.test(text) ||
    /jsx|tsx/i.test(sourceFile.fileName)
  );
}

function pushSymbol(
  symbols: SymbolInfo[],
  sourceFile: ts.SourceFile,
  name: string,
  kind: SymbolKind,
  node: ts.Node,
  exported: boolean,
): void {
  symbols.push({
    name,
    kind,
    line: lineOf(sourceFile, node.getStart(sourceFile)),
    exported,
    start: node.getStart(sourceFile),
    end: node.getEnd(),
  });
}

/**
 * Extract top-level functions, classes, interfaces, enums, and React components.
 */
export function extractSymbols(sourceFile: ts.SourceFile): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      const name = stmt.name.text;
      const kind: SymbolKind =
        looksLikeComponent(name, stmt, sourceFile) ? 'Component' : 'Function';
      pushSymbol(symbols, sourceFile, name, kind, stmt, isExported(stmt));
      continue;
    }

    if (ts.isClassDeclaration(stmt) && stmt.name) {
      const name = stmt.name.text;
      const kind: SymbolKind =
        looksLikeComponent(name, stmt, sourceFile) ? 'Component' : 'Class';
      pushSymbol(symbols, sourceFile, name, kind, stmt, isExported(stmt));
      continue;
    }

    if (ts.isInterfaceDeclaration(stmt)) {
      pushSymbol(
        symbols,
        sourceFile,
        stmt.name.text,
        'Interface',
        stmt,
        isExported(stmt),
      );
      continue;
    }

    if (ts.isEnumDeclaration(stmt)) {
      pushSymbol(
        symbols,
        sourceFile,
        stmt.name.text,
        'Enum',
        stmt,
        isExported(stmt),
      );
      continue;
    }

    if (ts.isVariableStatement(stmt)) {
      const exported = isExported(stmt);
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) {
          continue;
        }
        const name = decl.name.text;
        const init = decl.initializer;
        if (
          ts.isArrowFunction(init) ||
          ts.isFunctionExpression(init)
        ) {
          const kind: SymbolKind =
            looksLikeComponent(name, decl, sourceFile)
              ? 'Component'
              : 'Function';
          pushSymbol(symbols, sourceFile, name, kind, decl, exported);
        } else if (
          ts.isCallExpression(init) &&
          /^[A-Z]/.test(name)
        ) {
          // const Foo = memo(() => ...) / forwardRef(...)
          const text = init.getText(sourceFile);
          if (
            /memo|forwardRef|styled/.test(text) ||
            looksLikeComponent(name, decl, sourceFile)
          ) {
            pushSymbol(symbols, sourceFile, name, 'Component', decl, exported);
          }
        }
      }
    }
  }

  return symbols;
}

interface ImportBinding {
  localName: string;
  importedName: string;
  resolvedPath?: string;
}

function collectImportBindings(imports: ImportSpec[]): Map<string, ImportBinding> {
  const map = new Map<string, ImportBinding>();
  for (const imp of imports) {
    for (const name of imp.names) {
      if (name === '*' || name === 'default') {
        // default: often imported as a local alias we don't track without AST;
        // handled via AST walk below when we have the source.
        continue;
      }
      map.set(name, {
        localName: name,
        importedName: name,
        resolvedPath: imp.resolvedPath,
      });
    }
  }
  return map;
}

function collectImportBindingsFromAst(
  sourceFile: ts.SourceFile,
  imports: ImportSpec[],
): Map<string, ImportBinding> {
  const bySpecifier = new Map(
    imports.map((i) => [i.specifier, i] as const),
  );
  const map = new Map<string, ImportBinding>();

  for (const stmt of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(stmt) ||
      !stmt.moduleSpecifier ||
      !ts.isStringLiteral(stmt.moduleSpecifier)
    ) {
      continue;
    }
    const specifier = stmt.moduleSpecifier.text;
    const imp = bySpecifier.get(specifier);
    const resolvedPath = imp?.resolvedPath;
    const clause = stmt.importClause;
    if (!clause) {
      continue;
    }
    if (clause.name) {
      map.set(clause.name.text, {
        localName: clause.name.text,
        importedName: 'default',
        resolvedPath,
      });
    }
    if (clause.namedBindings) {
      if (ts.isNamespaceImport(clause.namedBindings)) {
        map.set(clause.namedBindings.name.text, {
          localName: clause.namedBindings.name.text,
          importedName: '*',
          resolvedPath,
        });
      } else if (ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) {
          const local = el.name.text;
          const imported = el.propertyName?.text ?? local;
          map.set(local, {
            localName: local,
            importedName: imported,
            resolvedPath,
          });
        }
      }
    }
  }

  // Fallback for names from ImportSpec
  for (const [k, v] of collectImportBindings(imports)) {
    if (!map.has(k)) {
      map.set(k, v);
    }
  }

  return map;
}

function calleeNameFromExpression(
  expr: ts.Expression,
): { name: string; memberOf?: string } | undefined {
  if (ts.isIdentifier(expr)) {
    return { name: expr.text };
  }
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) {
    if (ts.isIdentifier(expr.expression)) {
      return { name: expr.name.text, memberOf: expr.expression.text };
    }
    return { name: expr.name.text };
  }
  return undefined;
}

/**
 * Resolve immediate callees inside a named top-level function/const.
 * Does not parse other files.
 */
export function resolveFunctionCallees(
  sourceFile: ts.SourceFile,
  functionName: string,
  imports: ImportSpec[],
  localSymbols: SymbolInfo[],
): CalleeRef[] {
  const bindings = collectImportBindingsFromAst(sourceFile, imports);
  const localNames = new Set(localSymbols.map((s) => s.name));
  const callees: CalleeRef[] = [];
  const seen = new Set<string>();

  const target = findFunctionNode(sourceFile, functionName);
  if (!target) {
    return [];
  }

  const body = getBody(target);
  if (!body) {
    return [];
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const info = calleeNameFromExpression(node.expression);
      if (info) {
        const isAwait =
          ts.isAwaitExpression(node.parent) ||
          (ts.isPropertyAccessExpression(node.expression) &&
            info.name === 'then');

        let name = info.name;
        let targetFile: string | undefined;
        let local = false;

        if (info.memberOf) {
          const ns = bindings.get(info.memberOf);
          if (ns?.importedName === '*' && ns.resolvedPath) {
            targetFile = ns.resolvedPath;
            name = info.name;
          } else if (localNames.has(info.memberOf)) {
            // method call on local — skip as cross-symbol for now
            name = `${info.memberOf}.${info.name}`;
            local = true;
          }
        } else {
          const binding = bindings.get(info.name);
          if (binding?.resolvedPath) {
            targetFile = binding.resolvedPath;
            name = binding.importedName === 'default' ? info.name : binding.importedName;
          } else if (localNames.has(info.name)) {
            local = true;
          }
        }

        // Skip builtins / noise
        if (
          !['console', 'require', 'fetch', 'JSON', 'Math', 'Object', 'Array', 'Promise', 'Error'].includes(
            info.memberOf ?? info.name,
          ) &&
          !(info.memberOf === 'console')
        ) {
          const key = `${targetFile ?? ''}:${name}:${local}`;
          if (!seen.has(key) && name !== functionName) {
            seen.add(key);
            callees.push({
              name,
              targetFile,
              local: local && !targetFile,
              async: isAwait || undefined,
              line: lineOf(sourceFile, node.getStart(sourceFile)),
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(body);
  return callees;
}

function findFunctionNode(
  sourceFile: ts.SourceFile,
  functionName: string,
): ts.Node | undefined {
  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === functionName) {
      return stmt;
    }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.name.text === functionName &&
          decl.initializer &&
          (ts.isArrowFunction(decl.initializer) ||
            ts.isFunctionExpression(decl.initializer) ||
            ts.isCallExpression(decl.initializer))
        ) {
          return decl;
        }
      }
    }
    if (ts.isClassDeclaration(stmt) && stmt.name?.text === functionName) {
      return stmt;
    }
  }
  return undefined;
}

function getBody(node: ts.Node): ts.Node | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
    return node.body ?? node;
  }
  if (ts.isVariableDeclaration(node) && node.initializer) {
    const init = node.initializer;
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
      return init.body;
    }
    if (ts.isCallExpression(init)) {
      // memo(() => ...) — dig into first arrow/function arg
      for (const arg of init.arguments) {
        if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
          return arg.body;
        }
      }
      return init;
    }
  }
  if (ts.isClassDeclaration(node)) {
    return node;
  }
  return node;
}
