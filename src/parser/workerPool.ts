import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import type {
  FileParseResult,
  ParseFileRequest,
  ParseRequest,
  ResolveCallsRequest,
  ResolveCallsResult,
  WorkerOutbound,
} from './types';

export interface ParseFilesInput {
  workspaceRoot: string;
  files: Array<{ absolutePath: string; content?: string }>;
  tsconfigs: Array<{ configPath: string; baseDir: string }>;
  /** High priority jumps ahead of background prefetch */
  priority?: 'high' | 'low';
}

export interface ParseFileInput {
  workspaceRoot: string;
  file: { absolutePath: string; content?: string };
  tsconfigs: Array<{ configPath: string; baseDir: string }>;
}

export interface ResolveCallsInput {
  workspaceRoot: string;
  filePath: string;
  functionName: string;
  tsconfigs: Array<{ configPath: string; baseDir: string }>;
  content?: string;
}

type Pending =
  | {
      kind: 'parse';
      resolve: (results: FileParseResult[]) => void;
      reject: (err: Error) => void;
      priority: 'high' | 'low';
      request: ParseRequest | ParseFileRequest;
    }
  | {
      kind: 'resolve';
      resolve: (result: ResolveCallsResult) => void;
      reject: (err: Error) => void;
      priority: 'high' | 'low';
      request: ResolveCallsRequest;
    };

/**
 * Manages a pool of Node worker_threads for AST parsing.
 * Single worker with a priority queue (user expands jump ahead of prefetch).
 */
export class WorkerPool {
  private worker: Worker | undefined;
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();
  private readonly queue: Pending[] = [];
  private busy = false;
  private readonly workerScript: string;
  private maxOldSpaceSizeMb: number;

  constructor(options?: { workerScript?: string; maxOldSpaceSizeMb?: number }) {
    this.workerScript =
      options?.workerScript ??
      join(__dirname, 'parser', 'workers', 'parseWorker.js');
    this.maxOldSpaceSizeMb = options?.maxOldSpaceSizeMb ?? 1536;
  }

  private ensureWorker(): Worker {
    if (this.worker) {
      return this.worker;
    }

    const worker = new Worker(this.workerScript, {
      resourceLimits: {
        maxOldGenerationSizeMb: this.maxOldSpaceSizeMb,
      },
    });

    worker.on('message', (msg: WorkerOutbound) => {
      const pending = this.pending.get(msg.id);
      if (!pending) {
        this.busy = false;
        this.pump();
        return;
      }
      this.pending.delete(msg.id);
      this.busy = false;

      if (msg.type === 'error') {
        pending.reject(new Error(msg.message));
      } else if (msg.type === 'parseResult' && pending.kind === 'parse') {
        pending.resolve(msg.results);
      } else if (
        msg.type === 'resolveCallsResult' &&
        pending.kind === 'resolve'
      ) {
        pending.resolve(msg.result);
      } else {
        pending.reject(new Error('Unexpected worker response type'));
      }
      this.pump();
    });

    worker.on('error', (err) => {
      for (const [, p] of this.pending) {
        p.reject(err);
      }
      this.pending.clear();
      this.queue.length = 0;
      this.busy = false;
      this.worker = undefined;
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        for (const [, p] of this.pending) {
          p.reject(new Error(`Parser worker exited with code ${code}`));
        }
        this.pending.clear();
        this.queue.length = 0;
      }
      this.busy = false;
      this.worker = undefined;
    });

    this.worker = worker;
    return worker;
  }

  private enqueue(item: Pending): void {
    if (item.priority === 'high') {
      const firstLow = this.queue.findIndex((q) => q.priority === 'low');
      if (firstLow === -1) {
        this.queue.push(item);
      } else {
        this.queue.splice(firstLow, 0, item);
      }
    } else {
      this.queue.push(item);
    }
    this.pump();
  }

  private pump(): void {
    if (this.busy || this.queue.length === 0) {
      return;
    }
    const item = this.queue.shift()!;
    const worker = this.ensureWorker();
    this.busy = true;
    this.pending.set(item.request.id, item);
    worker.postMessage(item.request);
  }

  parseFiles(input: ParseFilesInput): Promise<FileParseResult[]> {
    const id = String(this.nextId++);
    const request: ParseRequest = {
      type: 'parseFiles',
      id,
      workspaceRoot: input.workspaceRoot,
      files: input.files,
      tsconfigs: input.tsconfigs,
    };

    return new Promise((resolve, reject) => {
      this.enqueue({
        kind: 'parse',
        resolve,
        reject,
        priority: input.priority ?? 'high',
        request,
      });
    });
  }

  parseFile(input: ParseFileInput): Promise<FileParseResult> {
    const id = String(this.nextId++);
    const request: ParseFileRequest = {
      type: 'parseFile',
      id,
      workspaceRoot: input.workspaceRoot,
      file: input.file,
      tsconfigs: input.tsconfigs,
    };

    return new Promise((resolve, reject) => {
      this.enqueue({
        kind: 'parse',
        resolve: (results) => {
          resolve(
            results[0] ?? {
              filePath: input.file.absolutePath,
              imports: [],
              exports: [],
              symbols: [],
              dependencyPaths: [],
              dynamicImportPaths: [],
              error: 'Empty parse result',
            },
          );
        },
        reject,
        priority: 'high',
        request,
      });
    });
  }

  resolveCalls(input: ResolveCallsInput): Promise<ResolveCallsResult> {
    const id = String(this.nextId++);
    const request: ResolveCallsRequest = {
      type: 'resolveCalls',
      id,
      workspaceRoot: input.workspaceRoot,
      filePath: input.filePath,
      functionName: input.functionName,
      content: input.content,
      tsconfigs: input.tsconfigs,
    };

    return new Promise((resolve, reject) => {
      this.enqueue({
        kind: 'resolve',
        resolve,
        reject,
        priority: 'high',
        request,
      });
    });
  }

  async dispose(): Promise<void> {
    this.queue.length = 0;
    if (this.worker) {
      await this.worker.terminate();
      this.worker = undefined;
    }
    this.pending.clear();
    this.busy = false;
  }
}
