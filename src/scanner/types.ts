export interface ScannedFile {
  /** Absolute real path */
  absolutePath: string;
  /** Workspace-relative posix path */
  relativePath: string;
  mtimeMs: number;
  contentHash: string;
}

export interface TsConfigInfo {
  /** Absolute path to tsconfig file */
  configPath: string;
  /** Directory containing the tsconfig */
  baseDir: string;
}

export interface ScanResult {
  workspaceRoot: string;
  files: ScannedFile[];
  tsconfigs: TsConfigInfo[];
}

export type ScanProgressCallback = (message: string, percent?: number) => void;
