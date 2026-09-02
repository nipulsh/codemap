import { readFileSync } from 'node:fs';
import type { SourceFileInfo } from '../analysis/types';
import type { SourceTextReader } from '../analysis/SourceTextCache';
import { extractExpressRoutes } from '../parser/extractRoutes';
import { throwIfAborted } from '../utils/cancellation';
import type { RouteDefinition, RouteExtractionResult } from './types';

export interface RouteAnalyzerOptions {
  /** Cooperative cancellation, checked before each file. */
  signal?: AbortSignal;
  /** Source text provider; defaults to reading from disk. */
  textReader?: SourceTextReader;
}

/**
 * Matches `.get` / `.post` / ... property accesses, allowing any TypeScript
 * trivia (whitespace, line comments, block comments) between the dot and the
 * method name. Kept in sync with HTTP_METHODS in extractRoutes.ts.
 */
const ROUTE_METHOD_ACCESS =
  /\.(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*(?:get|post|put|patch|delete|options|head)\b/;

/**
 * Cheap, semantics-preserving pre-filter for the route extractor.
 *
 * extractExpressRoutes can only register a route when BOTH hold:
 *  1. the file text contains the lowercase token `express` (an import of the
 *     express module or an `express()` / `express.Router()` call), and
 *  2. some `receiver.<httpMethod>` property access exists — every route is a
 *     PropertyAccessExpression call whose name is in HTTP_METHODS.
 *
 * Files failing either check are guaranteed to produce zero routes, so the
 * AST parse is skipped. Check (2) matters in practice: handler/service files
 * routinely import `Request`/`Response` types from 'express' and would
 * otherwise be parsed for nothing (measured: ~94% of files in a
 * handler-heavy synthetic workspace passed check (1) alone).
 */
export function mayContainExpressRoutes(content: string): boolean {
  return content.includes('express') && ROUTE_METHOD_ACCESS.test(content);
}

const DISK_READER: SourceTextReader = {
  read: (absolutePath) => readFileSync(absolutePath, 'utf8'),
};

/**
 * Analyze workspace source files for static HTTP routes.
 * Operates on Phase 5 analysis output without touching ExplorerService.
 */
export class RouteAnalyzer {
  analyze(
    files: SourceFileInfo[],
    options: RouteAnalyzerOptions = {},
  ): RouteExtractionResult {
    const iterator = this.analyzeIncremental(files, options);
    let step = iterator.next();
    while (!step.done) {
      step = iterator.next();
    }
    return step.value;
  }

  /**
   * Incremental variant: yields after each file so callers can interleave
   * event-loop turns or cancellation checks. Output is identical to analyze().
   */
  *analyzeIncremental(
    files: SourceFileInfo[],
    options: RouteAnalyzerOptions = {},
  ): Generator<void, RouteExtractionResult, void> {
    const routes: RouteDefinition[] = [];
    const errors: RouteExtractionResult['errors'] = [];
    const reader = options.textReader ?? DISK_READER;

    for (const file of files) {
      throwIfAborted(options.signal);

      if (file.parseError) {
        continue;
      }

      let content: string;
      try {
        content = reader.read(file.absolutePath);
      } catch (err) {
        errors.push({
          filePath: file.relativePath,
          message: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      if (!mayContainExpressRoutes(content)) {
        yield;
        continue;
      }

      try {
        const fileRoutes = extractExpressRoutes({
          filePath: file.absolutePath,
          content,
          symbols: file.symbols,
          imports: file.imports,
        });
        routes.push(...fileRoutes);
      } catch (err) {
        errors.push({
          filePath: file.relativePath,
          message: err instanceof Error ? err.message : String(err),
        });
      }

      yield;
    }

    routes.sort((a, b) => {
      const cmp = a.path.localeCompare(b.path);
      if (cmp !== 0) {
        return cmp;
      }
      const methodCmp = a.method.localeCompare(b.method);
      return methodCmp !== 0 ? methodCmp : a.line - b.line;
    });

    return { routes, errors };
  }
}
