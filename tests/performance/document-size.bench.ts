/**
 * Benchmark: PROJECT_ARCHITECTURE.md size and generation time vs repository size.
 *
 * Measures analyzeArchitecture() + buildArchitectureDocument() on synthetic
 * workspaces from ~60 to ~3,700 files and reports document bytes, documented
 * modules/files, the size of the dependency section, and the agent-context size.
 * The goal is to detect unbounded growth or duplication in the generated text.
 *
 * Run: npx tsx --expose-gc tests/performance/document-size.bench.ts
 */
import { WorkspaceAnalysisService } from '../../src/analysis/WorkspaceAnalysisService.ts';
import { analyzeArchitecture } from '../../src/documentation/ArchitectureAnalyzer.ts';
import { buildArchitectureDocument } from '../../src/documentation/ArchitectureDocumentBuilder.ts';
import {
  createSuite,
  isDirectRun,
  measureSync,
  round,
  runSuiteMain,
  type BenchmarkSuiteResult,
} from './benchmark-utils.ts';
import { createSyntheticWorkspace } from './synthetic-workspace.ts';

export const DOC_SCENARIOS = [
  { name: 'small', fileCount: 50, routeCount: 4 },
  { name: 'medium', fileCount: 250, routeCount: 20, cycleEvery: 60 },
  { name: 'large', fileCount: 1000, routeCount: 80, cycleEvery: 60 },
  { name: 'stress', fileCount: 3000, routeCount: 240, cycleEvery: 60 },
];

function countSection(markdown: string, heading: string): number {
  const start = markdown.indexOf(`## ${heading}`);
  if (start === -1) {
    return 0;
  }
  const rest = markdown.slice(start + heading.length + 3);
  const end = rest.indexOf('\n## ');
  return (end === -1 ? rest : rest.slice(0, end)).split('\n').length;
}

export async function runDocumentSizeBenchmark(): Promise<BenchmarkSuiteResult> {
  const suite = createSuite(
    'document-size',
    'PROJECT_ARCHITECTURE.md generation time and size by repository size',
  );
  const service = new WorkspaceAnalysisService();

  for (const scenario of DOC_SCENARIOS) {
    const ws = createSyntheticWorkspace({
      name: `doc-${scenario.name}`,
      fileCount: scenario.fileCount,
      routeCount: scenario.routeCount,
      cycleEvery: scenario.cycleEvery ?? 0,
    });
    try {
      const analysis = service.analyze(ws.root);

      const arch = measureSync(
        `${scenario.name} / analyzeArchitecture`,
        () => analyzeArchitecture(analysis),
        (a) => ({
          files: analysis.files.length,
          modules: a.modules.length,
          importantFiles: a.importantFiles.length,
          dependencies: a.dependencies.length,
          cycles: a.cycles.length,
        }),
      );
      suite.measurements.push(arch.measurement);

      const doc = measureSync(
        `${scenario.name} / buildArchitectureDocument`,
        () => buildArchitectureDocument(arch.result),
        (d) => {
          const md = d.fullMarkdown;
          return {
            files: analysis.files.length,
            docKb: round(Buffer.byteLength(md, 'utf8') / 1024, 1),
            docLines: md.split('\n').length,
            agentContextKb: round(Buffer.byteLength(d.agentContext, 'utf8') / 1024, 1),
            moduleSectionLines: countSection(md, 'Major Modules'),
            dependencyLines: countSection(md, 'Dependency Overview'),
            bytesPerFile: round(Buffer.byteLength(md, 'utf8') / Math.max(1, analysis.files.length), 0),
          };
        },
      );
      suite.measurements.push(doc.measurement);
    } finally {
      ws.cleanup();
    }
  }

  suite.notes.push(
    'Dependency Overview is capped at 30 edges and Important Files at 20 rows; Major Modules grows with module count (one section per directory), which is the only unbounded section.',
    'bytesPerFile falling as the repository grows indicates the document stays summary-shaped rather than duplicating per-file detail.',
  );
  return suite;
}

if (isDirectRun(import.meta.url)) {
  void runSuiteMain(runDocumentSizeBenchmark);
}
