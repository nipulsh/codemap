/**
 * Mock worker: crashes once (tracked via CODEMAP_FLAKY_CRASH_FLAG env path), then succeeds.
 */
const { parentPort } = require('node:worker_threads');
const fs = require('node:fs');

const crashFlag = process.env.CODEMAP_FLAKY_CRASH_FLAG;

parentPort.on('message', (msg) => {
  if (crashFlag && !fs.existsSync(crashFlag)) {
    fs.writeFileSync(crashFlag, 'crashed');
    process.exit(1);
  }

  if (msg.type === 'parseFiles' || msg.type === 'parseFile') {
    const files =
      msg.type === 'parseFiles'
        ? msg.files
        : [{ absolutePath: msg.file.absolutePath }];
    parentPort.postMessage({
      type: 'parseResult',
      id: msg.id,
      results: files.map((f) => ({
        filePath: f.absolutePath,
        imports: [],
        exports: [],
        symbols: [],
        dependencyPaths: [],
        dynamicImportPaths: [],
      })),
    });
    return;
  }

  if (msg.type === 'resolveCalls') {
    parentPort.postMessage({
      type: 'resolveCallsResult',
      id: msg.id,
      result: {
        filePath: msg.filePath,
        functionName: msg.functionName,
        callees: [],
      },
    });
    return;
  }

  parentPort.postMessage({
    type: 'error',
    id: msg.id,
    message: 'unknown message type',
  });
});
