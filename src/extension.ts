/**
 * Extension entry re-export for tooling that expects src/extension.ts.
 * Main entry is src/extension/activate.ts (bundled to out/extension.js).
 */
export { activate, deactivate } from './extension/activate';
