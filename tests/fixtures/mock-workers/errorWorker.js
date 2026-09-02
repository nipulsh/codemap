/**
 * Mock worker: always responds with a worker error message.
 */
const { parentPort } = require('node:worker_threads');

parentPort.on('message', (msg) => {
  parentPort.postMessage({
    type: 'error',
    id: msg.id,
    message: 'simulated worker error',
  });
});
