/**
 * Mock worker: exits with code 0 on every message.
 * Verifies in-flight tasks are rejected when a worker exits cleanly.
 */
const { parentPort } = require('node:worker_threads');

parentPort.on('message', () => {
  process.exit(0);
});
