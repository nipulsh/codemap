import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFixture } from './helpers.ts';
import { WorkspaceAnalysisService } from '../src/analysis/WorkspaceAnalysisService.ts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('WorkspaceAnalysisService', () => {
  it('analyzes a fixture and returns files and graph', () => {
    const result = analyzeFixture('basic-imports');
    assert.ok(result.files.length >= 2);
    assert.ok(result.graph.nodes.length >= 2);
    assert.ok(result.graph.edges.length >= 1);
    assert.equal(result.parseErrorCount, 0);
  });

  it('detects import dependencies', () => {
    const result = analyzeFixture('basic-imports');
    const dep = result.dependencies.find(
      (d) => d.source.endsWith('main.ts') && d.target.endsWith('utils.ts'),
    );
    assert.ok(dep, 'expected main.ts -> utils.ts dependency');
  });

  it('tolerates one broken source file without aborting', () => {
    const result = analyzeFixture('malformed');
    assert.ok(result.files.length >= 2);
    assert.ok(result.parseErrorCount >= 1);
    const good = result.files.find((f) => f.relativePath.endsWith('good.ts'));
    assert.ok(good);
    assert.equal(good?.parseError, undefined);
  });

  it('detects circular dependencies', () => {
    const result = analyzeFixture('circular');
    assert.ok(result.cycles.length >= 1);
    assert.ok(result.cycles[0].filePaths.length >= 2);
  });

  it('handles empty project gracefully', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codemap-empty-'));
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'empty', version: '1.0.0' }),
    );
    const service = new WorkspaceAnalysisService();
    const result = service.analyze(dir);
    assert.equal(result.files.length, 0);
    assert.equal(result.metadata.name, 'empty');
  });

  it('reads project metadata from package.json', () => {
    const result = analyzeFixture('small-app');
    assert.equal(result.metadata.name, 'small-app');
    assert.ok(result.metadata.description?.includes('sample'));
    assert.ok(result.metadata.dependencies.includes('express'));
  });
});

describe('entry point detection via analyzeFixture', () => {
  it('finds package.json main entry in small-app', () => {
    const result = analyzeFixture('small-app');
    const paths = result.files.map((f) => f.relativePath);
    assert.ok(paths.some((p) => p.endsWith('src/index.ts')));
  });
});
