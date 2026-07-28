import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import type { FileParseResult, ParseRequest, WorkerOutbound } from './types';

export interface ParseFilesInput {
  workspaceRoot: string;
  files: Array<{ absolutePath: string; content?: string }>;
  tsconfigs: Array<{ configPath: string; baseDir: string }>;
}

/**
 * Manages a pool of Node worker_threads for AST parsing.
 * Phase 1 uses a single worker; pool sizing expands in Phase 4.
 */
export class WorkerPool {
  private worker: Worker | undefined;
  private nextId = 1;
  private pending = new Map<
    string,
    {
      resolve: (results: FileParseResult[]) => void;
      reject: (err: Error) => void;
    }
  >();
  private readonly workerScript: string;
  private maxOldSpaceSizeMb: number;

  constructor(options?: { workerScript?: string; maxOldSpaceSizeMb?: number }) {
    // Bundled worker lives next to extension output
    this.workerScript =
      options?.workerScript ??
      join(__dirname, 'parser', 'workers', 'parseWorker.js');
    this.maxOldSpaceSizeMb = options?.maxOldSpaceSizeMb ?? 1536;
  }

  private ensureWorker(): Worker {
    if (this.worker) {
      return this.worker;
    }

    // Electron (VS Code host) rejects Node --max-old-space-size in execArgv;
    // use worker resourceLimits instead.
    const worker = new Worker(this.workerScript, {
      resourceLimits: {
        maxOldGenerationSizeMb: this.maxOldSpaceSizeMb,
      },
    });

    worker.on('message', (msg: WorkerOutbound) => {
      const pending = this.pending.get(msg.id);
      if (!pending) {
        return;
      }
      this.pending.delete(msg.id);
      if (msg.type === 'error') {
        pending.reject(new Error(msg.message));
      } else {
        pending.resolve(msg.results);
      }
    });

    worker.on('error', (err) => {
      for (const [, p] of this.pending) {
        p.reject(err);
      }
      this.pending.clear();
      this.worker = undefined;
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        for (const [, p] of this.pending) {
          p.reject(new Error(`Parser worker exited with code ${code}`));
        }
        this.pending.clear();
      }
      this.worker = undefined;
    });

    this.worker = worker;
    return worker;
  }

  parseFiles(input: ParseFilesInput): Promise<FileParseResult[]> {
    const id = String(this.nextId++);
    const worker = this.ensureWorker();

    const request: ParseRequest = {
      type: 'parseFiles',
      id,
      workspaceRoot: input.workspaceRoot,
      files: input.files,
      tsconfigs: input.tsconfigs,
    };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage(request);
    });
  }

  /**
   * Dispose the worker pool.
   */
  async dispose(): Promise<void> {
    if (this.worker) {
      await this.worker.terminate();
      this.worker = undefined;
    }
    this.pending.clear();
  }
}
