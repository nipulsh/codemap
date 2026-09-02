import type { SourceFileInfo } from '../analysis/types';
import type { ArchitecturalRole, RoleClassification } from './types';

interface ClassifyInput {
  relativePath: string;
  exports: string[];
  imports: string[];
  isDeclaredEntryPoint?: boolean;
}

function pushReason(
  reasons: string[],
  scores: Map<ArchitecturalRole, number>,
  role: ArchitecturalRole,
  weight: number,
  reason: string,
): void {
  scores.set(role, (scores.get(role) ?? 0) + weight);
  reasons.push(reason);
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

/**
 * Deterministic, confidence-based role classification from path and import signals.
 */
export function classifyFileRole(input: ClassifyInput): RoleClassification {
  const path = normalizePath(input.relativePath);
  const basename = path.split('/').pop() ?? path;
  const scores = new Map<ArchitecturalRole, number>();
  const reasons: string[] = [];

  if (input.isDeclaredEntryPoint) {
    pushReason(reasons, scores, 'entry-point', 1.0, 'declared entry point');
  }

  if (
    basename === 'activate.ts' ||
    basename === 'main.ts' ||
    basename === 'index.ts' ||
    basename === 'extension.ts'
  ) {
    pushReason(reasons, scores, 'entry-point', 0.6, `filename ${basename}`);
  }

  if (path.includes('/test') || path.includes('.test.') || path.includes('.spec.')) {
    pushReason(reasons, scores, 'test', 0.95, 'test file path pattern');
  }

  if (path.includes('/workers/') || basename.includes('worker')) {
    pushReason(reasons, scores, 'worker', 0.85, 'worker path pattern');
  }

  if (path.includes('/parser/') || basename.startsWith('extract')) {
    pushReason(reasons, scores, 'parser', 0.8, 'parser path pattern');
  }

  if (path.includes('/scanner/')) {
    pushReason(reasons, scores, 'scanner', 0.85, 'scanner path pattern');
  }

  if (path.includes('/cache/')) {
    pushReason(reasons, scores, 'cache', 0.85, 'cache path pattern');
  }

  if (
    path.includes('/webview/') ||
    path.endsWith('.tsx') ||
    path.includes('/components/')
  ) {
    pushReason(reasons, scores, 'ui', 0.75, 'UI/webview path pattern');
  }

  if (
    path.includes('controller') ||
    basename.includes('controller') ||
    path.includes('/routes/') ||
    path.includes('/api/')
  ) {
    pushReason(reasons, scores, 'controller', 0.7, 'controller/route path pattern');
  }

  if (path.includes('service') || basename.includes('service')) {
    pushReason(reasons, scores, 'service', 0.7, 'service path pattern');
  }

  if (
    path.includes('repository') ||
    path.includes('/repo/') ||
    basename.includes('repository')
  ) {
    pushReason(reasons, scores, 'repository', 0.7, 'repository path pattern');
  }

  if (
    basename === 'tsconfig.json' ||
    path.includes('/config/') ||
    basename.includes('config')
  ) {
    pushReason(reasons, scores, 'configuration', 0.65, 'configuration path pattern');
  }

  const importStr = input.imports.join(' ').toLowerCase();
  if (importStr.includes('worker_threads')) {
    pushReason(reasons, scores, 'worker', 0.5, 'imports worker_threads');
  }
  if (importStr.includes('react') || importStr.includes('@xyflow')) {
    pushReason(reasons, scores, 'ui', 0.4, 'imports UI framework');
  }

  if (scores.size === 0) {
    pushReason(reasons, scores, 'utility', 0.3, 'no strong role signals');
  }

  let bestRole: ArchitecturalRole = 'unknown';
  let bestScore = -1;
  for (const [role, score] of scores) {
    if (score > bestScore) {
      bestScore = score;
      bestRole = role;
    }
  }

  const confidence = Math.min(1, Math.max(0.1, bestScore));

  return {
    role: bestRole,
    confidence,
    reasons: [...new Set(reasons)].sort(),
  };
}

export function classifyModuleRole(
  modulePath: string,
  files: SourceFileInfo[],
): RoleClassification {
  const fileRoles = files.map((f) =>
    classifyFileRole({
      relativePath: f.relativePath,
      exports: f.exports.map((e) => e.name),
      imports: f.imports.map((i) => i.specifier),
    }),
  );

  const scores = new Map<ArchitecturalRole, number>();
  const reasons: string[] = [];

  for (const fr of fileRoles) {
    scores.set(fr.role, (scores.get(fr.role) ?? 0) + fr.confidence);
  }

  let bestRole: ArchitecturalRole = 'unknown';
  let bestScore = -1;
  for (const [role, score] of scores) {
    if (score > bestScore) {
      bestScore = score;
      bestRole = role;
    }
  }

  const path = normalizePath(modulePath);
  if (path.includes('parser')) {
    pushReason(reasons, scores, 'parser', 0.2, 'module directory name');
    if (bestRole === 'unknown') {
      bestRole = 'parser';
    }
  }

  return {
    role: bestRole,
    confidence: Math.min(1, bestScore / Math.max(1, files.length)),
    reasons: reasons.length > 0 ? [...new Set(reasons)].sort() : [`dominant file role: ${bestRole}`],
  };
}
