# CodeMap Roadmap

This roadmap extends the existing architecture visualizer without breaking the lazy interactive explorer.

## Phase 1 — Static Folder + File Graph

Workspace scan, worker-thread import/export parsing, React Flow graph, ELK/Dagre layout, manual refresh.

## Phase 2 — Live Incremental Updates

File watcher, on-disk cache, incremental reparse + `graph:patch`.

## Phase 3 — Function-Call Graph, Search, Filters

Function/component nodes, limited static call edges, search, filter toggles.

## Phase 4 — Scale & Polish

Performance targets, tooltips, keyboard shortcuts, folder zoom polish.

---

## Phase 5 — Workspace Analysis & Agent Architecture Documentation

Introduce a production-grade eager analysis pipeline separate from the existing lazy `ExplorerService`.

### 5.1 WorkspaceAnalysisService

`src/analysis/WorkspaceAnalysisService.ts` performs eager full-workspace scans using the existing scanner, parser, dependency index, and graph generator. Returns structured `WorkspaceAnalysisResult` without mutating `ExplorerService` or requiring the webview.

### 5.2 Shared Analysis Model

`src/analysis/types.ts` defines structured analysis types (project metadata, files, modules, dependencies, cycles, limitations) independent of Markdown or UI.

### 5.3 ArchitectureAnalyzer

`src/documentation/ArchitectureAnalyzer.ts` converts `WorkspaceAnalysisResult` into a deterministic `ProjectArchitecture` model with entry points, modules, important files, dependencies, cycles, and limitations.

### 5.4 Role Classification

`src/documentation/roleClassifier.ts` applies confidence-based heuristic role classification (entry-point, controller, service, worker, ui, etc.).

### 5.5 Architecture Document Builder

`src/documentation/ArchitectureDocumentBuilder.ts` generates deterministic `PROJECT_ARCHITECTURE.md` and condensed agent context from `ProjectArchitecture`.

### 5.6 VS Code Commands

- `CodeMap: Generate Architecture Document`
- `CodeMap: Update Architecture Document`
- `CodeMap: Copy Agent Context`

### 5.7 Configuration

- `codemap.architectureFile`
- `codemap.documentation.includeFunctionDetails`
- `codemap.documentation.includeDependencyGraph`
- `codemap.documentation.agentOptimized`

### 5.8 Tests

Unit tests for workspace analysis, entry-point detection, role classification, Markdown generation, deterministic output, and edge cases.

---

## Phase 6 — Static HTTP Route Intelligence

Static HTTP route detection built on `WorkspaceAnalysisService`. Phase 6A implements Express route extraction with a framework-neutral `RouteDefinition` model, `RouteAnalyzer`, and `RouteGraphBuilder` (`Route` nodes, `handles`/`servedBy` edges).

### 6A — Express (implemented)

- `src/parser/extractRoutes.ts` — AST-based Express route extraction
- `src/routes/types.ts` — `RouteDefinition` model
- `src/routes/RouteAnalyzer.ts` — workspace route analysis
- `src/routes/RouteGraphBuilder.ts` — route → graph conversion layer

Supports: `app.get/post/...`, `router` patterns, static mount prefixes, nested mounts, inline handlers, controller member handlers, handler symbol resolution, false-positive avoidance, unresolved dynamic prefix detection.

### 6B+ — Later Phase 6 work

- Fastify route extraction
- Next.js App Router and Pages API route extraction

## Phase 7 — Multi-Hop Static Call Tracing

Bounded BFS static call-chain analysis from route handlers via `CallChainAnalyzer`. Produces `StaticRouteTrace[]` — explicitly **not** runtime execution traces.

- `src/routes/CallChainAnalyzer.ts` — BFS traversal reusing `resolveCalls` / `resolveFunctionCallees`
- `src/routes/CallTraceGraphBuilder.ts` — optional `StaticRouteTrace` → `GraphPatch` conversion
- Opt-in via `WorkspaceAnalysisOptions.includeCallChains` (default: false)
- Configurable `callChainMaxDepth` (default: 8)

Supports: linear chains, branching, async call patterns (via existing resolver), cycles, recursion, external modules, unresolved dynamic dispatch, depth truncation, deterministic symbol IDs.

## Phase 8 — Route Trace Visualization (implemented)

Dedicated webview experience for exploring `StaticRouteTrace[]`:

- `shared/routeTrace.ts` — trace projection, depth filtering, route sorting, unresolved labels
- `src/webview/components/RouteTraceView.tsx` — route selector, metadata panel, depth filter, trace graph
- `src/webview/routeTrace/layoutTraceByDepth.ts` — depth-based vertical layout for trace projection
- Route selector with method/path filtering
- Static analysis banner (not runtime execution)
- Depth-based trace graph projection via existing React Flow (`ArchitectureGraph` trace mode)
- UI depth filter (no re-analysis on slider change)
- Cycle, external, and unresolved call indicators
- Source navigation via existing `node:open` integration
- Opt-in via **Route Trace** toolbar button or `CodeMap: Open Route Trace` command
- View mode toggle (`architecture` | `route-trace`) preserves underlying architecture graph state

## Phase 9 — Runtime Execution Tracing

Runtime observations are kept separate from static analysis:

```text
StaticRouteTrace  = source-derived possible call structure
RuntimeTrace      = observed execution for one actual run/request
TraceOverlay      = derived comparison between the two
```

Future UI overlay consumes `TraceOverlay` without replacing static structure.

### Phase 9A — Runtime Trace Protocol & Collector (implemented)

- `src/runtime/types.ts` — `RuntimeTrace`, `RuntimeSpan`, serializable event union, Zod wire schemas
- `src/runtime/TraceCollector.ts` — ingests runtime events, manages sessions, exposes completed traces
- `src/runtime/TraceSession.ts` — per-request span registry, parent-child relationships, timing/errors
- `src/runtime/TraceCorrelation.ts` — exact-match correlation to existing static `symbolId` values

Supports: trace/span lifecycle, nested spans, error preservation, producer timestamps, out-of-order events, unresolved spans, route ID attachment, deterministic serialization.

Does **not** include instrumentation, OpenTelemetry, or UI overlay.

### Phase 9B — Static ↔ Runtime Correlation (implemented)

- `src/runtime/TraceOverlay.ts` — `createTraceOverlay()`, `TraceOverlay`, overlay nodes/edges, metrics
- `src/runtime/TraceCorrelation.ts` — extended with `StaticTraceNodeIndex`, `correlateSpanToStaticNode()`, explicit match precedence
- `shared/traceOverlay.ts` — wire schemas, `enrichSnapshotWithOverlay()` for minimal Phase 8 plumbing

Supports: observed/unobserved/runtime-only/unresolved semantics, static edge observation, multi-invocation metrics, error preservation, deterministic output.

Does **not** include instrumentation or final runtime UI polish.

### Phase 9C — Express Runtime Instrumentation (implemented)

- `src/runtime/instrumentation/` — opt-in Express middleware, async context, explicit span helpers
- `instrumentExpress()` emits `RuntimeTraceEvent` into `TraceCollector`
- `withCodeMapSpan()` / `withCodeMapSpanSync()` for explicit nested function spans
- `createRouteResolverFromDefinitions()` maps Express route templates to static `routeId`
- Safe request metadata only (method, route pattern, status code — no headers/bodies/cookies)

Does **not** include Fastify/Next.js instrumentation, OpenTelemetry, or final runtime UI.

### Phase 9D — Runtime Overlay UI (implemented)

- Route Trace **Static** / **Runtime Overlay** display modes
- Runtime trace selector and refresh in `RouteTraceView`
- Overlay observation badges on graph nodes and edges (observed / unobserved / runtime-only / unresolved)
- Runtime metrics and error detail panel
- `RuntimeTraceRegistry` shared collector for extension host + instrumentation
- Message protocol: `runtimeTrace:list`, `runtimeTrace:overlay`, `runtimeTrace:select`, `runtimeTrace:refresh`

Future: Fastify/Next.js instrumentation and live trace streaming remain out of scope.

---

## Phase 10 — Production Hardening & Benchmarking (in progress)

Establish a measurable production-readiness baseline without adding new user-facing frameworks.

### 10A Performance Baseline (implemented)

- `tests/performance/` benchmark suites with `npm run benchmark*` scripts
- Synthetic workspace generator for repeatable size scenarios
- Measured hotspots fixed with evidence:
  - `createCallResolver` / per-analysis AST cache (call-chain analysis)
  - `SourceTextCache` (eliminate redundant disk reads)
  - `mayContainExpressRoutes` pre-filter (skip handler files that only import express types)
  - Map-based lookups in overlay projection, module analysis, and layout helpers
  - `layoutGraph` uses hierarchy edges only; large graphs use incremental tree layout
- Internal `AnalysisTimings` on `WorkspaceAnalysisResult`

### 10B Runtime Reliability (implemented)

- Bounded trace retention in `TraceCollector` (`maxCompletedTraces`, `maxSpansPerTrace`, `maxActiveTraces`)
- `withCodeMapSpan` concurrency fix (immutable AsyncLocalStorage contexts)
- Lazy span sorting in `TraceSession` (sort once in `toTrace()`)
- Late-event rejection for completed traces

### 10C Memory & Retention (implemented)

- Explicit FIFO eviction for completed traces with stats/issues
- Span-limit enforcement per trace session
- Registry/collector stats for diagnostics

### 10D Failure Recovery (implemented)

- `WorkerPool` per-worker task rejection, replacement after exit/error, dispose semantics
- Disk cache corrupt/malformed entry deletion + structural validation in `FileCache`
- Partial analysis failure isolation (malformed files do not abort workspace analysis)
- Cooperative cancellation via `AbortSignal` on eager analysis pipeline

### 10E Security Review (implemented)

- Express instrumentation collects method, route template, status code only
- No headers, cookies, bodies, authorization values, or arbitrary req/res serialization
- Documented in `EXPRESS_INSTRUMENTATION_LIMITATIONS`

### 10F Regression & Stress Testing (implemented)

- `tests/production-hardening.test.ts` — worker recovery, cache robustness, retention, failure isolation, perf regressions, security boundary
- Performance benchmarks: workspace, routes, call-chains, overlay, collector, instrumentation overhead, lazy-vs-eager, graph projection, document size
- `benchmark-results/REPORT.md` generated by `npm run benchmark`

**Status:** complete — validation and benchmark suites pass on Windows/Node 24 (Sep 2026).

---

## Architectural Rules for All Future Phases

- **Lazy explorer remains lazy** — `ExplorerService` powers interactive exploration.
- **Eager analysis is separate** — `WorkspaceAnalysisService` is the canonical full-workspace pipeline.
- **Analysis data is independent of presentation** — no React Flow or Markdown dependencies in core analysis.
- **Facts before AI** — deterministic extraction; AI optional for summaries only.
- **Static vs runtime must remain explicit** — distinguish inferred, observed, unresolved, and unknown.
- **Expensive analysis must not block the interactive host** — worker-backed where CPU-intensive.
- **Incremental compatibility** — design for future per-file invalidation.
