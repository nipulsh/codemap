import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFileRole, classifyModuleRole } from '../src/documentation/roleClassifier.ts';

describe('roleClassifier', () => {
  it('classifies test files', () => {
    const role = classifyFileRole({
      relativePath: 'src/foo.test.ts',
      exports: [],
      imports: [],
    });
    assert.equal(role.role, 'test');
    assert.ok(role.confidence >= 0.9);
  });

  it('classifies worker files', () => {
    const role = classifyFileRole({
      relativePath: 'src/parser/workers/parseWorker.ts',
      exports: [],
      imports: ['worker_threads'],
    });
    assert.equal(role.role, 'worker');
  });

  it('classifies controller files', () => {
    const role = classifyFileRole({
      relativePath: 'src/controllers/userController.ts',
      exports: ['handleUserRequest'],
      imports: ['../services/userService'],
    });
    assert.equal(role.role, 'controller');
  });

  it('classifies service files', () => {
    const role = classifyFileRole({
      relativePath: 'src/services/userService.ts',
      exports: ['findUser'],
      imports: [],
    });
    assert.equal(role.role, 'service');
  });

  it('marks declared entry points', () => {
    const role = classifyFileRole({
      relativePath: 'src/extension/activate.ts',
      exports: ['activate'],
      imports: ['vscode'],
      isDeclaredEntryPoint: true,
    });
    assert.equal(role.role, 'entry-point');
    assert.ok(role.reasons.some((r) => r.includes('declared')));
  });

  it('classifies module roles from file aggregate', () => {
    const role = classifyModuleRole('src/services', [
      {
        absolutePath: '/x/src/services/userService.ts',
        relativePath: 'src/services/userService.ts',
        contentHash: 'a',
        mtimeMs: 0,
        imports: [],
        exports: [{ name: 'findUser', isReExport: false, isTypeOnly: false }],
        symbols: [],
        dependencyPaths: [],
        dynamicImportPaths: [],
      },
    ]);
    assert.equal(role.role, 'service');
  });
});
