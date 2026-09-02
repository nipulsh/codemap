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

/** Thrown for tasks that were queued or in flight when the pool was disposed. */
export class WorkerPoolDisposedError extends Error {
  constructor(message = 'WorkerPool disposed') {
    super(message);
    this.name = 'WorkerPoolDisposedError';
  }
}

export interface WorkerPoolStats {
  workers: number;
  inFlight: number;
  queuedHigh: number;
  queuedLow: number;
  /** Workers replaced after an error or unexpected exit since construction. */
  workersReplaced: number;
  disposed: boolean;
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
 *
 * Failure semantics:
 * - A worker error or unexpected exit rejects only the tasks that were assigned
 *   to that worker; tasks on healthy workers are unaffected.
 * - The failed worker is replaced and queued work continues on the new worker.
 * - dispose() rejects every queued and in-flight task with
 *   WorkerPoolDisposedError, terminates all workers, and never spawns
 *   replacements. Tasks submitted after dispose() are rejected immediately.
 */
export class WorkerPool {
  private workers: Worker[] = [];
  private readonly pending = new Map<string, Pending>();
  /** Which worker each in-flight task was posted to. */
  private readonly taskWorker = new Map<string, Worker>();
  private readonly highPriorityQueue: Pending[] = [];
  private readonly lowPriorityQueue: Pending[] = [];
  private readonly workerTaskCount = new Map<Worker, number>();
  private readonly workerScript: string;
  private readonly maxOldSpaceSizeMb: number;
  private readonly numWorkers: number;
  private nextId = 1;
  private disposed = false;
  private workersReplaced = 0;

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

  stats(): WorkerPoolStats {
    return {
      workers: this.workers.length,
      inFlight: this.pending.size,
      queuedHigh: this.highPriorityQueue.length,
      queuedLow: this.lowPriorityQueue.length,
      workersReplaced: this.workersReplaced,
      disposed: this.disposed,
    };
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
        // Unknown/duplicate response: nothing to settle.
        return;
      }

      this.pending.delete(msg.id);
      this.taskWorker.delete(msg.id);
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
      this.failWorkerTasks(worker, err);
      this.replaceWorker(worker);
      this.processQueue();
    });

    worker.on('exit', (code) => {
      // Any exit while tasks are outstanding means those tasks will never be
      // answered — including code 0 (e.g. process.exit(0) inside the worker).
      this.failWorkerTasks(
        worker,
        this.disposed
          ? new WorkerPoolDisposedError()
          : new Error(`Parser worker exited with code ${code}`),
      );
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

  /** Reject only the tasks that were posted to `worker`. */
  private failWorkerTasks(worker: Worker, err: Error): void {
    for (const [id, owner] of [...this.taskWorker.entries()]) {
      if (owner !== worker) {
        continue;
      }
      const pending = this.pending.get(id);
      this.pending.delete(id);
      this.taskWorker.delete(id);
      pending?.reject(err);
    }
    this.workerTaskCount.set(worker, 0);
  }

  private replaceWorker(failedWorker: Worker): void {
    const index = this.workers.indexOf(failedWorker);
    if (index === -1) {
      return;
    }
    this.workers.splice(index, 1);
    this.workerTaskCount.delete(failedWorker);

    if (this.disposed) {
      return;
    }

    const worker = this.createWorker();
    this.workers.splice(index, 0, worker);
    this.workerTaskCount.set(worker, 0);
    this.workersReplaced += 1;
  }

  private enqueue(task: Pending): void {
    if (this.disposed) {
      task.reject(new WorkerPoolDisposedError());
      return;
    }
    if (task.priority === 'high') {
      this.highPriorityQueue.push(task);
    } else {
      this.lowPriorityQueue.push(task);
    }
    this.processQueue();
  }

  private processQueue(): void {
    if (this.disposed) {
      return;
    }

    // Process high priority queue first
    while (this.highPriorityQueue.length > 0) {
      const worker = this.getLeastBusyWorker();
      if (!worker) {
        break; // All workers busy
      }

      const task = this.highPriorityQueue.shift()!;
      this.assignTaskToWorker(worker, task);
    }

    // Then process low priority queue
    while (this.lowPriorityQueue.length > 0) {
      const worker = this.getLeastBusyWorker();
      if (!worker) {
        break; // All workers busy
      }

      const task = this.lowPriorityQueue.shift()!;
      this.assignTaskToWorker(worker, task);
    }
  }

  private getLeastBusyWorker(): Worker | null {
    if (this.workers.length === 0) {
      return null;
    }

    return this.workers.reduce((minWorker, currentWorker) => {
      const minCount = this.workerTaskCount.get(minWorker) ?? 0;
      const currentCount = this.workerTaskCount.get(currentWorker) ?? 0;
      return currentCount < minCount ? currentWorker : minWorker;
    });
  }

  private assignTaskToWorker(worker: Worker, task: Pending): void {
    this.pending.set(task.request.id, task);
    this.taskWorker.set(task.request.id, worker);
    this.incrementTaskCount(worker);
    worker.postMessage(task.request);
  }

  public async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    // Settle queued tasks: they will never run.
    const queued = [...this.highPriorityQueue, ...this.lowPriorityQueue];
    this.highPriorityQueue.length = 0;
    this.lowPriorityQueue.length = 0;
    for (const task of queued) {
      task.reject(new WorkerPoolDisposedError());
    }

    // Settle in-flight tasks: the workers are about to be terminated.
    for (const [id, pending] of [...this.pending.entries()]) {
      this.pending.delete(id);
      this.taskWorker.delete(id);
      pending.reject(new WorkerPoolDisposedError());
    }

    // Terminate all workers (exit handlers see `disposed` and do not respawn).
    const workers = this.workers;
    this.workers = [];
    await Promise.all(workers.map((worker) => worker.terminate()));

    this.workerTaskCount.clear();
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
