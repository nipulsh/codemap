import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { cpus } from 'node:os';
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
 * Multiple workers with a priority queue (user expands jump ahead of prefetch).
 */
export class WorkerPool {
  private workers: Worker[] = [];
  private readonly pending = new Map<string, Pending>();
  private readonly highPriorityQueue: Pending[] = [];
  private readonly lowPriorityQueue: Pending[] = [];
  private readonly workerTaskCount = new Map<Worker, number>();
  private readonly workerScript: string;
  private readonly maxOldSpaceSizeMb: number;
  private readonly numWorkers: number;
  private nextId = 1;

  constructor(options?: { workerScript?: string; maxOldSpaceSizeMb?: number; numWorkers?: number }) {
    this.workerScript =
      options?.workerScript ??
      join(__dirname, 'parser', 'workers', 'parseWorker.js');
    this.maxOldSpaceSizeMb = options?.maxOldSpaceSizeMb ?? 1536;
    // Default to number of CPU cores minus 1 (leave one for main thread), minimum 1
    this.numWorkers =
      options?.numWorkers ?? Math.max(1, Math.floor(cpus().length * 0.8));

    // Initialize workers
    this.initializeWorkers();
  }

  private initializeWorkers(): void {
    for (let i = 0; i < this.numWorkers; i++) {
      const worker = this.createWorker();
      this.workers.push(worker);
      this.workerTaskCount.set(worker, 0);
    }
  }

  private createWorker(): Worker {
    const worker = new Worker(this.workerScript, {
      resourceLimits: {
        maxOldGenerationSizeMb: this.maxOldSpaceSizeMb,
      },
    });

    worker.on('message', (msg: WorkerOutbound) => {
      const pending = this.pending.get(msg.id);
      if (!pending) {
        // This shouldn't happen, but if it does, clean up and continue
        this.decrementTaskCount(worker);
        return;
      }

      this.pending.delete(msg.id);
      this.decrementTaskCount(worker);

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

      // Process next task in queue now that a worker is free
      this.processQueue();
    });

    worker.on('error', (err) => {
      // Reject all pending tasks for this worker
      const failedTasks = [];
      for (const [id, pending] of this.pending.entries()) {
        // Note: We don't know which task was on this worker,
        // so we'll reject all - in practice this is rare
        failedTasks.push({ id, pending });
      }

      for (const { id, pending } of failedTasks) {
        this.pending.delete(id);
        pending.reject(err);
      }

      this.clearWorkerTasks(worker);
      this.replaceWorker(worker);
      this.processQueue();
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        // Reject all pending tasks for this worker
        const failedTasks = [];
        for (const [id, pending] of this.pending.entries()) {
          failedTasks.push({ id, pending });
        }

        for (const { id, pending } of failedTasks) {
          this.pending.delete(id);
          pending.reject(new Error(`Parser worker exited with code ${code}`));
        }
      }

      this.clearWorkerTasks(worker);
      this.replaceWorker(worker);
      this.processQueue();
    });

    return worker;
  }

  private decrementTaskCount(worker: Worker): void {
    const current = this.workerTaskCount.get(worker) ?? 0;
    if (current > 0) {
      this.workerTaskCount.set(worker, current - 1);
    }
  }

  private incrementTaskCount(worker: Worker): void {
    const current = this.workerTaskCount.get(worker) ?? 0;
    this.workerTaskCount.set(worker, current + 1);
  }

  private clearWorkerTasks(worker: Worker): void {
    // Note: We don't track which specific tasks are on which worker
    // In a more sophisticated implementation, we would track this
    // For now, we rely on the timeout/error mechanisms
  }

  private replaceWorker(failedWorker: Worker): void {
    const index = this.workers.indexOf(failedWorker);
    if (index !== -1) {
      this.workers.splice(index, 1);
      this.workerTaskCount.delete(failedWorker);

      const worker = this.createWorker();
      this.workers.splice(index, 0, worker);
      this.workerTaskCount.set(worker, 0);
    }
  }

  private enqueue(task: Pending): void {
    if (task.priority === 'high') {
      this.highPriorityQueue.push(task);
    } else {
      this.lowPriorityQueue.push(task);
    }
    this.processQueue();
  }

  private processQueue(): void {
    // Process high priority queue first
    while (this.highPriorityQueue.length > 0) {
      const worker = this.getLeastBusyWorker();
      if (!worker) break; // All workers busy

      const task = this.highPriorityQueue.shift()!;
      this.assignTaskToWorker(worker, task);
    }

    // Then process low priority queue
    while (this.lowPriorityQueue.length > 0) {
      const worker = this.getLeastBusyWorker();
      if (!worker) break; // All workers busy

      const task = this.lowPriorityQueue.shift()!;
      this.assignTaskToWorker(worker, task);
    }
  }

  private getLeastBusyWorker(): Worker | null {
    if (this.workers.length === 0) return null;

    return this.workers.reduce((minWorker, currentWorker) => {
      const minCount = this.workerTaskCount.get(minWorker) ?? 0;
      const currentCount = this.workerTaskCount.get(currentWorker) ?? 0;
      return currentCount < minCount ? currentWorker : minWorker;
    });
  }

  private assignTaskToWorker(worker: Worker, task: Pending): void {
    this.pending.set(task.request.id, task);
    this.incrementTaskCount(worker);
    worker.postMessage(task.request);
  }

  public async dispose(): Promise<void> {
    // Clear queues
    this.highPriorityQueue.length = 0;
    this.lowPriorityQueue.length = 0;

    // Terminate all workers
    await Promise.all(
      this.workers.map(worker => worker.terminate())
    );

    this.workers = [];
    this.workerTaskCount.clear();
    this.pending.clear();
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
}