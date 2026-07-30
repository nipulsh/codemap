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

export type SymbolKind =
  | 'Function'
  | 'Class'
  | 'Interface'
  | 'Enum'
  | 'Component';

export interface SymbolInfo {
  name: string;
  kind: SymbolKind;
  line: number;
  exported: boolean;
  /** Start/end offsets for call extraction scoping */
  start: number;
  end: number;
}

export interface CalleeRef {
  /** Identifier or property name of the callee */
  name: string;
  /** Absolute path if resolved via import binding */
  targetFile?: string;
  /** True when callee is a top-level symbol in the same file */
  local: boolean;
  /** Call expression uses await / returns Promise-ish (heuristic) */
  async?: boolean;
  line?: number;
}

export interface FileParseResult {
  filePath: string;
  imports: ImportSpec[];
  exports: ExportSpec[];
  symbols: SymbolInfo[];
  /** After barrel resolution: module paths this file effectively depends on */
  dependencyPaths: string[];
  /** Dynamic import resolved paths */
  dynamicImportPaths: string[];
  error?: string;
}

export interface ResolveCallsResult {
  filePath: string;
  functionName: string;
  callees: CalleeRef[];
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

export interface ParseFileRequest {
  type: 'parseFile';
  id: string;
  workspaceRoot: string;
  file: {
    absolutePath: string;
    content?: string;
  };
  tsconfigs: Array<{
    configPath: string;
    baseDir: string;
  }>;
}

export interface ResolveCallsRequest {
  type: 'resolveCalls';
  id: string;
  workspaceRoot: string;
  filePath: string;
  functionName: string;
  content?: string;
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

export interface ResolveCallsResponse {
  type: 'resolveCallsResult';
  id: string;
  result: ResolveCallsResult;
}

export interface ParseErrorResponse {
  type: 'error';
  id: string;
  message: string;
}

export type WorkerInbound =
  | ParseRequest
  | ParseFileRequest
  | ResolveCallsRequest;
export type WorkerOutbound =
  | ParseResponse
  | ResolveCallsResponse
  | ParseErrorResponse;
