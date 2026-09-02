import type { EntryPointInfo } from '../analysis/types';

export type ArchitecturalRole =
  | 'entry-point'
  | 'controller'
  | 'service'
  | 'repository'
  | 'worker'
  | 'ui'
  | 'parser'
  | 'scanner'
  | 'cache'
  | 'configuration'
  | 'test'
  | 'utility'
  | 'unknown';

export interface RoleClassification {
  role: ArchitecturalRole;
  confidence: number;
  reasons: string[];
}

export interface ArchitectureModule {
  name: string;
  path: string;
  purpose: string;
  fileCount: number;
  files: string[];
  role: RoleClassification;
  exports: string[];
  dependencies: string[];
  dependents: string[];
}

export interface ImportantFile {
  path: string;
  role: RoleClassification;
  fanIn: number;
  fanOut: number;
  exportCount: number;
  score: number;
  scoreReasons: string[];
}

export interface DependencyRelation {
  source: string;
  target: string;
  kind: 'imports' | 'dynamicImport' | 'exports';
}

export interface ArchitecturalRule {
  rule: string;
  source: 'inferred' | 'static';
}

export interface ProjectArchitecture {
  projectName: string;
  summary: string;
  technologies: string[];
  entryPoints: EntryPointInfo[];
  modules: ArchitectureModule[];
  importantFiles: ImportantFile[];
  dependencies: DependencyRelation[];
  cycles: Array<{ filePaths: string[] }>;
  architecturalRules: ArchitecturalRule[];
  knownLimitations: string[];
  metadata: {
    fileCount: number;
    moduleCount: number;
    parseErrorCount: number;
    hasTypeScript: boolean;
  };
}

export interface DocumentBuildOptions {
  includeFunctionDetails?: boolean;
  includeDependencyGraph?: boolean;
  agentOptimized?: boolean;
}

export interface GeneratedDocument {
  fullMarkdown: string;
  agentContext: string;
}
