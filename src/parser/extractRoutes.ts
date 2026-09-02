import * as ts from 'typescript';
import type { ImportSpec, SymbolInfo } from './types';
import type {
  HttpMethod,
  RouteConfidence,
  RouteDefinition,
} from '../routes/types';
import { normalizePath } from '../utils/path';

const HTTP_METHODS = new Set([
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'options',
  'head',
]);

const EXPRESS_MODULE_SPECIFIERS = new Set(['express', 'express/lib/express']);

function lineOf(sourceFile: ts.SourceFile, pos: number): number {
  return sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
}

function normalizeRoutePath(prefix: string | undefined, routePath: string): string {
  const p = (prefix ?? '').replace(/\/+$/, '');
  const r = routePath.startsWith('/') ? routePath : `/${routePath}`;
  if (!p) {
    return r;
  }
  return `${p}${r}`.replace(/\/+/g, '/');
}

function methodUpper(name: string): HttpMethod {
  return name.toUpperCase() as HttpMethod;
}

function buildRouteId(
  method: HttpMethod,
  path: string,
  sourceFile: string,
  line: number,
): string {
  return `route:express:${method}:${path}:${normalizePath(sourceFile)}:${line}`;
}

function isExpressCall(node: ts.CallExpression): boolean {
  return (
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'express' &&
    node.arguments.length === 0
  );
}

function isExpressRouterCall(node: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(node.expression)) {
    return false;
  }
  return (
    node.expression.name.text === 'Router' &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'express'
  );
}

function isRouterIdentifierCall(
  node: ts.CallExpression,
  bindings: Map<string, string>,
): boolean {
  if (!ts.isIdentifier(node.expression)) {
    return false;
  }
  const imported = bindings.get(node.expression.text);
  return imported === 'Router' || imported === 'default';
}

function isExpressModuleSpecifier(specifier: string): boolean {
  return (
    EXPRESS_MODULE_SPECIFIERS.has(specifier) ||
    specifier === 'express' ||
    /^express\//.test(specifier)
  );
}

function collectExpressImportBindings(
  sourceFile: ts.SourceFile,
): Map<string, string> {
  const bindings = new Map<string, string>();

  for (const stmt of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(stmt) ||
      !stmt.moduleSpecifier ||
      !ts.isStringLiteral(stmt.moduleSpecifier)
    ) {
      continue;
    }
    if (!isExpressModuleSpecifier(stmt.moduleSpecifier.text)) {
      continue;
    }

    const clause = stmt.importClause;
    if (!clause) {
      continue;
    }
    if (clause.name) {
      bindings.set(clause.name.text, 'default');
    }
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        const local = el.name.text;
        const imported = el.propertyName?.text ?? local;
        bindings.set(local, imported);
      }
    }
  }

  return bindings;
}

function isExpressInitializer(
  init: ts.Expression,
  bindings: Map<string, string>,
): boolean {
  if (ts.isCallExpression(init)) {
    if (isExpressCall(init)) {
      return true;
    }
    if (isExpressRouterCall(init)) {
      return true;
    }
    if (isRouterIdentifierCall(init, bindings)) {
      return true;
    }
  }
  return false;
}

function getStringLiteralArg(expr: ts.Expression): string | undefined {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.text;
  }
  return undefined;
}

function resolveHandler(
  arg: ts.Expression,
  sourceFile: ts.SourceFile,
  symbols: SymbolInfo[],
): { handlerSymbol?: string; handlerLine?: number; handlerResolved: boolean } {
  const filePath = normalizePath(sourceFile.fileName);

  if (ts.isIdentifier(arg)) {
    const sym = symbols.find((s) => s.name === arg.text);
    return {
      handlerSymbol: arg.text,
      handlerLine: sym?.line,
      handlerResolved: !!sym,
    };
  }

  if (ts.isPropertyAccessExpression(arg) && ts.isIdentifier(arg.name)) {
    const member = arg.name.text;
    const obj = ts.isIdentifier(arg.expression)
      ? arg.expression.text
      : undefined;
    const handlerSymbol = obj ? `${obj}.${member}` : member;
    const sym = symbols.find((s) => s.name === member || s.name === obj);
    return {
      handlerSymbol,
      handlerLine: sym?.line,
      handlerResolved: !!sym,
    };
  }

  if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
    const line = lineOf(sourceFile, arg.getStart(sourceFile));
    return {
      handlerSymbol: `${filePath}:${line}:inline-handler`,
      handlerLine: line,
      handlerResolved: true,
    };
  }

  return { handlerResolved: false };
}

function findHandlerArgument(
  args: ts.NodeArray<ts.Expression>,
): ts.Expression | undefined {
  for (let i = args.length - 1; i >= 1; i--) {
    const arg = args[i];
    if (
      ts.isIdentifier(arg) ||
      ts.isPropertyAccessExpression(arg) ||
      ts.isArrowFunction(arg) ||
      ts.isFunctionExpression(arg)
    ) {
      return arg;
    }
  }
  return undefined;
}

function getReceiverIdentifier(
  expr: ts.PropertyAccessExpression,
): string | undefined {
  if (ts.isIdentifier(expr.expression)) {
    return expr.expression.text;
  }
  return undefined;
}

export interface ExtractExpressRoutesOptions {
  filePath: string;
  content: string;
  symbols?: SymbolInfo[];
  imports?: ImportSpec[];
}

/**
 * Extract Express HTTP routes from a single source file using AST analysis.
 */
export function extractExpressRoutes(
  options: ExtractExpressRoutesOptions,
): RouteDefinition[] {
  const { filePath, content, symbols = [] } = options;
  const normalizedFile = normalizePath(filePath);

  const sourceFile = ts.createSourceFile(
    normalizedFile,
    content,
    ts.ScriptTarget.ES2022,
    true,
    normalizedFile.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const expressBindings = collectExpressImportBindings(sourceFile);
  const expressVariables = new Set<string>();
  const mountPrefixes = new Map<string, { prefix?: string; unresolved: boolean }>();

  // Pass 1: detect express app/router variables
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) {
      continue;
    }
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) {
        continue;
      }
      if (isExpressInitializer(decl.initializer, expressBindings)) {
        expressVariables.add(decl.name.text);
        mountPrefixes.set(decl.name.text, { prefix: '', unresolved: false });
      }
    }
  }

  // Pass 2: resolve app.use("/prefix", router) mounts (may run multiple passes for nesting)
  const useCalls: Array<{
    parentVar: string;
    childVar: string;
    prefix?: string;
    unresolved: boolean;
    line: number;
  }> = [];

  const visitForMounts = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const receiver = getReceiverIdentifier(node.expression);
      const method = node.expression.name.text;

      if (receiver && method === 'use' && expressVariables.has(receiver)) {
        const args = node.arguments;
        if (args.length >= 2) {
          const prefixLit = getStringLiteralArg(args[0]);
          const childArg = args[1];
          if (ts.isIdentifier(childArg)) {
            useCalls.push({
              parentVar: receiver,
              childVar: childArg.text,
              prefix: prefixLit,
              unresolved: prefixLit === undefined,
              line: lineOf(sourceFile, node.getStart(sourceFile)),
            });
            expressVariables.add(childArg.text);
            if (!mountPrefixes.has(childArg.text)) {
              mountPrefixes.set(childArg.text, { prefix: undefined, unresolved: false });
            }
          }
        }
      }
    }
    ts.forEachChild(node, visitForMounts);
  };
  visitForMounts(sourceFile);

  // Resolve mount prefix chains
  function resolveMountPrefix(varName: string, visited = new Set<string>()): {
    prefix?: string;
    unresolved: boolean;
  } {
    if (visited.has(varName)) {
      return { prefix: undefined, unresolved: true };
    }
    visited.add(varName);

    const direct = mountPrefixes.get(varName);
    const mountsTo = useCalls.filter((u) => u.childVar === varName);

    if (mountsTo.length === 0) {
      return direct ?? { prefix: '', unresolved: false };
    }

    // Use the last mount in source order for this child
    const mount = mountsTo[mountsTo.length - 1];
    if (mount.unresolved) {
      return { prefix: undefined, unresolved: true };
    }

    const parent = resolveMountPrefix(mount.parentVar, visited);
    if (parent.unresolved) {
      return { prefix: undefined, unresolved: true };
    }

    const combined = normalizeRoutePath(parent.prefix, mount.prefix ?? '');
    return { prefix: combined, unresolved: false };
  }

  for (const child of expressVariables) {
    mountPrefixes.set(child, resolveMountPrefix(child));
  }

  // Pass 3: extract route registrations
  const routes: RouteDefinition[] = [];

  const visitForRoutes = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const receiver = getReceiverIdentifier(node.expression);
      const methodName = node.expression.name.text;

      if (
        !receiver ||
        !HTTP_METHODS.has(methodName) ||
        !expressVariables.has(receiver)
      ) {
        ts.forEachChild(node, visitForRoutes);
        return;
      }

      const args = node.arguments;
      if (args.length < 2) {
        ts.forEachChild(node, visitForRoutes);
        return;
      }

      const routePathLit = getStringLiteralArg(args[0]);
      if (routePathLit === undefined) {
        ts.forEachChild(node, visitForRoutes);
        return;
      }

      const line = lineOf(sourceFile, node.getStart(sourceFile));
      const mount = mountPrefixes.get(receiver) ?? { prefix: '', unresolved: false };
      const fullPath = mount.unresolved
        ? routePathLit
        : normalizeRoutePath(mount.prefix, routePathLit);

      const handlerArg = findHandlerArgument(args);
      const handler = handlerArg
        ? resolveHandler(handlerArg, sourceFile, symbols)
        : { handlerResolved: false };

      let confidence: RouteConfidence = 'high';
      if (mount.unresolved) {
        confidence = 'low';
      } else if (!handler.handlerResolved) {
        confidence = 'medium';
      }

      const method = methodUpper(methodName);

      routes.push({
        id: buildRouteId(method, fullPath, normalizedFile, line),
        method,
        path: fullPath,
        framework: 'express',
        sourceFile: normalizedFile,
        line,
        handlerSymbol: handler.handlerSymbol,
        handlerLine: handler.handlerLine,
        routerVariable: receiver,
        mountPrefix: mount.prefix || undefined,
        confidence,
        handlerResolved: handler.handlerResolved,
        unresolvedMount: mount.unresolved || undefined,
      });
    }
    ts.forEachChild(node, visitForRoutes);
  };
  visitForRoutes(sourceFile);

  routes.sort((a, b) => {
    const cmp = a.sourceFile.localeCompare(b.sourceFile);
    return cmp !== 0 ? cmp : a.line - b.line;
  });

  return routes;
}
