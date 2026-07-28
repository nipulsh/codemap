import { parentPort, workerData } from 'node:worker_threads';
import { parseFiles } from '../extractImports';
import type { WorkerInbound, WorkerOutbound } from '../types';

if (!parentPort) {
  throw new Error('parseWorker must be run as a worker thread');
}

const port = parentPort;

port.on('message', (msg: WorkerInbound) => {
  if (msg.type !== 'parseFiles') {
    const err: WorkerOutbound = {
      type: 'error',
      id: (msg as { id?: string }).id ?? 'unknown',
      message: `Unknown worker message type`,
    };
    port.postMessage(err);
    return;
  }

  try {
    const results = parseFiles(msg.workspaceRoot, msg.files, msg.tsconfigs);
    const response: WorkerOutbound = {
      type: 'parseResult',
      id: msg.id,
      results,
    };
    port.postMessage(response);
  } catch (err) {
    const response: WorkerOutbound = {
      type: 'error',
      id: msg.id,
      message: err instanceof Error ? err.message : String(err),
    };
    port.postMessage(response);
  }
});

// Acknowledge ready when loaded via workerData (optional)
void workerData;
