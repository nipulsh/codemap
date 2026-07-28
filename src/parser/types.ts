export interface ImportSpec {
  /** Resolved absolute path of the imported module (if resolvable) */
  resolvedPath?: string;
  /** Raw module specifier from source */
  specifier: string;
  kind: 'static' | 'dynamic';
  isTypeOnly: boolean;
  names: string[];
}

export interface ExportSpec {
  name: string;
  isReExport: boolean;
  /** For re-exports: resolved absolute path of the source module */
  fromPath?: string;
  fromSpecifier?: string;
  isTypeOnly: boolean;
}

export interface FileParseResult {
  filePath: string;
  imports: ImportSpec[];
  exports: ExportSpec[];
  /** After barrel resolution: module paths this file effectively depends on */
  dependencyPaths: string[];
  /** Dynamic import resolved paths */
  dynamicImportPaths: string[];
  error?: string;
}

export interface ParseRequest {
  type: 'parseFiles';
  id: string;
  workspaceRoot: string;
  files: Array<{
    absolutePath: string;
    content?: string;
  }>;
  tsconfigs: Array<{
    configPath: string;
    baseDir: string;
  }>;
}

export interface ParseResponse {
  type: 'parseResult';
  id: string;
  results: FileParseResult[];
}

export interface ParseErrorResponse {
  type: 'error';
  id: string;
  message: string;
}

export type WorkerInbound = ParseRequest;
export type WorkerOutbound = ParseResponse | ParseErrorResponse;
