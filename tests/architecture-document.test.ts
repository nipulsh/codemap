import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFixture } from './helpers.ts';
import { analyzeArchitecture } from '../src/documentation/ArchitectureAnalyzer.ts';
import {
  buildArchitectureDocument,
  getRequiredHeadings,
} from '../src/documentation/ArchitectureDocumentBuilder.ts';

describe('ArchitectureAnalyzer', () => {
  it('produces entry points for small-app', () => {
    const result = analyzeFixture('small-app');
    const arch = analyzeArchitecture(result);
    assert.ok(arch.entryPoints.length >= 1);
    assert.ok(
      arch.entryPoints.some((e) => e.path.includes('index.ts')),
      'expected index.ts entry point',
    );
  });

  it('ranks important files by connectivity', () => {
    const result = analyzeFixture('small-app');
    const arch = analyzeArchitecture(result);
    assert.ok(arch.importantFiles.length >= 1);
    const top = arch.importantFiles[0];
    assert.ok(top.score > 0);
    assert.ok(top.scoreReasons.length >= 1);
  });

  it('detects technology stack from package.json', () => {
    const result = analyzeFixture('small-app');
    const arch = analyzeArchitecture(result);
    assert.ok(arch.technologies.includes('Express'));
    assert.ok(arch.technologies.includes('TypeScript'));
  });

  it('reports cycles from circular fixture', () => {
    const result = analyzeFixture('circular');
    const arch = analyzeArchitecture(result);
    assert.ok(arch.cycles.length >= 1);
  });

  it('includes known limitations', () => {
    const result = analyzeFixture('basic-imports');
    const arch = analyzeArchitecture(result);
    assert.ok(arch.knownLimitations.length >= 1);
  });
});

describe('ArchitectureDocumentBuilder', () => {
  it('includes all required headings', () => {
    const result = analyzeFixture('small-app');
    const arch = analyzeArchitecture(result);
    const doc = buildArchitectureDocument(arch);
    for (const heading of getRequiredHeadings()) {
      assert.ok(
        doc.fullMarkdown.includes(heading) ||
          doc.fullMarkdown.includes(`# ${heading}`) ||
          doc.fullMarkdown.includes(`## ${heading}`),
        `missing heading: ${heading}`,
      );
    }
  });

  it('produces stable output across repeated generation', () => {
    const result = analyzeFixture('basic-imports');
    const arch = analyzeArchitecture(result);
    const doc1 = buildArchitectureDocument(arch).fullMarkdown;
    const doc2 = buildArchitectureDocument(arch).fullMarkdown;
    assert.equal(doc1, doc2);
  });

  it('generates agent context with key sections', () => {
    const result = analyzeFixture('small-app');
    const arch = analyzeArchitecture(result);
    const doc = buildArchitectureDocument(arch);
    assert.ok(doc.agentContext.includes('## Project'));
    assert.ok(doc.agentContext.includes('## Stack'));
    assert.ok(doc.agentContext.includes('## Entry Points'));
    assert.ok(doc.agentContext.includes('## Known Limitations'));
  });

  it('respects includeDependencyGraph option', () => {
    const result = analyzeFixture('basic-imports');
    const arch = analyzeArchitecture(result);
    const withDeps = buildArchitectureDocument(arch, {
      includeDependencyGraph: true,
    }).fullMarkdown;
    const withoutDeps = buildArchitectureDocument(arch, {
      includeDependencyGraph: false,
    }).fullMarkdown;
    assert.notEqual(withDeps, withoutDeps);
    assert.ok(withoutDeps.includes('Dependency graph omitted'));
  });
});
