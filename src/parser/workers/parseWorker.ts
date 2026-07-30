import { parentPort, workerData } from 'node:worker_threads';
import { parseFile, parseFiles, resolveCalls } from '../extractImports';
import type { WorkerInbound, WorkerOutbound } from '../types';

if (!parentPort) {
  throw new Error('parseWorker must be run as a worker thread');
}

const port = parentPort;

port.on('message', (msg: WorkerInbound) => {
  try {
    if (msg.type === 'parseFiles') {
      const results = parseFiles(msg.workspaceRoot, msg.files, msg.tsconfigs);
      const response: WorkerOutbound = {
        type: 'parseResult',
        id: msg.id,
        results,
      };
      port.postMessage(response);
      return;
    }

    if (msg.type === 'parseFile') {
      const result = parseFile(msg.workspaceRoot, msg.file, msg.tsconfigs);
      const response: WorkerOutbound = {
        type: 'parseResult',
        id: msg.id,
        results: [result],
      };
      port.postMessage(response);
      return;
    }

    if (msg.type === 'resolveCalls') {
      const result = resolveCalls(
        msg.workspaceRoot,
        msg.filePath,
        msg.functionName,
        msg.tsconfigs,
        msg.content,
      );
      const response: WorkerOutbound = {
        type: 'resolveCallsResult',
        id: msg.id,
        result,
      };
      port.postMessage(response);
      return;
    }

    const err: WorkerOutbound = {
      type: 'error',
      id: (msg as { id?: string }).id ?? 'unknown',
      message: `Unknown worker message type`,
    };
    port.postMessage(err);
  } catch (err) {
    const response: WorkerOutbound = {
      type: 'error',
      id: (msg as { id?: string }).id ?? 'unknown',
      message: err instanceof Error ? err.message : String(err),
    };
    port.postMessage(response);
  }
});

void workerData;
