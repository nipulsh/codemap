/**
 * Lightweight benchmarking helpers built on Node's built-in timing/memory APIs.
 * No external benchmarking framework. Results are written as JSON so they can be
 * compared across runs, plus a human-readable Markdown summary.
 *
 * Memory notes:
 *  - heapUsedDeltaMb = heapUsed(after) - heapUsed(before). When the process runs
 *    with --expose-gc a full GC is forced before both samples so the delta
 *    approximates retained memory of the produced result. Without --expose-gc the
 *    number includes garbage that has not been collected yet.
 *  - rssAfterMb is the process RSS right after the scenario (whole process,
 *    including V8, worker threads, and the benchmark harness itself).
 *  - peakRssMb is only sampled for async scenarios (a timer samples RSS while the
 *    scenario runs) and is therefore approximate.
 */
import { performance } from 'node:perf_hooks';
import { cpus, totalmem, platform, arch, release } from 'node:os';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type MetricValue = number | string | boolean | undefined;

export interface BenchmarkMeasurement {
  scenario: string;
  ms: number;
  heapUsedDeltaMb: number;
  rssAfterMb: number;
  peakRssMb?: number;
  metrics: Record<string, MetricValue>;
}

export interface EnvironmentInfo {
  node: string;
  platform: string;
  release: string;
  arch: string;
  cpuModel: string;
  cpuCount: number;
  totalMemoryGb: number;
  gcExposed: boolean;
  timestamp: string;
}

export interface BenchmarkSuiteResult {
  suite: string;
  description: string;
  environment: EnvironmentInfo;
  measurements: BenchmarkMeasurement[];
  notes: string[];
}

const RESULTS_DIR = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  '..',
  'benchmark-results',
);

export function resultsDir(): string {
  return RESULTS_DIR;
}

export function environmentInfo(): EnvironmentInfo {
  const cpuList = cpus();
  return {
    node: process.version,
    platform: platform(),
    release: release(),
    arch: arch(),
    cpuModel: cpuList[0]?.model?.trim() ?? 'unknown',
    cpuCount: cpuList.length,
    totalMemoryGb: round(totalmem() / 1024 ** 3, 1),
    gcExposed: typeof globalThis.gc === 'function',
    timestamp: new Date().toISOString(),
  };
}

export function forceGc(): void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc === 'function') {
    gc();
  }
}

export function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function toMb(bytes: number): number {
  return round(bytes / 1024 / 1024, 2);
}

export function nowMs(): number {
  return performance.now();
}

export function measureSync<T>(
  scenario: string,
  fn: () => T,
  extractMetrics: (result: T, ms: number) => Record<string, MetricValue> = () => ({}),
): { result: T; measurement: BenchmarkMeasurement } {
  forceGc();
  const heapBefore = process.memoryUsage().heapUsed;
  const start = performance.now();
  const result = fn();
  const ms = performance.now() - start;
  forceGc();
  const after = process.memoryUsage();
  const measurement: BenchmarkMeasurement = {
    scenario,
    ms: round(ms, 2),
    heapUsedDeltaMb: toMb(after.heapUsed - heapBefore),
    rssAfterMb: toMb(after.rss),
    metrics: extractMetrics(result, ms),
  };
  return { result, measurement };
}

export async function measureAsync<T>(
  scenario: string,
  fn: () => Promise<T>,
  extractMetrics: (result: T, ms: number) => Record<string, MetricValue> = () => ({}),
): Promise<{ result: T; measurement: BenchmarkMeasurement }> {
  forceGc();
  const heapBefore = process.memoryUsage().heapUsed;
  let peakRss = process.memoryUsage().rss;
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 25);
  const start = performance.now();
  let result: T;
  try {
    result = await fn();
  } finally {
    clearInterval(sampler);
  }
  const ms = performance.now() - start;
  forceGc();
  const after = process.memoryUsage();
  peakRss = Math.max(peakRss, after.rss);
  const measurement: BenchmarkMeasurement = {
    scenario,
    ms: round(ms, 2),
    heapUsedDeltaMb: toMb(after.heapUsed - heapBefore),
    rssAfterMb: toMb(after.rss),
    peakRssMb: toMb(peakRss),
    metrics: extractMetrics(result, ms),
  };
  return { result, measurement };
}

/** Run fn `iterations` times and return the median wall time (ms). */
export function medianOf(iterations: number, fn: () => void): number {
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  return percentile(samples, 50);
}

/** Percentile over an unsorted sample array (nearest-rank). */
export function percentile(samples: number[], p: number): number {
  if (samples.length === 0) {
    return 0;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return round(sorted[rank]!, 3);
}

export function mean(samples: number[]): number {
  if (samples.length === 0) {
    return 0;
  }
  return round(samples.reduce((a, b) => a + b, 0) / samples.length, 3);
}

export function createSuite(
  suite: string,
  description: string,
): BenchmarkSuiteResult {
  return {
    suite,
    description,
    environment: environmentInfo(),
    measurements: [],
    notes: [],
  };
}

export function writeSuiteResult(result: BenchmarkSuiteResult): string {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const file = join(RESULTS_DIR, `${result.suite}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2), 'utf8');
  return file;
}

export function readAllSuiteResults(): BenchmarkSuiteResult[] {
  if (!existsSync(RESULTS_DIR)) {
    return [];
  }
  return readdirSync(RESULTS_DIR)
    .filter((f) => f.endsWith('.json') && f !== 'latest.json')
    .sort()
    .map((f) => JSON.parse(readFileSync(join(RESULTS_DIR, f), 'utf8')) as BenchmarkSuiteResult);
}

export function formatCell(value: MetricValue): string {
  if (value === undefined) {
    return '–';
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  return String(value);
}

/** Render a Markdown table for a list of measurements with selected metric columns. */
export function renderMeasurementsTable(
  measurements: BenchmarkMeasurement[],
  metricColumns: string[],
  options: { includeMemory?: boolean } = {},
): string {
  const includeMemory = options.includeMemory !== false;
  const header = [
    'Scenario',
    ...metricColumns,
    'Time (ms)',
    ...(includeMemory ? ['Heap Δ (MB)', 'RSS after (MB)'] : []),
  ];
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
  ];
  for (const m of measurements) {
    const row = [
      m.scenario,
      ...metricColumns.map((c) => formatCell(m.metrics[c])),
      formatCell(m.ms),
      ...(includeMemory
        ? [formatCell(m.heapUsedDeltaMb), formatCell(m.rssAfterMb)]
        : []),
    ];
    lines.push(`| ${row.join(' | ')} |`);
  }
  return lines.join('\n');
}

export function printSuite(result: BenchmarkSuiteResult): void {
  console.log(`\n== ${result.suite}: ${result.description}`);
  for (const m of result.measurements) {
    const metrics = Object.entries(m.metrics)
      .map(([k, v]) => `${k}=${formatCell(v)}`)
      .join(' ');
    console.log(
      `  ${m.scenario.padEnd(44)} ${String(m.ms.toFixed(1)).padStart(9)} ms  heapΔ=${m.heapUsedDeltaMb.toFixed(1)}MB rss=${m.rssAfterMb.toFixed(0)}MB  ${metrics}`,
    );
  }
  for (const note of result.notes) {
    console.log(`  note: ${note}`);
  }
}

/** True when the given module URL is the script Node was started with. */
export function isDirectRun(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return resolve(entry) === resolve(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}

/** Standard entry wrapper: run a suite, print, persist, exit non-zero on error. */
export async function runSuiteMain(
  build: () => Promise<BenchmarkSuiteResult> | BenchmarkSuiteResult,
): Promise<void> {
  try {
    const result = await build();
    printSuite(result);
    const file = writeSuiteResult(result);
    console.log(`\nwrote ${file}`);
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
}
